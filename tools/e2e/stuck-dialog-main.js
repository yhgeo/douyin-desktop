// End-to-end test for the stuck-dialog recovery.
//
// Douyin's "是否保存登录信息？" prompt can end up present but unusable: both buttons
// sit in Semi's loading state, which sets pointer-events:none, behind a full-screen
// mask. The page side recovers it by reusing Douyin's own synchronous cleanup.
//
// A stub page reproduces that exact DOM shape (there is no React fiber in the stub,
// so this exercises the fallback removal path; the fiber path was verified against
// the live stuck dialog).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const harness = require('./harness');

const PORT = 45994;
const userDataArg = process.argv.find((item) => item.startsWith('--e2e-user-data='));
if (userDataArg) app.setPath('userData', userDataArg.slice('--e2e-user-data='.length));

harness.applyHarnessSwitches(PORT);

const PRELOAD = path.join(__dirname, '..', '..', 'app', 'preload.js');

const STUCK_DIALOG = `
<div id="trust-logout-dialog">
  <div class="trust-login-dialog-mask">
    <div class="trust-login-dialog-content">
      <div class="trust-login-dialog-title">是否保存登录信息？（0）</div>
      <div class="trust-login-dialog-button">
        <button class="semi-button trust-login-dialog-button-cancel" style="pointer-events: none">取消</button>
        <button class="semi-button trust-login-dialog-button-confirm" style="pointer-events: none">保存</button>
      </div>
    </div>
  </div>
</div>`;

const HEALTHY_DIALOG = `
<div id="trust-logout-dialog">
  <div class="trust-login-dialog-mask">
    <div class="trust-login-dialog-button">
      <button class="semi-button trust-login-dialog-button-cancel">取消</button>
      <button class="semi-button trust-login-dialog-button-confirm">保存</button>
    </div>
  </div>
</div>`;

const PAGE = `<!doctype html><html><head><title>douyin</title>
<script>window.${harness.STUB_MARKER} = true;</script>
<style>
  .trust-login-dialog-mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 505; }
</style>
</head><body><div id="app"></div></body></html>`;

app.whenReady().then(async () => {
  const { received } = harness.installPreloadIpc({});
  const results = [];
  ipcMain.on('stuck-dialog-recovery-result', (_event, result) => { results.push(result); });

  const server = await harness.serveDouyinPage(PORT, PAGE);
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
  await new Promise((resolve) => setTimeout(resolve, 600));

  const report = {};
  report.isLocalStub = await win.webContents.executeJavaScript(`Boolean(window['${harness.STUB_MARKER}'])`);

  const inject = (html) => win.webContents.executeJavaScript(`(() => {
    document.getElementById('trust-logout-dialog')?.remove();
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)});
    return Boolean(document.getElementById('trust-logout-dialog'));
  })()`);

  const askRecover = async () => {
    results.length = 0;
    win.webContents.send('recover-stuck-dialog');
    await new Promise((resolve) => setTimeout(resolve, 500));
    return results[0] || null;
  };

  // 1. A stuck dialog is recovered and the page becomes usable again.
  await inject(STUCK_DIALOG);
  report.stuckInjected = await win.webContents.executeJavaScript(`(() => {
    const d = document.getElementById('trust-logout-dialog');
    const buttons = [...d.querySelectorAll('.trust-login-dialog-button-cancel, .trust-login-dialog-button-confirm')];
    return {
      present: Boolean(d),
      maskPresent: Boolean(document.querySelector('.trust-login-dialog-mask')),
      allButtonsUnusable: buttons.length > 0 && buttons.every((b) => getComputedStyle(b).pointerEvents === 'none'),
    };
  })()`);
  report.stuckRecovery = await askRecover();
  report.afterRecovery = await win.webContents.executeJavaScript(`({
    dialog: Boolean(document.getElementById('trust-logout-dialog')),
    mask: Boolean(document.querySelector('.trust-login-dialog-mask')),
  })`);

  // 2. Asking again when nothing is wrong reports nothing to do.
  report.secondRecovery = await askRecover();

  // 3. A healthy dialog is still recoverable on request (Douyin's own cleanup),
  //    and the recovery reports which path it used.
  await inject(HEALTHY_DIALOG);
  report.healthyRecovery = await askRecover();
  report.afterHealthy = await win.webContents.executeJavaScript(
    `Boolean(document.getElementById('trust-logout-dialog'))`,
  );

  report.consoleErrors = [];
  process.stdout.write(`STUCK_REPORT=${JSON.stringify(report)}\n`);

  server.close();
  app.quit();
});

app.on('window-all-closed', () => {});
