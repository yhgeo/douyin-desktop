// End-to-end test for the two independent clearing operations:
//
//   「清除抖音网页数据」 -> cookies / cache / site storage, script config KEPT
//   「清除脚本配置数据」 -> script config only, site data KEPT
//
// It drives the real app/preload.js against a real www.douyin.com origin and uses
// the production GmStore, then performs exactly the two operations the menu
// items perform and checks what each one actually destroys.
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const harness = require('./harness');
const { GmStore } = require('../../app/gm-store');

const PORT = 45994;
const userDataArg = process.argv.find((item) => item.startsWith('--e2e-user-data='));
if (userDataArg) app.setPath('userData', userDataArg.slice('--e2e-user-data='.length));

harness.applyHarnessSwitches(PORT);

const PRELOAD = path.join(__dirname, '..', '..', 'app', 'preload.js');

app.whenReady().then(async () => {
  const store = new GmStore(path.join(app.getPath('userData'), 'userscript-config.json'));
  const { received } = harness.installPreloadIpc({ store });
  const server = await harness.serveDouyinPage(PORT, harness.PAGE_PLAIN);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  await win.loadURL('http://www.douyin.com/');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const report = {};

  report.isLocalStub = await win.webContents.executeJavaScript(
    `Boolean(window['${harness.STUB_MARKER}'])`,
  );

  // Seed a script setting plus some "site data" that a real session would hold.
  report.seeded = await win.webContents.executeJavaScript(`(() => {
    GM_setValue('GM_Panel', { panel: { 'douyin-optimization': { enable: true } }, marker: 4242 });
    localStorage.setItem('HasUserLogin', '1');
    localStorage.setItem('webcast_local_quality', 'origin');
    document.cookie = 'sessionid=abc123; path=/';
    return {
      scriptValue: GM_getValue('GM_Panel', null),
      siteFlag: localStorage.getItem('HasUserLogin'),
      cookieCount: document.cookie.split(';').filter(Boolean).length,
    };
  })()`);
  // IPC writes are async; let them land in the store.
  await new Promise((resolve) => setTimeout(resolve, 300));
  report.storeAfterSeed = store.getAll();

  // --- Operation 1: 清除抖音网页数据 -----------------------------------------
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  report.afterClearWebData = await win.webContents.executeJavaScript(`(() => {
    return {
      scriptValue: GM_getValue('GM_Panel', null),
      scriptKeys: GM_listValues(),
      siteFlag: localStorage.getItem('HasUserLogin'),
      siteQuality: localStorage.getItem('webcast_local_quality'),
      cookieCount: document.cookie.split(';').filter(Boolean).length,
    };
  })()`);
  report.storeAfterClearWebData = store.getAll();

  // --- Operation 2: 清除脚本配置数据 ------------------------------------------
  // Mirrors clearUserscriptData() in app/main.js.
  store.clear();
  win.webContents.send('gm-store-replaced', {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  report.afterClearScriptData = await win.webContents.executeJavaScript(`(() => {
    GM_setValue('__probe_after_clear', 1);
    return {
      scriptValue: GM_getValue('GM_Panel', 'FALLBACK'),
      scriptKeys: GM_listValues(),
      siteFlag: localStorage.getItem('HasUserLogin'),
    };
  })()`);
  report.storeAfterClearScriptData = store.getAll();
  report.userscriptLoadStates = received.userscriptLoadStates;

  process.stdout.write(`CLEAR_REPORT=${JSON.stringify(report)}\n`);

  server.close();
  app.quit();
});

app.on('window-all-closed', () => {});
