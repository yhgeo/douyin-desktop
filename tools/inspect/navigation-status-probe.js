// Confirm the blank window is the server refusing the document, and capture the
// request/response headers so the reason is visible (anti-crawl cookies, a
// redirect to a challenge, a stale signature, ...).
//
// Usage: node tools/inspect/navigation-status-probe.js [--port=9222] [--url=https://www.douyin.com/]
'use strict';

const arg = (k, d) => (process.argv.find((a) => a.startsWith('--' + k + '=')) || `--${k}=${d}`).split('=').slice(1).join('=');
const PORT = Number(arg('port', '9222'));
const URL_ = arg('url', 'https://www.douyin.com/');

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
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws timeout')), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', (e) => { clearTimeout(t); rej(e); });
  });

  const docs = [];
  const reqs = [];
  const others = [];
  let failures = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      const rec = {
        url: r.url,
        status: r.status,
        mime: r.mimeType,
        fromDiskCache: r.fromDiskCache,
        fromServiceWorker: r.fromServiceWorker,
        headers: r.headers,
      };
      if (m.params.type === 'Document') docs.push(rec);
      else others.push({ type: m.params.type, status: r.status, url: r.url.slice(0, 120) });
    } else if (m.method === 'Network.requestWillBeSent') {
      if (m.params.type === 'Document') {
        reqs.push({ url: m.params.request.url, headers: m.params.request.headers });
      }
    } else if (m.method === 'Network.loadingFailed') {
      failures.push({ url: (m.params.documentURL || '').slice(0, 100), err: m.params.errorText, type: m.params.type });
    }
  });

  await send('Network.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });

  await new Promise((r) => setTimeout(r, 9000));

  const evalExpr = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.exceptionDetails ? { __error: r.exceptionDetails.text } : (r.result && r.result.value);
  };
  await send('Runtime.enable');
  const finalState = await evalExpr(`(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      href: location.href,
      title: document.title,
      bodyChildren: document.body ? document.body.childElementCount : -1,
      bodyText: document.body ? (document.body.innerText || '').trim().slice(0, 150) : '',
      scriptCount: document.scripts.length,
      readyState: document.readyState,
      navStatus: nav ? nav.responseStatus : null,
      navDecoded: nav ? nav.decodedBodySize : null,
      resources: performance.getEntriesByType('resource').length,
    };
  })()`);

  process.stdout.write('NAV=' + JSON.stringify({
    requestedUrl: URL_,
    documentResponses: docs,
    documentRequests: reqs,
    otherResponses: others.slice(0, 25),
    loadingFailures: failures.slice(0, 15),
    finalState,
  }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('NAV=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
