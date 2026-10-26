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
const { installLiveAudience } = require('./live-audience');

/** `@require` order matters: the userscript reads these as globals at load time. */
const VENDOR_BUNDLES = ['domutils.umd.js', 'pops.umd.js', 'utils.umd.js', 'qmsg.umd.js'];
const USERSCRIPT = path.join('assets', 'douyin-optimization.user.js');
const EXPERIENCE_ENHANCER = path.join('assets', 'douyin-experience-enhancer.user.js');

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
  // Top frame only. The bundle registers menu commands, drives the player and rewrites
  // the page's chrome - none of which means anything inside an iframe - and it is four
  // vendor bundles plus a 15k-line script, so evaluating it per frame is pure cost.
  //
  // Today Electron does not run this preload in sub-frames at all (window.js leaves
  // `nodeIntegrationInSubFrames` off), so this guard changes nothing; it is here so that
  // switching that option on cannot quietly turn the bundle into a per-iframe expense.
  if (!isTopFrame) return false;

  // The bundle must not be evaluated before the document has a root element:
  // DOMUtils.addStyle dereferences `document.documentElement.childNodes`, which is null
  // during the raw preload phase and would abort the whole userscript.
  whenDocumentElementAvailable(() => {
    try {
      VENDOR_BUNDLES.forEach((file) => evaluateBundled(path.join('vendor', file)));
      window.__douyinDesktopStartLiveAudience = () => installLiveAudience();
      evaluateBundled(USERSCRIPT);
      if (isTopFrame) ipcRenderer.send('userscript-loaded', { ok: true });
    } catch (error) {
      console.error('[抖音] 内置脚本加载失败', error);
      ipcRenderer.send('userscript-loaded', { ok: false, message: String(error?.message || error) });
    }
  });
  return true;
}

function injectExperienceEnhancer({ isTopFrame, hostname }) {
  // Match the upstream exclusions; unlike the original bundle, this script appends
  // to document.head immediately and must wait until the document is parsed.
  if (!isTopFrame || !/(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(hostname)
      || hostname.toLowerCase() === 'lf-zt.douyin.com') return false;
  const run = () => {
    try {
      evaluateBundled(EXPERIENCE_ENHANCER);
      console.info('[抖音] 网页抖音体验增强 5.7 已加载');
    } catch (error) {
      console.error('[抖音] 网页抖音体验增强加载失败', error);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
  return true;
}

module.exports = { USERSCRIPT, EXPERIENCE_ENHANCER, VENDOR_BUNDLES, injectUserscript, injectExperienceEnhancer };
