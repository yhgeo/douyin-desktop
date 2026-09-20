'use strict';

// Unit coverage for the blank-document detector. The e2e test covers the recovery
// itself against a stub origin; these pin the classification rules, which is where a
// false positive would be destructive (it would clear site data on a healthy load).

const test = require('node:test');
const assert = require('node:assert/strict');

const { STORAGES, isBlankDocument } = require('../app/blank-page-recovery');

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
