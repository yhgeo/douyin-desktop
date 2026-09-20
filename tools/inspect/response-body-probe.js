// Ground truth: what bytes does douyin.com actually send for the document?
//
// The window is blank, the DOM never changes, and the document response alternates
// between `application/json` (empty) and `text/html`. Capture the real body for
// both the app's own User-Agent and an overridden plain-Chrome one, so the cause
// is not inferred from mime types alone.
//
// Usage: node tools/inspect/response-body-probe.js [--port=9222]
'use strict';

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
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
  // Resolve send() promises. Without this every command hangs forever.
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
  return { ws, send };
}

/** Navigate once and return what the server sent for the document. */
async function capture(send, ws, ua, label) {
  let docReq = null;
  let finished = false;
  let response = null;
  const subresources = [];
  const failures = [];

  const onMessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Network.responseReceived') {
      if (m.params.type === 'Document' && m.params.frameId) {
        docReq = m.params.requestId;
        response = { status: m.params.response.status, mime: m.params.response.mimeType, headers: m.params.response.headers };
      } else {
        subresources.push({ type: m.params.type, status: m.params.response.status, url: m.params.response.url.slice(0, 80) });
      }
    }
    if (m.method === 'Network.loadingFinished' && m.params.requestId === docReq) finished = true;
    if (m.method === 'Network.loadingFailed') failures.push({ type: m.params.type, err: m.params.errorText, canceled: m.params.canceled });
  };
  ws.addEventListener('message', onMessage);

  if (ua) await send('Network.setUserAgentOverride', { userAgent: ua });
  else await send('Network.setUserAgentOverride', { userAgent: '' }).catch(() => {});

  docReq = null; finished = false; response = null;
  await send('Page.navigate', { url: 'https://www.douyin.com/' });

  for (let i = 0; i < 40 && !(docReq && finished); i++) await sleep(250);

  let body = null;
  let bodyError = null;
  if (docReq) {
    try {
      const r = await send('Network.getResponseBody', { requestId: docReq });
      body = { length: (r.body || '').length, base64: r.base64Encoded, head: (r.body || '').slice(0, 400) };
    } catch (err) {
      bodyError = String((err && err.message) || err);
    }
  }
  await sleep(2500);
  const state = await (async () => {
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return { title: document.title, bodyChildren: document.body ? document.body.childElementCount : -1,
          scriptCount: document.scripts.length, htmlLength: document.documentElement.outerHTML.length,
          resources: performance.getEntriesByType('resource').length,
          navDecoded: nav ? nav.decodedBodySize : null };
      })()`,
      returnByValue: true,
    });
    return r.result && r.result.value;
  })();

  ws.removeEventListener('message', onMessage);
  return { label, ua: ua || '(app default)', gotResponse: Boolean(docReq), response, body, bodyError, subresourceCount: subresources.length, subresources: subresources.slice(0, 8), failures: failures.slice(0, 8), state };
}

(async () => {
  const { ws, send } = await connect();
  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');

  const withChromeUa = await capture(send, ws, CHROME_UA, 'chrome-ua');
  const withAppUa = await capture(send, ws, null, 'app-ua');

  process.stdout.write('BODY=' + JSON.stringify({ withChromeUa, withAppUa }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('BODY=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
