'use strict';

// The one script setting that is known to break this app.
//
// This is worth unit tests rather than a comment because getting it wrong is invisible in both
// directions: failing to notice the flag leaves the user with a black window that looks exactly
// like a server outage, and mangling the rest of the configuration while turning it off loses
// every other panel setting the user has.
//
// How it was pinned down: a profile that returned an empty document on every launch loaded
// normally as soon as this one flag was turned off - same machine, same build, same profile.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANTI_CRAWL_COOKIE_REMOVAL,
  PANEL_KEY,
  isAntiCrawlCookieRemovalOn,
  withoutAntiCrawlCookieRemoval,
} = require('../app/storage/harmful-settings');

/** A store shaped like the real one: one panel object holding every switch. */
function storeWithFlag(value) {
  return {
    [PANEL_KEY]: {
      'shieldSearch': false,
      [ANTI_CRAWL_COOKIE_REMOVAL]: value,
      'live-pauseVideo': true,
    },
  };
}

test('the flag is detected when it is on', () => {
  assert.equal(isAntiCrawlCookieRemovalOn(storeWithFlag(true)), true);
});

test('and not when it is off, absent, or the store is a shape we do not recognise', () => {
  assert.equal(isAntiCrawlCookieRemovalOn(storeWithFlag(false)), false);
  assert.equal(isAntiCrawlCookieRemovalOn({}), false);
  assert.equal(isAntiCrawlCookieRemovalOn({ [PANEL_KEY]: {} }), false);
  // Values come from a JSON file the user can edit, so nothing about the shape is guaranteed.
  assert.equal(isAntiCrawlCookieRemovalOn(null), false);
  assert.equal(isAntiCrawlCookieRemovalOn(undefined), false);
  assert.equal(isAntiCrawlCookieRemovalOn({ [PANEL_KEY]: 'not an object' }), false);
  assert.equal(isAntiCrawlCookieRemovalOn({ [PANEL_KEY]: null }), false);
});

test('turning it off leaves every other setting alone', () => {
  // The expensive mistake here would be clearing the panel while fixing one switch in it.
  const before = storeWithFlag(true);
  const after = withoutAntiCrawlCookieRemoval(before);

  assert.equal(after[PANEL_KEY][ANTI_CRAWL_COOKIE_REMOVAL], false);
  assert.equal(after[PANEL_KEY].shieldSearch, false, 'false stays false');
  assert.equal(after[PANEL_KEY]['live-pauseVideo'], true, 'true stays true');
  assert.deepEqual(Object.keys(after[PANEL_KEY]).sort(), Object.keys(before[PANEL_KEY]).sort());
});

test('it does not modify the object it was given', () => {
  // The caller decides whether to persist; a function that edits in place would write to the
  // store as a side effect of merely asking a question about it.
  const before = storeWithFlag(true);
  withoutAntiCrawlCookieRemoval(before);
  assert.equal(before[PANEL_KEY][ANTI_CRAWL_COOKIE_REMOVAL], true);
});

test('other top-level values survive too', () => {
  const values = { ...storeWithFlag(true), someOtherKey: { nested: 1 } };
  const after = withoutAntiCrawlCookieRemoval(values);
  assert.deepEqual(after.someOtherKey, { nested: 1 });
});

test('it copes with a store that has no panel at all', () => {
  // A first run, or a config file that was hand-edited down to nothing.
  const after = withoutAntiCrawlCookieRemoval({});
  assert.equal(after[PANEL_KEY][ANTI_CRAWL_COOKIE_REMOVAL], false);
  assert.equal(isAntiCrawlCookieRemovalOn(after), false);
});

test('the names match what the userscript actually uses', () => {
  // These strings are the interface with a bundle we do not control. If upstream renames the
  // switch, this check should be the thing that fails - silently looking for the wrong key
  // means the warning never fires and the bug comes back.
  assert.equal(PANEL_KEY, 'GM_Panel');
  assert.equal(ANTI_CRAWL_COOKIE_REMOVAL, 'dy-cookie-remove__ac__');

  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'assets', 'douyin-optimization.user.js'),
    'utf8',
  );
  assert.ok(
    source.includes(`"${ANTI_CRAWL_COOKIE_REMOVAL}"`),
    'the bundled userscript no longer mentions this switch',
  );
  assert.ok(source.includes('"__ac_signature"'), 'and it no longer deletes the signature cookie');
});
