const { app, BrowserWindow, Menu, session, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

const HOME_URL = 'https://www.douyin.com/';
const SCRIPT_NAME = '抖音优化';
let mainWindow;
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: '抖音桌面版',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.)?(douyin\.com|iesdouyin\.com)\//i.test(url)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(HOME_URL);
}

function buildMenu() {
  const settings = readSettings();
  const menu = Menu.buildFromTemplate([
    {
      label: '导航',
      submenu: [
        { label: '抖音首页', click: () => mainWindow?.loadURL(HOME_URL) },
        { label: '后退', accelerator: 'Alt+Left', click: () => mainWindow?.webContents.goBack() },
        { label: '前进', accelerator: 'Alt+Right', click: () => mainWindow?.webContents.goForward() },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
      ],
    },
    {
      label: '应用',
      submenu: [
        {
          label: `${SCRIPT_NAME}（内置）`,
          type: 'checkbox',
          checked: settings.scriptEnabled,
          click: (item) => {
            const next = { ...readSettings(), scriptEnabled: item.checked };
            writeSettings(next);
            mainWindow?.webContents.reload();
          },
        },
        { type: 'separator' },
        { label: '打开开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.openDevTools() },
        {
          label: '清除抖音站点数据',
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow, {
              type: 'warning', buttons: ['取消', '清除'], defaultId: 0,
              title: '清除站点数据', message: '这会清除登录状态、Cookie 和本地设置。确定继续吗？',
            });
            if (result.response !== 1) return;
            await session.defaultSession.clearStorageData({ origins: ['https://www.douyin.com'] });
            mainWindow?.webContents.reload();
          },
        },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: '项目仓库', click: () => shell.openExternal('https://github.com/yhgeo/douyin-desktop') }] },
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
  ipcMain.on('get-script-enabled', (event) => { event.returnValue = readSettings().scriptEnabled; });
  ipcMain.handle('gm-http-request', async (_event, options) => {
    try {
      const result = await requestUrl(options.url, options);
      return {
        ok: true, status: result.status, statusText: result.statusText,
        headers: Object.entries(result.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\\r\\n'),
        responseText: result.body.toString('utf8'),
        response: result.body.toString('utf8'),
      };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
  ipcMain.on('gm-download', (event, { url }) => {
    if (mainWindow && url) mainWindow.webContents.downloadURL(url);
  });
  buildMenu();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
