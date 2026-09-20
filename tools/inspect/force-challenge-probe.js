// Force the anti-crawl challenge by removing the `__ac_*` cookies, then watch what
// the server actually answers.
//
// Why: the challenge document is only served when the client has no valid
// `__ac_signature`, so a normal load never exercises that path. Dropping the cookies
// puts the client in exactly the state the app reaches naturally when the signature
// expires - which is when the black screen appears.
//
// Usage: node tools/inspect/force-challenge-probe.js [--port=9232] [--wait=15000]
'use strict';

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9232').slice(7));
const WAIT = Number((process.argv.find((a) => a.startsWith('--wait=')) || '--wait=15000').slice(7));
const TARGET = (process.argv.find((a) => a.startsWith('--url=')) || '--url=https://www.douyin.com/').slice(6);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || ''));
  if (!page) throw new Error('no douyin page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); });
  });

  ws.addEventListener('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timeout`)); }
    }, 30000);
  });

  return { send, events, close: () => ws.close() };
}

(async () => {
  const out = { target: TARGET };
  let cdp;
  try {
    cdp = await connect();
    const { send, events } = cdp;

    await send('Network.enable');
    await send('Page.enable');
    await send('Runtime.enable');

    // 1. Read the current cookies so we know what the healthy state looks like.
    const before = (await send('Network.getCookies', { urls: [TARGET] })).cookies || [];
    out.cookiesBefore = before.map((c) => c.name).filter((n) => /^__ac/.test(n));

    // 2. Drop every `__ac_*` cookie. Only these: they are the anti-crawl signature,
    //    not the login, so this cannot log anyone out.
    const acNames = before.map((c) => c.name).filter((n) => /^__ac/.test(n));
    for (const name of acNames) {
      await send('Network.deleteCookies', { name, url: TARGET }).catch(() => {});
    }
    out.deleted = acNames;

    // 3. Clear the anti-crawl's localStorage marker too, so the client looks fresh.
    await send('Runtime.evaluate', {
      expression: `(() => { try { localStorage.removeItem('__ac_referer'); return Object.keys(localStorage).length; } catch (e) { return -1; } })()`,
      returnByValue: true,
    });

    // 4. Navigate and record every document response.
    events.length = 0;
    await send('Page.navigate', { url: TARGET });
    await sleep(WAIT);

    const docs = [];
    for (const e of events) {
      if (e.method !== 'Network.responseReceived') continue;
      const r = e.params?.response;
      if (!r || e.params?.type !== 'Document') continue;
      docs.push({
        url: r.url,
        status: r.status,
        mime: r.mimeType,
        fromDiskCache: r.fromDiskCache,
        protocol: r.protocol,
        headers: r.headers,
      });
    }
    out.documentResponses = docs;

    // 5. What state did the window end up in?
    const state = await send('Runtime.evaluate', {
      expression: `(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return {
          href: location.href,
          title: document.title,
          readyState: document.readyState,
          bodyChildren: document.body ? document.body.childElementCount : -1,
          scripts: document.scripts.length,
          decoded: nav ? nav.decodedBodySize : -1,
          acCookies: document.cookie.split('; ').filter((c) => c.startsWith('__ac')).map((c) => c.split('=')[0]),
          bodyHead: document.body ? document.body.innerHTML.slice(0, 160) : '',
        };
      })()`,
      returnByValue: true,
    });
    out.state = state.result?.value;

    const after = (await send('Network.getCookies', { urls: [TARGET] })).cookies || [];
    out.cookiesAfter = after.map((c) => c.name).filter((n) => /^__ac/.test(n));

    cdp.close();
  } catch (error) {
    out.error = String(error?.message || error);
  }
  process.stdout.write('FORCE=' + JSON.stringify(out) + '\n');
  process.exit(0);
})();
