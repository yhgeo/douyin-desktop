'use strict';

// The loading document has to satisfy two other modules' rules, and neither is visible from
// its own source. Both properties were verified by hand against a real Electron window first
// (the document loads, and `isSafeNavigationUrl` accepts it); these assertions are what keep
// them true when someone edits the allow-list or the blank-page predicate.
//
// Why it matters: if the guard starts refusing this document the user is back to a black
// rectangle, and if the repair watcher starts calling it blank the app would clear the user's
// site data on every single launch.

const test = require('node:test');
const assert = require('node:assert/strict');

const { LOGO_PATH, loadingDocument, readLogoDataUri } = require('../app/platform/loading-document');
const { isSafeNavigationUrl } = require('../app/platform/url-policy');
const { isBlankDocument } = require('../app/recovery/blank-page');

/** The document's own markup, for assertions about what the user sees. */
function decode(url) {
  return decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, ''));
}

test('the loading document is a data URL the navigation guard allows', () => {
  assert.match(loadingDocument(), /^data:text\/html;charset=utf-8,/);
  assert.equal(isSafeNavigationUrl(loadingDocument()), true);
});

test('the obvious alternative is refused, which is why it is not used', () => {
  // `loadFile()` would produce a file: URL, and web-contents-guard.js blocks those. Worth
  // pinning: it is the first thing anyone would reach for.
  assert.equal(isSafeNavigationUrl('file:///C:/app/assets/loading.html'), false);
});

test('the repair watcher does not mistake it for a blank page', () => {
  // A false positive here would clear the user's site data on every launch.
  assert.equal(isBlankDocument({ readyState: 'complete', bodyChildren: 2, scripts: 0 }), false);
});

test('it says what is happening', () => {
  const html = decode(loadingDocument());
  assert.match(html, /正在加载/);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>抖音<\/title>/);
});

test('the logo is inlined, because a data: document cannot fetch anything', () => {
  assert.match(readLogoDataUri(), /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);

  const html = decode(loadingDocument());
  assert.ok(html.includes('<img src="data:image/png;base64,'), 'the logo must be inline');
  assert.ok(!/<img src="(?!data:)/.test(html), 'no image may point outside the document');
  assert.ok(!/(href|src)="https?:/.test(html), 'and nothing else may either');
});

test('a missing logo costs the message nothing', () => {
  assert.equal(readLogoDataUri('/definitely/not/here.png'), '');

  const html = decode(loadingDocument({ logoPath: '/definitely/not/here.png' }));
  assert.match(html, /正在加载/, 'the text is the point; the logo is decoration');
  assert.ok(!html.includes('<img'), 'and no broken image is left behind');
});

test('the logo path is the one that ships', () => {
  assert.ok(LOGO_PATH.endsWith('douyin-logo.png'));
  assert.match(readLogoDataUri(), /^data:image\/png;base64,/);
});
