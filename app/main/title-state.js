'use strict';

/**
 * What each window's title bar should say right now.
 *
 * The repair watcher (recovery/blank-page.js) reports progress through `onStatus`, and
 * that notice has to survive the page updating its own title - which a reload does, and
 * a reload is exactly what a repair performs.
 *
 * web-contents-guard.js already intercepts `page-title-updated` to keep the title
 * stable, but it used to write a constant, so the repair notice was wiped by the first
 * title update after it appeared. Measured: set the title to
 * `抖音 — 页面加载异常，正在自动修复（第 1 次）`, emit one `page-title-updated`, and the
 * title was back to `抖音`. Both writers now go through one lookup.
 *
 * Keyed by webContents, and a WeakMap because the key is a live Electron object -
 * entries must not outlive it.
 */

const { titlesFor } = require('./titles');

/** @type {WeakMap<object, { phase: string, round?: number }>} */
const statuses = new WeakMap();

/**
 * Record the repair phase a window is in. `healthy` (or nothing) clears it, so a
 * recovered window stops advertising a repair.
 *
 * @param {object} contents
 * @param {{ phase: string, round?: number }} [status]
 */
function setRepairStatus(contents, status) {
  if (!contents) return;
  if (!status || typeof status.phase !== 'string' || status.phase === 'healthy') {
    statuses.delete(contents);
    return;
  }
  statuses.set(contents, status);
}

/**
 * The title this window should be showing right now.
 *
 * @param {object} [contents]
 * @returns {string}
 */
function titleFor(contents) {
  return titlesFor(contents ? statuses.get(contents) : undefined);
}

module.exports = { setRepairStatus, titleFor };
