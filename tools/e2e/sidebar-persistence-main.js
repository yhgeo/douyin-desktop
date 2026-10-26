'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const harness = require('./harness');
const archive = process.argv.find(arg => arg.startsWith('--archive='));
const appRoot = archive ? archive.slice('--archive='.length) : path.join(__dirname, '../..');
const { hardenWebContents } = require(path.join(appRoot, 'app/platform/web-contents-guard'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-sidebar-persistence-')));
app.disableHardwareAcceleration();
app.on('web-contents-created', (_, contents) => hardenWebContents(contents));
const guard = setTimeout(() => app.exit(2), 25000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = '<!doctype html><html><head><title>fixture</title></head><body>'
  + '<div class="xg-right-grid"><xg-icon class="xgplayer-autoplay-setting"></xg-icon></div>'
  + '<a id="live-card" href="https://live.douyin.com/123456?enter_method=web_video_head&room_id=7690554468169042707" target="_blank">Live card</a>'
  + '<div data-e2e="live-room-audience">9万</div>'
  + '<script>window.__douyinDesktopLocalStub=true;document.querySelector("[data-e2e=live-room-audience]").__reactFiber$fixture='
  + '{dependencies:{firstContext:{memoizedValue:{roomStore:{roomInfo:{room:{room_view_stats:{display_value:91234}}}}}}}};</script></body></html>';
app.whenReady().then(async () => {
  const { store, received } = harness.installPreloadIpc({ experienceEnhancerEnabled: true });
  store.set('GM_Panel', { 'dy-live-showLiveRoomAudienceCount': true });
  const navigations = [];
  session.defaultSession.protocol.handle('https', request => {
    navigations.push(request.url);
    return new Response(fixture, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(appRoot,'app/preload/index.js'), contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  const evaluate = code => win.webContents.executeJavaScript(code);
  const readSwitch = () => evaluate('document.querySelector(".skip-live-button button")?.getAttribute("aria-checked")');
  await win.loadURL('https://www.douyin.com/?recommend=1'); await delay(800);
  assert.equal(await evaluate('window.__douyinDesktopLocalStub'), true);
  assert.equal(await readSwitch(), 'true');
  await evaluate('document.querySelector(".skip-live-button button").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerType:"mouse",button:0})); true');
  assert.equal(await readSwitch(), 'false');
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("douyin_default_toggle_states")).skipLive'), 'disabled');
  await win.loadURL('https://live.douyin.com/?from_nav=1'); await delay(500);
  const opened = new Promise(resolve => app.once('browser-window-created', (_, child) => { child.hide(); resolve(child); }));
  await evaluate('document.querySelector("#live-card").click(); true');
  const child = await opened; await delay(900);
  assert.equal(child.webContents.getURL(), 'https://live.douyin.com/123456');
  assert.ok(navigations.includes('https://live.douyin.com/123456'));
  assert.equal(await child.webContents.executeJavaScript('typeof window.__douyinDesktopStartLiveAudience'), 'function');
  assert.equal(await child.webContents.executeJavaScript('document.querySelector("[data-e2e=live-room-audience]").textContent'), '91234');
  assert.equal(child.webContents.getLastWebPreferences().nodeIntegration, false);
  child.destroy();
  await win.loadURL('https://www.douyin.com/?recommend=1'); await delay(700);
  assert.equal(await readSwitch(), 'false');
  win.webContents.reload(); await new Promise(resolve => win.webContents.once('did-finish-load', resolve)); await delay(700);
  assert.equal(await readSwitch(), 'false');
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"=",bubbles:true})); true');
  assert.equal(await readSwitch(), 'true');
  await win.loadURL('https://www.douyin.com/?recommend=1&reload=1'); await delay(700);
  assert.equal(await readSwitch(), 'true');
  assert.ok(received.userscriptLoadStates.length >= 5);
  assert.ok(received.userscriptLoadStates.every(state => state.ok));
  // Match the user's three-window flow: main -> search -> live room.
  const searchOpened = new Promise(resolve => win.webContents.once('did-create-window', resolve));
  await evaluate('window.open("https://www.douyin.com/search/anchor","_blank"); true');
  const search = await searchOpened; search.hide(); await delay(500);
  const roomOpened = new Promise(resolve => search.webContents.once('did-create-window', resolve));
  await search.webContents.executeJavaScript('document.querySelector("#live-card").click(); true');
  const room = await roomOpened; room.hide(); await delay(700);
  search.close(); await delay(300);
  assert.equal(search.isDestroyed(), true);
  assert.equal(room.isDestroyed(), false);
  assert.equal(await room.webContents.executeJavaScript('document.querySelector("[data-e2e=live-room-audience]").textContent'), '91234');
  room.close();
  console.log('SIDEBAR_PERSISTENCE=passed: real toolbar click, live sidebar, popup auto-injection/count, return to recommendation, reload, keyboard toggle');
  clearTimeout(guard); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
