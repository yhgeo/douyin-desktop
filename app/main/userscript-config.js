'use strict';

/**
 * Export and import the userscript's whole configuration as a JSON file.
 *
 * The point of the format (see storage/config-transfer.js) is that a backup survives
 * being edited by hand and refuses to import something that is not one, so the dialogs
 * here stay thin: pick a file, hand it to the parser, report what happened.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const { SCRIPT_NAME, SCRIPT_VERSION } = require('../platform/constants');
const log = require('../diagnostics/logger');
const { getMainWindow } = require('./window');
const { broadcast } = require('./broadcast');
const { clearCommands, resetLoadState, scheduleMenuRebuild } = require('./userscript-menu');
const { userscriptStore } = require('../storage/userscript-store');
const { buildExportPayload, parseImportPayload, suggestFileName } = require('../storage/config-transfer');

/** The script was reset, so every frame's mirror and the menu are now stale. */
function afterConfigurationReplaced(values) {
  broadcast('gm-store-replaced', values);
  clearCommands();
  resetLoadState();
  scheduleMenuRebuild();
  getMainWindow()?.webContents.reload();
}

/** Write the whole script configuration to a user-chosen JSON file. */
async function exportUserscriptConfig() {
  const window = getMainWindow();
  try {
    const payload = buildExportPayload(userscriptStore.getAll(), {
      scriptName: SCRIPT_NAME,
      scriptVersion: SCRIPT_VERSION,
    });
    const result = await dialog.showSaveDialog(window, {
      title: '导出脚本配置',
      defaultPath: path.join(app.getPath('documents'), suggestFileName(SCRIPT_NAME)),
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    await dialog.showMessageBox(window, {
      type: 'info',
      title: '导出完成',
      message: `已导出 ${Object.keys(payload.values).length} 项配置`,
      detail: result.filePath,
      buttons: ['好'],
    });
    return { ok: true, path: result.filePath, keys: Object.keys(payload.values) };
  } catch (error) {
    const message = String((error && error.message) || error);
    log.error('导出脚本配置失败', { error: message });
    await dialog.showMessageBox(window, {
      type: 'error',
      title: '导出失败',
      message,
      buttons: ['好'],
    });
    return { ok: false, error: message };
  }
}

/** Restore the whole script configuration from a user-chosen JSON file. */
async function importUserscriptConfig() {
  const window = getMainWindow();
  try {
    const result = await dialog.showOpenDialog(window, {
      title: '导入脚本配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };

    const filePath = result.filePaths[0];
    const parsed = parseImportPayload(fs.readFileSync(filePath, 'utf8'));
    if (!parsed.ok) {
      await dialog.showMessageBox(window, {
        type: 'error',
        title: '导入失败',
        message: parsed.error,
        detail: filePath,
        buttons: ['好'],
      });
      return { ok: false, error: parsed.error };
    }

    const confirm = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['取消', '导入并覆盖'],
      defaultId: 1,
      cancelId: 0,
      title: '导入脚本配置',
      message: `即将导入 ${parsed.keys.length} 项配置。`,
      detail: '当前「抖音优化」的全部配置会被覆盖，确定继续吗？',
    });
    if (confirm.response !== 1) return { ok: false, canceled: true };

    userscriptStore.replaceAll(parsed.values);
    afterConfigurationReplaced(parsed.values);
    return { ok: true, keys: parsed.keys };
  } catch (error) {
    const message = String((error && error.message) || error);
    log.error('导入脚本配置失败', { error: message });
    await dialog.showMessageBox(window, {
      type: 'error',
      title: '导入失败',
      message,
      buttons: ['好'],
    });
    return { ok: false, error: message };
  }
}

module.exports = { afterConfigurationReplaced, exportUserscriptConfig, importUserscriptConfig };
