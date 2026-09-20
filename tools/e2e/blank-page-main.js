// End-to-end test for the blank-page recovery.
//
// The real failure: Douyin answers the document request with an empty body, the
// window paints black, and it stays black across reloads and restarts because the
// cause is persisted site state (a half-wiped localStorage left the anti-crawl
// challenge unable to produce an accepted signature).
//
// The stub origin reproduces exactly that: the first navigation gets a genuinely
// empty document, and a real page is only served once the site storage has been
// reset. That makes the assertion meaningful - the page can only come back if the
// recovery really cleared storage.
const { app, BrowserWindow, session } = require('electron');

const harness = require('./harness');
const { attachBlankPageRecovery } = require('../../app/blank-page-recovery');

const PORT = 45996;
const userDataArg = process.argv.find((item) => item.startsWith('--e2e-user-data='));
if (userDataArg) app.setPath('userData', userDataArg.slice('--e2e-user-data='.length));

harness.applyHarnessSwitches(PORT);

// Exactly the shape the server sent to the stuck profile: a document with nothing
// in it. No marker, no scripts.
const EMPTY_DOCUMENT = '<!doctype html><html><head><title>douyin</title></head><body></body></html>';

// A healthy page: enough scripts that the recovery treats it as a real load.
const GOOD_PAGE = `<!doctype html><html><head><title>douyin</title>
<script>window.${harness.STUB_MARKER} = true;</script>
</head><body><div id="app">ok</div>
<script>window.__e2eGoodPage = true;</script>
<script>window.__s = (window.__s || 0) + 1;</script>
<script>window.__s = (window.__s || 0) + 1;</script>
<script>window.__s = (window.__s || 0) + 1;</script>
<script>window.__s = (window.__s || 0) + 1;</script>
</body></html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const report = { documentRequests: 0, recoveries: [], blankShape: null, probeKeySet: false };

  // Refuse the document until the storage has been cleared, then serve the real page.
  let storageWasCleared = false;
  const server = await harness.serveDouyinOrigin(PORT, (_request, response) => {
    report.documentRequests += 1;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(storageWasCleared ? GOOD_PAGE : EMPTY_DOCUMENT);
  });

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });

  // The stub flips to serving a real page once storage is cleared. Observing the
  // clear here is what proves the recovery actually ran.
  const originalClear = session.defaultSession.clearStorageData.bind(session.defaultSession);
  session.defaultSession.clearStorageData = async (options) => {
    const result = await originalClear(options);
    storageWasCleared = true;
    report.clearOptions = options;
    return result;
  };

  // Record the shape of the refused document, and leave a storage breadcrumb that
  // must not survive the recovery.
  win.webContents.on('did-finish-load', async () => {
    if (report.blankShape) return;
    try {
      report.blankShape = await win.webContents.executeJavaScript(`({
        bodyChildren: document.body ? document.body.childElementCount : -1,
        scripts: document.scripts.length,
        readyState: document.readyState,
      })`, true);
      await win.webContents.executeJavaScript(`localStorage.setItem('e2e-probe', '1')`, true);
      report.probeKeySet = await win.webContents.executeJavaScript(`localStorage.getItem('e2e-probe')`, true) === '1';
    } catch (error) {
      report.probeError = String(error.message);
    }
  });

  attachBlankPageRecovery(win.webContents, {
    session: session.defaultSession,
    settleMs: 400,
    onRecovered: (info) => report.recoveries.push({ attempt: info.attempt, failed: info.failed || null }),
  });

  await win.loadURL('http://www.douyin.com/').catch((error) => { report.loadError = String(error.message); });

  // Wait for the repaired page rather than a fixed sleep, so the test is not timing
  // dependent on a slow machine.
  for (let i = 0; i < 60 && !report.goodPage; i++) {
    await sleep(250);
    report.goodPage = await win.webContents
      .executeJavaScript(`Boolean(window.__e2eGoodPage)`, true)
      .catch(() => false);
  }

  report.final = await win.webContents.executeJavaScript(`({
    href: location.href,
    bodyChildren: document.body ? document.body.childElementCount : -1,
    scripts: document.scripts.length,
    isLocalStub: Boolean(window['${harness.STUB_MARKER}']),
    probeKeyAfter: localStorage.getItem('e2e-probe'),
  })`, true).catch((error) => ({ error: String(error.message) }));

  // A healthy page must not be repaired again.
  const requestsAfterRepair = report.documentRequests;
  await sleep(2500);
  report.extraRequestsAfterHealthyLoad = report.documentRequests - requestsAfterRepair;

  process.stdout.write(`BLANK_REPORT=${JSON.stringify(report)}\n`);

  server.close();
  app.quit();
});

app.on('window-all-closed', () => {});
