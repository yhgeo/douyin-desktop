'use strict';

/**
 * The document shown while the real site is on its way.
 *
 * The window is created before the page is fetched and its background is near-black - which
 * is also exactly what this app looks like when the site refuses to serve anything. So the
 * one state where the user most needs to be told "this is normal" was indistinguishable from
 * the failure this app has an entire recovery system for, and that system's notices live in
 * the title bar, which nobody reads while staring at a black rectangle.
 *
 * Measured: ~3 s from launch to a ready window, then 4.7-10 s before the page finishes
 * loading. (The portable build adds ~12.7 s *before* the process even starts, which no
 * in-app change can cover - see AGENTS.md.)
 *
 * Two properties make this document safe to use, and both are asserted in the tests rather
 * than left to whoever edits `url-policy.js` or the blank-page predicate next:
 *
 *  1. `web-contents-guard.js` refuses any navigation outside its allow-list, so this app's
 *     own policy would block a `file:` document. `data:` passes.
 *  2. It must not look like a blank page. It has two body children, so the repair watcher
 *     never fires on it.
 *
 * Free of `electron` imports on purpose: `platform/constants.js` calls `app.getPath` at load,
 * so a module that imported it could not be unit tested at all. The logo path is derived here
 * the same way `script-meta.js` avoids the same trap.
 */

const fs = require('node:fs');
const path = require('node:path');
const { APP_NAME } = require('./script-meta');

const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'douyin-logo.png');

/**
 * The logo as a data URI, so the document stays self-contained.
 *
 * @param {string} [filePath] overridable so the fallback is testable
 */
function readLogoDataUri(filePath = LOGO_PATH) {
  try {
    return `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    // A missing logo must not cost the user the message.
    return '';
  }
}

/**
 * @param {{ logoPath?: string }} [options]
 * @returns {string} a `data:` URL for the loading document
 */
function loadingDocument(options = {}) {
  const logo = readLogoDataUri(options.logoPath);
  const image = logo ? `<img src="${logo}" alt="">` : '';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${APP_NAME}</title><style>
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:20px;background:#111214;color:#d8d8d8;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;
  -webkit-user-select:none;cursor:default}
img{width:88px;height:88px;object-fit:contain;opacity:.92}
p{margin:0;letter-spacing:.1em}
</style></head><body>${image}<p>正在加载…</p></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = { LOGO_PATH, loadingDocument, readLogoDataUri };
