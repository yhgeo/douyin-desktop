// Verify the blank-page recovery in the *real* app against the *real* site.
//
// The e2e test proves the logic against a stub origin, but the feature only matters
// if it fires in the shipping app. Reproduce the exact failure without needing a
// corrupted profile: intercept the document request with CDP and fulfil it with an
// empty body - precisely what Douyin does when it refuses to serve the page.
//
// The interception is released after the first fulfilment, so the reload the recovery
// triggers is allowed to reach the real server. If the page then renders, the whole
// chain (detect -> clear site storage -> reload) worked end to end.
//
// Usage: node tools/inspect/simulate-refused-document.js [--port=9229] [--wait=20000]
'use strict';

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '9229'));
const WAIT = Number(arg('wait', '20000'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exactly the shape the server sent to the stuck profile: a document with nothing in
// it - no body content, no scripts.
const EMPTY_DOCUMENT = '<!doctype html><html><head><title>douyin</title></head><body></body></html>';

const STATE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    href: location.href,
    title: document.title,
    bodyChildren: document.body ? document.body.childElementCount : -1,
    scripts: document.scripts.length,
    htmlLength: document.documentElement.outerHTML.length,
    navStatus: nav ? nav.responseStatus : null,
    navDecoded: nav ? nav.decodedBodySize : null,
    readyState: document.readyState,
  };
})()`;

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

  const report = { fulfilled: false, pausedTypes: [], navigations: [] };
  let released = false;

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, resourceType, request } = m.params;
      report.pausedTypes.push(resourceType);
      if (resourceType === 'Document' && !report.fulfilled) {
        report.fulfilled = true;
        report.fulfilledUrl = request.url;
        send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(EMPTY_DOCUMENT, 'utf8').toString('base64'),
        }).catch(() => {});
        return;
      }
      send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
      report.navigations.push(m.params.frame.url.slice(0, 90));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  const readState = async () => {
    const r = await send('Runtime.evaluate', { expression: STATE, returnByValue: true });
    return r.exceptionDetails ? null : (r.result && r.result.value);
  };

  report.before = await readState();

  // Force a navigation so the document request goes through our interception.
  await send('Page.reload', { ignoreCache: true });

  // As soon as the empty document has been served, stop intercepting so the recovery's
  // own reload can reach the real server.
  for (let i = 0; i < 60 && !report.fulfilled; i++) await sleep(100);
  await sleep(300);
  await send('Fetch.disable').catch(() => {});
  released = true;

  report.rightAfterFulfil = await readState();

  // Watch for the page coming back on its own.
  for (let i = 0; i < Math.ceil(WAIT / 500); i++) {
    await sleep(500);
    const state = await readState();
    if (state && state.bodyChildren > 0 && state.scripts > 0) { report.recovered = state; break; }
  }

  report.final = await readState();
  report.released = released;
  process.stdout.write('SIMULATE=' + JSON.stringify(report) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('SIMULATE=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
