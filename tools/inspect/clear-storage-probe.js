// Bisect the live profile's bad state, least destructive first.
//
// Cookies are ruled out (transferring them to a fresh profile does not reproduce the
// black screen). What remains is the rest of the persisted site state - a stale
// service worker or cache entry can serve an empty document for a navigation.
//
// Clears one storage type at a time, reloads, and reports whether the page came back,
// so the guilty type is identified instead of nuking everything.
//
// Usage:
//   node tools/inspect/clear-storage-probe.js --port=9222 --types=service_workers,cache_storage --reload
//   node tools/inspect/clear-storage-probe.js --port=9222 --types=cookies --reload
'use strict';

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '9222'));
const TYPES = arg('types', 'service_workers,cache_storage');
const ORIGIN = arg('origin', 'https://www.douyin.com');
const DO_RELOAD = process.argv.includes('--reload');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Storage.enable').catch(() => {});
  await send('Network.enable');

  const readState = async () => {
    const r = await send('Runtime.evaluate', { expression: STATE, returnByValue: true });
    return r.result && r.result.value;
  };

  // What is actually stored for this origin, before we touch anything.
  const sw = await send('Runtime.evaluate', {
    expression: `(async () => {
      const out = { controller: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller), scopes: [], caches: [] };
      try { out.scopes = (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope); } catch (e) { out.swErr = String(e.message); }
      try { out.caches = await caches.keys(); } catch (e) { out.cacheErr = String(e.message); }
      try { out.idb = (await indexedDB.databases()).map((d) => d.name); } catch (e) { out.idbErr = String(e.message); }
      try { out.localStorageKeys = Object.keys(localStorage).length; } catch (e) { out.lsErr = String(e.message); }
      return out;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  const before = await readState();
  const DRY = process.argv.includes('--dry') || !process.argv.includes('--clear');
  if (!DRY) await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: TYPES });

  let after = null;
  if (DO_RELOAD) {
    await send('Page.reload', { ignoreCache: true });
    await sleep(16000);
    after = await readState();
  }

  process.stdout.write('CLEAR=' + JSON.stringify({
    dry: DRY,
    types: TYPES,
    origin: ORIGIN,
    storedBefore: sw.result && sw.result.value,
    before,
    after,
  }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('CLEAR=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
