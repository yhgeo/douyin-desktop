'use strict';

/**
 * A small rotating text log.
 *
 * Every recovery in this app exists because Douyin did something surprising, and every
 * one of them was hard to diagnose afterwards: the window was black, the console output
 * was gone, and the only evidence left was on disk. This writes that evidence down.
 *
 * Retention is sized against a measurement rather than a guess. Capturing the page's
 * console output produced 22 lines in the first 75 seconds of an ordinary load, which
 * would have rotated a small file away every couple of hours and buried whatever was
 * useful - so the file is sized for days of use and repeats are collapsed upstream
 * (see page-diagnostics.js).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Rotate at this size. With three files that is days of ordinary use. */
const MAX_BYTES = 2 * 1024 * 1024;

/** How many rotated files to keep (`main.log.1`, `main.log.2`, ...). */
const KEEP_ROTATED = 2;

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

module.exports = { KEEP_ROTATED, MAX_BYTES, createLogFile, safeJson, stamp };
