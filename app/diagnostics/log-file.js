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

/**
 * Rotation can fail, and then the file grows without limit.
 *
 * The realistic way to hit this: the menu item opens the log in an editor, and Windows refuses
 * to rename a file another process has open. Rotation then silently does nothing on every
 * write (the catch below deliberately does not fail a log line over it), and the "2 MB cap"
 * stops being a cap at all.
 *
 * So past this multiple of `MAX_BYTES`, keep the newest lines and drop the rest. A bounded log
 * with a gap in it beats an unbounded one, and the newest lines are the ones that matter.
 */
const HARD_LIMIT_MULTIPLE = 4;

/**
 * How much of the tail to keep when the ceiling is enforced, as a fraction of `maxBytes`.
 *
 * Relative rather than absolute on purpose: a fixed 256 KB would be *larger* than the whole
 * limit for a small `maxBytes`, so the "truncate" would rewrite a bigger file than it found
 * and the ceiling would never hold.
 */
const TRUNCATE_KEEP_RATIO = 0.5;

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
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return; // No file yet.
    }
    if (size < maxBytes) return;

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
      // A lost rotation is not worth failing a log line over - but it does mean the file
      // keeps growing, so fall through to the ceiling check below.
    }
    enforceCeiling(size);
  };

  /** Keep the file bounded even when rotation cannot happen. See HARD_LIMIT_MULTIPLE. */
  const enforceCeiling = (size) => {
    if (size < maxBytes * HARD_LIMIT_MULTIPLE) return;
    try {
      const fd = fs.openSync(filePath, 'r');
      const keepBytes = Math.max(1, Math.floor(maxBytes * TRUNCATE_KEEP_RATIO));
      const from = Math.max(0, size - keepBytes);
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      fs.closeSync(fd);

      const text = buffer.toString('utf8');
      // Drop the partial first line, so what is kept starts at a real entry.
      const firstBreak = text.indexOf('\n');
      const kept = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
      fs.writeFileSync(
        filePath,
        `${stamp()} [warn] 日志超过上限且轮转失败，已丢弃较早内容\n${kept}`,
        'utf8',
      );
    } catch {
      // Nothing left to try. A logger that throws is worse than a logger that loses lines.
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

module.exports = {
  HARD_LIMIT_MULTIPLE,
  KEEP_ROTATED,
  MAX_BYTES,
  TRUNCATE_KEEP_RATIO,
  createLogFile,
  safeJson,
  stamp,
};
