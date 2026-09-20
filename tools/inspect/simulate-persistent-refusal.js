// Prove the blank-page watcher escalates and never gives up, on the real app.
//
// simulate-refused-document.js refuses the document once and then releases, which
// proves a single repair works. This one refuses *every* document for a while, so the
// watcher has to walk its whole ladder and keep retrying - the behaviour that replaced
// the old "give up after two attempts and leave the window black" logic.
//
// Interception is limited to document requests, so the rest of the page is untouched
// and the test does not distort what the app sees.
//
// Usage: node tools/inspect/simulate-persistent-refusal.js [--port=9233] [--hold=45000]
'use strict';

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '9233'));
const HOLD = Number(arg('hold', '45000'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EMPTY_DOCUMENT = '<!doctype html><html><head><title>douyin</title></head><body></body></html>';

const STATE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    href: location.href,
    title: document.title,
    bodyChildren: document.body ? document.body.childElementCount : -1,
    scripts: document.scripts.length,
    navDecoded: nav ? nav.decodedBodySize : null,
    readyState: document.readyState,
  };
})()`;

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  const report = { refusedDocuments: 0, navigations: [] };
  let holding = true;

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      return;
    }
    if (m.method === 'Fetch.requestPaused') {
      const { requestId } = m.params;
      if (holding) {
        report.refusedDocuments += 1;
        send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(EMPTY_DOCUMENT, 'utf8').toString('base64'),
        }).catch(() => {});
      } else {
        send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
      return;
    }
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
      report.navigations.push(m.params.frame.url.slice(0, 80));
    }
  });

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws timeout')), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', (e) => { clearTimeout(t); rej(e); });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', {
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
  });

  const readState = async () => {
    const r = await send('Runtime.evaluate', { expression: STATE, returnByValue: true });
    return r.exceptionDetails ? null : (r.result && r.result.value);
  };

  report.before = await readState();

  // Start the refusal, then reload so the first document request is refused.
  await send('Page.reload', { ignoreCache: true });
  await sleep(HOLD);

  report.duringHold = await readState();
  report.refusedDuringHold = report.refusedDocuments;

  // Release and let the watcher's next attempt reach the real server.
  holding = false;
  await send('Page.reload', { ignoreCache: true });

  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const state = await readState();
    if (state && state.bodyChildren > 0 && state.scripts > 0) { report.recovered = state; break; }
  }

  report.final = await readState();
  await send('Fetch.disable').catch(() => {});
  process.stdout.write('REFUSAL=' + JSON.stringify(report) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('REFUSAL=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
