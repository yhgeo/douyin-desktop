// Prove the black screen is the persisted session, without touching the live profile.
//
// A fresh profile loads douyin.com; the live profile gets an empty document. Transfer
// the live profile's cookies into a throwaway instance:
//   A) inject them, reload  -> if the page goes blank, the cookie jar is the cause
//   B) drop them, reload    -> if the page comes back, clearing them is the fix
//
// Usage: node tools/inspect/cookie-transfer-probe.js --from=9222 --to=9226
'use strict';

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const FROM = Number(arg('from', '9222'));
const TO = Number(arg('to', '9226'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
    const t = setTimeout(() => rej(new Error(`ws timeout :${port}`)), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); });
    ws.addEventListener('error', (e) => { clearTimeout(t); rej(e); });
  });
  await send('Network.enable');
  await send('Page.enable');
  await send('Runtime.enable');
  return { ws, send };
}

const STATE = `(() => {
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
})()`;

const readState = async (send) => {
  const r = await send('Runtime.evaluate', { expression: STATE, returnByValue: true });
  return r.result && r.result.value;
};

(async () => {
  const live = await attach(FROM);
  const cookies = (await live.send('Network.getCookies', { urls: ['https://www.douyin.com/', 'https://www.iesdouyin.com/'] })).cookies || [];
  const liveState = await readState(live.send);
  live.ws.close();

  const probe = await attach(TO);
  const before = await readState(probe.send);

  // A) inject the live profile's cookies
  let injected = 0;
  for (const c of cookies) {
    try {
      await probe.send('Network.setCookie', {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(c.expires > 0 ? { expires: c.expires } : {}),
        ...(c.sameSite && c.sameSite !== 'unspecified' ? { sameSite: c.sameSite } : {}),
      });
      injected++;
    } catch (e) { /* some cookies refuse to be set; count what landed */ }
  }
  const injectedNow = ((await probe.send('Network.getCookies', { urls: ['https://www.douyin.com/'] })).cookies || []).length;

  // The live profile's defining trait is a logged-in session with no anti-crawl
  // signature at all. Reproduce exactly that: keep the injected login cookies, but
  // drop the signature the probe instance obtained on its own.
  let droppedAc = 0;
  if (process.argv.includes('--drop-ac')) {
    const ac = (await probe.send('Network.getCookies', { urls: ['https://www.douyin.com/'] })).cookies || [];
    for (const c of ac) {
      if (/^__ac_/.test(c.name)) {
        await probe.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
        droppedAc++;
      }
    }
  }

  await probe.send('Page.reload', { ignoreCache: true });
  await sleep(16000);
  const afterInject = await readState(probe.send);

  // B) drop every douyin cookie and reload again
  const toDrop = (await probe.send('Network.getCookies', { urls: ['https://www.douyin.com/', 'https://www.iesdouyin.com/'] })).cookies || [];
  let dropped = 0;
  for (const c of toDrop) {
    try {
      await probe.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
      dropped++;
    } catch (e) { /* ignore */ }
  }
  await probe.send('Page.reload', { ignoreCache: true });
  await sleep(16000);
  const afterClear = await readState(probe.send);

  process.stdout.write('TRANSFER=' + JSON.stringify({
    liveCookieCount: cookies.length,
    liveState,
    probeBefore: before,
    injectedRequested: injected,
    injectedPresent: injectedNow,
    droppedAc,
    afterInject,
    dropped,
    afterClear,
  }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('TRANSFER=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
