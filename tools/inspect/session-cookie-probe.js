// The app's window gets an empty document from douyin.com while a fresh profile
// loads the site fine, so the persisted session is the suspect. Dump the cookies
// first (read-only), then optionally drop just the anti-crawl ones and reload -
// that keeps the login intact, unlike clearing everything.
//
// Usage:
//   node tools/inspect/session-cookie-probe.js --port=9222 --list
//   node tools/inspect/session-cookie-probe.js --port=9222 --clear=ac --reload
//   node tools/inspect/session-cookie-probe.js --port=9222 --clear=all --reload
'use strict';

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  if (p) return p.split('=').slice(1).join('=');
  return process.argv.includes(`--${k}`) ? true : d;
};
const PORT = Number(arg('port', '9222'));
const CLEAR = arg('clear', null);
const DO_RELOAD = Boolean(arg('reload', false));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Regenerated automatically by the anti-crawl challenge, so dropping them does not
// log anyone out.
const ANTI_CRAWL = ['__ac_nonce', '__ac_signature', '__ac_referer'];

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

  await send('Network.enable');
  await send('Runtime.enable');
  await send('Page.enable');

  const readCookies = async () => {
    const r = await send('Network.getCookies', { urls: ['https://www.douyin.com/', 'https://www.iesdouyin.com/'] });
    return (r.cookies || []).map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      expiresHuman: c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 19) : 'session',
      expired: c.expires > 0 && c.expires * 1000 < Date.now(),
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      size: (c.value || '').length,
      valueHead: (c.value || '').slice(0, 24),
    }));
  };

  const before = await readCookies();

  const cleared = [];
  if (CLEAR === 'ac' || CLEAR === 'all') {
    for (const c of before) {
      if (CLEAR === 'all' || ANTI_CRAWL.includes(c.name)) {
        await send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
        cleared.push(c.name + '@' + c.domain);
      }
    }
  }

  if (DO_RELOAD) {
    await send('Page.reload', { ignoreCache: true });
    await sleep(16000);
  }

  const after = CLEAR ? await readCookies() : null;

  const state = await (async () => {
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
    return r.result && r.result.value;
  })();

  process.stdout.write('SESSION=' + JSON.stringify({ clearedCount: cleared.length, cleared, before, after, state }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('SESSION=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
