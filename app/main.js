const { app, BrowserWindow, Menu, session, ipcMain, shell, dialog, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { isWebUrl } = require('./url-policy');
const { hardenWebContents } = require('./web-contents-guard');
const { GmStore } = require('./gm-store');
const { buildExportPayload, parseImportPayload, suggestFileName } = require('./config-transfer');

const APP_NAME = '抖音';
const HOME_URL = 'https://www.douyin.com/';
const SCRIPT_NAME = '抖音优化';
// Kept in sync with GM_info in app/preload.js; written into backup files.
const SCRIPT_VERSION = '2026.9.17.17';
const ICON_PATH = path.join(__dirname, '..', 'assets', 'douyin-icon.png');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
// Userscript GM_* values are owned here, not by the page, so clearing Douyin's
// site data and clearing the script configuration are independent operations.
const userscriptStore = new GmStore(path.join(app.getPath('userData'), 'userscript-config.json'));
const userscriptMenuCommands = new Map();
let mainWindow;
let rebuildMenuTimer;
let userscriptLoadState = null;

app.setName(APP_NAME);
app.commandLine.appendSwitch('lang', 'zh-CN');

// Chromium throttles timers and requestAnimationFrame for windows it considers
// occluded or hidden. Douyin's own dialogs close from a state update that this
// throttling can stall, which leaves the dialog and its mask stuck over the page
// (see attachResponsivenessHandlers below). `backgroundThrottling: false` on the
// main window covers that window, but Douyin also opens helper windows of its own
// - those would still be throttled - so turn it off for every window here.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function readSettings() {
  try {
    return { scriptEnabled: true, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {
    return { scriptEnabled: true };
  }
}

function writeSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('[抖音] 保存应用设置失败', settingsPath, error);
    return false;
  }
}

function requestUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (error) { reject(error); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error(`不支持的请求协议：${parsed.protocol}`));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.request(parsed, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 30000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        statusText: response.statusMessage || '',
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

/**
 * The single place the app is allowed to hand a URL to the operating system.
 * Only real web URLs pass; custom schemes such as `bytedance://` are refused
 * here as well, so no caller can accidentally trigger the Windows
 * "需要新应用以打开此链接" dialog.
 */
function openExternalSafely(rawUrl) {
  if (!isWebUrl(rawUrl)) {
    console.warn('[抖音] 已拦截外部协议调用', rawUrl);
    return false;
  }
  shell.openExternal(rawUrl).catch((error) => {
    console.error('[抖音] 打开外部链接失败', rawUrl, error);
  });
  return true;
}

function logBlockedRequest(info) {
  console.warn(`[抖音] 已拦截${info.reason === 'popup-blocked' ? '弹窗' : '跳转'}（${info.kind}）：${info.url}`);
}

/** Push a change to every frame so no frame keeps serving a stale value. */
function broadcastStoreChange(change) {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send('gm-store-changed', change);
  }
}

/** Wipe the userscript's stored configuration and restart it cleanly. */
function clearUserscriptData() {
  userscriptStore.clear();
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send('gm-store-replaced', {});
  }
  userscriptMenuCommands.clear();
  userscriptLoadState = null;
  scheduleMenuRebuild();
  mainWindow?.webContents.reload();
}

function findUserscriptCommand(namePattern) {
  return [...userscriptMenuCommands.values()].find((item) => namePattern.test(item.name));
}

function invokeUserscriptCommand(command) {
  if (!command || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('invoke-gm-menu-command', command.id);
}

/** Write the whole script configuration to a user-chosen JSON file. */
async function exportUserscriptConfig() {
  try {
    const payload = buildExportPayload(userscriptStore.getAll(), {
      scriptName: SCRIPT_NAME,
      scriptVersion: SCRIPT_VERSION,
    });
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出脚本配置',
      defaultPath: path.join(app.getPath('documents'), suggestFileName(SCRIPT_NAME)),
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '导出完成',
      message: `已导出 ${Object.keys(payload.values).length} 项配置`,
      detail: result.filePath,
      buttons: ['好'],
    });
    return { ok: true, path: result.filePath, keys: Object.keys(payload.values) };
  } catch (error) {
    console.error('[抖音] 导出脚本配置失败', error);
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '导出失败',
      message: String(error?.message || error),
      buttons: ['好'],
    });
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Restore the whole script configuration from a user-chosen JSON file. */
async function importUserscriptConfig() {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入脚本配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };

    const filePath = result.filePaths[0];
    const parsed = parseImportPayload(fs.readFileSync(filePath, 'utf8'));
    if (!parsed.ok) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '导入失败',
        message: parsed.error,
        detail: filePath,
        buttons: ['好'],
      });
      return { ok: false, error: parsed.error };
    }

    const confirm = await dialog.showMessageBox(mainWindow, {
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
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send('gm-store-replaced', parsed.values);
    }
    userscriptMenuCommands.clear();
    userscriptLoadState = null;
    scheduleMenuRebuild();
    mainWindow?.webContents.reload();
    return { ok: true, keys: parsed.keys };
  } catch (error) {
    console.error('[抖音] 导入脚本配置失败', error);
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '导入失败',
      message: String(error?.message || error),
      buttons: ['好'],
    });
    return { ok: false, error: String(error?.message || error) };
  }
}

function configureWebContents(contents) {
  hardenWebContents(contents, {
    openExternal: openExternalSafely,
    onBlocked: logBlockedRequest,
    title: APP_NAME,
  });
}

function scheduleMenuRebuild() {
  clearTimeout(rebuildMenuTimer);
  rebuildMenuTimer = setTimeout(buildMenu, 30);
}

function buildMenu() {
  const settings = readSettings();
  const desktopSettings = findUserscriptCommand(/^\s*⚙?\s*设置\s*$/);
  const mobileSettings = findUserscriptCommand(/移动端设置/);
  const extraScriptCommands = [...userscriptMenuCommands.values()].filter(
    (item) => item.id !== desktopSettings?.id && item.id !== mobileSettings?.id,
  );

  const scriptSubmenu = [
    {
      label: `启用${SCRIPT_NAME}`,
      type: 'checkbox',
      checked: settings.scriptEnabled,
      click: (item) => {
        writeSettings({ ...readSettings(), scriptEnabled: item.checked });
        userscriptMenuCommands.clear();
        userscriptLoadState = null;
        mainWindow?.webContents.reload();
        scheduleMenuRebuild();
      },
    },
    { type: 'separator' },
    {
      label: '打开配置界面',
      accelerator: 'CmdOrCtrl+,',
      enabled: settings.scriptEnabled && Boolean(desktopSettings),
      click: () => invokeUserscriptCommand(desktopSettings),
    },
    {
      label: '打开移动端配置',
      enabled: settings.scriptEnabled && Boolean(mobileSettings),
      click: () => invokeUserscriptCommand(mobileSettings),
    },
    { type: 'separator' },
    { label: '导出配置到文件…', click: () => exportUserscriptConfig() },
    { label: '从文件导入配置…', click: () => importUserscriptConfig() },
  ];

  if (extraScriptCommands.length) {
    scriptSubmenu.push({ type: 'separator' });
    for (const command of extraScriptCommands) {
      scriptSubmenu.push({ label: command.name, click: () => invokeUserscriptCommand(command) });
    }
  }

  if (userscriptLoadState && !userscriptLoadState.ok) {
    scriptSubmenu.push({ type: 'separator' });
    scriptSubmenu.push({
      label: `⚠ 内置脚本加载失败：${userscriptLoadState.message || '未知错误'}`,
      enabled: false,
    });
  }

  const toolSubmenu = [
    { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
    { type: 'separator' },
    {
      label: '清除抖音网页数据',
      click: async () => {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['取消', '清除'],
          defaultId: 0,
          cancelId: 0,
          title: '清除抖音网页数据',
          message: '这会清除登录状态、Cookie、网页缓存和网页本地数据。',
          detail: '「抖音优化」的脚本配置会保留。确定继续吗？',
        });
        if (result.response !== 1) return;
        // Script configuration lives in the main process, not in site
        // storage, so it is untouched by this.
        await session.defaultSession.clearStorageData();
        await session.defaultSession.clearCache();
        mainWindow?.webContents.reload();
      },
    },
    {
      label: '清除脚本配置数据',
      click: async () => {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['取消', '清除'],
          defaultId: 0,
          cancelId: 0,
          title: '清除脚本配置数据',
          message: '这会清除「抖音优化」的全部配置，恢复为默认设置。',
          detail: '登录状态和网页数据会保留。确定继续吗？',
        });
        if (result.response !== 1) return;
        clearUserscriptData();
      },
    },
    { type: 'separator' },
    { label: '退出抖音', accelerator: 'Alt+F4', role: 'quit' },
  ];

  const menu = Menu.buildFromTemplate([
    {
      label: '导航',
      submenu: [
        { label: '抖音首页', accelerator: 'Alt+Home', click: () => mainWindow?.loadURL(HOME_URL) },
        { label: '后退', accelerator: 'Alt+Left', click: () => mainWindow?.webContents.goBack() },
        { label: '前进', accelerator: 'Alt+Right', click: () => mainWindow?.webContents.goForward() },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
      ],
    },
    { label: SCRIPT_NAME, submenu: scriptSubmenu },
    {
      label: '视图',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: '恢复默认缩放', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
      ],
    },
    { label: '工具', submenu: toolSubmenu },
    {
      label: '帮助',
      submenu: [
        { label: '抖音优化脚本主页', click: () => openExternalSafely('https://scriptcat.org/zh-CN/script-show-page/2534') },
        { label: '项目仓库', click: () => openExternalSafely('https://github.com/yhgeo/douyin-desktop') },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: APP_NAME,
    icon: ICON_PATH,
    backgroundColor: '#050505',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      // Chromium throttles timers and requestAnimationFrame for windows it
      // considers occluded or hidden, and Electron enables that by default.
      // Douyin's own dialogs close from a timer-driven state update (for example
      // the "是否保存登录信息？" prompt), so once throttling kicks in the dialog
      // stays on screen and its mask keeps swallowing clicks - the page looks
      // frozen and only a reload recovers. Opening DevTools also clears it, which
      // is the tell-tale sign: DevTools is what disables throttling.
      // A desktop shell has exactly one window; it should never throttle it.
      backgroundThrottling: false,
    },
  });

  attachResponsivenessHandlers(mainWindow.webContents);
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(HOME_URL);
  mainWindow.setTitle(APP_NAME);
}

/**
 * Turn a frozen page into a one-click recovery.
 *
 * Douyin's own dialogs can leave the page unresponsive: its "是否保存登录信息？"
 * prompt hides itself and *then* runs the caller's confirm/cancel handler, so if
 * that handler blocks, the hide never renders and the dialog's mask keeps
 * swallowing clicks. Waiting out the countdown works because that path never runs
 * the handler at all.
 *
 * The main process keeps running while the renderer is blocked, so Chromium tells
 * us about it and we can offer a reload instead of leaving a dead window that the
 * user has to fix by hand.
 */
function attachResponsivenessHandlers(contents) {
  let prompting = false;
  let graceTimer = null;

  const clearGrace = () => {
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  contents.on('unresponsive', () => {
    console.warn('[抖音] 页面无响应');
    if (prompting) return;
    // Give it a moment: a long synchronous task is not the same as a dead page,
    // and a prompt for every hiccup would be worse than the hiccup.
    clearGrace();
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (contents.isDestroyed()) return;
      prompting = true;
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['继续等待', '重新加载页面'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        title: '页面无响应',
        message: '抖音页面暂时无响应。',
        detail: '这通常是网页自身脚本卡住（例如弹窗按钮的处理逻辑出错）。重新加载页面即可恢复。',
      }).then((result) => {
        prompting = false;
        if (result.response === 1 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }).catch((error) => {
        prompting = false;
        console.error('[抖音] 页面无响应提示失败', error);
      });
    }, 5000);
  });

  contents.on('responsive', () => {
    // Recovered on its own - cancel the pending prompt.
    clearGrace();
    if (!prompting) console.info('[抖音] 页面已恢复响应');
  });
}

app.on('web-contents-created', (_event, contents) => configureWebContents(contents));

// A dying GPU process can leave Chromium mis-classifying the window's visibility,
// which is what makes throttling kick in in the first place. Surface it instead of
// letting it look like a random freeze.
app.on('child-process-gone', (_event, details) => {
  if (details?.type === 'GPU') {
    console.error(`[抖音] GPU 进程异常退出（${details.reason}），页面可能被节流导致弹窗无响应`);
  }
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.yhgeo.douyin');

  ipcMain.on('get-script-enabled', (event) => { event.returnValue = readSettings().scriptEnabled; });
  ipcMain.on('gm-menu-reset', () => {
    userscriptMenuCommands.clear();
    scheduleMenuRebuild();
  });
  ipcMain.on('gm-menu-register', (_event, command) => {
    if (!command?.id || !command?.name) return;
    userscriptMenuCommands.set(command.id, { id: command.id, name: String(command.name) });
    scheduleMenuRebuild();
  });
  ipcMain.on('gm-menu-unregister', (_event, id) => {
    userscriptMenuCommands.delete(id);
    scheduleMenuRebuild();
  });
  // Surface a failed bundle injection instead of leaving it buried in the
  // renderer console, because a failed injection looks like "settings do nothing".
  ipcMain.on('userscript-loaded', (_event, state) => {
    userscriptLoadState = { ok: Boolean(state?.ok), message: state?.message };
    if (!userscriptLoadState.ok) console.error(`[抖音] 内置脚本加载失败：${state?.message}`);
    scheduleMenuRebuild();
  });
  ipcMain.on('userscript-storage-error', (_event, info) => {
    console.error(`[抖音] 脚本配置${info?.phase === 'read' ? '读取' : '保存'}失败：${info?.message}`);
  });

  // Userscript GM_* storage. `gm-store-read` is synchronous because the
  // userscript calls GM_getValue synchronously; writes are fire-and-forget and
  // persisted immediately by GmStore.
  ipcMain.on('gm-store-read', (event) => {
    event.returnValue = { values: userscriptStore.getAll(), initialized: userscriptStore.initialized };
  });
  ipcMain.on('gm-store-import', (_event, values) => {
    userscriptStore.replaceAll(values);
  });
  ipcMain.on('gm-store-set', (_event, { key, value, source }) => {
    const { oldValue } = userscriptStore.set(key, value);
    broadcastStoreChange({ key, value, oldValue, source });
  });
  ipcMain.on('gm-store-delete', (_event, { key, source }) => {
    const { oldValue } = userscriptStore.delete(key);
    broadcastStoreChange({ key, oldValue, deleted: true, source });
  });
  ipcMain.handle('gm-http-request', async (_event, options) => {
    try {
      const result = await requestUrl(options.url, options);
      return {
        ok: true,
        status: result.status,
        statusText: result.statusText,
        headers: Object.entries(result.headers)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n'),
        responseText: result.body.toString('utf8'),
        response: result.body.toString('utf8'),
      };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
  ipcMain.on('gm-download', (_event, { url }) => {
    if (mainWindow && url && isWebUrl(url)) mainWindow.webContents.downloadURL(url);
  });

  buildMenu();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
