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
const { isPlainObject } = require('../storage/config-transfer');
const { requestUrl } = require('../platform/http');
const { isDouyinHost } = require('../platform/url-policy');
const { downloadBroker } = require('../platform/downloads');
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

/**
 * Is this message coming from a Douyin page?
 *
 * The preload only installs the GM_* API on Douyin hosts, so in practice every caller
 * is one - but the IPC surface itself is reachable from whatever the window happens to
 * be showing, and `gm-http-request` is a request the *main process* makes with no CORS
 * rules attached. Checking the sender costs nothing and stops a page that is not Douyin
 * from using the app as a proxy.
 *
 * @param {import('electron').IpcMainEvent|import('electron').IpcMainInvokeEvent} event
 */
function senderIsDouyin(event) {
  try {
    const url = event?.senderFrame?.url;
    if (!url) return false;
    return isDouyinHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

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
  // Every payload below is checked before use. The renderer is the untrusted side of
  // this boundary, and destructuring a `null` payload throws inside the handler - which
  // turns one malformed message into a silent failure to save the setting.
  ipcMain.on('gm-store-import', (_event, values) => {
    if (!isPlainObject(values)) {
      log.warn('忽略无效的脚本配置导入', { receivedType: typeof values });
      return;
    }
    userscriptStore.replaceAll(values);
  });
  ipcMain.on('gm-store-set', (_event, payload) => {
    if (!isPlainObject(payload) || typeof payload.key !== 'string' || payload.key === '') {
      log.warn('忽略无效的脚本配置写入', { receivedType: typeof payload });
      return;
    }
    const { key, value, source } = payload;
    const { oldValue } = userscriptStore.set(key, value);
    broadcast('gm-store-changed', { key, value, oldValue, source });
  });
  ipcMain.on('gm-store-delete', (_event, payload) => {
    if (!isPlainObject(payload) || typeof payload.key !== 'string' || payload.key === '') {
      log.warn('忽略无效的脚本配置删除', { receivedType: typeof payload });
      return;
    }
    const { key, source } = payload;
    const { oldValue } = userscriptStore.delete(key);
    broadcast('gm-store-changed', { key, oldValue, deleted: true, source });
  });

  // --- helpers the page cannot do itself ------------------------------------
  /** requestId -> AbortController, so a renderer-side abort() can stop a live request. */
  const httpAborts = new Map();

  ipcMain.handle('gm-http-request', async (event, options) => {
    if (!isPlainObject(options) || typeof options.url !== 'string') {
      return { ok: false, error: '请求参数无效' };
    }
    // The main process makes this request with no CORS rules attached, so it is only
    // ever offered to a Douyin page. Without this check the app is an open proxy for
    // whatever the window happens to be displaying.
    if (!senderIsDouyin(event)) {
      log.warn('拒绝非抖音页面发起的 GM 请求', { url: options.url });
      return { ok: false, error: '请求来源不是抖音页面' };
    }

    const requestId = typeof options.requestId === 'string' ? options.requestId : null;
    const controller = new AbortController();
    if (requestId) httpAborts.set(requestId, controller);

    try {
      const result = await requestUrl(options.url, { ...options, signal: controller.signal });
      const text = result.body.toString('utf8');
      return {
        ok: true,
        status: result.status,
        statusText: result.statusText,
        finalUrl: result.finalUrl,
        headers: Object.entries(result.headers)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n'),
        responseText: text,
        response: text,
      };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    } finally {
      if (requestId) httpAborts.delete(requestId);
    }
  });

  ipcMain.on('gm-http-abort', (_event, payload) => {
    if (!isPlainObject(payload) || typeof payload.requestId !== 'string') return;
    httpAborts.get(payload.requestId)?.abort();
  });

  /**
   * GM_download.
   *
   * The reply is asynchronous on purpose: the userscript shows a progress percentage,
   * reports failure and offers cancellation, all of which come from the download's own
   * events. Answering immediately with `onload()` told the user "下载已完成" before the
   * transfer had started.
   */
  ipcMain.on('gm-download', (event, payload) => {
    if (!isPlainObject(payload) || typeof payload.requestId !== 'string') return;
    const { url, name, requestId } = payload;
    const window = getMainWindow();
    if (!window) return;

    if (!downloadBroker.request({ url, name, requestId, sender: event.sender })) {
      // A scheme the policy refuses: report it now rather than leaving the script's
      // progress toast spinning forever.
      event.sender.send('gm-download-done', { requestId, state: 'blocked' });
      return;
    }
    window.webContents.downloadURL(url);
  });
  ipcMain.on('gm-download-abort', (_event, payload) => {
    if (!isPlainObject(payload) || typeof payload.requestId !== 'string') return;
    downloadBroker.abort(payload.requestId);
  });
}

module.exports = { registerIpcHandlers };
