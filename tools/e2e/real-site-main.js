// Verifies the fix against the REAL https://www.douyin.com/ instead of a local
// stand-in page.
//
// This is the strongest available check: it uses the production preload and the
// real bundled userscript against the live site, and reports whether the script
// actually got past `DouYin.init()`.
//
// Requires network access. Pass a proxy when the machine needs one:
//   electron tools/e2e/real-site-main.js --proxy-server=http://127.0.0.1:51725
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const proxyArg = process.argv.find((item) => item.startsWith('--proxy-server='));
const loadTimeoutMs = Number(
  (process.argv.find((item) => item.startsWith('--load-timeout=')) || '--load-timeout=45000').slice(15),
);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('lang', 'zh-CN');
if (proxyArg) {
  app.commandLine.appendSwitch('proxy-server', proxyArg.slice('--proxy-server='.length));
}

const userDataArg = process.argv.find((item) => item.startsWith('--real-user-data='));
if (userDataArg) app.setPath('userData', userDataArg.slice('--real-user-data='.length));

const PRELOAD = path.join(__dirname, '..', '..', 'app', 'preload.js');

const userscriptLoadStates = [];
const storageErrors = [];
const consoleErrors = [];

app.whenReady().then(async () => {
  ipcMain.on('get-script-enabled', (event) => { event.returnValue = true; });
  ipcMain.on('gm-menu-reset', () => {});
  ipcMain.on('gm-menu-register', () => {});
  ipcMain.on('gm-menu-unregister', () => {});
  ipcMain.on('userscript-loaded', (_event, state) => { userscriptLoadStates.push(state); });
  ipcMain.on('userscript-storage-error', (_event, info) => { storageErrors.push(info); });
  ipcMain.handle('gm-http-request', async () => ({ ok: false, error: 'disabled in test' }));
  ipcMain.on('gm-download', () => {});

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

  win.webContents.on('console-message', (event) => {
    if (event && event.level === 'error') consoleErrors.push(event.message);
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    process.stdout.write(`REAL_LOAD_FAIL=${code} ${description} ${url}\n`);
  });

  const loaded = new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve('did-finish-load'));
    win.webContents.once('did-fail-load', () => resolve('did-fail-load'));
    setTimeout(() => resolve('timeout'), loadTimeoutMs);
  });

  try {
    await win.loadURL('https://www.douyin.com/');
  } catch (error) {
    process.stdout.write(`REAL_LOAD_ERROR=${error.message}\n`);
  }
  process.stdout.write(`REAL_LOAD_STATE=${await loaded}\n`);

  // Let the SPA settle so the script has something to work with.
  await new Promise((resolve) => setTimeout(resolve, 8000));

  const pageState = await win.webContents.executeJavaScript(`(() => {
    const styles = [...document.head.querySelectorAll('style')];
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyChildren: document.body ? document.body.childElementCount : -1,
      styleCount: styles.length,
      // The userscript's ad-block CSS is injected by addStyle(), the exact call
      // that used to throw. Its presence proves the init path ran to completion.
      blockCssPresent: styles.some((node) => /data-e2e|semiTabPanel|douyin/i.test(node.textContent || '')),
      gmApiPresent: typeof GM_getValue === 'function',
      storedKeys: typeof GM_listValues === 'function' ? GM_listValues() : null,
    };
  })()`);

  process.stdout.write(`REAL_PAGE=${JSON.stringify(pageState)}\n`);
  process.stdout.write(`REAL_USERSCRIPT_STATES=${JSON.stringify(userscriptLoadStates)}\n`);
  process.stdout.write(`REAL_STORAGE_ERRORS=${JSON.stringify(storageErrors)}\n`);
  process.stdout.write(`REAL_CONSOLE_ERRORS=${JSON.stringify(consoleErrors.slice(0, 10))}\n`);

  app.exit(0);
});

app.on('window-all-closed', () => {});
