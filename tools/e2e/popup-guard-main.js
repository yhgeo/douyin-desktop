// End-to-end test for the navigation/popup policy.
//
// Loads a page on a real `www.douyin.com` origin, applies the production
// `hardenWebContents` guard, then fires every route a page can use to push a
// custom scheme (bytedance://, snssdk1128://) or a ByteDance popup at the app.
//
// It also passively records which Chromium navigation events fire, which is how
// we document *why* the old guard leaked: `will-navigate` is main-frame only, so
// a subframe could still send a custom scheme to Windows. No custom scheme is
// ever actually handed to the OS here - the guard blocks them first - so running
// this test can never pop the Windows "需要新应用以打开此链接" dialog.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const harness = require('./harness');
const { hardenWebContents } = require('../../app/web-contents-guard');

const PORT = 45996;

harness.applyHarnessSwitches(PORT);

const PAGE = `<!doctype html><html><head><title>douyin</title>
<script>window.${harness.STUB_MARKER} = true;</script>
</head><body>
<div id="app"></div><iframe id="child" src="about:blank"></iframe>
<a id="blank-target" href="bytedance://open?url=blank-target" target="_blank">x</a>
<a id="same-frame" href="bytedance://open?url=same-frame">y</a>
</body></html>`;

// Every URL the app tried to hand to the operating system.
const openExternalCalls = [];
// Every request the guard refused, with the reason.
const blocked = [];
// Passive event telemetry (which navigation events Chromium actually emits).
const navigationEvents = [];
let windowCount = 0;

app.on('browser-window-created', () => { windowCount += 1; });

app.whenReady().then(async () => {
  const server = await harness.serveDouyinPage(PORT, PAGE);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  hardenWebContents(win.webContents, {
    openExternal: (url) => openExternalCalls.push(url),
    onBlocked: (info) => blocked.push(info),
    title: '抖音',
  });

  // Passive observers, registered after the guard so they see what it sees.
  win.webContents.on('will-frame-navigate', (details) => {
    navigationEvents.push({ event: 'will-frame-navigate', url: details.url, isMainFrame: details.isMainFrame });
  });
  win.webContents.on('will-navigate', (details) => {
    navigationEvents.push({ event: 'will-navigate', url: details.url });
  });

  await win.loadURL('http://www.douyin.com/');

  const vectors = await win.webContents.executeJavaScript(`(async () => {
    const results = {};
    results.__diag = {
      href: location.href,
      isLocalStub: Boolean(window['${harness.STUB_MARKER}']),
      title: document.title,
      ids: [...document.querySelectorAll('[id]')].map((el) => el.id),
    };
    const child = document.getElementById('child');
    if (!child) return results;

    results.popupBytedance = String(window.open('bytedance://open?url=popup-bytedance'));
    results.popupSnssdk = String(window.open('snssdk1128://user/profile?uid=1'));
    results.popupToutiao = String(window.open('https://www.toutiao.com/article/1'));
    results.popupDouyin = String(window.open('https://www.douyin.com/video/1'));
    results.popupExternal = String(window.open('https://example.com/page'));

    // <a target="_blank"> with a custom scheme.
    document.getElementById('blank-target').click();

    // Subframe navigation - the case the old guard missed.
    child.contentWindow.location.href = 'bytedance://open?url=iframe-navigate';

    // Subframe link click.
    const childAnchor = child.contentDocument.createElement('a');
    childAnchor.href = 'snssdk1128://user/profile?uid=2';
    child.contentDocument.body.appendChild(childAnchor);
    childAnchor.click();

    await new Promise((resolve) => setTimeout(resolve, 400));

    results.iframeLocation = child.contentWindow.location.href;
    results.topLocation = location.href;

    // Same-frame link click, checked last because it would navigate away.
    document.getElementById('same-frame').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    results.topLocationAfterClick = location.href;

    return results;
  })()`);

  process.stdout.write(`POPUP_VECTORS=${JSON.stringify(vectors)}\n`);
  process.stdout.write(`POPUP_OPEN_EXTERNAL=${JSON.stringify(openExternalCalls)}\n`);
  process.stdout.write(`POPUP_BLOCKED=${JSON.stringify(blocked)}\n`);
  process.stdout.write(`POPUP_NAV_EVENTS=${JSON.stringify(navigationEvents)}\n`);
  process.stdout.write(`POPUP_WINDOW_COUNT=${windowCount}\n`);

  server.close();
  app.quit();
});

app.on('window-all-closed', () => {});
