'use strict';

/**
 * The main window, and everything that has to be wired to it.
 *
 * This module owns the window reference so no other module has to. Everything that
 * watches the page - navigation diagnostics, the blank-page repair, the frozen-page
 * prompt - is attached here, in one place, which is also the only place that needs to
 * know the web preferences and why they are what they are.
 */

const path = require('node:path');
const { BrowserWindow, dialog, session } = require('electron');
const { APP_NAME, HOME_URL, ICON_PATH } = require('../platform/constants');
const log = require('../diagnostics/logger');
const { attachPageDiagnostics } = require('../diagnostics/page-diagnostics');
const { attachResponsivenessHandlers } = require('../recovery/responsiveness');
const { attachBlankPageRecovery } = require('../recovery/blank-page');
const { titlesFor } = require('./titles');
const { setRepairStatus } = require('./title-state');

let mainWindow = null;

/** The live window, or null while it is being created or already gone. */
function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/**
 * Offer a reload when the renderer really is blocked.
 *
 * Douyin's own dialogs can leave the page unresponsive (recovery/responsiveness.js
 * explains the chain), so the alternative to this prompt is a dead window.
 */
function attachFrozenPageRecovery(contents) {
  return attachResponsivenessHandlers(contents, {
    confirmReload: async () => {
      const result = await dialog.showMessageBox(getMainWindow(), {
        type: 'warning',
        buttons: ['继续等待', '重新加载页面'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        title: '页面无响应',
        message: '抖音页面暂时无响应。',
        detail: '这通常是网页自身脚本卡住（例如弹窗按钮的处理逻辑出错）。重新加载页面即可恢复。',
      });
      return result.response === 1;
    },
    log: (message, error) => log.error(message, { error: String((error && error.message) || error) }),
  });
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
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      // Chromium throttles timers and requestAnimationFrame for windows it considers
      // occluded or hidden, and Electron enables that by default. Douyin's own dialogs
      // close from a timer-driven state update (the "是否保存登录信息？" prompt), so once
      // throttling kicks in the dialog stays on screen and its mask keeps swallowing
      // clicks - the page looks frozen and only a reload recovers. Opening DevTools also
      // clears it, which is the tell-tale sign: DevTools is what disables throttling.
      // A desktop shell has exactly one window; it should never throttle it.
      backgroundThrottling: false,
    },
  });

  attachFrozenPageRecovery(mainWindow.webContents);
  attachPageDiagnostics(mainWindow.webContents, log);
  attachBlankPageRecovery(mainWindow.webContents, {
    session: session.defaultSession,
    log: (level, message, data) => log[level]?.(message, data),
    // A black window with no feedback reads as a frozen app, and a user who thinks it is
    // frozen closes it - which is exactly what happened on 2026-09-20 21:45, three
    // seconds into a repair that was working. Say what is going on in the title bar.
    onStatus: (status) => {
      const window = getMainWindow();
      if (!window) return;
      // Recorded as well as displayed: web-contents-guard.js answers every
      // page-title-updated with the same lookup, so the page cannot wipe the notice.
      setRepairStatus(window.webContents, status);
      window.setTitle(titlesFor(status));
    },
    onRecovered: (info) => {
      if (info.failed) {
        log.error('无法清除站点数据', { round: info.round, error: info.failed });
        return;
      }
      log.warn('页面加载为空，已清除站点数据并重新加载', {
        round: info.round,
        actions: info.actions,
        removedCookies: info.removedCookies,
      });
    },
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(HOME_URL);
  mainWindow.setTitle(APP_NAME);
  return mainWindow;
}

module.exports = { createWindow, getMainWindow };
