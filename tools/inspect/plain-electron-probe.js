// Isolate the black screen: open douyin.com in a *plain* Electron window with no
// preload, no userscript and a clean profile, and report what actually renders.
//
// The app's window gets a 72,914-byte response whose body is ByteDance's anti-crawl
// JS-VM challenge (`_$jsvmprt`) and never resolves. Two candidates: the server is
// challenging this machine, or our shell interferes with the challenge. This probe
// removes the shell from the equation.
//
// Usage: electron.exe tools/inspect/plain-electron-probe.js [--ua=chrome|default]
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const MODE = arg('ua', 'chrome');
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const TARGET = arg('url', 'https://www.douyin.com/');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), `dy-plain-${MODE}-${Date.now()}`));
if (MODE === 'chrome') app.userAgentFallback = CHROME_UA;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  const logs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    const text = String(message);
    if (/error|fail|blocked|refused/i.test(text)) logs.push(`console(${level}): ${text.slice(0, 200)}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logs.push(`did-fail-load: ${code} ${desc} ${String(url).slice(0, 80)}`));
  win.webContents.on('did-navigate', (_e, url, httpCode) => logs.push(`did-navigate: ${httpCode} ${String(url).slice(0, 80)}`));

  let loadError = null;
  try {
    await win.loadURL(TARGET);
  } catch (e) {
    loadError = String((e && e.message) || e);
  }
  await sleep(15000);

  const readState = () => win.webContents.executeJavaScript(`(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const html = document.documentElement.outerHTML;
    return {
      href: location.href,
      title: document.title,
      bodyChildren: document.body ? document.body.childElementCount : -1,
      bodyText: document.body ? (document.body.innerText || '').trim().slice(0, 150) : '',
      scriptCount: document.scripts.length,
      scriptSrcs: [...document.scripts].map((s) => (s.src || '(inline)').slice(0, 80)).slice(0, 10),
      resourceCount: performance.getEntriesByType('resource').length,
      htmlLength: html.length,
      navStatus: nav ? nav.responseStatus : null,
      navDecoded: nav ? nav.decodedBodySize : null,
      ua: navigator.userAgent,
      acCookies: document.cookie.split('; ').filter((c) => /__ac|ttwid|sessionid|passport/i.test(c)).map((c) => c.split('=')[0]),
      challengeInDom: /_\\$jsvmprt/.test(html),
    };
  })()`);

  const state = await readState().catch((e) => ({ error: String(e.message) }));

  // Ask the server for the page again over the same session, to see whether it is
  // still handing out the challenge - independent of what the DOM ended up as.
  const refetch = await win.webContents.executeJavaScript(`(async () => {
    try {
      const r = await fetch(location.href, { credentials: 'include' });
      const text = await r.text();
      return {
        status: r.status,
        contentType: r.headers.get('content-type'),
        length: text.length,
        isChallenge: /_\\$jsvmprt/.test(text),
        head: text.slice(0, 200),
      };
    } catch (e) { return { error: String(e.message) }; }
  })()`).catch((e) => ({ error: String(e.message) }));

  process.stdout.write('PLAIN=' + JSON.stringify({ mode: MODE, target: TARGET, loadError, state, refetch, logs: logs.slice(0, 15) }) + '\n');
  app.exit(0);
}).catch((e) => {
  process.stdout.write('PLAIN=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  app.exit(0);
});
