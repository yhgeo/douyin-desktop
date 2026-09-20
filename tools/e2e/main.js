// End-to-end harness for the real app/preload/index.js.
//
// Loads the production preload against a genuine `www.douyin.com` origin, then
// restarts the whole process to check whether the userscript's settings survived.
//
// Usage:
//   electron tools/e2e/main.js --e2e-user-data=<dir> --e2e-phase=write
//   electron tools/e2e/main.js --e2e-user-data=<dir> --e2e-phase=read
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const harness = require('./harness');
const { GmStore } = require('../../app/storage/gm-store');

const PORT = 45999;
const arg = (name) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const userData = arg('e2e-user-data');
if (userData) app.setPath('userData', userData);
const phase = arg('e2e-phase') || 'write';

harness.applyHarnessSwitches(PORT);

const PRELOAD = path.join(__dirname, '..', '..', 'app', 'preload', 'index.js');

app.whenReady().then(async () => {
  // Use the production store so persistence is genuinely exercised; the two
  // phases run as separate processes against the same userData directory.
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

  // Only the app's own errors matter; the page may emit unrelated warnings.
  const consoleErrors = [];
  win.webContents.on('console-message', (event) => {
    if (event && event.level === 'error' && String(event.message).includes('[抖音]')) {
      consoleErrors.push(event.message);
    }
  });

  await win.loadURL('http://www.douyin.com/');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const script = phase === 'write'
    ? `(() => {
        if (typeof GM_setValue !== 'function') return { ok: false, error: 'GM_setValue missing' };
        GM_setValue('GM_Panel', { panel: { 'douyin-optimization': { enable: true } }, marker: ${Date.now()} });
        GM_setValue('short-cut', [{ key: 'a', value: 1 }]);
        return {
          ok: true,
          isLocalStub: Boolean(window['${harness.STUB_MARKER}']),
          readBack: GM_getValue('GM_Panel', null),
          legacyKeyPresent: localStorage.getItem('douyin-desktop:gm-values') !== null,
          styleCount: document.head.querySelectorAll('style').length,
        };
      })()`
    : `(() => {
        if (typeof GM_getValue !== 'function') return { ok: false, error: 'GM_getValue missing' };
        return {
          ok: true,
          isLocalStub: Boolean(window['${harness.STUB_MARKER}']),
          panel: GM_getValue('GM_Panel', null),
          shortCut: GM_getValue('short-cut', null),
          keys: typeof GM_listValues === 'function' ? GM_listValues() : null,
          styleCount: document.head.querySelectorAll('style').length,
        };
      })()`;

  const result = await win.webContents.executeJavaScript(script);
  process.stdout.write(`E2E_${phase.toUpperCase()}=${JSON.stringify(result)}\n`);
  process.stdout.write(`E2E_USERSCRIPT_STATES=${JSON.stringify(received.userscriptLoadStates)}\n`);
  process.stdout.write(`E2E_STORAGE_ERRORS=${JSON.stringify(received.storageErrors)}\n`);
  process.stdout.write(`E2E_CONSOLE_ERRORS=${JSON.stringify(consoleErrors)}\n`);

  server.close();
  app.quit();
});

app.on('window-all-closed', () => {});
