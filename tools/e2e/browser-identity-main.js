'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const archive = process.argv.find(arg => arg.startsWith('--archive='));
const root = archive ? archive.slice('--archive='.length) : path.join(__dirname, '../..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-identity-')));
app.disableHardwareAcceleration();
app.on('browser-window-created', (_, win) => { win.once('ready-to-show', () => setImmediate(() => { if (!win.isDestroyed()) win.hide(); })); });
const timeout = setTimeout(() => app.exit(2), 25000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('https', request => {
    if (new URL(request.url).pathname === '/identity') return new Response(JSON.stringify({ userAgent: request.headers.get('user-agent') }), { headers: { 'content-type': 'application/json' } });
    return new Response('<!doctype html><html><head><title>local fixture</title></head><body><p>Local fixture</p><script>window.__douyinDesktopLocalStub=true;</script></body></html>', { headers: { 'content-type': 'text/html' } });
  });
  const { start, browserUserAgent } = require(path.join(root, 'app/main/lifecycle'));
  await start();
  const { getMainWindow } = require(path.join(root, 'app/main/window'));
  const main = getMainWindow(); main.hide();
  const inspect = async win => {
    await delay(250);
    return win.webContents.executeJavaScript('(async () => ({ fixture:window.__douyinDesktopLocalStub, navigator:navigator.userAgent, network:(await fetch("/identity").then(r => r.json())).userAgent }))()');
  };
  const open = async (win, url) => {
    const created = new Promise(resolve => win.webContents.once('did-create-window', resolve));
    await win.webContents.executeJavaScript('window.open(' + JSON.stringify(url) + ',"_blank"); true');
    const child = await created; child.hide(); await delay(300); return child;
  };
  const search = await open(main, 'https://www.douyin.com/search/anchor');
  const room = await open(search, 'https://live.douyin.com/123456');
  const states = [];
  for (const win of [main, search, room]) states.push(await inspect(win));
  console.log('BROWSER_IDENTITIES', JSON.stringify(states));
  for (const state of states) { assert.equal(state.fixture, true); assert.equal(state.navigator, browserUserAgent()); assert.equal(state.network, browserUserAgent()); }
  search.close(); await delay(200);
  assert.equal(room.isDestroyed(), false);
  room.destroy(); main.destroy(); clearTimeout(timeout);
  console.log('BROWSER_IDENTITY=passed: actual startup, main/search/room navigator UA, room survives closing search');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
