'use strict';

/**
 * Record what a window actually does, so a failure can be reconstructed afterwards.
 *
 * Two measurements shaped this:
 *
 *  - only warning/error console output is captured, because the bundled userscript
 *    logs heavily at info level and would drown everything else;
 *  - identical messages are collapsed within a window. Measured on the real site, the
 *    same CSP warning arrives once per offending script (nine copies, nine different
 *    sources) and the APM SDK logs `[SDK] <epoch-ms> 0 already inited`, which looks
 *    unique every single time. Keying on the raw message and its source therefore
 *    deduplicated nothing at all until the varying parts were normalised away.
 */

/** Identical renderer console messages are collapsed within this window. */
const CONSOLE_DEDUPE_MS = 60000;

/** Stop growing the dedupe map if a page goes wild with distinct messages. */
const MAX_TRACKED_MESSAGES = 200;

/** Console levels worth keeping. The userscript logs heavily at info level. */
const NOTEWORTHY_LEVELS = new Set(['warning', 'error', 2, 3]);

/**
 * Strip the parts of a message that change on every occurrence.
 *
 * The full original message is still what gets written - this only decides identity.
 */
function normalizeForDedupe(message) {
  return message.replace(/\d{4,}/g, '#');
}

/**
 * Is this navigation worth a line in the log?
 *
 * Only real web navigations are. The loading document in main/window.js is a `data:` URL
 * and runs to several kilobytes (it carries the logo inline), so logging it would put that
 * whole string in the log on every launch - once per navigation event. It is also not a
 * page the user asked for, so a failure to show it is not something to report either.
 */
function isLoggableNavigation(url) {
  return /^https?:/i.test(String(url || ''));
}

/**
 * @param {Electron.WebContents} contents
 * @param {ReturnType<import('./log-file').createLogFile>} log
 * @param {{ dedupeMs?: number }} [options]
 * @returns {() => void} detaches
 */
function attachPageDiagnostics(contents, log, options = {}) {
  const dedupeMs = Number.isFinite(options.dedupeMs) ? options.dedupeMs : CONSOLE_DEDUPE_MS;
  /** `${level}|${normalizedMessage}` -> { lastLoggedAt, suppressed } */
  const seenMessages = new Map();
  /**
   * The last URL whose navigation was logged.
   *
   * Reloading the URL you are already on is what a repair does, and it is the same page
   * coming back - so logging it again every round (and every time the user hits refresh)
   * only buries the lines that matter. A change of URL is real navigation and is logged.
   */
  let lastLoggedUrl = null;

  const onStart = (event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    if (!isLoggableNavigation(url)) return;
    if (url === lastLoggedUrl) return;
    log.info('开始导航', { url });
  };

  const onFinish = () => {
    const url = contents.getURL();
    if (!isLoggableNavigation(url)) return;
    if (url === lastLoggedUrl) return;
    lastLoggedUrl = url;
    log.info('页面加载完成', { url });
  };

  const onFail = (event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 is ERR_ABORTED, which every ordinary navigation produces on its way out.
    if (errorCode === -3) return;
    if (!isLoggableNavigation(validatedUrl)) return;
    log.warn('页面加载失败', { url: validatedUrl, errorCode, errorDescription });
  };

  const onConsole = (...args) => {
    // Electron changed this signature; support both shapes.
    const details = typeof args[1] === 'object' && args[1] !== null ? args[1] : null;
    const level = details ? details.level : args[1];
    const message = String((details ? details.message : args[2]) || '');
    const line = details ? details.lineNumber : args[3];
    const source = String((details ? details.sourceId : args[4]) || '');
    if (!NOTEWORTHY_LEVELS.has(level)) return;

    const key = `${level}|${normalizeForDedupe(message)}`;
    const now = Date.now();
    const previous = seenMessages.get(key);
    if (previous && now - previous.lastLoggedAt < dedupeMs) {
      previous.suppressed += 1;
      return;
    }

    const suppressed = previous ? previous.suppressed : 0;
    if (seenMessages.size > MAX_TRACKED_MESSAGES) seenMessages.clear();
    seenMessages.set(key, { lastLoggedAt: now, suppressed: 0 });

    log.warn('页面控制台', {
      level,
      message: message.slice(0, 500),
      source,
      line,
      ...(suppressed ? { suppressedSinceLast: suppressed } : {}),
    });
  };

  const onRendererGone = (event, details) => {
    log.error('渲染进程退出', { reason: details?.reason, exitCode: details?.exitCode });
  };

  const onUnresponsive = () => log.warn('页面无响应');
  const onResponsive = () => log.info('页面恢复响应');

  contents.on('did-start-navigation', onStart);
  contents.on('did-finish-load', onFinish);
  contents.on('did-fail-load', onFail);
  contents.on('console-message', onConsole);
  contents.on('render-process-gone', onRendererGone);
  contents.on('unresponsive', onUnresponsive);
  contents.on('responsive', onResponsive);

  return () => {
    contents.removeListener('did-start-navigation', onStart);
    contents.removeListener('did-finish-load', onFinish);
    contents.removeListener('did-fail-load', onFail);
    contents.removeListener('console-message', onConsole);
    contents.removeListener('render-process-gone', onRendererGone);
    contents.removeListener('unresponsive', onUnresponsive);
    contents.removeListener('responsive', onResponsive);
  };
}

module.exports = {
  CONSOLE_DEDUPE_MS,
  MAX_TRACKED_MESSAGES,
  NOTEWORTHY_LEVELS,
  attachPageDiagnostics,
  isLoggableNavigation,
  normalizeForDedupe,
};
