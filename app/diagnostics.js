'use strict';

/**
 * Persistent diagnostics for the shell.
 *
 * Every recovery in this app exists because Douyin did something surprising, and
 * every one of them was hard to diagnose afterwards: the window was black, the
 * console output was gone, and the only evidence left was on disk. This module
 * writes that evidence down.
 *
 * It is deliberately small and boring - a rotating text file plus a few page
 * lifecycle hooks - because its value is being *there* when something goes wrong,
 * not in what it can do.
 *
 * Retention is sized against a measurement, not a guess. Left alone, capturing the
 * page's console output produced 22 lines in the first 75 seconds, and 15 of them
 * were the same CSP warning repeated - which would have rotated the file away every
 * couple of hours and buried whatever was actually useful. So identical messages are
 * collapsed into a counter, and the file is large enough to hold days of ordinary use.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Rotate at this size. With three files that is days of ordinary use. */
const MAX_BYTES = 2 * 1024 * 1024;

/** How many rotated files to keep (`main.log.1`, `main.log.2`, ...). */
const KEEP_ROTATED = 2;

/** Identical renderer console messages are collapsed within this window. */
const CONSOLE_DEDUPE_MS = 60000;

/** Stop growing the dedupe map if a page goes wild with distinct messages. */
const MAX_TRACKED_MESSAGES = 200;

/** Console levels worth keeping. The userscript logs heavily at info level. */
const NOTEWORTHY_LEVELS = new Set(['warning', 'error', 2, 3]);

/**
 * Strip the parts of a message that change on every occurrence.
 *
 * Measured on the real site: the same CSP warning is reported once per offending
 * script, so keying on the message *and* its source produced nine copies; and the
 * APM SDK logs `[SDK] <epoch-ms> 0 already inited`, which looks unique every time.
 * Both defeat deduplication unless the varying parts are normalised away.
 *
 * The full original message is still what gets written - this only decides identity.
 */
function normalizeForDedupe(message) {
  return message.replace(/\d{4,}/g, '#');
}

function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.`
    + `${pad(date.getMilliseconds(), 3)}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {object} options
 * @param {string} options.dir directory to write into (created if missing)
 * @param {string} [options.fileName]
 * @param {number} [options.maxBytes]
 * @param {number} [options.keep] rotated files to keep
 * @returns {{ path: string, rotatedPath: (i: number) => string, write: Function, info: Function, warn: Function, error: Function }}
 */
function createLogFile({ dir, fileName = 'main.log', maxBytes = MAX_BYTES, keep = KEEP_ROTATED }) {
  const filePath = path.join(dir, fileName);
  const rotatedPath = (index) => `${filePath}.${index}`;
  let broken = false;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    broken = true;
    // A logger that throws is worse than no logger.
    console.error('[抖音] 无法创建日志目录', dir, error);
  }

  const rotateIfNeeded = () => {
    try {
      if (fs.statSync(filePath).size < maxBytes) return;
    } catch {
      return; // No file yet.
    }
    try {
      // Oldest first, so nothing is dropped before it has been moved.
      for (let index = keep; index >= 1; index -= 1) {
        const from = index === 1 ? filePath : rotatedPath(index - 1);
        const to = rotatedPath(index);
        if (!fs.existsSync(from)) continue;
        if (index === keep && fs.existsSync(to)) fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
      }
    } catch {
      // A lost rotation is not worth failing a log line over.
    }
  };

  const write = (level, message, data) => {
    const line = `${stamp()} [${level}] ${message}${data === undefined ? '' : ` ${safeJson(data)}`}\n`;
    if (!broken) {
      try {
        rotateIfNeeded();
        fs.appendFileSync(filePath, line, 'utf8');
      } catch (error) {
        broken = true;
        console.error('[抖音] 写日志失败', filePath, error);
      }
    }
    // Mirror to the console so `npm start` shows the same story.
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(`[抖音] ${message}`, data === undefined ? '' : data);
  };

  return {
    path: filePath,
    rotatedPath,
    write,
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}

/**
 * Log what a window actually does, so a failure can be reconstructed later.
 *
 * Only warning/error console output is captured, and identical messages are collapsed
 * within `dedupeMs` - see the note at the top of the file for the measurement behind
 * that.
 *
 * @param {Electron.WebContents} contents
 * @param {ReturnType<typeof createLogFile>} log
 * @param {{ dedupeMs?: number }} [options]
 * @returns {() => void} detaches
 */
function attachPageDiagnostics(contents, log, options = {}) {
  const dedupeMs = Number.isFinite(options.dedupeMs) ? options.dedupeMs : CONSOLE_DEDUPE_MS;
  /** `${level}|${normalizedMessage}` -> { lastLoggedAt, suppressed } */
  const seenMessages = new Map();

  const onStart = (event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    log.info('开始导航', { url });
  };

  const onFinish = () => {
    log.info('页面加载完成', { url: contents.getURL() });
  };

  const onFail = (event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 is ERR_ABORTED, which every ordinary navigation produces on its way out.
    if (errorCode === -3) return;
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
  KEEP_ROTATED,
  MAX_BYTES,
  NOTEWORTHY_LEVELS,
  attachPageDiagnostics,
  createLogFile,
  normalizeForDedupe,
};
