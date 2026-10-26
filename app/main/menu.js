'use strict';

/**
 * The application menu.
 *
 * The script submenu is dynamic: the userscript registers its own entries at runtime
 * (settings, mobile settings, and whatever else it exposes), so the menu is rebuilt
 * whenever that list changes - see userscript-menu.js for the registry and the debounce.
 */

const { Menu, shell } = require('electron');
const path = require('node:path');
const { APP_NAME, HOME_URL, SCRIPT_NAME } = require('../platform/constants');
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
  disableAntiCrawlCookieRemoval,
  repairUnloadablePage,
  requestStuckDialogRecovery,
  saveCurrentFrame,
  showAbout,
} = require('./actions');
const { exportUserscriptConfig, importUserscriptConfig } = require('./userscript-config');
const { applyPreset } = require('./presets');
const { loadPresets } = require('../storage/presets');

function invokeUserscriptCommand(command) {
  const window = getMainWindow();
  if (!command || !window) return;
  window.webContents.send('invoke-gm-menu-command', command.id);
}

/** Where the shipped presets live; also the folder the menu offers to open. */
const PRESET_DIR = path.join(__dirname, '..', '..', 'assets', 'presets');

/**
 * 预设配置 ▸ …
 *
 * Built from whatever JSON files are in `assets/presets`, so adding a preset is adding a
 * file (the same format as 导出配置). A file that cannot be parsed still appears, disabled,
 * with the reason as its label - a preset that silently vanished would look like the menu
 * is broken.
 */
function buildPresetSubmenu() {
  const presets = loadPresets(PRESET_DIR);
  const items = presets.map((preset) => (preset.ok
    ? {
      label: preset.name,
      click: () => { applyPreset(preset); },
    }
    : {
      label: `${preset.name}（不可用：${preset.error}）`,
      enabled: false,
    }));

  if (items.length) items.push({ type: 'separator' });
  items.push({
    label: '打开预设文件夹…',
    click: () => { shell.openPath(PRESET_DIR).catch(() => {}); },
  });

  return { label: '预设配置', submenu: items };
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
    buildPresetSubmenu(),
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

/**
 * The 工具 menu.
 *
 * Ordered by what someone reaching for this menu needs, not by what the code is: the recovery
 * actions first (something is wrong right now), then the log (so they can report it), then the
 * destructive clears, and developer tools last - they are not a user action, and having them
 * at the top made the menu read as a developer menu.
 *
 * The long label is deliberate and worth the width: "移除某些Cookie" is a switch in the script's
 * own panel, and nobody staring at a black window would guess that is where the cause is. The
 * parenthetical is what makes it findable.
 */
function buildToolSubmenu() {
  return [
    { label: '关闭卡住的弹窗', click: () => requestStuckDialogRecovery() },
    { label: '修复无法加载的页面', click: () => repairUnloadablePage() },
    { label: '关闭「移除某些Cookie」（黑屏的已知原因）', click: () => disableAntiCrawlCookieRemoval() },
    { type: 'separator' },
    { label: '打开运行日志', click: () => { shell.openPath(log.path).catch(() => {}); } },
    // The one thing a DOM probe cannot record: what the pixels actually look like.
    { label: '保存当前画面（截图）', click: () => { saveCurrentFrame(); } },
    {
      // Off by default: it samples while the user watches, so it is something you switch on
      // to reproduce a bug and switch off afterwards. See diagnostics/player-probe.js.
      label: '记录播放器诊断（复现问题时打开）',
      type: 'checkbox',
      checked: Boolean(readSettings().playerProbe),
      click: (item) => {
        writeSettings({ ...readSettings(), playerProbe: item.checked });
        getMainWindow()?.webContents.send('player-probe-set', item.checked);
        if (item.checked) log.info('播放器诊断已开启：滚动几个视频后到日志里找「播放器诊断」');
      },
    },
    { type: 'separator' },
    { label: '清除抖音网页数据…', click: () => clearDouyinSiteData() },
    { label: '清除脚本配置数据…', click: () => clearUserscriptData() },
    { type: 'separator' },
    { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => getMainWindow()?.webContents.toggleDevTools() },
    { type: 'separator' },
    { label: '退出抖音', accelerator: 'Alt+F4', role: 'quit' },
  ];
}

function buildHelpSubmenu() {
  return [
    {
      label: '使用说明',
      click: () => openExternalSafely('https://github.com/yhgeo/douyin-desktop#readme'),
    },
    { label: '抖音优化脚本主页', click: () => openExternalSafely('https://scriptcat.org/zh-CN/script-show-page/2534') },
    { label: '项目仓库', click: () => openExternalSafely('https://github.com/yhgeo/douyin-desktop') },
    { type: 'separator' },
    // Version and the data directory in one place. Both get asked for whenever something goes
    // wrong, and both used to require opening a log file and reading its first lines.
    { label: `关于 ${APP_NAME}`, click: () => showAbout() },
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
      label: '体验增强',
      submenu: [
        {
          label: '启用网页抖音体验增强（5.7）',
          type: 'checkbox',
          checked: readSettings().experienceEnhancerEnabled === true,
          click: (item) => {
            if (!writeSettings({ ...readSettings(), experienceEnhancerEnabled: item.checked })) {
              item.checked = !item.checked;
              return;
            }
            getMainWindow()?.webContents.reload();
          },
        },
        { label: '启用后在视频工具栏调整功能与设置', enabled: false },
        { label: '含跳过直播、关键词屏蔽、画质选择；同类功能请只开一套', enabled: false },
        { type: 'separator' },
        { label: '脚本主页与更新说明', click: () => openExternalSafely('https://greasyfork.org/zh-CN/scripts/539942') },
      ],
    },
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
    { label: '帮助', submenu: buildHelpSubmenu() },
  ]);
  Menu.setApplicationMenu(menu);
  return menu;
}

// Hand the builder to the registry so anything that changes the command list can ask for
// a rebuild without importing this module.
setMenuBuilder(buildMenu);

module.exports = { buildMenu };
