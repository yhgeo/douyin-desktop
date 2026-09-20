const { ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { whenDocumentElementAvailable } = require('./dom-ready');
const { LEGACY_VALUES_KEY } = require('./gm-store');

const isDouyin = /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(location.hostname);
const isTopFrame = window.top === window;
const scriptEnabled = isDouyin && ipcRenderer.sendSync('get-script-enabled') !== false;
// Identifies this frame so we can ignore the echo of our own writes.
const frameId = `frame-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const valueListeners = new Map();
const menuCommands = new Map();
let listenerId = 0;
let menuCommandId = 0;
/** In-memory mirror of the main-process store; GM_getValue must be synchronous. */
let valuesCache = null;

/**
 * Read the whole store once, then serve reads from memory.
 *
 * Values live in the main process (see app/gm-store.js) rather than in the
 * page's `localStorage`, so clearing Douyin's site data no longer destroys the
 * script configuration, and the remote page cannot read or wipe it.
 */
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
  valueListeners.forEach((item) => { if (item.key === key) item.callback(key, oldValue, newValue, true); });
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
function gmSetValues(values) { Object.entries(values || {}).forEach(([key, value]) => gmSetValue(key, value)); }
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
  menuCommands.set(id, { name: String(name), callback });
  if (isTopFrame) ipcRenderer.send('gm-menu-register', { id, name: String(name) });
  return id;
}
function gmUnregisterMenuCommand(id) {
  menuCommands.delete(id);
  if (isTopFrame) ipcRenderer.send('gm-menu-unregister', id);
}
function gmGetResourceText() { return undefined; }
function gmXmlhttpRequest(details = {}) {
  ipcRenderer.invoke('gm-http-request', {
    url: details.url,
    method: details.method || 'GET',
    headers: details.headers || {},
    body: details.data || details.body,
  }).then((result) => {
    if (!result.ok) { details.onerror?.({ error: result.error }); return; }
    const response = {
      status: result.status,
      statusText: result.statusText,
      responseText: result.responseText,
      response: result.response,
      responseHeaders: result.headers,
      finalUrl: details.url,
    };
    details.onload?.(response);
  }).catch((error) => details.onerror?.({ error: error.message || String(error) }));
  return { abort() {} };
}
function gmDownload(details, nameOrOptions) {
  const options = typeof details === 'string' ? { url: details, name: nameOrOptions } : details;
  if (!options?.url) return;
  ipcRenderer.send('gm-download', { url: options.url, name: options.name });
  options.onload?.();
}

// Keep every frame's mirror in sync, so a value changed in one frame (or window)
// is immediately visible everywhere - previously each frame cached its own copy
// and could clobber another frame's write.
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

ipcRenderer.on('invoke-gm-menu-command', (_event, id) => {
  const command = menuCommands.get(id);
  if (!command || typeof command.callback !== 'function') return;
  try { command.callback(); } catch (error) { console.error(`[抖音] 执行脚本菜单“${command.name}”失败`, error); }
});

if (scriptEnabled) {
  if (isTopFrame) ipcRenderer.send('gm-menu-reset');
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
  window.GM_info = { script: { name: '抖音优化', version: '2026.9.17.17' }, scriptHandler: '抖音' };
  window.unsafeWindow = window;

  const files = ['domutils.umd.js', 'pops.umd.js', 'utils.umd.js', 'qmsg.umd.js'];
  const root = path.join(__dirname, '..');
  const evaluateBundled = (file) => (0, eval)(fs.readFileSync(path.join(root, file), 'utf8'));

  // The bundle must not be evaluated before the document has a root element:
  // DOMUtils.addStyle dereferences `document.documentElement.childNodes`, which
  // is null during the raw preload phase and would abort the whole userscript.
  whenDocumentElementAvailable(() => {
    try {
      files.forEach((file) => evaluateBundled(path.join('vendor', file)));
      evaluateBundled(path.join('assets', 'douyin-optimization.user.js'));
      if (isTopFrame) ipcRenderer.send('userscript-loaded', { ok: true });
    } catch (error) {
      console.error('[抖音] 内置脚本加载失败', error);
      ipcRenderer.send('userscript-loaded', { ok: false, message: String(error?.message || error) });
    }
  });
}
