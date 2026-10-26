'use strict';
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const harness = require('./harness');
const archive = process.argv.find(arg => arg.startsWith('--archive='));
const appRoot = archive ? archive.slice('--archive='.length) : path.join(__dirname, '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-enhancement-test-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const guard = setTimeout(() => { console.error('enhancement test timed out'); app.exit(1); }, 30000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const options = { experienceEnhancerEnabled: true };
  const { received } = harness.installPreloadIpc(options);
  // Use an in-memory origin: the test makes no external network requests and
  // does not depend on a system OpenSSL installation or local TLS listener.
  session.defaultSession.protocol.handle('https', () => new Response(harness.PAGE_PLAIN, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(appRoot, 'app/preload/index.js'),
    contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } });
  const errors = []; let loaded = 0;
  win.webContents.on('console-message', event => {
    if (event.level === 'error' && event.message.includes('[抖音]')) errors.push(event.message);
    if (event.message.includes('网页抖音体验增强 5.7 已加载')) loaded++;
  });
  const evaluate = code => win.webContents.executeJavaScript(code);
  await win.loadURL('https://www.douyin.com/');
  await delay(500);
  assert.equal(await evaluate('window.__douyinDesktopLocalStub'), true);
  assert.ok(received.userscriptLoadStates.some(state => state.ok));
  assert.equal(loaded, 1);
  await evaluate('(' + function () {
    const toolbar = document.createElement('div');
    toolbar.className = 'douyin-player-controls-right';
    toolbar.style.cssText = 'display:flex; flex-direction:column; flex-wrap:wrap; width:1200px; height:32px; position:fixed; left:0; top:0;';
    const autoplay = document.createElement('dy-icon');
    autoplay.className = 'douyin-player-autoplay-setting';
    toolbar.append(autoplay);
    const playback = document.createElement('dy-icon');
    playback.className = 'douyin-player-playback-setting';
    playback.innerHTML = '<div class="douyin-player-setting-content">1.0x</div>';
    toolbar.append(playback);
    const nativeVolume = document.createElement('dy-icon');
    nativeVolume.className = 'douyin-player-volume';
    nativeVolume.style.cssText = 'width:40px; height:22px;';
    toolbar.append(nativeVolume);
    document.body.append(toolbar);

    const active = document.createElement('div');
    active.dataset.e2e = 'feed-active-video';
    active.dataset.e2eVid = 'seek-fixture';
    active.style.cssText = 'position:fixed; width:320px; height:180px; left:0; top:40px;';
    const video = document.createElement('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    video.src = 'https://example.invalid/seek-fixture.mp4';
    active.append(video);
    document.body.append(active);
  }.toString() + ')()');
  await delay(800);
  const controlState = await evaluate('(() => {\n'
    + 'const toolbar = document.querySelector(".douyin-player-controls-right");\n'
    + 'const group = toolbar && toolbar.querySelector(".dy-enhancer-toolbar-group");\n'
    + 'const playback = document.querySelector(".douyin-player-playback-setting");\n'
    + 'const content = playback && playback.querySelector(".douyin-player-setting-content");\n'
    + 'const video = document.querySelector("[data-e2e=feed-active-video] video");\n'
    + 'const toolbarRect = toolbar.getBoundingClientRect(); const groupRect = group.getBoundingClientRect(); const nativeRect = toolbar.querySelector(".douyin-player-volume").getBoundingClientRect();\n'
    + 'return { display: getComputedStyle(toolbar).display, flexDirection: getComputedStyle(toolbar).flexDirection, flexWrap: getComputedStyle(toolbar).flexWrap, groupWrap: getComputedStyle(group).flexWrap, groupWidth: getComputedStyle(group).width, toolbarHeight: toolbarRect.height, groupTop: groupRect.top, nativeTop: nativeRect.top, marginTop: getComputedStyle(playback).marginTop, position: getComputedStyle(playback).position, pointerEvents: getComputedStyle(content).pointerEvents };\n'
    + '})()');
  // Row/column layout of the controls is deliberately not asserted here: this fixture is a
  // fake DOM, and pinning it is what previously locked in a layout that reversed the real
  // player's native control order. Layout is checked against the real player instead.
  assert.equal(controlState.display, 'flex');
  assert.notEqual(controlState.groupWidth, '0px');
  assert.equal(controlState.marginTop, '0px');
  assert.equal(controlState.position, 'relative');
  assert.equal(controlState.pointerEvents, 'auto');
  assert.deepEqual(errors, []);
  await evaluate('(' + function () {
    window.testStore = { roomStore: { roomInfo: { room: { room_view_stats: { display_value: 91234 } } } } };
    window.makeAudience = () => {
      const element = document.createElement('div'); element.dataset.e2e = 'live-room-audience';
      element.innerHTML = '<span>9万</span><i id=tooltip>?</i>';
      element.__reactFiber$test = { dependencies: { firstContext: { memoizedValue: window.testStore } } };
      document.body.append(element); return element;
    };
    window.audience = makeAudience();
    window.stopAudience = window.__douyinDesktopStartLiveAudience()[0];
  }.toString() + ')()');
  assert.equal(await evaluate('audience.querySelector("span").textContent'), '91234');
  assert.equal(await evaluate('audience.querySelector("i").textContent'), '?');
  await evaluate('testStore.roomStore.roomInfo.room.room_view_stats.display_value = 91321');
  await delay(1200);
  assert.equal(await evaluate('audience.querySelector("span").textContent'), '91321');
  await evaluate('audience.remove(); testStore.roomStore.roomInfo.room.room_view_stats.display_value = "95678"; audience = makeAudience()');
  await delay(500);
  assert.equal(await evaluate('audience.querySelector("span").textContent'), '95678');
  await evaluate('stopAudience(); testStore.roomStore.roomInfo.room.room_view_stats.display_value = 98765; audience.querySelector("span").textContent = "9万"');
  await delay(1200);
  assert.equal(await evaluate('audience.querySelector("span").textContent'), '9万');
  options.experienceEnhancerEnabled = false;
  await win.loadURL('https://www.douyin.com/?disabled=1'); await delay(500);
  assert.equal(loaded, 1);
  options.experienceEnhancerEnabled = true; options.scriptEnabled = false;
  await win.loadURL('https://www.douyin.com/?only-enhancer=1'); await delay(500);
  assert.equal(loaded, 2);
  assert.equal(await evaluate('typeof GM_getValue'), 'undefined');
  assert.deepEqual(errors, []);
  const { buildMenu } = require(path.join(appRoot, 'app/main/menu'));
  const { readSettings } = require(path.join(appRoot, 'app/storage/settings'));
  const menu = buildMenu();
  const toggle = menu.items.find(item => item.label === '体验增强').submenu.items[0];
  assert.equal(toggle.checked, false);
  toggle.click();
  assert.equal(readSettings().experienceEnhancerEnabled, true);
  toggle.click();
  assert.equal(readSettings().experienceEnhancerEnabled, false);
  console.log('ENHANCEMENT_TEST=passed (coexistence, independent switches, exact counts, live updates, DOM replacement, tooltip preservation, cleanup)');
  clearTimeout(guard); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
