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
 */

const fs = require('node:fs');
const path = require('node:path');

/** Rotate at this size so a long-running session cannot fill the disk. */
const MAX_BYTES = 512 * 1024;

function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.`
    + `${pad(date.getMilliseconds(), 3)}`;
}

/**
 * @param {object} options
 * @param {string} options.dir directory to write into (created if missing)
 * @param {string} [options.fileName]
 * @param {number} [options.maxBytes]
 * @returns {{ path: string, write: Function, info: Function, warn: Function, error: Function }}
 */
function createLogFile({ dir, fileName = 'main.log', maxBytes = MAX_BYTES }) {
  const filePath = path.join(dir, fileName);
  const previousPath = path.join(dir, `${fileName}.1`);
  let broken = false;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    broken = true;
    // Nothing to do but stay quiet: a logger that throws is worse than no logger.
    console.error('[抖音] 无法创建日志目录', dir, error);
  }

  const rotateIfNeeded = () => {
    try {
      const { size } = fs.statSync(filePath);
      if (size < maxBytes) return;
      fs.renameSync(filePath, previousPath);
    } catch {
      // Missing file, or the rename lost a race - both harmless.
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
    // Also mirror to the console so `npm start` shows the same story.
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(`[抖音] ${message}`, data === undefined ? '' : data);
  };

  return {
    path: filePath,
    previousPath,
    write,
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Log what a window actually does, so a failure can be reconstructed later.
 *
 * Only warning/error console output is captured: the bundled userscript logs
 * heavily at info level and would drown everything else out.
 *
 * @param {Electron.WebContents} contents
 * @param {ReturnType<typeof createLogFile>} log
 * @returns {() => void} detaches
 */
function attachPageDiagnostics(contents, log) {
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
    const message = details ? details.message : args[2];
    const line = details ? details.lineNumber : args[3];
    const source = details ? details.sourceId : args[4];
    if (level !== 'warning' && level !== 'error' && level !== 2 && level !== 3) return;
    log.warn('页面控制台', { level, message: String(message || '').slice(0, 500), source: String(source || ''), line });
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

module.exports = { MAX_BYTES, attachPageDiagnostics, createLogFile };
