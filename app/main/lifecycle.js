'use strict';

/**
 * Application lifecycle: what happens before the first window, and around quitting.
 *
 * This is the only module that talks to `app` at the top level. Everything it starts is
 * imported explicitly, so reading this file top to bottom is reading the startup order.
 */

const { BrowserWindow, app, session } = require('electron');
const { APP_NAME, USER_DATA } = require('../platform/constants');
const log = require('../diagnostics/logger');
const { hardenWebContents } = require('../platform/web-contents-guard');
const { logBlockedRequest, openExternalSafely } = require('../platform/external-links');
const { registerIpcHandlers } = require('./ipc');
const { buildMenu } = require('./menu');
const { createWindow, getMainWindow } = require('./window');

/**
 * A plain browser User-Agent.
 *
 * Electron appends `<productName>/<version>` to the default UA, and this app is named
 * 抖音 - so it was announcing itself as `... 抖音/0.1.x Chrome/...`, a malformed
 * Douyin-app identity that a web page has no business claiming. Measured while a profile
 * was stuck: that UA got `application/json` with zero bytes back while a plain Chrome UA
 * got the HTML page. Removing just that token is the minimal change; everything else is
 * what Chromium would send anyway.
 */
function browserUserAgent() {
  const major = String(process.versions.chrome || '').split('.')[0] || '120';
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Which build is this, and where does it keep its files?
 *
 * Worth recording because several builds share one profile: `npm start`, the installed
 * app and the portable executable all resolve `userData` from the package name, so
 * "which one is running?" is a real question, and it is answered by the log rather than
 * by guessing.
 */
function describeRunMode() {
  return {
    mode: app.isPackaged ? 'packaged' : 'development',
    // electron-builder's portable target sets these; the installed build does not.
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR || null,
    execPath: process.execPath,
    userData: USER_DATA,
  };
}

/** Apply the policy that keeps custom schemes away from the OS, to every window. */
function configureWebContents(contents) {
  hardenWebContents(contents, {
    openExternal: openExternalSafely,
    onBlocked: logBlockedRequest,
    title: APP_NAME,
  });
}

/**
 * Two processes against one Chromium profile is not supported: the second one gets
 * inconsistent LevelDB stores and the damage survives restarts. The packaged app and
 * `npm start` share a profile, so this is easy to hit by accident - and a half-written
 * `Local Storage/leveldb` is exactly what the black-screen bug looked like on disk.
 *
 * @returns {boolean} whether this process owns the profile
 */
function claimProfile() {
  const ownsProfile = app.requestSingleInstanceLock();
  if (!ownsProfile) {
    // Actionable on purpose: this is the one way the lock can confuse someone who
    // restarted to pick up a new build, and it exits silently otherwise.
    log.warn('抖音已经在运行，本次启动退出（要加载新版本，请先完全退出正在运行的窗口，再重新启动）');
    app.quit();
  }
  return ownsProfile;
}

function registerAppEvents(ownsProfile) {
  app.on('second-instance', () => {
    const window = getMainWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  // Let Chromium flush its stores on the way out; an unclean exit is how the on-disk
  // state ends up half-written in the first place.
  app.on('before-quit', () => {
    try {
      session.defaultSession.flushStorageData();
      session.defaultSession.cookies.flushStore().catch(() => {});
    } catch {
      // Already shutting down.
    }
  });

  app.on('web-contents-created', (_event, contents) => configureWebContents(contents));

  // A dying GPU process can leave Chromium mis-classifying the window's visibility, which
  // is what makes throttling kick in in the first place. Surface it instead of letting it
  // look like a random freeze.
  app.on('child-process-gone', (_event, details) => {
    if (details?.type === 'GPU') {
      log.error('GPU 进程异常退出，页面可能被节流', { reason: details.reason });
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (ownsProfile && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/** Command line switches that must be set before Chromium reads them. */
function applyCommandLineSwitches() {
  app.setName(APP_NAME);
  app.commandLine.appendSwitch('lang', 'zh-CN');

  // Chromium throttles timers and requestAnimationFrame for windows it considers occluded
  // or hidden. Douyin's dialogs close from a state update that this throttling can stall,
  // which leaves the dialog and its mask stuck over the page (see recovery/responsiveness).
  // `backgroundThrottling: false` covers the main window, but Douyin opens helper windows
  // of its own - those would still be throttled - so turn it off for every window.
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

/** Start the app. Safe to call once, at the end of app/main.js. */
async function start() {
  applyCommandLineSwitches();
  const ownsProfile = claimProfile();
  registerAppEvents(ownsProfile);

  await app.whenReady();
  if (!ownsProfile) return;

  app.setAppUserModelId('com.yhgeo.douyin');
  session.defaultSession.setUserAgent(browserUserAgent());
  log.info('启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userAgent: browserUserAgent(),
    logFile: log.path,
    ...describeRunMode(),
  });

  registerIpcHandlers();
  buildMenu();
  await createWindow();
}

module.exports = { browserUserAgent, describeRunMode, start };
