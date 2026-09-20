'use strict';

// Unit coverage for the diagnostics log.
//
// Two things here are load-bearing rather than cosmetic:
//
//  - rotation, because a log that rotates away in an hour is no use for a failure
//    that shows up after a few;
//  - collapsing repeated console messages, because the site emits the same CSP
//    warning constantly and it would otherwise drown everything else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createLogFile } = require('../app/diagnostics/log-file');
const { attachPageDiagnostics, normalizeForDedupe } = require('../app/diagnostics/page-diagnostics');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dy-log-${name}-`));
}

/** A stand-in for Electron's WebContents, which is just an event emitter here. */
class FakeContents extends EventEmitter {
  constructor(url = 'https://www.douyin.com/') {
    super();
    this.url = url;
  }

  getURL() { return this.url; }

  isDestroyed() { return false; }
}

/** Capture the console output the logger mirrors, instead of printing it. */
function quiet(run) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { lines, value: run() };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test('a log line carries a timestamp, a level and the JSON payload', () => {
  const dir = tempDir('format');
  const log = quiet(() => createLogFile({ dir })).value;

  log.info('开始导航', { url: 'https://www.douyin.com/' });

  const content = fs.readFileSync(log.path, 'utf8');
  assert.match(content, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\] 开始导航 /);
  assert.match(content, /"url":"https:\/\/www\.douyin\.com\/"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the log directory is created if it does not exist', () => {
  const dir = path.join(tempDir('mkdir'), 'nested', 'logs');
  assert.equal(fs.existsSync(dir), false);
  const log = quiet(() => createLogFile({ dir })).value;
  log.info('启动');
  assert.equal(fs.existsSync(log.path), true);
  fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
});

test('rotation keeps the configured number of previous files', () => {
  const dir = tempDir('rotate');
  // Tiny limit so a couple of lines trip it.
  const log = quiet(() => createLogFile({ dir, maxBytes: 80, keep: 2 })).value;

  for (const marker of ['first', 'second', 'third', 'fourth', 'fifth']) {
    log.info(marker, { padding: 'x'.repeat(40) });
  }

  assert.equal(fs.existsSync(log.rotatedPath(1)), true, 'one rotated file expected');
  assert.equal(fs.existsSync(log.rotatedPath(2)), true, 'two rotated files expected');
  // Never more than `keep`, however long it runs.
  assert.equal(fs.existsSync(log.rotatedPath(3)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('navigations and load failures are recorded', () => {
  const dir = tempDir('nav');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 0 });
  contents.emit('did-start-navigation', {}, 'https://www.douyin.com/', false, true);
  contents.emit('did-start-navigation', {}, 'https://sub.frame/', false, false); // subframe: ignored
  contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://www.douyin.com/', true);
  contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://www.douyin.com/', true); // routine

  const content = fs.readFileSync(log.path, 'utf8');
  assert.match(content, /开始导航 .*"url":"https:\/\/www\.douyin\.com\/"/);
  assert.equal(content.includes('https://sub.frame/'), false, 'subframes must not be logged');
  assert.match(content, /页面加载失败 .*ERR_NAME_NOT_RESOLVED/);
  assert.equal(content.includes('ERR_ABORTED'), false, 'ERR_ABORTED is routine noise');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repeated console messages are collapsed instead of flooding the log', () => {
  const dir = tempDir('dedupe');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 60000 });
  const csp = "The Content Security Policy directive 'upgrade-insecure-requests' is ignored";
  for (let i = 0; i < 12; i += 1) {
    contents.emit('console-message', {}, { level: 3, message: csp, lineNumber: 0, sourceId: 'https://www.douyin.com/' });
  }
  // A different message must still get through immediately.
  contents.emit('console-message', {}, { level: 3, message: 'something new', lineNumber: 9, sourceId: 'https://www.douyin.com/' });

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, `expected 2 lines, got:\n${lines.join('\n')}`);
  assert.match(lines[0], /upgrade-insecure-requests/);
  assert.match(lines[1], /something new/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the same message from different scripts is still the same message', () => {
  // Measured on the real site: the CSP warning is reported once per offending script,
  // so keying on message *and* source produced nine log lines for one problem.
  const dir = tempDir('dedupe-source');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 60000 });
  const csp = "The Content Security Policy directive 'upgrade-insecure-requests' is ignored";
  for (const source of [
    'https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/',
    'https://www.douyin.com/',
    'https://lf-cdn-tos.bytescm.com/obj/rc-verifycenter/rmc-nocaptcha/setup.js',
    '',
  ]) {
    contents.emit('console-message', {}, { level: 3, message: csp, lineNumber: 0, sourceId: source });
  }

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, `expected 1 line, got:\n${lines.join('\n')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('messages that differ only by an embedded id are treated as repeats', () => {
  // The site's APM SDK logs `[SDK] <epoch-ms> 0 already inited`, which otherwise looks
  // like a brand new message every single time.
  const dir = tempDir('dedupe-id');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 60000 });
  for (const ms of [1789912126867, 1789912999999, 1789913000123]) {
    contents.emit('console-message', {}, {
      level: 2, message: `[SDK] ${ms}        0 already inited`, lineNumber: 0, sourceId: 'https://lf3-short.ibytedapm.com/',
    });
  }

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, `expected 1 line, got:\n${lines.join('\n')}`);
  // The written line keeps the real message, not the normalised key.
  assert.match(lines[0], /1789912126867/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalisation only collapses long digit runs', () => {
  assert.equal(normalizeForDedupe('already inited'), 'already inited');
  assert.equal(normalizeForDedupe('[SDK] 1789912126867 0 already inited'), '[SDK] # 0 already inited');
  // Short numbers are meaningful and must survive.
  assert.equal(normalizeForDedupe('HTTP 404 on /aweme/v1/web/feed'), 'HTTP 404 on /aweme/v1/web/feed');
});

test('a repeat that outlives the window is logged again with the count it hid', async () => {
  const dir = tempDir('dedupe-window');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  // A deliberately tiny window, so the second half of the behaviour is exercised
  // without a real minute-long wait. The sleep is four times the window.
  attachPageDiagnostics(contents, log, { dedupeMs: 40 });
  const emit = () => contents.emit('console-message', {}, {
    level: 2, message: 'same', lineNumber: 1, sourceId: 'src',
  });

  emit();          // first sighting: logged
  emit();          // suppressed
  emit();          // suppressed
  await new Promise((resolve) => setTimeout(resolve, 150));
  emit();          // outlived the window: logged, reporting what it hid

  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, `expected 2 lines, got:\n${lines.join('\n')}`);
  assert.equal(lines[0].includes('suppressedSinceLast'), false);
  assert.match(lines[1], /"suppressedSinceLast":2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('info-level console output is not captured', () => {
  // The bundled userscript logs heavily at info level; capturing it would make the
  // file useless within minutes.
  const dir = tempDir('level');
  const log = quiet(() => createLogFile({ dir })).value;
  const contents = new FakeContents();

  attachPageDiagnostics(contents, log, { dedupeMs: 0 });
  contents.emit('console-message', {}, { level: 1, message: '抖音优化 log.info', lineNumber: 1, sourceId: 'src' });
  contents.emit('console-message', {}, { level: 0, message: 'verbose', lineNumber: 1, sourceId: 'src' });

  assert.equal(fs.existsSync(log.path), false, 'no lines expected for info/verbose');
  fs.rmSync(dir, { recursive: true, force: true });
});
