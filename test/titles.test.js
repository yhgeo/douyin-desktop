'use strict';

// The window title is the only thing a user sees while the app is not working, so these
// strings are worth pinning. They used to live in main/window.js, which requires
// `electron` and therefore cannot be imported by a plain unit test.

const test = require('node:test');
const assert = require('node:assert/strict');

const { titlesFor } = require('../app/main/titles');

test('a repair in progress says which round it is on', () => {
  assert.equal(titlesFor({ phase: 'repairing', round: 3 }), '抖音 — 页面加载异常，正在自动修复（第 3 次）');
});

test('past the ladder it stops claiming a local fix is coming', () => {
  // Nothing local is wrong any more, and retrying harder is what made the server less
  // willing in the first place - so the wording has to change with the phase.
  assert.equal(
    titlesFor({ phase: 'waiting-for-server', round: 5 }),
    '抖音 — 服务器暂时没有返回页面，正在等待重试（第 5 次）',
  );
});

test('the captcha interstitial asks the user to do something', () => {
  assert.equal(titlesFor({ phase: 'captcha' }), '抖音 — 服务器要求人机验证，请在页面中完成验证');
});

test('anything else falls back to the plain title', () => {
  assert.equal(titlesFor({ phase: 'healthy' }), '抖音');
  assert.equal(titlesFor({}), '抖音');
  assert.equal(titlesFor(null), '抖音');
  assert.equal(titlesFor(undefined), '抖音');
});
