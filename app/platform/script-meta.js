'use strict';

/**
 * Names shared by the main process *and* the preload.
 *
 * Deliberately free of any `electron` import: the preload runs in the renderer, where
 * `app` does not exist, so it cannot require platform/constants.js. Keeping the names
 * here means the script version reported by `GM_info` and the one written into a
 * configuration backup cannot drift apart.
 */

const APP_NAME = '抖音';
const HOME_URL = 'https://www.douyin.com/';
const SCRIPT_NAME = '抖音优化';
const SCRIPT_VERSION = '2026.9.17.17';

module.exports = { APP_NAME, HOME_URL, SCRIPT_NAME, SCRIPT_VERSION };
