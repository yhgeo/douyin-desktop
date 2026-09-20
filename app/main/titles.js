'use strict';

/**
 * What the window title says about a repair state.
 *
 * Pulled out of main/window.js because that module requires `electron`, which makes
 * anything inside it untestable from a plain unit test - and these strings are the only
 * thing a user sees while the app is not working, so they are worth pinning.
 *
 * The rule they follow: say what is happening, and when it is not something this app can
 * fix, say that too. "Auto-repairing" forever is a lie; "waiting for the server" is not.
 *
 * A black window with no explanation is what makes people force-quit the app - which is
 * exactly what happened on 2026-09-20, three seconds into a repair that was working.
 */

const { APP_NAME } = require('../platform/script-meta');

/**
 * @param {{ phase: string, round?: number }} status
 * @returns {string}
 */
function titlesFor(status) {
  if (!status || typeof status.phase !== 'string') return APP_NAME;

  switch (status.phase) {
    case 'repairing':
      return `${APP_NAME} — 页面加载异常，正在自动修复（第 ${status.round} 次）`;
    case 'waiting-for-server':
      // Past the ladder: nothing local is wrong any more, and retrying harder is what
      // made the server less willing in the first place.
      return `${APP_NAME} — 服务器暂时没有返回页面，正在等待重试（第 ${status.round} 次）`;
    case 'captcha':
      return `${APP_NAME} — 服务器要求人机验证，请在页面中完成验证`;
    default:
      return APP_NAME;
  }
}

module.exports = { titlesFor };
