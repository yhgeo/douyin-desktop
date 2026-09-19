const { app, BrowserWindow, Menu, session, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

const APP_NAME = '抖音';
const HOME_URL = 'https://www.douyin.com/';
const SCRIPT_NAME = '抖音优化';
const ICON_PATH = path.join(__dirname, '..', 'assets', 'douyin-icon.png');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const userscriptMenuCommands = new Map();
let mainWindow;
let rebuildMenuTimer;

app.setName(APP_NAME);
app.commandLine.appendSwitch('lang', 'zh-CN');

function readSettings() {
  try {
    return { scriptEnabled: true, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
  } catch {
    return { scriptEnabled: true };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
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

function isDouyinHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return ['http:', 'https:'].includes(url.protocol)
      && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')
        || url.hostname === 'iesdouyin.com' || url.hostname.endsWith('.iesdouyin.com'));
  } catch {
    return false;
  }
}

function isWebUrl(rawUrl) {
  try { return ['http:', 'https:'].includes(new URL(rawUrl).protocol); } catch { return false; }
}

function configureWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isDouyinHttpUrl(url)) return { action: 'allow' };
    if (isWebUrl(url)) shell.openExternal(url);
    // Do not hand custom schemes such as bytedance:// to Windows. Doing so causes
    // the system "Get an app to open this link" dialog shown by the user.
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isWebUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isWebUrl(url)) event.preventDefault();
  });
  contents.on('page-title-updated', (event) => {
    event.preventDefault();
    BrowserWindow.fromWebContents(contents)?.setTitle(APP_NAME);
  });
}

function findUserscriptCommand(namePattern) {
  return [...userscriptMenuCommands.values()].find((item) => namePattern.test(item.name));
}

function invokeUserscriptCommand(command) {
  if (!command || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('invoke-gm-menu-command', command.id);
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
  ];

  if (extraScriptCommands.length) {
    scriptSubmenu.push({ type: 'separator' });
    for (const command of extraScriptCommands) {
      scriptSubmenu.push({ label: command.name, click: () => invokeUserscriptCommand(command) });
    }
  }

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
    {
      label: '工具',
      submenu: [
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
        {
          label: '清除抖音站点数据',
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['取消', '清除'],
              defaultId: 0,
              cancelId: 0,
              title: '清除站点数据',
              message: '这会清除登录状态、Cookie 和本地设置。确定继续吗？',
            });
            if (result.response !== 1) return;
            await session.defaultSession.clearStorageData();
            mainWindow?.webContents.reload();
          },
        },
        { type: 'separator' },
        { label: '退出抖音', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '抖音优化脚本主页', click: () => shell.openExternal('https://scriptcat.org/zh-CN/script-show-page/2534') },
        { label: '项目仓库', click: () => shell.openExternal('https://github.com/yhgeo/douyin-desktop') },
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
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(HOME_URL);
  mainWindow.setTitle(APP_NAME);
}

app.on('web-contents-created', (_event, contents) => configureWebContents(contents));

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
