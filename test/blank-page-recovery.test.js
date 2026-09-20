'use strict';

// Unit coverage for the blank-document detector. The e2e test covers the recovery
// itself against a stub origin; these pin the classification rules, which is where a
// false positive would be destructive (it would clear site data on a healthy load).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BACKOFF_MS,
  LADDER,
  STORAGES,
  applyLadderStep,
  backoffForRound,
  clearAntiCrawlCookies,
  isBlankDocument,
} = require('../app/blank-page-recovery');

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
