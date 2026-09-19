const { ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const isDouyin = /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(location.hostname);
const isTopFrame = window.top === window;
const scriptEnabled = isDouyin && ipcRenderer.sendSync('get-script-enabled') !== false;
const valuesKey = 'douyin-desktop:gm-values';
const valueListeners = new Map();
const menuCommands = new Map();
let listenerId = 0;
let menuCommandId = 0;

function loadValues() {
  try { return JSON.parse(localStorage.getItem(valuesKey) || '{}'); } catch { return {}; }
}
function saveValues(values) {
  try { localStorage.setItem(valuesKey, JSON.stringify(values)); } catch (error) { console.error('[抖音] 保存脚本配置失败', error); }
}
function gmGetValue(key, fallback) {
  const values = loadValues();
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
}
function gmSetValue(key, value) {
  const values = loadValues();
  const oldValue = values[key];
  values[key] = value;
  saveValues(values);
  valueListeners.forEach((item) => { if (item.key === key) item.callback(key, oldValue, value, true); });
  return Promise.resolve();
}
function gmSetValues(values) { Object.entries(values || {}).forEach(([key, value]) => gmSetValue(key, value)); }
function gmDeleteValue(key) { const values = loadValues(); delete values[key]; saveValues(values); }
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
function gmXmlHttpRequest(details = {}) {
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
  window.GM_xmlhttpRequest = gmXmlHttpRequest;
  window.GM_download = gmDownload;
  window.GM_info = { script: { name: '抖音优化', version: '2026.9.17.17' }, scriptHandler: '抖音' };
  window.unsafeWindow = window;

  const files = ['domutils.umd.js', 'pops.umd.js', 'utils.umd.js', 'qmsg.umd.js'];
  const root = path.join(__dirname, '..');
  const evaluateBundled = (file) => (0, eval)(fs.readFileSync(path.join(root, file), 'utf8'));
  try {
    files.forEach((file) => evaluateBundled(path.join('vendor', file)));
    evaluateBundled(path.join('assets', 'douyin-optimization.user.js'));
  } catch (error) {
    console.error('[抖音] 内置脚本加载失败', error);
  }
}
