'use strict';

/**
 * The userscript's GM_* value store, as a single instance.
 *
 * The values live in the main process rather than in the page's `localStorage`, so
 * clearing Douyin's site data no longer destroys the script configuration, and the
 * remote page cannot read or wipe it.
 *
 * Exported as an instance (not a factory) because exactly one store exists per run and
 * several modules - the menu, the IPC layer, the import/export actions - all operate on
 * that same one. A second instance would be a bug, not a feature.
 */

const { USERSCRIPT_CONFIG_PATH } = require('../platform/constants');
const { GmStore } = require('./gm-store');

const userscriptStore = new GmStore(USERSCRIPT_CONFIG_PATH);

module.exports = { userscriptStore };
