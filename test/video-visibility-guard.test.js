'use strict';

// The shell-side guard that stops the bundled userscript's CSS from hiding the video.
//
// Worth testing rather than eyeballing because both directions are expensive and neither is
// obvious:
//
//  * too narrow and the bug stays - the user sees a blurred picture in fullscreen, from the
//    third video onwards, and nothing in the log says why;
//  * too broad and the guard starts deleting the site's own rules, which breaks layout in ways
//    that look nothing like a CSS guard.
//
// So the guard is checked against the *real* selectors from the bundle, not against strings
// invented for the test. If upstream adds another selector of this shape, the first test fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ANCESTOR_HIDE,
  installVideoVisibilityGuard,
  isDangerousRule,
  sweepStylesheets,
} = require('../app/preload/video-visibility-guard');

const BUNDLE = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'douyin-optimization.user.js'),
  'utf8',
);

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

test('a hide-rule that matches by descendant inside the feed player is dangerous', () => {
  // The real shape, abbreviated. `:has()` matches any ancestor containing the icon, so the
  // rule can land on the layer that holds the video.
  assert.equal(
    isDangerousRule({ selectorText: '.playerContainer .slider-video > div > div:has(path[d="M17.448 x"])', display: 'none' }),
    true,
  );
});

test('and nothing else is', () => {
  // A rule that hides but does not match by descendant cannot land on an ancestor by accident.
  assert.equal(isDangerousRule({ selectorText: '.playerContainer .slider-video > div > div.xgplayer-shop-anchor', display: 'none' }), false);
  // A descendant match somewhere else on the page is not this bug.
  assert.equal(isDangerousRule({ selectorText: '#douyin-right-container div:has(> svg path[d="x"])', display: 'none' }), false);
  // Same selector, but it does not hide anything.
  assert.equal(isDangerousRule({ selectorText: '.slider-video > div:has(path[d="x"])', display: 'block' }), false);
  assert.equal(isDangerousRule({ selectorText: '.slider-video > div:has(path[d="x"])', display: '' }), false);
  // Degenerate input, because this reads a stylesheet the page could have mangled.
  assert.equal(isDangerousRule({}), false);
  assert.equal(isDangerousRule(null), false);
  assert.equal(isDangerousRule(undefined), false);
  assert.equal(isDangerousRule({ selectorText: '', display: 'none' }), false);
});

test('the pattern is scoped to the feed player on purpose', () => {
  // `.slider-video` is what makes this narrow: it is the structure where the video and the
  // blurred backdrop are siblings. Dropping that requirement would widen the guard to the
  // whole page.
  assert.match('.playerContainer .slider-video > div:has(x)', ANCESTOR_HIDE);
  assert.doesNotMatch('.playerContainer .somewhere-else > div:has(x)', ANCESTOR_HIDE);
});

// ---------------------------------------------------------------------------
// Against the real bundle
// ---------------------------------------------------------------------------

test('the guard covers every selector in the bundle that has this shape', () => {
  // The guard's scope is defined by the dependency, so it is read from the dependency. Two
  // selectors have this shape today - the close-fullscreen button and the search floating bar -
  // and they are exactly the two the user reported as causing the blur.
  const selectors = [...BUNDLE.matchAll(/\.playerContainer \.slider-video[^']*:has\([^']*/g)]
    .map((match) => match[0]);

  assert.equal(selectors.length, 2, `expected 2 selectors of this shape, found ${selectors.length}:\n${selectors.join('\n')}`);
  for (const selector of selectors) {
    assert.equal(
      isDangerousRule({ selectorText: selector, display: 'none' }),
      true,
      `the guard would not act on:\n${selector}`,
    );
  }
  // Both switches are the ones the report names, so the fix lands where the report points.
  assert.ok(selectors.some((s) => s.includes('M17.448')), 'the close-fullscreen selector');
  assert.ok(selectors.some((s) => s.includes('searchbar-button')), 'the search-floating-bar selector');
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** A stand-in for a CSSStyleSheet whose rules can be listed and deleted. */
function fakeSheet(rules) {
  const list = rules.map((r) => ({ selectorText: r.selectorText, style: { display: r.display } }));
  return {
    get cssRules() { return list; },
    deleteRule(index) { list.splice(index, 1); },
    left: () => list.map((r) => r.selectorText),
  };
}

/**
 * A stand-in for the document.
 *
 * `holders` maps a selector to the elements it matches; each element says whether it contains a
 * video and whether it is currently hidden.
 */
function fakeDoc({ sheets, holders }) {
  return {
    styleSheets: sheets,
    querySelectorAll: (selector) => holders[selector] || [],
    defaultView: { getComputedStyle: (element) => ({ display: element.hidden ? 'none' : 'block' }) },
  };
}

const DANGEROUS = '.playerContainer .slider-video > div > div:has(path[d="M17.448"])';

test('a rule that is hiding a video right now is removed, once', () => {
  const sheet = fakeSheet([{ selectorText: DANGEROUS, display: 'none' }]);
  const doc = fakeDoc({ sheets: [sheet], holders: { [DANGEROUS]: [{ querySelector: () => ({}), hidden: true }] } });
  const logged = [];

  const removed = sweepStylesheets({ doc, log: (message, data) => logged.push({ message, data }), dropped: new Set() });

  assert.equal(removed, 1);
  assert.deepEqual(sheet.left(), [], 'the rule is gone, so the site styles the player again');
  assert.equal(logged.length, 1);
  assert.match(logged[0].data.selector, /slider-video/);
});

test('a rule of the same shape that is not hiding a video is left alone', () => {
  // Condition 3 is what keeps the guard honest: it acts on what is happening, not on what
  // could happen. The site is free to hide anything that does not contain the video.
  const sheet = fakeSheet([{ selectorText: DANGEROUS, display: 'none' }]);
  const doc = fakeDoc({ sheets: [sheet], holders: { [DANGEROUS]: [{ querySelector: () => null, hidden: true }] } });

  assert.equal(sweepStylesheets({ doc, log: () => {}, dropped: new Set() }), 0);
  assert.deepEqual(sheet.left(), [DANGEROUS]);
});

test('a video holder that is not hidden is not touched', () => {
  // The selector matches the video layer, but nothing has hidden it - so there is no rule to
  // remove and removing one would be a change nobody asked for.
  const sheet = fakeSheet([{ selectorText: DANGEROUS, display: 'none' }]);
  const doc = fakeDoc({ sheets: [sheet], holders: { [DANGEROUS]: [{ querySelector: () => ({}), hidden: false }] } });

  assert.equal(sweepStylesheets({ doc, log: () => {}, dropped: new Set() }), 0);
  assert.deepEqual(sheet.left(), [DANGEROUS]);
});

test('a stylesheet that refuses to be read is skipped, not fatal', () => {
  // Cross-origin sheets throw on `cssRules`. Reading the page's stylesheets means meeting them.
  const hostile = {
    get cssRules() { throw new Error('SecurityError'); },
    deleteRule() { throw new Error('should not be reached'); },
  };
  const ok = fakeSheet([{ selectorText: DANGEROUS, display: 'none' }]);
  const doc = fakeDoc({ sheets: [hostile, ok], holders: { [DANGEROUS]: [{ querySelector: () => ({}), hidden: true }] } });

  assert.equal(sweepStylesheets({ doc, log: () => {}, dropped: new Set() }), 1);
  assert.deepEqual(ok.left(), []);
});

test('the same selector is reported once, however often the sweep runs', () => {
  // The script re-injects its styles on every URL change, so the sweep runs a lot. A log line
  // per sweep would bury everything else.
  const dropped = new Set();
  const logged = [];
  const build = () => ({
    sheet: fakeSheet([{ selectorText: DANGEROUS, display: 'none' }]),
    doc: null,
  });

  for (let i = 0; i < 3; i += 1) {
    const { sheet } = build();
    const doc = fakeDoc({ sheets: [sheet], holders: { [DANGEROUS]: [{ querySelector: () => ({}), hidden: true }] } });
    sweepStylesheets({ doc, log: (message) => logged.push(message), dropped });
  }

  assert.equal(logged.length, 1);
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

test('installing it returns a detach that stops the observer', () => {
  // The preload is re-run per document, so a guard that cannot be detached would accumulate
  // observers across navigations.
  const listeners = new Map();
  const doc = {
    readyState: 'complete',
    head: { nodeType: 1 },
    documentElement: { nodeType: 1 },
    styleSheets: [],
    querySelectorAll: () => [],
    addEventListener: (type, handler) => listeners.set(type, handler),
    defaultView: { getComputedStyle: () => ({ display: 'block' }) },
  };
  let observed = 0;
  let disconnected = 0;
  const original = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    observe() { observed += 1; }

    disconnect() { disconnected += 1; }
  };

  try {
    const detach = installVideoVisibilityGuard({ doc, log: () => {} });
    assert.equal(observed, 2, 'head and documentElement');
    detach();
    assert.equal(disconnected, 1);
  } finally {
    globalThis.MutationObserver = original;
  }
});
