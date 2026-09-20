'use strict';

/**
 * Recover a window that loaded nothing at all.
 *
 * Douyin sometimes answers a document request with an empty body - status 200,
 * zero bytes, no scripts. The window then paints as a black rectangle and stays
 * that way across reloads *and* restarts, because the cause is persisted state
 * rather than anything in memory.
 *
 * Measured on a real stuck profile (2026-09-20), by comparing it against a fresh
 * profile on the same machine at the same moment:
 *
 *   fresh profile  -> 200, text/html, 1.03 MB, 165 body children, 193 scripts
 *   stuck profile  -> 200, 0 bytes,    0 body children,   0 scripts
 *
 * The stuck profile's `localStorage` had been left half-wiped - 2 keys where the
 * site normally keeps ~54, with leftover leveldb `.tmp` files in
 * `Local Storage/leveldb` from a process that was killed mid-write. Douyin's
 * anti-crawl challenge (`_$jsvmprt`, served as `<body></body>` plus one obfuscated
 * inline script) reads that state to compute `__ac_signature`; with it corrupted the
 * signature never matches, so the server refuses the follow-up navigation and the
 * challenge can never run again. A deadlock: refreshing cannot help, and neither can
 * clearing cookies, because cookies are not what is broken.
 *
 * Clearing the site's *non-cookie* storage breaks it. The challenge then runs from
 * scratch and succeeds, and the login survives untouched - verified on the live
 * profile, which came back and stayed back across reloads.
 */

/** Only Douyin's own storage is ever touched. */
const DOUYIN_ORIGIN = 'https://www.douyin.com';

/**
 * Electron's storage names (note `indexdb`, not `indexeddb`).
 *
 * `cookies` is deliberately absent: dropping it would log the user out, and it is
 * not part of the problem.
 */
const STORAGES = ['serviceworkers', 'cachestorage', 'localstorage', 'indexdb'];

/** Let the anti-crawl challenge finish before judging the page. */
const SETTLE_MS = 2500;

/** Give up after this many repairs per window, so a genuine outage cannot loop. */
const MAX_ATTEMPTS = 2;

/** Enough scripts to be sure a real Douyin page rendered, not the challenge page. */
const REAL_PAGE_SCRIPTS = 5;

const PROBE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    href: location.href,
    readyState: document.readyState,
    bodyChildren: document.body ? document.body.childElementCount : -1,
    scripts: document.scripts.length,
    decoded: nav ? nav.decodedBodySize : -1,
  };
})()`;

/**
 * A document that finished loading with nothing in it.
 *
 * Douyin's real page has hundreds of body elements and scripts, and even the
 * anti-crawl challenge page carries its own inline script - so "no body content and
 * no scripts" cannot be a page still in flight. `readyState` is checked as well so a
 * half-parsed document is never mistaken for a refused one.
 */
function isBlankDocument(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.readyState !== 'complete') return false;
  return state.bodyChildren === 0 && state.scripts === 0;
}

/**
 * Watch a window and repair it if Douyin refuses to serve it.
 *
 * @param {Electron.WebContents} contents
 * @param {object} options
 * @param {Electron.Session} options.session session whose storage is cleared
 * @param {string} [options.origin]
 * @param {number} [options.settleMs]
 * @param {number} [options.maxAttempts]
 * @param {(info: object) => void} [options.onRecovered]
 * @returns {() => void} stop watching
 */
function attachBlankPageRecovery(contents, options = {}) {
  const {
    session: targetSession,
    origin = DOUYIN_ORIGIN,
    settleMs = SETTLE_MS,
    maxAttempts = MAX_ATTEMPTS,
    onRecovered = () => {},
  } = options;

  let attempts = 0;
  let timer = null;

  const stop = () => { clearTimeout(timer); timer = null; };

  const inspect = async () => {
    if (contents.isDestroyed()) return null;
    try {
      return await contents.executeJavaScript(PROBE, true);
    } catch (error) {
      // A navigation raced the probe; the next did-finish-load re-checks.
      return null;
    }
  };

  const check = async () => {
    const state = await inspect();
    if (!state) return;

    if (!isBlankDocument(state)) {
      // A real page proves the session recovered, so the budget resets.
      if (state.scripts >= REAL_PAGE_SCRIPTS) attempts = 0;
      return;
    }
    if (!String(state.href || '').startsWith(origin)) return;
    if (attempts >= maxAttempts) return;

    attempts += 1;
    try {
      await targetSession.clearStorageData({ origin, storages: STORAGES });
    } catch (error) {
      onRecovered({ attempt: attempts, failed: String((error && error.message) || error), state });
      return;
    }
    onRecovered({ attempt: attempts, state });
    if (!contents.isDestroyed()) contents.reloadIgnoringCache();
  };

  const onFinish = () => {
    stop();
    timer = setTimeout(() => { check().catch(() => {}); }, settleMs);
  };

  contents.on('did-finish-load', onFinish);
  contents.once('destroyed', stop);

  return () => {
    stop();
    contents.removeListener('did-finish-load', onFinish);
  };
}

/** Clear the storage that breaks Douyin's anti-crawl challenge. Keeps the login. */
async function clearDouyinSiteStorage(targetSession, origin = DOUYIN_ORIGIN) {
  await targetSession.clearStorageData({ origin, storages: STORAGES });
}

module.exports = {
  DOUYIN_ORIGIN,
  MAX_ATTEMPTS,
  PROBE,
  SETTLE_MS,
  STORAGES,
  attachBlankPageRecovery,
  clearDouyinSiteStorage,
  isBlankDocument,
};
