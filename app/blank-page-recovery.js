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
 *
 * What changed after that fix turned out not to be enough
 * ------------------------------------------------------
 * The first version of this watcher gave up after two repairs per window and reset
 * its budget only when a real page loaded. So if two repairs did not bring the page
 * back, the window stayed black until the app was restarted, silently - no log, no
 * message, nothing to look at. That is what "it went black again and I had to fix it
 * by hand" actually was: not a missing repair, an exhausted one.
 *
 * Now it escalates instead of giving up:
 *
 *   round 1  clear the site's non-cookie storage
 *   round 2  ...and drop the `__ac_*` cookies, so a stale signature cannot be
 *            reused and the server has to hand out a fresh challenge
 *   round 3  ...and clear the HTTP cache
 *   round 4+ repeat round 3 with growing delays (10s, 30s, 60s, then every 2min)
 *
 * It never stops on its own, because the alternative is a black window waiting for
 * a human. The delays exist only so a genuinely unreachable server is not hammered.
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

/**
 * The anti-crawl signature pair. These are not login cookies - they are issued by
 * Douyin's challenge and carry no identity - so removing them costs the user
 * nothing, while a stale one can keep the server convinced the client is broken.
 */
const ANTI_CRAWL_COOKIE_PREFIX = '__ac_';

/** Let the anti-crawl challenge finish before judging the page. */
const SETTLE_MS = 2500;

/** Enough scripts to be sure a real Douyin page rendered, not the challenge page. */
const REAL_PAGE_SCRIPTS = 5;

/** Waits used once the escalation ladder is exhausted, in order. */
const BACKOFF_MS = [10000, 30000, 60000, 120000];

/**
 * The escalation ladder. `round` is 1-based; anything beyond the ladder repeats the
 * last entry, because by then the problem is the server rather than a stale cookie.
 */
const LADDER = [
  { round: 1, actions: ['storage'] },
  { round: 2, actions: ['storage', 'anti-crawl-cookies'] },
  { round: 3, actions: ['storage', 'anti-crawl-cookies', 'http-cache'] },
];

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

/** Clear the storage that breaks Douyin's anti-crawl challenge. Keeps the login. */
async function clearDouyinSiteStorage(targetSession, origin = DOUYIN_ORIGIN) {
  await targetSession.clearStorageData({ origin, storages: STORAGES });
}

/**
 * Drop Douyin's anti-crawl cookies only.
 *
 * Deliberately name-filtered rather than "clear all cookies for the origin": the
 * login cookies live in the same jar, and losing them would be a much worse
 * outcome than a black page.
 *
 * @returns {Promise<string[]>} the cookie names actually removed
 */
async function clearAntiCrawlCookies(targetSession, origin = DOUYIN_ORIGIN) {
  const cookies = await targetSession.cookies.get({ url: origin });
  const doomed = cookies.filter((cookie) => String(cookie.name).startsWith(ANTI_CRAWL_COOKIE_PREFIX));
  const removed = [];
  for (const cookie of doomed) {
    try {
      await targetSession.cookies.remove(origin, cookie.name);
      removed.push(cookie.name);
    } catch {
      // A cookie can disappear between the read and the remove; not worth failing over.
    }
  }
  return removed;
}

/**
 * Apply one rung of the ladder.
 *
 * @returns {Promise<{ actions: string[], removedCookies: string[] }>}
 */
async function applyLadderStep(targetSession, origin, round) {
  const index = Math.min(Math.max(round, 1), LADDER.length) - 1;
  const { actions } = LADDER[index];
  const removedCookies = [];

  for (const action of actions) {
    if (action === 'storage') await clearDouyinSiteStorage(targetSession, origin);
    else if (action === 'anti-crawl-cookies') removedCookies.push(...await clearAntiCrawlCookies(targetSession, origin));
    else if (action === 'http-cache') await targetSession.clearCache();
  }

  return { actions, removedCookies };
}

/** How long to wait before retrying, given the round number. */
function backoffForRound(round) {
  const extra = round - LADDER.length;
  if (extra <= 0) return 0;
  return BACKOFF_MS[Math.min(extra, BACKOFF_MS.length) - 1];
}

/**
 * Watch a window and repair it if Douyin refuses to serve it.
 *
 * @param {Electron.WebContents} contents
 * @param {object} options
 * @param {Electron.Session} options.session session whose storage is cleared
 * @param {string} [options.origin]
 * @param {number} [options.settleMs]
 * @param {number} [options.maxRounds] give up after this many consecutive blanks (default: never)
 * @param {(level: string, message: string, data?: object) => void} [options.log]
 * @param {(info: object) => void} [options.onRecovered]
 * @returns {() => void} stop watching
 */
function attachBlankPageRecovery(contents, options = {}) {
  const {
    session: targetSession,
    origin = DOUYIN_ORIGIN,
    settleMs = SETTLE_MS,
    maxRounds = Infinity,
    log = () => {},
    onRecovered = () => {},
  } = options;

  /** Blank documents seen in a row. Reset by any real page. */
  let rounds = 0;
  let timer = null;
  let stopped = false;

  const stop = () => { clearTimeout(timer); timer = null; };

  const inspect = async () => {
    if (contents.isDestroyed()) return null;
    try {
      return await contents.executeJavaScript(PROBE, true);
    } catch {
      // A navigation raced the probe; the next did-finish-load re-checks.
      return null;
    }
  };

  const repair = async (round) => {
    let applied = { actions: [], removedCookies: [] };
    try {
      applied = await applyLadderStep(targetSession, origin, round);
    } catch (error) {
      log('error', '清除站点数据失败', { round, error: String((error && error.message) || error) });
      onRecovered({ round, failed: String((error && error.message) || error) });
      return;
    }
    onRecovered({ round, ...applied });
    if (!contents.isDestroyed()) contents.reloadIgnoringCache();
  };

  const check = async () => {
    if (stopped || contents.isDestroyed()) return;
    const state = await inspect();
    if (!state) return;

    if (!isBlankDocument(state)) {
      if (rounds > 0) {
        log('info', '页面已恢复', { rounds, scripts: state.scripts, decoded: state.decoded, href: state.href });
      }
      if (state.scripts >= REAL_PAGE_SCRIPTS) rounds = 0;
      return;
    }
    if (!String(state.href || '').startsWith(origin)) return;
    if (rounds >= maxRounds) {
      log('error', '页面仍为空，已达重试上限', { rounds, state });
      return;
    }

    rounds += 1;
    const wait = backoffForRound(rounds);
    log('warn', '页面加载为空，准备修复', { round: rounds, waitMs: wait, state });

    if (wait > 0) {
      stop();
      timer = setTimeout(() => { if (!stopped) repair(rounds).catch(() => {}); }, wait);
      return;
    }
    await repair(rounds);
  };

  const scheduleCheck = (delay = settleMs) => {
    if (stopped) return;
    stop();
    timer = setTimeout(() => { check().catch(() => {}); }, delay);
  };

  const onFinish = () => scheduleCheck();
  const onFail = (event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 is ERR_ABORTED, which every ordinary navigation produces on its way out.
    if (errorCode === -3) return;
    log('warn', '导航失败，稍后检查页面状态', { url: validatedUrl, errorCode, errorDescription });
    scheduleCheck();
  };

  contents.on('did-finish-load', onFinish);
  contents.on('did-fail-load', onFail);
  contents.once('destroyed', () => { stopped = true; stop(); });

  return () => {
    stopped = true;
    stop();
    contents.removeListener('did-finish-load', onFinish);
    contents.removeListener('did-fail-load', onFail);
  };
}

module.exports = {
  ANTI_CRAWL_COOKIE_PREFIX,
  BACKOFF_MS,
  DOUYIN_ORIGIN,
  LADDER,
  PROBE,
  SETTLE_MS,
  STORAGES,
  applyLadderStep,
  attachBlankPageRecovery,
  backoffForRound,
  clearAntiCrawlCookies,
  clearDouyinSiteStorage,
  isBlankDocument,
};
