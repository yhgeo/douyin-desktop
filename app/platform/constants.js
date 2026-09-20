'use strict';

/**
 * Names the app uses, and where its files live.
 *
 * Every path is derived once, at load. `app.getPath('userData')` is resolved from the
 * package `name` (`douyin-desktop`) and `app.setName('抖音')` runs later, so computing
 * these eagerly is what keeps the dev tree, the portable build and the installed build
 * pointing at the *same* profile. Resolving them lazily would risk a module being loaded
 * after the rename and quietly landing somewhere else.
 *
 * Main process only - the preload must use platform/script-meta.js instead.
 */

const path = require('node:path');
const { app } = require('electron');
const { APP_NAME, HOME_URL, SCRIPT_NAME, SCRIPT_VERSION } = require('./script-meta');

const USER_DATA = app.getPath('userData');
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json');
const USERSCRIPT_CONFIG_PATH = path.join(USER_DATA, 'userscript-config.json');
const LOG_DIR = path.join(USER_DATA, 'logs');
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'douyin-icon.png');

module.exports = {
  APP_NAME,
  HOME_URL,
  ICON_PATH,
  LOG_DIR,
  SCRIPT_NAME,
  SCRIPT_VERSION,
  SETTINGS_PATH,
  USER_DATA,
  USERSCRIPT_CONFIG_PATH,
};
