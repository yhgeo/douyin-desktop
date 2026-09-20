'use strict';

/**
 * Evaluate the bundled userscript, and its dependencies, into the page.
 *
 * The userscript is a Tampermonkey script with `@require` dependencies; those are
 * vendored into `vendor/` and evaluated first, in the same order the `@require` list
 * declares, because the bundle's top-level code reads them as globals.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');
const { whenDocumentElementAvailable } = require('../platform/dom-ready');

/** `@require` order matters: the userscript reads these as globals at load time. */
const VENDOR_BUNDLES = ['domutils.umd.js', 'pops.umd.js', 'utils.umd.js', 'qmsg.umd.js'];
const USERSCRIPT = path.join('assets', 'douyin-optimization.user.js');

/** Repository root - `app/preload/` is two levels down. */
const APP_ROOT = path.join(__dirname, '..', '..');

function evaluateBundled(relativePath) {
  // Indirect eval on purpose: the bundle expects to run as a script in the page's global
  // scope, which is what `contextIsolation: false` gives it.
  return (0, eval)(fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8'));
}

/**
 * @param {{ isTopFrame: boolean }} context
 * @returns {boolean} whether the bundle was scheduled (it runs on documentElement)
 */
function injectUserscript({ isTopFrame }) {
  // The bundle must not be evaluated before the document has a root element:
  // DOMUtils.addStyle dereferences `document.documentElement.childNodes`, which is null
  // during the raw preload phase and would abort the whole userscript.
  whenDocumentElementAvailable(() => {
    try {
      VENDOR_BUNDLES.forEach((file) => evaluateBundled(path.join('vendor', file)));
      evaluateBundled(USERSCRIPT);
      if (isTopFrame) ipcRenderer.send('userscript-loaded', { ok: true });
    } catch (error) {
      console.error('[抖音] 内置脚本加载失败', error);
      ipcRenderer.send('userscript-loaded', { ok: false, message: String(error?.message || error) });
    }
  });
  return true;
}

module.exports = { USERSCRIPT, VENDOR_BUNDLES, injectUserscript };
