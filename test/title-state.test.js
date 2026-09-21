'use strict';

// The window title is the app's only channel while the page is not working, and it has
// two writers:
//
//   * `main/window.js`, which sets it from the repair status reported by the recovery
//     watcher;
//   * `platform/web-contents-guard.js`, which re-sets it on every `page-title-updated`
//     so the remote page cannot rename the window.
//
// They used to disagree: the guard wrote the constant `抖音`. So the first title update
// after a repair began erased the notice - and a repair *reloads the page*, which is
// precisely what produces one. Measured: set the title to
// `抖音 — 页面加载异常，正在自动修复（第 1 次）`, emit a single `page-title-updated`, and the
// title was back to `抖音`.
//
// Both now resolve through `main/title-state.js`, keyed by webContents.
//
// `platform/web-contents-guard.js` imports `electron`, so the stub goes in first.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { installElectronStub } = require('./helpers/electron-stub');

/** The one window every `BrowserWindow.fromWebContents()` call in this file returns. */
const fakeWindow = {
  title: null,
  setTitle(value) {
    this.title = value;
  },
};

const { restore } = installElectronStub({ window: fakeWindow });
const { setRepairStatus, titleFor } = require('../app/main/title-state');
const { hardenWebContents } = require('../app/platform/web-contents-guard');

test.after(() => restore());

function fakeContents() {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  return contents;
}

/** Emit a title update and report whether the page was stopped from renaming the window. */
function pageRetitles(contents, title = '抖音 - 记录美好生活') {
  let prevented = false;
  contents.emit('page-title-updated', { preventDefault: () => { prevented = true; } }, title);
  return prevented;
}

// ---------------------------------------------------------------------------
// The lookup itself
// ---------------------------------------------------------------------------

test('titleFor reports the phase recorded for that window', () => {
  const contents = fakeContents();
  assert.equal(titleFor(contents), '抖音', 'a window with no status is simply healthy');

  setRepairStatus(contents, { phase: 'repairing', round: 3 });
  assert.equal(titleFor(contents), '抖音 — 页面加载异常，正在自动修复（第 3 次）');

  setRepairStatus(contents, { phase: 'waiting-for-server', round: 5 });
  assert.equal(titleFor(contents), '抖音 — 服务器暂时没有返回页面，正在等待重试（第 5 次）');

  setRepairStatus(contents, { phase: 'captcha' });
  assert.equal(titleFor(contents), '抖音 — 服务器要求人机验证，请在页面中完成验证');
});

test('a healthy status clears the notice, and so does no status at all', () => {
  const contents = fakeContents();
  setRepairStatus(contents, { phase: 'repairing', round: 1 });
  assert.notEqual(titleFor(contents), '抖音');

  setRepairStatus(contents, { phase: 'healthy' });
  assert.equal(titleFor(contents), '抖音', 'a recovered window must stop advertising a repair');

  setRepairStatus(contents, { phase: 'repairing', round: 1 });
  setRepairStatus(contents, undefined);
  assert.equal(titleFor(contents), '抖音');
});

test('a malformed status is ignored rather than rendered', () => {
  const contents = fakeContents();
  setRepairStatus(contents, { phase: 'repairing', round: 2 });

  // No phase string means there is nothing to say, so the notice is dropped.
  setRepairStatus(contents, { round: 4 });
  assert.equal(titleFor(contents), '抖音');
});

test('each window keeps its own status', () => {
  // The state used to be a single variable, so a second window would show the first
  // window's repair notice.
  const one = fakeContents();
  const two = fakeContents();
  setRepairStatus(one, { phase: 'captcha' });
  setRepairStatus(two, { phase: 'repairing', round: 1 });

  assert.equal(titleFor(one), '抖音 — 服务器要求人机验证，请在页面中完成验证');
  assert.equal(titleFor(two), '抖音 — 页面加载异常，正在自动修复（第 1 次）');

  setRepairStatus(one, { phase: 'healthy' });
  assert.equal(titleFor(one), '抖音');
  assert.equal(titleFor(two), '抖音 — 页面加载异常，正在自动修复（第 1 次）', 'the other window is untouched');
});

test('titleFor tolerates having no webContents', () => {
  assert.equal(titleFor(null), '抖音');
  assert.equal(titleFor(undefined), '抖音');
  assert.equal(titleFor({}), '抖音', 'an unknown window is healthy');
  assert.doesNotThrow(() => setRepairStatus(null, { phase: 'repairing', round: 1 }));
});

// ---------------------------------------------------------------------------
// The regression: a page title update must not wipe the notice
// ---------------------------------------------------------------------------

test('a title update from the page does not wipe a repair notice', () => {
  const contents = fakeContents();
  hardenWebContents(contents, { title: titleFor });

  setRepairStatus(contents, { phase: 'repairing', round: 1 });
  fakeWindow.setTitle(titleFor(contents));

  const prevented = pageRetitles(contents);

  assert.equal(prevented, true, 'the page must not be allowed to rename the window');
  assert.equal(fakeWindow.title, '抖音 — 页面加载异常，正在自动修复（第 1 次）');
});

test('the notice follows the phase across the ladder', () => {
  const contents = fakeContents();
  hardenWebContents(contents, { title: titleFor });

  for (const [status, expected] of [
    [{ phase: 'repairing', round: 1 }, '抖音 — 页面加载异常，正在自动修复（第 1 次）'],
    [{ phase: 'repairing', round: 4 }, '抖音 — 页面加载异常，正在自动修复（第 4 次）'],
    [{ phase: 'waiting-for-server', round: 6 }, '抖音 — 服务器暂时没有返回页面，正在等待重试（第 6 次）'],
    [{ phase: 'captcha' }, '抖音 — 服务器要求人机验证，请在页面中完成验证'],
    [{ phase: 'healthy' }, '抖音'],
  ]) {
    setRepairStatus(contents, status);
    pageRetitles(contents);
    assert.equal(fakeWindow.title, expected, `phase ${status.phase}`);
  }
});

test('a constant title is still accepted - and is exactly what used to erase the notice', () => {
  // Back-compat for callers that pass a string. This test documents the old failure:
  // with a constant, the repair notice is gone the moment the page updates its title.
  const contents = fakeContents();
  hardenWebContents(contents, { title: '抖音' });

  setRepairStatus(contents, { phase: 'repairing', round: 2 });
  pageRetitles(contents);

  assert.equal(fakeWindow.title, '抖音', 'this is the bug the function form fixes');
});

test('no title option at all falls back to the app name', () => {
  const contents = fakeContents();
  hardenWebContents(contents);

  pageRetitles(contents);

  assert.equal(fakeWindow.title, '抖音');
});
