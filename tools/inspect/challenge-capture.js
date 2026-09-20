// Catch the anti-crawl challenge failing, from the very start.
//
// A plain Electron window passes douyin.com's `_$jsvmprt` challenge and lands on the
// real page; the app's window gets the challenge and stays blank. The challenge runs
// before any DevTools attaches, so its error is never seen - enable Runtime/Log/
// Network first, then navigate, and record everything the challenge does.
//
// Usage: node tools/inspect/challenge-capture.js [--port=9222] [--url=https://www.douyin.com/]
'use strict';

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '9222'));
const URL_ = arg('url', 'https://www.douyin.com/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (!m.id) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws timeout')), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', (e) => { clearTimeout(t); rej(e); });
  });

  const exceptions = [];
  const consoles = [];
  const netFailures = [];
  const xhrs = [];
  const navs = [];

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (!m.method) return;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push({
        text: d.text,
        desc: ((d.exception && (d.exception.description || d.exception.value)) || '').slice(0, 500),
        url: (d.url || '').split('/').pop(),
        line: d.lineNumber,
        frames: ((d.stackTrace && d.stackTrace.callFrames) || []).slice(0, 4)
          .map((f) => `${f.functionName || '(anon)'}@${(f.url || '').split('/').pop()}:${f.lineNumber}`),
      });
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ').slice(0, 300);
      if (!/Electron Security Warning/.test(text)) consoles.push({ type: m.params.type, text });
    } else if (m.method === 'Log.entryAdded') {
      const en = m.params.entry || {};
      if (en.level === 'error' && !/Electron Security Warning/.test(en.text || '')) {
        consoles.push({ type: 'log.' + en.level, text: (en.text || '').slice(0, 300) });
      }
    } else if (m.method === 'Network.loadingFailed') {
      netFailures.push({ type: m.params.type, err: m.params.errorText, canceled: m.params.canceled, url: (m.params.documentURL || '').slice(0, 80) });
    } else if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (m.params.type === 'XHR' || m.params.type === 'Fetch') xhrs.push({ phase: 'sent', type: m.params.type, url: r.url.slice(0, 120), method: r.method });
    } else if (m.method === 'Network.responseReceived') {
      if (m.params.type === 'XHR' || m.params.type === 'Fetch') {
        xhrs.push({ phase: 'resp', type: m.params.type, status: m.params.response.status, url: m.params.response.url.slice(0, 120) });
      }
    } else if (m.method === 'Page.frameNavigated') {
      if (!m.params.frame.parentId) navs.push(m.params.frame.url.slice(0, 120));
    }
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');

  await send('Page.navigate', { url: URL_ });
  await sleep(16000);

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        href: location.href, title: document.title,
        bodyChildren: document.body ? document.body.childElementCount : -1,
        scriptCount: document.scripts.length,
        resources: performance.getEntriesByType('resource').length,
        navStatus: nav ? nav.responseStatus : null,
        navDecoded: nav ? nav.decodedBodySize : null,
        acCookies: document.cookie.split('; ').filter((c) => /__ac/i.test(c)).map((c) => c.split('=')[0]),
      };
    })()`,
    returnByValue: true,
  });

  process.stdout.write('CHALLENGE=' + JSON.stringify({
    exceptions: exceptions.slice(0, 15),
    consoles: consoles.slice(0, 25),
    netFailures: netFailures.slice(0, 12),
    xhrs: xhrs.slice(0, 20),
    navigations: navs.slice(0, 8),
    finalState: r.result && r.result.value,
  }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('CHALLENGE=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
