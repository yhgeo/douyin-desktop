'use strict';

/**
 * The single place the app is allowed to hand a URL to the operating system.
 *
 * This exists because of one Windows dialog: an unhandled custom scheme such as
 * `bytedance://` makes Windows ask "需要新应用以打开此链接". Routing every external
 * hand-off through here means no caller can trigger it by accident - and the check is
 * on the URL, not on the caller's intentions.
 */

const { shell } = require('electron');
const { isWebUrl } = require('./url-policy');
const log = require('../diagnostics/logger');

/**
 * @param {string} rawUrl
 * @returns {boolean} whether the URL was handed over
 */
function openExternalSafely(rawUrl) {
  if (!isWebUrl(rawUrl)) {
    log.warn('已拦截外部协议调用', { url: rawUrl });
    return false;
  }
  shell.openExternal(rawUrl).catch((error) => {
    log.error('打开外部链接失败', { url: rawUrl, error: String((error && error.message) || error) });
  });
  return true;
}

/** Report a navigation or popup the URL policy refused. */
function logBlockedRequest(info) {
  const kind = info.reason === 'popup-blocked' ? '弹窗' : '跳转';
  log.warn(`已拦截${kind}`, { reason: info.reason, kind: info.kind, url: info.url });
}

module.exports = { logBlockedRequest, openExternalSafely };
