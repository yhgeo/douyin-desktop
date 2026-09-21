'use strict';

// Coverage for the download policy in platform/downloads.js.
//
// Two production bugs motivate every assertion below:
//
//  1. the custom-scheme guard was registered with `contents.on('will-download')`, where
//     Electron never emits it. The handler was dead code, so a `bytedance://` download
//     could still reach the Windows shell - the "需要新应用以打开此链接" dialog this app
//     exists to prevent. A probe arming both registrations measured 0 calls on the
//     webContents and 2 on the session.
//  2. `GM_download` answered with an immediate `onload()`. The script's progress bar,
//     failure notice and cancel button are all driven by the callbacks that never came,
//     so the UI reported "下载已完成" before the transfer had started.
//
// The stub goes in before the require: `platform/downloads.js` pulls in
// `platform/constants.js`, which calls `app.getPath` at load time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { installElectronStub } = require('./helpers/electron-stub');

const { restore, stub } = installElectronStub();
const { createDownloadBroker, safeFileName, uniqueSavePath } = require('../app/platform/downloads');

test.after(() => restore());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Swallow the log output; the assertions that care about it capture their own. */
function silentLog() {
  return { warn() {}, info() {}, error() {}, debug() {} };
}

function capturingLog() {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args) };
}

function fakeSession() {
  return new EventEmitter();
}

function fakeDownloadItem(url, filename) {
  const item = new EventEmitter();
  item.getURL = () => url;
  item.getFilename = () => filename;
  item.getReceivedBytes = () => 512;
  item.getTotalBytes = () => 2048;
  item.savePath = null;
  item.cancelled = false;
  item.setSavePath = (value) => {
    item.savePath = value;
  };
  item.cancel = () => {
    item.cancelled = true;
  };
  return item;
}

function fakeSender() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

/** Emit `will-download` and report whether the handler refused it. */
function deliver(session, item) {
  let prevented = false;
  session.emit('will-download', { preventDefault: () => { prevented = true; } }, item);
  return prevented;
}

/** A directory that is cleaned up tolerantly - cleanup says nothing about the code. */
function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `douyin-downloads-${label}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not a test failure.
  }
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

test('safeFileName strips the characters Windows rejects', () => {
  assert.equal(safeFileName('a/b:c*d?e"f<g>h|i.mp4', 'fallback.mp4'), 'b_c_d_e_f_g_h_i.mp4');
});

test('safeFileName cannot be walked out of the downloads folder', () => {
  // `setSavePath` takes a path, so a name is a path injection vector if it is trusted.
  for (const hostile of ['..', '.', '../..', '../../etc/passwd', 'sub/../../escape']) {
    const result = safeFileName(hostile, 'real.bin');
    assert.ok(!result.includes('/'), `${hostile} -> ${result}`);
    assert.ok(!result.includes('\\'), `${hostile} -> ${result}`);
    assert.notEqual(result, '..');
    assert.notEqual(result, '.');
  }
  assert.equal(safeFileName('..', 'real.bin'), 'real.bin');
});

test('safeFileName falls back when the script gave nothing usable', () => {
  assert.equal(safeFileName('', 'fallback.mp4'), 'fallback.mp4');
  assert.equal(safeFileName('   ', 'fallback.mp4'), 'fallback.mp4');
  assert.equal(safeFileName(undefined, 'fallback.mp4'), 'fallback.mp4');
  assert.equal(safeFileName(null, 'fallback.mp4'), 'fallback.mp4');
  // Nothing to fall back to either: still a name, never an empty string.
  assert.match(safeFileName('', ''), /^download-\d+$/);
});

test('uniqueSavePath never overwrites an existing file', () => {
  const dir = tempDir('unique');
  try {
    const first = uniqueSavePath(dir, 'video.mp4');
    assert.equal(path.basename(first), 'video.mp4');
    fs.writeFileSync(first, 'x');

    const second = uniqueSavePath(dir, 'video.mp4');
    assert.equal(path.basename(second), 'video (1).mp4');
    fs.writeFileSync(second, 'x');

    assert.equal(path.basename(uniqueSavePath(dir, 'video.mp4')), 'video (2).mp4');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

test('request refuses a URL that may not be downloaded', () => {
  const broker = createDownloadBroker({ log: silentLog() });
  const sender = fakeSender();
  assert.equal(broker.request({ url: 'bytedance://webview?url=x', requestId: 1, sender }), false);
  assert.equal(broker.request({ url: 'snssdk1128://x', requestId: 1, sender }), false);
  assert.equal(broker.request({ url: '', requestId: 1, sender }), false);
  assert.equal(broker.request({ url: undefined, requestId: 1, sender }), false);
  // A request with no id could never be matched to its download.
  assert.equal(broker.request({ url: 'https://v.douyin.com/a.mp4', sender }), false);
  assert.equal(broker.request({ url: 'https://v.douyin.com/a.mp4', requestId: 0, sender }), false);
  // The preload numbers ids from 1 (`gm-download-${++downloadId}`), so a falsy id only
  // ever means "the caller did not send one".
  assert.equal(broker.request({ url: 'https://v.douyin.com/a.mp4', requestId: 'gm-download-1', sender }), true);
});

// ---------------------------------------------------------------------------
// The session handler
// ---------------------------------------------------------------------------

test('a custom-scheme download is refused instead of being handed to the OS', () => {
  // This is the regression: registered on a webContents, this handler never ran.
  const log = capturingLog();
  const broker = createDownloadBroker({ log });
  const session = fakeSession();
  broker.attach(session);

  const item = fakeDownloadItem('bytedance://webview?url=https%3A%2F%2Fx', 'x.bin');
  const prevented = deliver(session, item);

  assert.equal(prevented, true, 'the OS must never be asked to open a custom scheme');
  assert.equal(item.savePath, null, 'and nothing is written');
  assert.equal(log.warnings.length, 1);
  assert.match(String(log.warnings[0][0]), /已拦截下载/);
});

test('a download nobody asked for keeps Chromium default behaviour', () => {
  // Blanket-refusing every download would break the page's own "保存" actions.
  const broker = createDownloadBroker({ log: silentLog() });
  const session = fakeSession();
  broker.attach(session);

  const item = fakeDownloadItem('https://example.com/file.zip', 'file.zip');
  const prevented = deliver(session, item);

  assert.equal(prevented, false);
  assert.equal(item.savePath, null);
});

test('a requested download gets the script name, and reports progress and completion', () => {
  const broker = createDownloadBroker({ log: silentLog() });
  const session = fakeSession();
  broker.attach(session);

  const sender = fakeSender();
  const url = 'https://v.douyin.com/abc.mp4';
  assert.equal(broker.request({ url, name: '我的视频.mp4', requestId: 7, sender }), true);

  const item = fakeDownloadItem(url, 'from-the-url.mp4');
  const prevented = deliver(session, item);

  assert.equal(prevented, false, 'an http(s) download is allowed through');
  const expected = path.join(stub.downloads, '我的视频.mp4');
  assert.equal(item.savePath, expected, 'the name the script asked for wins over the URL');

  item.emit('updated', {}, 'progressing');
  assert.deepEqual(sender.sent.at(-1), {
    channel: 'gm-download-progress',
    payload: { requestId: 7, state: 'progressing', loaded: 512, total: 2048 },
  });

  item.emit('done', {}, 'completed');
  assert.deepEqual(sender.sent.at(-1), {
    channel: 'gm-download-done',
    payload: { requestId: 7, state: 'completed', path: expected },
  });
});

test('the queue is per URL, so overlapping downloads keep their own names', () => {
  // A single FIFO would hand the wrong name to the wrong file: `downloadURL` resolves
  // asynchronously, so the second item can arrive before the first.
  const broker = createDownloadBroker({ log: silentLog() });
  const session = fakeSession();
  broker.attach(session);

  const sender = fakeSender();
  broker.request({ url: 'https://a/1.mp4', name: 'first.mp4', requestId: 1, sender });
  broker.request({ url: 'https://a/2.mp4', name: 'second.mp4', requestId: 2, sender });

  const second = fakeDownloadItem('https://a/2.mp4', 'x.mp4');
  const first = fakeDownloadItem('https://a/1.mp4', 'x.mp4');
  deliver(session, second);
  deliver(session, first);

  assert.equal(path.basename(second.savePath), 'second.mp4');
  assert.equal(path.basename(first.savePath), 'first.mp4');
});

test('two downloads of the same URL do not overwrite each other', () => {
  const broker = createDownloadBroker({ log: silentLog() });
  const session = fakeSession();
  broker.attach(session);

  const sender = fakeSender();
  const url = 'https://v.douyin.com/same.mp4';
  broker.request({ url, name: 'clip.mp4', requestId: 1, sender });
  broker.request({ url, name: 'clip.mp4', requestId: 2, sender });

  const first = fakeDownloadItem(url, 'clip.mp4');
  deliver(session, first);
  fs.writeFileSync(first.savePath, 'already here');
  const second = fakeDownloadItem(url, 'clip.mp4');
  deliver(session, second);

  assert.equal(path.basename(first.savePath), 'clip.mp4');
  assert.equal(path.basename(second.savePath), 'clip (1).mp4');
});

test('a download whose frame went away does not throw', () => {
  const broker = createDownloadBroker({ log: silentLog() });
  const session = fakeSession();
  broker.attach(session);

  const destroyed = { isDestroyed: () => true, send: () => { throw new Error('gone'); } };
  const url = 'https://v.douyin.com/gone.mp4';
  broker.request({ url, name: 'gone.mp4', requestId: 3, sender: destroyed });

  const item = fakeDownloadItem(url, 'gone.mp4');
  deliver(session, item);
  assert.doesNotThrow(() => item.emit('updated', {}, 'progressing'));
  assert.doesNotThrow(() => item.emit('done', {}, 'completed'));

  // Same for a sender that still claims to be alive but whose send() fails.
  const broken = { isDestroyed: () => false, send: () => { throw new Error('pipe closed'); } };
  broker.request({ url: 'https://v.douyin.com/broken.mp4', name: 'b.mp4', requestId: 4, sender: broken });
  const brokenItem = fakeDownloadItem('https://v.douyin.com/broken.mp4', 'b.mp4');
  deliver(session, brokenItem);
  assert.doesNotThrow(() => brokenItem.emit('done', {}, 'completed'));
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('abort cancels the matching download, and only while it is in flight', () => {
  const broker = createDownloadBroker({ log: silentLog() });
  const session = fakeSession();
  broker.attach(session);

  const sender = fakeSender();
  const url = 'https://v.douyin.com/cancel.mp4';
  broker.request({ url, name: 'cancel.mp4', requestId: 5, sender });

  assert.equal(broker.abort(5), false, 'nothing to cancel before the download starts');

  const item = fakeDownloadItem(url, 'cancel.mp4');
  deliver(session, item);

  assert.equal(broker.abort(5), true);
  assert.equal(item.cancelled, true);

  item.emit('done', {}, 'cancelled');
  assert.equal(broker.abort(5), false, 'and it is forgotten once finished');
});

test('abort reports failure instead of throwing when the item refuses to cancel', () => {
  const log = capturingLog();
  const broker = createDownloadBroker({ log });
  const session = fakeSession();
  broker.attach(session);

  const sender = fakeSender();
  const url = 'https://v.douyin.com/stubborn.mp4';
  broker.request({ url, name: 's.mp4', requestId: 6, sender });
  const item = fakeDownloadItem(url, 's.mp4');
  item.cancel = () => { throw new Error('already finished'); };
  deliver(session, item);

  assert.equal(broker.abort(6), false);
  assert.equal(log.warnings.length, 1);
  assert.match(String(log.warnings[0][0]), /取消下载失败/);
});
