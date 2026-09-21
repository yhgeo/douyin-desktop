'use strict';

/**
 * The userscript's menu commands, its load state, and when the app menu needs rebuilding.
 *
 * This lives apart from the menu template itself to keep the dependency graph acyclic:
 * importing a config file has to clear these commands and ask for a rebuild, while the
 * menu template has to read them. Keeping the state here means neither module has to
 * know about the other.
 *
 * `buildMenu` is injected by menu.js rather than imported, for the same reason.
 */

const log = require('../diagnostics/logger');

/** Rebuild at most this often; the userscript registers commands in bursts on load. */
const REBUILD_DEBOUNCE_MS = 30;

/** id -> { id, name } */
const commands = new Map();
let loadState = null;
let buildMenu = null;
let rebuildTimer = null;

/** menu.js hands its template builder over at load time. */
function setMenuBuilder(builder) {
  buildMenu = builder;
}

function scheduleMenuRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    try {
      buildMenu?.();
    } catch (error) {
      log.error('重建菜单失败', { error: String((error && error.message) || error) });
    }
  }, REBUILD_DEBOUNCE_MS);
  // Same rule as every other timer the app arms: a pending one must not be the reason
  // the process stays alive.
  if (rebuildTimer.unref) rebuildTimer.unref();
}

function registerCommand(command) {
  if (!command?.id || !command?.name) return;
  commands.set(command.id, { id: command.id, name: String(command.name) });
  scheduleMenuRebuild();
}

function unregisterCommand(id) {
  commands.delete(id);
  scheduleMenuRebuild();
}

function clearCommands() {
  commands.clear();
}

function listCommands() {
  return [...commands.values()];
}

/** Find a command by name, e.g. the settings entry the script registers. */
function findCommand(namePattern) {
  return listCommands().find((item) => namePattern.test(item.name));
}

/**
 * Record whether the bundled userscript injected successfully.
 *
 * Surfaced in the menu rather than only in the console, because a failed injection looks
 * to the user like "the settings do nothing".
 */
function setLoadState(state) {
  loadState = { ok: Boolean(state?.ok), message: state?.message };
  if (!loadState.ok) log.error('内置脚本加载失败', { message: state?.message });
  scheduleMenuRebuild();
}

function getLoadState() {
  return loadState;
}

function resetLoadState() {
  loadState = null;
}

module.exports = {
  REBUILD_DEBOUNCE_MS,
  clearCommands,
  findCommand,
  getLoadState,
  listCommands,
  registerCommand,
  resetLoadState,
  scheduleMenuRebuild,
  setLoadState,
  setMenuBuilder,
  unregisterCommand,
};
