'use strict';

/**
 * The application menu.
 *
 * The script submenu is dynamic: the userscript registers its own entries at runtime
 * (settings, mobile settings, and whatever else it exposes), so the menu is rebuilt
 * whenever that list changes - see userscript-menu.js for the registry and the debounce.
 */

const { Menu, shell } = require('electron');
const { HOME_URL, SCRIPT_NAME } = require('../platform/constants');
const log = require('../diagnostics/logger');
const { openExternalSafely } = require('../platform/external-links');
const { readSettings, writeSettings } = require('../storage/settings');
const {
  clearCommands,
  findCommand,
  getLoadState,
  listCommands,
  resetLoadState,
  scheduleMenuRebuild,
  setMenuBuilder,
} = require('./userscript-menu');
const { getMainWindow } = require('./window');
const {
  clearDouyinSiteData,
  clearUserscriptData,
  repairUnloadablePage,
  requestStuckDialogRecovery,
} = require('./actions');
const { exportUserscriptConfig, importUserscriptConfig } = require('./userscript-config');

function invokeUserscriptCommand(command) {
  const window = getMainWindow();
  if (!command || !window) return;
  window.webContents.send('invoke-gm-menu-command', command.id);
}

function buildScriptSubmenu() {
  const settings = readSettings();
  const desktopSettings = findCommand(/^\s*⚙?\s*设置\s*$/);
  const mobileSettings = findCommand(/移动端设置/);
  const extraCommands = listCommands().filter(
    (item) => item.id !== desktopSettings?.id && item.id !== mobileSettings?.id,
  );

  const submenu = [
    {
      label: `启用${SCRIPT_NAME}`,
      type: 'checkbox',
      checked: settings.scriptEnabled,
      click: (item) => {
        writeSettings({ ...readSettings(), scriptEnabled: item.checked });
        clearCommands();
        resetLoadState();
        getMainWindow()?.webContents.reload();
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

  if (extraCommands.length) {
    submenu.push({ type: 'separator' });
    for (const command of extraCommands) {
      submenu.push({ label: command.name, click: () => invokeUserscriptCommand(command) });
    }
  }

  const loadState = getLoadState();
  if (loadState && !loadState.ok) {
    submenu.push({ type: 'separator' });
    submenu.push({
      label: `⚠ 内置脚本加载失败：${loadState.message || '未知错误'}`,
      enabled: false,
    });
  }

  return submenu;
}

function buildToolSubmenu() {
  return [
    {
      label: '开发者工具',
      accelerator: 'CmdOrCtrl+Shift+I',
      click: () => getMainWindow()?.webContents.toggleDevTools(),
    },
    { label: '关闭卡住的弹窗', click: () => requestStuckDialogRecovery() },
    { label: '修复无法加载的页面', click: () => repairUnloadablePage() },
    { label: '打开运行日志', click: () => { shell.openPath(log.path).catch(() => {}); } },
    { type: 'separator' },
    { label: '清除抖音网页数据', click: () => clearDouyinSiteData() },
    { label: '清除脚本配置数据', click: () => clearUserscriptData() },
    { type: 'separator' },
    { label: '退出抖音', accelerator: 'Alt+F4', role: 'quit' },
  ];
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: '导航',
      submenu: [
        { label: '抖音首页', accelerator: 'Alt+Home', click: () => getMainWindow()?.loadURL(HOME_URL) },
        { label: '后退', accelerator: 'Alt+Left', click: () => getMainWindow()?.webContents.goBack() },
        { label: '前进', accelerator: 'Alt+Right', click: () => getMainWindow()?.webContents.goForward() },
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => getMainWindow()?.webContents.reload() },
      ],
    },
    { label: SCRIPT_NAME, submenu: buildScriptSubmenu() },
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
    { label: '工具', submenu: buildToolSubmenu() },
    {
      label: '帮助',
      submenu: [
        { label: '抖音优化脚本主页', click: () => openExternalSafely('https://scriptcat.org/zh-CN/script-show-page/2534') },
        { label: '项目仓库', click: () => openExternalSafely('https://github.com/yhgeo/douyin-desktop') },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  return menu;
}

// Hand the builder to the registry so anything that changes the command list can ask for
// a rebuild without importing this module.
setMenuBuilder(buildMenu);

module.exports = { buildMenu };
