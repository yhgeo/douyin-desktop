'use strict';

/**
 * Application settings (`userData/settings.json`).
 *
 * Deliberately separate from the userscript's own configuration: this file holds the
 * shell's own switches (currently just whether the userscript is enabled), so
 * "clear the script configuration" and "clear Douyin's site data" stay independent of
 * each other.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SETTINGS_PATH } = require('../platform/constants');
const log = require('../diagnostics/logger');

const DEFAULTS = { scriptEnabled: true };

function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    // Missing or unreadable: defaults are the right answer, not an error.
    return { ...DEFAULTS };
  }
}

function writeSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (error) {
    log.error('保存应用设置失败', { path: SETTINGS_PATH, error: String((error && error.message) || error) });
    return false;
  }
}

module.exports = { DEFAULTS, SETTINGS_PATH, readSettings, writeSettings };
