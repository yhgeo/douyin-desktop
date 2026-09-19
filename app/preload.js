const { ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const isDouyin = /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(location.hostname);
const scriptEnabled = isDouyin && ipcRenderer.sendSync('get-script-enabled') !== false;
const valuesKey = 'douyin-desktop:gm-values';
const listeners = new Map();
let listenerId = 0;

function loadValues() {
  try { return JSON.parse(localStorage.getItem(valuesKey) || '{}'); } catch { return {}; }
}
function saveValues(values) { localStorage.setItem(valuesKey, JSON.stringify(values)); }
function gmGetValue(key, fallback) {
  const values = loadValues();
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
}
function gmSetValue(key, value) {
  const values = loadValues();
  const oldValue = values[key];
  values[key] = value;
  saveValues(values);
  listeners.forEach((item) => { if (item.key === key) item.callback(key, oldValue, value, true); });
  return Promise.resolve();
}
function gmSetValues(values) { Object.entries(values || {}).forEach(([key, value]) => gmSetValue(key, value)); }
function gmDeleteValue(key) { const values = loadValues(); delete values[key]; saveValues(values); }
function gmListValues() { return Object.keys(loadValues()); }
function gmAddValueChangeListener(key, callback) { const id = ++listenerId; listeners.set(id, { key, callback }); return id; }
function gmRemoveValueChangeListener(id) { listeners.delete(id); }
function gmRegisterMenuCommand(_name, _callback) { return `desktop-menu-${++listenerId}`; }
function gmUnregisterMenuCommand() {}
function gmGetResourceText() { return undefined; }
function gmXmlHttpRequest(details = {}) {
  ipcRenderer.invoke('gm-http-request', {
    url: details.url,
    method: details.method || 'GET',
    headers: details.headers || {},
    body: details.data || details.body,
  }).then((result) => {
    if (!result.ok) { details.onerror?.({ error: result.error }); return; }
    const response = { status: result.status, statusText: result.statusText, responseText: result.responseText, response: result.response, responseHeaders: result.headers, finalUrl: details.url };
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

if (scriptEnabled) {
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
  window.GM_xmlhttpRequest = gmXmlHttpRequest;
  window.GM_download = gmDownload;
  window.GM_info = { script: { name: '抖音优化', version: '2026.9.17.17' }, scriptHandler: '抖音桌面版' };
  window.unsafeWindow = window;

  const files = ['domutils.umd.js', 'pops.umd.js', 'utils.umd.js', 'qmsg.umd.js'];
  const root = path.join(__dirname, '..');
  // Evaluate in the page world instead of inserting inline script elements, so the
  // remote page CSP cannot block the bundled runtime and userscript.
  const evaluateBundled = (file) => (0, eval)(fs.readFileSync(path.join(root, file), 'utf8'));
  try {
    files.forEach((file) => evaluateBundled(path.join('vendor', file)));
    evaluateBundled(path.join('assets', 'douyin-optimization.user.js'));
  } catch (error) {
    console.error('[抖音桌面版] 内置脚本加载失败', error);
  }
}

