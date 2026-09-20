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

// Only 保存 was clicked. This is the common real-world case: 取消 is still
// clickable, but clicking also cancelled the countdown, so the async call is the
// only remaining way out - and it never settles.
const ONE_BUTTON_STUCK = `
<div id="trust-logout-dialog">
  <div class="trust-login-dialog-mask">
    <div class="trust-login-dialog-button">
      <button class="semi-button trust-login-dialog-button-cancel">取消</button>
      <button class="semi-button trust-login-dialog-button-confirm" style="pointer-events: none">保存</button>
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

// Stuck, but with none of the signals the original detector knew about: no loading
// class, `pointer-events` left at auto, not `disabled` - only a spinner child. A
// detection miss here is silent (nothing happens, nothing is logged), so each of
// these shapes is pinned separately.
const SPINNER_ONLY_STUCK = `
<div id="trust-logout-dialog">
  <div class="trust-login-dialog-mask">
    <div class="trust-login-dialog-button">
      <button class="semi-button trust-login-dialog-button-cancel">取消</button>
      <button class="semi-button trust-login-dialog-button-confirm">
        <span class="semi-spin"></span><span class="semi-button-content">保存</span>
      </button>
    </div>
  </div>
</div>`;

// Stuck via the aria flag only.
const ARIA_DISABLED_STUCK = `
<div id="trust-logout-dialog">
  <div class="trust-login-dialog-mask">
    <div class="trust-login-dialog-button">
      <button class="semi-button trust-login-dialog-button-cancel" aria-disabled="true">取消</button>
      <button class="semi-button trust-login-dialog-button-confirm">保存</button>
    </div>
  </div>
</div>`;

// The exact classes the selector looks for are gone, which is what a Douyin rename
// would look like. The looser fallback has to still find the buttons.
const RENAMED_BUTTON_STUCK = `
<div id="trust-logout-dialog">
  <div class="trust-login-dialog-mask">
    <div class="trust-login-dialog-button">
      <button class="semi-button trust-login-dialog-button-dismiss">取消</button>
      <button class="semi-button trust-login-dialog-button-submit semi-button-loading">保存</button>
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
  // Manual recoveries answer on this channel; the automatic watcher announces itself on
  // a different one. Both are collected, otherwise a watcher recovery would be
  // indistinguishable from the dialog having closed for some unrelated reason.
  const watcherRecoveries = [];
  ipcMain.on('stuck-dialog-recovery-result', (_event, result) => { results.push(result); });
  ipcMain.on('stuck-dialog-recovered', (_event, info) => { watcherRecoveries.push(info); });

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

  // 4. The watcher must catch a dialog where only one button was clicked. This is
  //    the case that previously slipped through, because detection required every
  //    button to be stuck.
  await inject(ONE_BUTTON_STUCK);
  report.oneButtonInjected = await win.webContents.executeJavaScript(`(() => {
    const d = document.getElementById('trust-logout-dialog');
    const buttons = [...d.querySelectorAll('.trust-login-dialog-button-cancel, .trust-login-dialog-button-confirm')];
    return {
      present: Boolean(d),
      stuckCount: buttons.filter((b) => getComputedStyle(b).pointerEvents === 'none').length,
      clickableCount: buttons.filter((b) => getComputedStyle(b).pointerEvents !== 'none').length,
    };
  })()`);

  // Wait until the watcher has closed the dialog, and report how long that took.
  // Polling instead of sleeping a fixed amount keeps the timing assertion honest: a
  // fixed sleep passes even when the watcher never fired.
  const waitForDialogGone = async (timeoutMs) => {
    const started = Date.now();
    for (let i = 0; i < Math.ceil(timeoutMs / 100); i++) {
      const gone = await win.webContents.executeJavaScript(
        `!document.getElementById('trust-logout-dialog')`, true);
      if (gone) return Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  // Closing must be near-instant, not "eventually": the whole point of the change is
  // that the user should not be left waiting on a dead page.
  report.oneButtonElapsedMs = await waitForDialogGone(6000);
  report.afterWatcher = await win.webContents.executeJavaScript(`({
    dialog: Boolean(document.getElementById('trust-logout-dialog')),
    mask: Boolean(document.querySelector('.trust-login-dialog-mask')),
  })`);

  // 5. Each shape below is stuck in a way the original detector could not see, and a
  //    detection miss is silent - the dialog simply stays and nothing is logged.
  const cases = [
    ['spinnerOnly', SPINNER_ONLY_STUCK],
    ['ariaDisabled', ARIA_DISABLED_STUCK],
    ['renamedButtons', RENAMED_BUTTON_STUCK],
  ];
  report.detectionCases = {};
  for (const [name, html] of cases) {
    await inject(html);
    const elapsed = await waitForDialogGone(6000);
    report.detectionCases[name] = {
      elapsedMs: elapsed,
      maskGone: await win.webContents.executeJavaScript(
        `!document.querySelector('.trust-login-dialog-mask')`, true),
    };
  }

  report.watcherRecoveries = watcherRecoveries.slice();
  report.consoleErrors = [];
  process.stdout.write(`STUCK_REPORT=${JSON.stringify(report)}\n`);

  server.close();
  app.quit();
});

app.on('window-all-closed', () => {});
