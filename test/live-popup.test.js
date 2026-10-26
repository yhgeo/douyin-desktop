'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
require('./helpers/electron-stub').installElectronStub();
const { hardenWebContents, canonicalLivePopupUrl } = require('../app/platform/web-contents-guard');
function popup(url, opener = 'https://www.douyin.com/') {
  const contents = new EventEmitter();
  contents.getURL = () => opener;
  contents.setWindowOpenHandler = callback => { contents.handler = callback; };
  hardenWebContents(contents);
  return contents.handler({ url });
}
test('live room popups receive the same restricted preload as the main window', () => {
  for (const url of ['https://live.douyin.com/123456?from_nav=1', 'https://www.douyin.com/root/live/123456']) {
    const result = popup(url);
    assert.equal(result.action, 'allow');
    assert.equal(result.outlivesOpener, true);
    const prefs = result.overrideBrowserWindowOptions.webPreferences;
    assert.match(prefs.preload.replaceAll('\\', '/'), /app\/preload\/index.js$/);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.webviewTag, false);
    assert.equal(prefs.sandbox, false);
  }
});
test('rooms opened from search survive closing the search window', () => {
  for (const room of ['https://live.douyin.com/123456', 'https://www.douyin.com/root/live/123456', 'https://www.douyin.com/follow/live/123456']) {
    assert.equal(popup(room, 'https://www.douyin.com/search/anchor?type=user').outlivesOpener, true);
  }
});
test('only live-home room cards use fresh popup navigation', () => {
  const room = 'https://live.douyin.com/42075947470?enter_method=web_video_head&room_id=7690554468169042707';
  assert.equal(canonicalLivePopupUrl(room, 'https://live.douyin.com/?from_nav=1'), 'https://live.douyin.com/42075947470');
  for (const opener of ['https://www.douyin.com/', 'https://live.douyin.com/123', 'https://live.douyin.com.attacker.example/']) {
    assert.equal(canonicalLivePopupUrl(room, opener), null);
  }
  assert.equal(canonicalLivePopupUrl('https://www.douyin.com/passport', 'https://live.douyin.com/'), null);
  assert.equal(canonicalLivePopupUrl('https://live.douyin.com/', 'https://live.douyin.com/'), null);
  assert.equal(canonicalLivePopupUrl('https://live.douyin.com.attacker.example/123', 'https://live.douyin.com/'), null);
});
test('verification and unrelated popup policies stay unchanged', () => {
  for (const url of ['https://www.douyin.com/passport', 'https://verify.douyin.com/', 'https://live.douyin.com/']) assert.deepEqual(popup(url), { action: 'allow' });
  assert.deepEqual(popup('https://live.douyin.com.attacker.example/123'), { action: 'deny' });
  assert.deepEqual(popup('bytedance://dispatch_message/'), { action: 'deny' });
});

test('popup navigation runs after creation and detaches with the guard', async () => {
  const contents = new EventEmitter();
  contents.getURL = () => 'https://live.douyin.com/?from_nav=1';
  contents.setWindowOpenHandler = () => {};
  const detach = hardenWebContents(contents);
  const loaded = [];
  const child = { isDestroyed: () => false, loadURL: async url => { loaded.push(url); } };
  contents.emit('did-create-window', child, { url: 'https://live.douyin.com/123?enter_method=web_video_head' });
  assert.deepEqual(loaded, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(loaded, ['https://live.douyin.com/123']);
  detach();
  assert.equal(contents.listenerCount('did-create-window'), 0);
});

test('a popup closed before initialization is not navigated', async () => {
  const contents = new EventEmitter();
  contents.getURL = () => 'https://live.douyin.com/';
  contents.setWindowOpenHandler = () => {};
  hardenWebContents(contents);
  let loaded = false;
  contents.emit('did-create-window', { isDestroyed: () => true, loadURL: async () => { loaded = true; } }, { url: 'https://live.douyin.com/123' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded, false);
});
