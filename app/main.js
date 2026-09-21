'use strict';

/**
 * Entry point - a table of contents, nothing more.
 *
 * The behaviour lives in the modules below, so this file should stay short enough to
 * read in one go and tell you where everything else is:
 *
 *   main/lifecycle.js          startup order, single instance, quit behaviour
 *   main/profile-location.js   where this build keeps its data (runs first)
 *   main/window.js             the window, and everything watching the page
 *   main/menu.js               the application menu
 *   main/ipc.js                every channel the page side uses
 *   main/actions.js            the 工具 menu's recovery actions
 *   main/userscript-config.js  import/export of the script's configuration
 *   main/userscript-menu.js    the entries the userscript registers, and its load state
 *
 * Supporting layers:
 *
 *   platform/      Chromium/Electron plumbing - constants, URL policy, window hardening
 *   recovery/      one module per way the page can break
 *   storage/       settings, the userscript value store, the backup format
 *   diagnostics/   the rotating log and the page event capture
 *   preload/       the page-side bridge (GM_* API and userscript injection)
 */

// This has to happen before anything reads `app.getPath('userData')`. platform/constants.js
// resolves every path at load, so requiring the logger first would already have pinned the
// old location - which is why this is the one import that cannot move below.
const { reportNotes, useLocalProfile } = require('./main/profile-location');

const profile = useLocalProfile();

const log = require('./diagnostics/logger');
const { start } = require('./main/lifecycle');

reportNotes(log, profile.notes);

start().catch((error) => {
  log.error('启动失败', { error: String((error && error.stack) || error) });
});
