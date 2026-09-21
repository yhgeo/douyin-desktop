'use strict';

/**
 * The actions behind the 工具 menu - the ones a user reaches for when something is
 * already wrong.
 *
 * Kept together because they share a shape: confirm, do one decisive thing, tell the
 * user what happened. Each one exists because a specific failure had no in-page escape.
 */

const { dialog, session } = require('electron');
const log = require('../diagnostics/logger');
const { getMainWindow } = require('./window');
const { broadcast } = require('./broadcast');
const { clearCommands, resetLoadState, scheduleMenuRebuild } = require('./userscript-menu');
const { userscriptStore } = require('../storage/userscript-store');
const {
  ANTI_CRAWL_COOKIE_REMOVAL,
  isAntiCrawlCookieRemovalOn,
  withoutAntiCrawlCookieRemoval,
} = require('../storage/harmful-settings');
const {
  DOUYIN_ORIGIN,
  LADDER,
  PROBE: BLANK_PAGE_PROBE,
  applyLadderStep,
  isBlankDocument,
} = require('../recovery/blank-page');

let stuckDialogRecoveryPending = null;

/**
 * Ask the page to dismiss a stuck Douyin dialog.
 *
 * The prompt's own close path waits on an async call that can never settle, which leaves
 * every button disabled behind a full-screen mask. The page side reuses Douyin's
 * synchronous cleanup (the one its countdown uses); see recovery/stuck-dialog.js.
 */
function requestStuckDialogRecovery() {
  const window = getMainWindow();
  if (!window) return;
  if (stuckDialogRecoveryPending) return;
  stuckDialogRecoveryPending = setTimeout(() => { stuckDialogRecoveryPending = null; }, 4000);
  window.webContents.send('recover-stuck-dialog');
}

/** Called when the page answers, so the "nothing to do" message is not shown twice. */
function settleStuckDialogRecovery() {
  clearTimeout(stuckDialogRecoveryPending);
  stuckDialogRecoveryPending = null;
}

/**
 * Repair a window that loaded an empty document.
 *
 * Douyin refuses to serve the page when its persisted site state is damaged, and the
 * window stays black across reloads and restarts. Clearing the site's non-cookie storage
 * lets the anti-crawl challenge run from scratch again; the login survives. See
 * recovery/blank-page.js for the measurements behind this.
 */
async function repairUnloadablePage() {
  const window = getMainWindow();
  if (!window) return;
  const contents = window.webContents;

  let blank = false;
  try {
    blank = isBlankDocument(await contents.executeJavaScript(BLANK_PAGE_PROBE, true));
  } catch {
    // Not readable; still worth a plain reload.
  }

  if (blank) {
    // The manual action is the thorough one: run the whole ladder instead of starting at
    // the gentlest rung.
    try {
      const applied = await applyLadderStep(session.defaultSession, DOUYIN_ORIGIN, LADDER.length);
      log.warn('手动修复：已清除站点数据', applied);
    } catch (error) {
      log.error('手动修复失败', { error: String((error && error.message) || error) });
    }
  } else {
    log.info('手动修复：页面正常，仅强制重载');
  }

  if (!contents.isDestroyed()) contents.reloadIgnoringCache();
}

/** Wipe Douyin's site data, including the login. The script configuration is untouched. */
async function clearDouyinSiteData() {
  const window = getMainWindow();
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['取消', '清除'],
    defaultId: 0,
    cancelId: 0,
    title: '清除抖音网页数据',
    message: '这会清除登录状态、Cookie、网页缓存和网页本地数据。',
    detail: '「抖音优化」的脚本配置会保留。确定继续吗？',
  });
  if (result.response !== 1) return;

  // Script configuration lives in the main process, not in site storage, so it is
  // untouched by this.
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  getMainWindow()?.webContents.reload();
}

/** Wipe the userscript's stored configuration and restart it cleanly. */
function clearUserscriptData() {
  userscriptStore.clear();
  broadcast('gm-store-replaced', {});
  clearCommands();
  resetLoadState();
  scheduleMenuRebuild();
  getMainWindow()?.webContents.reload();
}

/**
 * Turn off the one script setting known to break this app.
 *
 * A menu action rather than a silent fix. The switch belongs to the user and rewriting their
 * configuration without asking is not this app's business - but neither is leaving them to
 * rediscover it from the README while staring at a black window, which is exactly what
 * happened. See storage/harmful-settings.js for what the setting does and how it was pinned
 * down.
 *
 * The change is broadcast rather than left for the next launch: the page side caches the
 * store, so without the broadcast the switch would look like it had no effect until a restart.
 */
async function disableAntiCrawlCookieRemoval() {
  const window = getMainWindow();
  const values = userscriptStore.getAll();

  if (!isAntiCrawlCookieRemovalOn(values)) {
    if (window) {
      await dialog.showMessageBox(window, {
        type: 'info',
        noLink: true,
        buttons: ['好'],
        title: '无需处理',
        message: '「移除某些Cookie」本来就是关闭的。',
      });
    }
    return;
  }

  userscriptStore.replaceAll(withoutAntiCrawlCookieRemoval(values));
  broadcast('gm-store-replaced', userscriptStore.getAll());
  log.warn('已关闭「移除某些Cookie」', { setting: ANTI_CRAWL_COOKIE_REMOVAL });

  if (!window) return;
  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    noLink: true,
    buttons: ['重新加载页面', '稍后'],
    defaultId: 0,
    cancelId: 1,
    title: '已关闭「移除某些Cookie」',
    message: '这个开关会删除抖音的反爬签名 cookie，是页面加载为空（黑屏）的已知原因。',
    detail: '已经关掉了。重新加载页面让它立即生效；页面本身已经是好的就不用管。',
  });
  if (response === 0) window.webContents.reloadIgnoringCache();
}

module.exports = {
  clearDouyinSiteData,
  clearUserscriptData,
  disableAntiCrawlCookieRemoval,
  repairUnloadablePage,
  requestStuckDialogRecovery,
  settleStuckDialogRecovery,
};
