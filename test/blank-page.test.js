'use strict';

// Unit coverage for the blank-document detector. The e2e test covers the recovery
// itself against a stub origin; these pin the classification rules, which is where a
// false positive would be destructive (it would clear site data on a healthy load).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  BACKOFF_MS,
  CAPTCHA_RECHECK_MS,
  LADDER,
  SETTLE_MS,
  STORAGES,
  applyLadderStep,
  attachBlankPageRecovery,
  backoffForRound,
  clearAntiCrawlCookies,
  isBlankDocument,
  isCaptchaState,
  withTimeout,
} = require('../app/recovery/blank-page');

test('a document with no content and no scripts counts as blank', () => {
  assert.equal(isBlankDocument({ readyState: 'complete', bodyChildren: 0, scripts: 0 }), true);
});

test('a document that is still loading is never blank', () => {
  // A half-parsed document is momentarily empty; acting on it would clear site data
  // during a perfectly normal load.
  assert.equal(isBlankDocument({ readyState: 'loading', bodyChildren: 0, scripts: 0 }), false);
  assert.equal(isBlankDocument({ readyState: 'interactive', bodyChildren: 0, scripts: 0 }), false);
});

test('any body content means the page rendered', () => {
  assert.equal(isBlankDocument({ readyState: 'complete', bodyChildren: 1, scripts: 0 }), false);
  assert.equal(isBlankDocument({ readyState: 'complete', bodyChildren: 165, scripts: 193 }), false);
});

test("the anti-crawl challenge page is not blank", () => {
  // Measured shape of Douyin's challenge document: an empty-looking body plus one
  // inline script. Treating it as blank would rip the challenge out mid-flight and
  // make the deadlock permanent.
  assert.equal(isBlankDocument({ readyState: 'complete', bodyChildren: 2, scripts: 2 }), false);
});

test('a real page is not blank', () => {
  assert.equal(isBlankDocument({ readyState: 'complete', bodyChildren: 161, scripts: 189 }), false);
});

test('unreadable probe results are not blank', () => {
  assert.equal(isBlankDocument(null), false);
  assert.equal(isBlankDocument(undefined), false);
  assert.equal(isBlankDocument('complete'), false);
  assert.equal(isBlankDocument({}), false);
});

test('cookies are never among the cleared storages', () => {
  // Clearing cookies would log the user out, and cookies were proven not to be the
  // cause: transferring the stuck profile's cookies to a fresh profile did not
  // reproduce the blank page.
  assert.equal(STORAGES.includes('cookies'), false);
  assert.deepEqual(STORAGES, ['serviceworkers', 'cachestorage', 'localstorage', 'indexdb']);
});

// ---------------------------------------------------------------------------
// The escalation ladder.
//
// The first version of the watcher gave up after two repairs, which is why a stuck
// window stayed black until the app was restarted. These pin the replacement.
// ---------------------------------------------------------------------------

function fakeSession({ cookies = [] } = {}) {
  const state = { cleared: [], removed: [], cacheClears: 0 };
  return {
    state,
    clearStorageData: async (options) => { state.cleared.push(options); },
    clearCache: async () => { state.cacheClears += 1; },
    cookies: {
      get: async () => cookies,
      remove: async (url, name) => { state.removed.push(name); },
    },
  };
}

test('only anti-crawl cookies are dropped, never the login', async () => {
  const session = fakeSession({
    cookies: [
      { name: '__ac_signature' },
      { name: '__ac_nonce' },
      { name: '__ac_referer' },
      { name: 'sessionid' },
      { name: 'sid_guard' },
      { name: 'ttwid' },
      { name: 'passport_csrf_token' },
    ],
  });

  const removed = await clearAntiCrawlCookies(session, 'https://www.douyin.com');

  assert.deepEqual(removed.sort(), ['__ac_nonce', '__ac_referer', '__ac_signature']);
  assert.equal(session.state.removed.includes('sessionid'), false);
  assert.equal(session.state.removed.includes('sid_guard'), false);
  assert.equal(session.state.removed.includes('ttwid'), false);
  assert.equal(session.state.removed.includes('passport_csrf_token'), false);
});

test('the ladder starts gentle and escalates one action at a time', async () => {
  const first = fakeSession();
  const one = await applyLadderStep(first, 'https://www.douyin.com', 1);
  assert.deepEqual(one.actions, ['storage']);
  assert.equal(first.state.cleared.length, 1);
  assert.equal(first.state.removed.length, 0);
  assert.equal(first.state.cacheClears, 0);

  const second = fakeSession({ cookies: [{ name: '__ac_signature' }] });
  const two = await applyLadderStep(second, 'https://www.douyin.com', 2);
  assert.deepEqual(two.actions, ['storage', 'anti-crawl-cookies']);
  assert.deepEqual(two.removedCookies, ['__ac_signature']);
  assert.equal(second.state.cacheClears, 0);

  const third = fakeSession({ cookies: [{ name: '__ac_signature' }] });
  const three = await applyLadderStep(third, 'https://www.douyin.com', 3);
  assert.deepEqual(three.actions, ['storage', 'anti-crawl-cookies', 'http-cache']);
  assert.equal(third.state.cacheClears, 1);
});

test('beyond the ladder it repeats the last rung instead of failing', async () => {
  // Never stop: a black window waiting for a human is worse than a repeated attempt.
  const session = fakeSession();
  const four = await applyLadderStep(session, 'https://www.douyin.com', 4);
  assert.deepEqual(four.actions, LADDER[LADDER.length - 1].actions);
  assert.equal(session.state.cacheClears, 1);
});

test('every rung clears storage and none of them clears cookies', () => {
  for (const rung of LADDER) {
    assert.equal(rung.actions.includes('storage'), true);
    for (const options of [rung.actions]) {
      assert.equal(options.includes('cookies'), false);
    }
  }
});

test('retries are immediate first, then spaced out', () => {
  assert.equal(backoffForRound(1), 0);
  assert.equal(backoffForRound(2), 0);
  assert.equal(backoffForRound(3), 0);
  assert.deepEqual(
    BACKOFF_MS.map((_, index) => backoffForRound(LADDER.length + index + 1)),
    BACKOFF_MS,
  );
  // The cap holds however long the server stays unreachable.
  assert.equal(backoffForRound(99), BACKOFF_MS[BACKOFF_MS.length - 1]);
});

// ---------------------------------------------------------------------------
// The watcher itself, driven by a fake page.
//
// The e2e test proves this against a real Electron window; this pins the timing and
// the status reporting, which is what decides whether a user waits for the repair or
// closes the window believing the app has hung.
// ---------------------------------------------------------------------------

const BLANK_STATE = { href: 'https://www.douyin.com/', readyState: 'complete', bodyChildren: 0, scripts: 0, decoded: 0 };
const GOOD_STATE = { href: 'https://www.douyin.com/jingxuan', readyState: 'complete', bodyChildren: 160, scripts: 190, decoded: 900000 };

class FakePage extends EventEmitter {
  constructor(states) {
    super();
    this.states = states;
    this.index = 0;
    this.reloads = 0;
  }

  isDestroyed() { return false; }

  getURL() { return 'https://www.douyin.com/'; }

  async executeJavaScript() {
    return this.states[Math.min(this.index, this.states.length - 1)];
  }

  reloadIgnoringCache() {
    this.reloads += 1;
    this.index += 1;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the settle delay is short enough that a user waits for the repair', () => {
  // Measured against a real user on 2026-09-20: with a 2500 ms settle the log shows
  // round 1 then round 2 two and a half seconds apart, and then nothing - the window
  // was closed while the repair was still climbing. Keep this small.
  assert.ok(SETTLE_MS <= 1000, `settle delay is ${SETTLE_MS} ms, which is long enough to look hung`);
});

test('the watcher escalates rung by rung and reports its progress', async () => {
  const session = fakeSession({ cookies: [{ name: '__ac_signature' }, { name: 'sessionid' }] });
  const page = new FakePage([BLANK_STATE, BLANK_STATE, BLANK_STATE, GOOD_STATE]);
  const statuses = [];
  const recoveries = [];

  attachBlankPageRecovery(page, {
    session,
    settleMs: 0,
    log: () => {},
    onStatus: (status) => statuses.push(status),
    onRecovered: (info) => recoveries.push(info),
  });

  for (let round = 1; round <= 3; round += 1) {
    page.emit('did-finish-load');
    await settle();
  }

  assert.equal(page.reloads, 3, 'one reload per rung');
  assert.deepEqual(recoveries.map((item) => item.round), [1, 2, 3]);
  assert.deepEqual(recoveries[0].actions, ['storage']);
  assert.deepEqual(recoveries[1].actions, ['storage', 'anti-crawl-cookies']);
  assert.deepEqual(recoveries[2].actions, ['storage', 'anti-crawl-cookies', 'http-cache']);
  assert.deepEqual(recoveries[1].removedCookies, ['__ac_signature']);
  assert.equal(session.state.removed.includes('sessionid'), false);

  // The shell needs these to say "正在自动修复（第 N 次）" instead of showing a dead
  // black rectangle, which is what makes a user wait instead of closing the window.
  assert.deepEqual(
    statuses.filter((item) => item.phase === 'repairing').map((item) => item.round),
    [1, 2, 3],
  );

  // A real page ends the episode and clears the notice.
  page.emit('did-finish-load');
  await settle();
  assert.equal(statuses.at(-1).phase, 'healthy');
  assert.equal(page.reloads, 3, 'a healthy page must not be reloaded again');
});

// ---------------------------------------------------------------------------
// A repair that stalls is worse than one that fails.
//
// Found on a real run: `session.cookies.get()` goes through Chromium's network service,
// and when that service crashed the promise never settled - which hung the whole ladder
// mid-round and left the window black with a repair stuck on an await.
// ---------------------------------------------------------------------------

test('withTimeout resolves to the fallback instead of hanging', async () => {
  const never = new Promise(() => {});
  assert.equal(await withTimeout(never, 20, 'fallback'), 'fallback');
  assert.equal(await withTimeout(Promise.resolve('ok'), 50, 'fallback'), 'ok');
});

test('withTimeout releases its guard timer as soon as the race is decided', async () => {
  // The timer has to be *cleared*, not merely left to fire: an armed 30-second timer
  // keeps the event loop alive, which is why the whole unit run used to sit idle until
  // the last one expired.
  //
  // It must not be `unref`'d, though - that was tried, and it let the test runner's loop
  // exit while ten tests were still awaiting their answer. The project rule is "unref
  // anything that only exists to keep watching"; this timer exists to *answer* a caller,
  // so it has to hold the loop open until it does.
  const armedTimers = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

  const before = armedTimers();
  const raced = withTimeout(Promise.resolve('ok'), 60_000, 'fallback');
  assert.equal(armedTimers(), before + 1, 'the guard timer is armed while the race is pending');

  assert.equal(await raced, 'ok');
  assert.equal(armedTimers(), before, 'and cleared once the race is decided');
});

test('a hanging cookie read is skipped, not waited on', async () => {
  const session = {
    cookies: { get: () => new Promise(() => {}), remove: async () => {} },
  };
  const started = Date.now();
  const removed = await clearAntiCrawlCookies(session, 'https://www.douyin.com', 20);
  assert.deepEqual(removed, []);
  assert.ok(Date.now() - started < 1000, 'must not wait for the real timeout');
});

test('a hanging cookie step still lets the rung clear storage and reload', async () => {
  const cleared = [];
  const session = {
    clearStorageData: async (options) => { cleared.push(options); },
    clearCache: async () => {},
    cookies: { get: () => new Promise(() => {}), remove: async () => {} },
  };

  const applied = await applyLadderStep(session, 'https://www.douyin.com', 2);

  assert.deepEqual(applied.actions, ['storage', 'anti-crawl-cookies']);
  assert.deepEqual(applied.removedCookies, []);
  assert.equal(cleared.length, 1, 'storage must still be cleared');
});

test('one failing action does not skip the rest of the rung', async () => {
  const cleared = [];
  const session = {
    clearStorageData: async (options) => { cleared.push(options); },
    clearCache: async () => { throw new Error('cache unavailable'); },
    cookies: { get: async () => [], remove: async () => {} },
  };

  const applied = await applyLadderStep(session, 'https://www.douyin.com', 3);

  assert.deepEqual(applied.actions, ['storage', 'anti-crawl-cookies', 'http-cache']);
  assert.equal(cleared.length, 1, 'the earlier actions still ran');
  assert.equal(applied.stepFailures.length, 1);
  assert.equal(applied.stepFailures[0].action, 'http-cache');
  // `failed` is the watcher's *hard* failure and is a string. Sharing the name made an
  // empty array look like a failure, so every successful repair was logged as one.
  assert.equal('failed' in applied, false);
});

test('a captcha interstitial is reported instead of being repaired', async () => {
  // The third failure shape, found on 2026-09-21: the server answers with a small
  // "验证码中间页" document. It has a body and scripts, so the blank detector never fired
  // and the window stayed unusable with nothing in the log.
  const captchaState = {
    href: 'https://www.douyin.com/',
    readyState: 'complete',
    bodyChildren: 3,
    scripts: 3,
    decoded: 38095,
    title: '验证码中间页',
    captcha: true,
  };
  const session = fakeSession();
  const page = new FakePage([captchaState]);
  const statuses = [];
  const logs = [];

  attachBlankPageRecovery(page, {
    session,
    settleMs: 0,
    log: (level, message, data) => logs.push({ level, message, data }),
    onStatus: (status) => statuses.push(status),
  });

  page.emit('did-finish-load');
  await settle();

  assert.deepEqual(statuses.map((item) => item.phase), ['captcha']);
  assert.equal(logs.filter((item) => item.message === '服务器要求人机验证').length, 1);
  // Clearing site data is the wrong response: nothing on this machine is wrong.
  assert.equal(session.state.cleared.length, 0);
  assert.equal(page.reloads, 0);
});

test('the backoff stops leaning on a server that is not answering', () => {
  // Every retry is another request against a client the server is already unhappy with,
  // and the state only healed after the machine went quiet for five minutes.
  assert.ok(BACKOFF_MS[0] >= 15000, 'first backoff is ' + BACKOFF_MS[0] + ' ms');
  assert.ok(BACKOFF_MS[BACKOFF_MS.length - 1] >= 300000, 'cap is ' + BACKOFF_MS[BACKOFF_MS.length - 1] + ' ms');
});

test('a page that recovers on its own clears the captcha notice', async () => {
  // Reported 2026-09-21: the window kept saying 服务器要求人机验证 long after the page was
  // fine and no captcha had ever been shown. The captcha branch resets `rounds` to 0, and
  // `healthy` was only reported when rounds > 0 - so the notice had nothing to clear it.
  const captchaState = {
    href: 'https://www.douyin.com/',
    readyState: 'complete',
    bodyChildren: 3,
    scripts: 3,
    decoded: 38095,
    title: '验证码中间页',
    captcha: true,
  };
  const page = new FakePage([captchaState, GOOD_STATE]);
  const statuses = [];

  attachBlankPageRecovery(page, {
    session: fakeSession(),
    settleMs: 0,
    log: () => {},
    onStatus: (status) => statuses.push(status),
  });

  page.emit('did-finish-load');
  await settle();
  assert.deepEqual(statuses.map((item) => item.phase), ['captcha']);

  // The page moved on by itself. FakePage only serves the next state once a reload has
  // happened, and a captcha clearing is a navigation rather than a repair - so the index
  // is advanced directly instead of through reloadIgnoringCache().
  page.index = 1;
  page.emit('did-finish-load');
  await settle();

  assert.deepEqual(statuses.map((item) => item.phase), ['captcha', 'healthy']);
});

test('a healthy load never touches the title bar', async () => {
  // The other half of the same rule: clearing must not turn into churn. A normal load
  // reports 'healthy' once and then stays quiet, so the window title is not rewritten
  // on every navigation.
  const page = new FakePage([GOOD_STATE, GOOD_STATE, GOOD_STATE]);
  const statuses = [];

  attachBlankPageRecovery(page, {
    session: fakeSession(),
    settleMs: 0,
    log: () => {},
    onStatus: (status) => statuses.push(status),
  });

  for (let i = 0; i < 3; i += 1) {
    page.emit('did-finish-load');
    await settle();
  }

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].phase, 'healthy');
});

test('the captcha notice is re-checked rather than set and forgotten', async () => {
  // A captcha can clear without a navigation, so the state is polled while it lasts.
  const captchaState = {
    href: 'https://www.douyin.com/',
    readyState: 'complete',
    bodyChildren: 3,
    scripts: 3,
    decoded: 38095,
    title: '验证码中间页',
    captcha: true,
  };
  const page = new FakePage([captchaState]);
  const statuses = [];

  const stop = attachBlankPageRecovery(page, {
    session: fakeSession(),
    settleMs: 0,
    log: () => {},
    onStatus: (status) => statuses.push(status),
  });

  page.emit('did-finish-load');
  await settle();
  assert.equal(statuses.length, 1);

  // Past the re-check interval the state is examined again; still captcha, so the notice
  // is not repeated (the phase did not change).
  await new Promise((resolve) => setTimeout(resolve, CAPTCHA_RECHECK_MS + 200));
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].phase, 'captcha');

  stop();
});

test('a hidden verify-centre frame on a normal page is not a captcha', () => {
  // Measured 2026-09-21 14:33 in the log: 服务器要求人机验证 was reported against a page whose
  // title was 抖音-记录美好生活. Douyin pre-creates a hidden verify-centre iframe on the
  // ordinary page, and merely finding one was treated as proof of a challenge - so the
  // notice appeared on a perfectly usable page, which is what the user reported as
  // "no captcha appeared, but the notice stayed".
  assert.equal(isCaptchaState({ title: '抖音-记录美好生活', captchaFrameVisible: true, bodyChildren: 160 }), false);
  assert.equal(isCaptchaState({ title: '抖音-记录美好生活', captchaFrameVisible: false, bodyChildren: 160 }), false);
  // The interstitial itself: its title is the reliable signal...
  assert.equal(isCaptchaState({ title: '验证码中间页', captchaFrameVisible: false, bodyChildren: 3 }), true);
  // ...and a visible challenge frame on a document with no real content also counts.
  assert.equal(isCaptchaState({ title: '抖音', captchaFrameVisible: true, bodyChildren: 3 }), true);
  assert.equal(isCaptchaState(null), false);
  assert.equal(isCaptchaState(undefined), false);
});
