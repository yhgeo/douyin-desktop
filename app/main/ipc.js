'use strict';

/**
 * Every IPC channel the preload uses, in one place.
 *
 * Splitting these out of the startup path is deliberate: the set of channels is the
 * contract with the page side (app/preload/), and having them in one file makes it
 * possible to see that contract at a glance. Two of them are synchronous by design -
 * `get-script-enabled` and `gm-store-read` - because the userscript calls
 * `GM_getValue` synchronously and cannot await.
 */

const { dialog, ipcMain } = require('electron');
const log = require('../diagnostics/logger');
const { readSettings } = require('../storage/settings');
const { userscriptStore } = require('../storage/userscript-store');
const { requestUrl } = require('../platform/http');
const { isWebUrl } = require('../platform/url-policy');
const { broadcast } = require('./broadcast');
const { getMainWindow } = require('./window');
const { settleStuckDialogRecovery } = require('./actions');
const {
  registerCommand,
  unregisterCommand,
  clearCommands,
  setLoadState,
  scheduleMenuRebuild,
} = require('./userscript-menu');

function registerIpcHandlers() {
  ipcMain.on('get-script-enabled', (event) => {
    event.returnValue = readSettings().scriptEnabled;
  });

  // --- the userscript's own menu entries ------------------------------------
  ipcMain.on('gm-menu-reset', () => {
    clearCommands();
    scheduleMenuRebuild();
  });
  ipcMain.on('gm-menu-register', (_event, command) => registerCommand(command));
  ipcMain.on('gm-menu-unregister', (_event, id) => unregisterCommand(id));
  ipcMain.on('userscript-loaded', (_event, state) => setLoadState(state));

  // --- recovery results ------------------------------------------------------
  ipcMain.on('stuck-dialog-recovered', (_event, info) => {
    log.info('页面自行恢复了卡住的弹窗', info);
  });
  ipcMain.on('stuck-dialog-recovery-result', (_event, result) => {
    settleStuckDialogRecovery();
    if (result?.recovered) {
      log.info('已关闭卡住的弹窗', { via: result.via });
      return;
    }
    dialog.showMessageBox(getMainWindow(), {
      type: 'info',
      title: '关闭卡住的弹窗',
      message: '当前没有检测到卡住的弹窗。',
      buttons: ['好'],
    }).catch(() => {});
  });

  // --- userscript value storage ---------------------------------------------
  ipcMain.on('userscript-storage-error', (_event, info) => {
    log.error('脚本配置读写失败', info);
  });
  ipcMain.on('gm-store-read', (event) => {
    event.returnValue = { values: userscriptStore.getAll(), initialized: userscriptStore.initialized };
  });
  ipcMain.on('gm-store-import', (_event, values) => {
    userscriptStore.replaceAll(values);
  });
  ipcMain.on('gm-store-set', (_event, { key, value, source }) => {
    const { oldValue } = userscriptStore.set(key, value);
    broadcast('gm-store-changed', { key, value, oldValue, source });
  });
  ipcMain.on('gm-store-delete', (_event, { key, source }) => {
    const { oldValue } = userscriptStore.delete(key);
    broadcast('gm-store-changed', { key, oldValue, deleted: true, source });
  });

  // --- helpers the page cannot do itself ------------------------------------
  ipcMain.handle('gm-http-request', async (_event, options) => {
    try {
      const result = await requestUrl(options.url, options);
      const text = result.body.toString('utf8');
      return {
        ok: true,
        status: result.status,
        statusText: result.statusText,
        headers: Object.entries(result.headers)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n'),
        responseText: text,
        response: text,
      };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
  ipcMain.on('gm-download', (_event, { url }) => {
    const window = getMainWindow();
    if (window && url && isWebUrl(url)) window.webContents.downloadURL(url);
  });
}

module.exports = { registerIpcHandlers };
