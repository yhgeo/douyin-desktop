'use strict';

/**
 * The GM_* API surface the bundled userscript expects.
 *
 * Values live in the main process (storage/gm-store.js) rather than in the page's
 * `localStorage`, so clearing Douyin's site data no longer destroys the script
 * configuration and the remote page cannot read or wipe it. This module keeps the
 * renderer-side mirror and translates calls into IPC.
 *
 * Two calls are synchronous by design: the userscript reads `GM_getValue` in expressions
 * and cannot await, so the initial read is a `sendSync` and everything afterwards is
 * served from the in-memory mirror.
 */

const { ipcRenderer } = require('electron');
const { SCRIPT_NAME, SCRIPT_VERSION, APP_NAME } = require('../platform/script-meta');
const { LEGACY_VALUES_KEY } = require('../storage/gm-store');

/**
 * @param {{ frameId: string, isTopFrame: boolean }} context
 */
function installGmApi({ frameId, isTopFrame }) {
  const valueListeners = new Map();
  const menuCommands = new Map();
  let listenerId = 0;
  let menuCommandId = 0;
  let downloadId = 0;
  let httpRequestId = 0;
  /** requestId -> the caller's callback bag, until its download finishes. */
  const downloadRequests = new Map();
  /** requestId -> { aborted } for in-flight GM_xmlhttpRequest calls. */
  const httpRequests = new Map();
  /** In-memory mirror of the main-process store; GM_getValue must be synchronous. */
  let valuesCache = null;

  /** Read the whole store once, then serve reads from memory. */
  function loadValues() {
    if (valuesCache !== null) return valuesCache;

    let initial = { values: {}, initialized: false };
    try {
      initial = ipcRenderer.sendSync('gm-store-read') || initial;
    } catch (error) {
      console.error('[抖音] 读取脚本配置失败', error);
    }
    valuesCache = initial.values && typeof initial.values === 'object' ? initial.values : {};

    // One-time migration from the old localStorage-backed store.
    if (!initial.initialized) {
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_VALUES_KEY) || 'null');
        if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
          valuesCache = { ...valuesCache, ...legacy };
        }
        localStorage.removeItem(LEGACY_VALUES_KEY);
      } catch {
        // Nothing to migrate; start clean.
      }
      ipcRenderer.send('gm-store-import', valuesCache);
    }

    return valuesCache;
  }

  function notifyListeners(key, oldValue, newValue) {
    valueListeners.forEach((item) => {
      if (item.key === key) item.callback(key, oldValue, newValue, true);
    });
  }

  function gmGetValue(key, fallback) {
    const values = loadValues();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
  }

  function gmSetValue(key, value) {
    const values = loadValues();
    const oldValue = values[key];
    values[key] = value;
    ipcRenderer.send('gm-store-set', { key, value, source: frameId });
    notifyListeners(key, oldValue, value);
    return Promise.resolve();
  }

  function gmSetValues(values) {
    Object.entries(values || {}).forEach(([key, value]) => gmSetValue(key, value));
  }

  function gmDeleteValue(key) {
    const values = loadValues();
    const oldValue = values[key];
    delete values[key];
    ipcRenderer.send('gm-store-delete', { key, source: frameId });
    notifyListeners(key, oldValue, undefined);
  }

  function gmListValues() { return Object.keys(loadValues()); }

  function gmAddValueChangeListener(key, callback) {
    const id = ++listenerId;
    valueListeners.set(id, { key, callback });
    return id;
  }

  function gmRemoveValueChangeListener(id) { valueListeners.delete(id); }

  function gmRegisterMenuCommand(name, callback) {
    const id = `gm-menu-${++menuCommandId}`;
    // `id` is stored on the record as well: the settings entry lists commands and invokes
    // them by id, so a record without one could never be triggered.
    menuCommands.set(id, { id, name: String(name), callback });
    if (isTopFrame) ipcRenderer.send('gm-menu-register', { id, name: String(name) });
    return id;
  }

  function gmUnregisterMenuCommand(id) {
    menuCommands.delete(id);
    if (isTopFrame) ipcRenderer.send('gm-menu-unregister', id);
  }

  function gmGetResourceText() { return undefined; }

  /**
   * `GM_xmlhttpRequest`, proxied through the main process so the request is not subject
   * to the page's CORS rules - which is the point of the API.
   *
   * Returns a handle whose `abort()` really cancels: the request lives in the main
   * process, so the renderer cannot stop it alone and has to ask. It used to return a
   * no-op, which meant a caller that gave up still left the request running.
   */
  function gmXmlhttpRequest(details = {}) {
    const requestId = `gm-http-${++httpRequestId}`;
    const state = { aborted: false };
    httpRequests.set(requestId, state);

    const finish = () => { httpRequests.delete(requestId); };

    ipcRenderer.invoke('gm-http-request', {
      requestId,
      url: details.url,
      method: details.method || 'GET',
      headers: details.headers || {},
      body: details.data || details.body,
    }).then((result) => {
      if (state.aborted) return;
      finish();
      if (!result.ok) {
        details.onerror?.({ error: result.error });
        return;
      }
      details.onload?.({
        status: result.status,
        statusText: result.statusText,
        responseText: result.responseText,
        response: result.response,
        responseHeaders: result.headers,
        // After a redirect this is the URL that actually answered, not the one asked for.
        finalUrl: result.finalUrl || details.url,
      });
    }).catch((error) => {
      if (state.aborted) return;
      finish();
      details.onerror?.({ error: error.message || String(error) });
    });

    return {
      abort() {
        state.aborted = true;
        finish();
        ipcRenderer.send('gm-http-abort', { requestId });
      },
    };
  }

  /**
   * `GM_download`.
   *
   * Returns a handle immediately and reports through the caller's callbacks as the
   * download actually progresses. The userscript builds its whole download UI on those
   * callbacks - a progress percentage, a failure message, and `abort()` when the user
   * closes the progress toast - so calling `onload()` up front made it announce
   * "下载已完成" before anything had been transferred, and left the toast unable to
   * cancel anything.
   */
  function gmDownload(details, nameOrOptions) {
    const options = typeof details === 'string' ? { url: details, name: nameOrOptions } : details;
    if (!options?.url) return undefined;

    const requestId = `gm-download-${++downloadId}`;
    downloadRequests.set(requestId, options);
    ipcRenderer.send('gm-download', { url: options.url, name: options.name, requestId });

    return {
      abort() {
        downloadRequests.delete(requestId);
        ipcRenderer.send('gm-download-abort', { requestId });
      },
    };
  }

  // Keep every frame's mirror in sync, so a value changed in one frame (or window) is
  // immediately visible everywhere - previously each frame cached its own copy and could
  // clobber another frame's write.
  ipcRenderer.on('gm-store-changed', (_event, change) => {
    if (!change || change.source === frameId) return;
    const values = loadValues();
    const oldValue = values[change.key];
    if (change.deleted) delete values[change.key];
    else values[change.key] = change.value;
    notifyListeners(change.key, oldValue, change.deleted ? undefined : change.value);
  });

  ipcRenderer.on('gm-store-replaced', (_event, next) => {
    valuesCache = next && typeof next === 'object' ? next : {};
  });

  // Download lifecycle, reported by the main process as it actually happens.
  ipcRenderer.on('gm-download-progress', (_event, payload) => {
    if (!payload || typeof payload.requestId !== 'string') return;
    const options = downloadRequests.get(payload.requestId);
    options?.onprogress?.({ loaded: payload.loaded, total: payload.total });
  });

  ipcRenderer.on('gm-download-done', (_event, payload) => {
    if (!payload || typeof payload.requestId !== 'string') return;
    const options = downloadRequests.get(payload.requestId);
    downloadRequests.delete(payload.requestId);
    if (!options) return;
    if (payload.state === 'completed') options.onload?.();
    else if (payload.state === 'cancelled') options.onerror?.({ error: '已取消' });
    else options.onerror?.({ error: payload.state || '下载失败' });
  });

  ipcRenderer.on('invoke-gm-menu-command', (_event, id) => {
    const command = menuCommands.get(id);
    if (!command || typeof command.callback !== 'function') return;
    try {
      command.callback();
    } catch (error) {
      console.error(`[抖音] 执行脚本菜单“${command.name}”失败`, error);
    }
  });

  window.GM_getValue = gmGetValue;
  window.GM_setValue = gmSetValue;
  window.GM_setValues = gmSetValues;
  window.GM_deleteValue = gmDeleteValue;
  window.GM_listValues = gmListValues;
  window.GM_addValueChangeListener = gmAddValueChangeListener;
  window.GM_removeValueChangeListener = gmRemoveValueChangeListener;
  window.GM_registerMenuCommand = gmRegisterMenuCommand;
  window.GM_unregisterMenuCommand = gmUnregisterMenuCommand;
  window.GM_getResourceText = gmGetResourceText;
  window.GM_xmlhttpRequest = gmXmlhttpRequest;
  window.GM_download = gmDownload;
  window.GM_info = { script: { name: SCRIPT_NAME, version: SCRIPT_VERSION }, scriptHandler: APP_NAME };
  window.unsafeWindow = window;
}

module.exports = { installGmApi };
