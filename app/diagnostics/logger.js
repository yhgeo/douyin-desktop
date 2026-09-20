'use strict';

/**
 * The app's logger: one rotating file under `userData/logs`.
 *
 * Owned as a singleton because nearly every module needs to write to the same file,
 * and threading a logger through every call site would obscure the actual wiring. The
 * path is resolved in platform/constants.js, once, for the reason documented there.
 */

const { LOG_DIR } = require('../platform/constants');
const { createLogFile } = require('./log-file');

const log = createLogFile({ dir: LOG_DIR });

module.exports = log;
