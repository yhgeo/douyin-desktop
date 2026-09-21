'use strict';

/**
 * Downloads, handled at the session level.
 *
 * `will-download` is a **Session** event, not a WebContents one. The guard for
 * custom-scheme downloads used to be registered with `contents.on('will-download')`,
 * which silently does nothing - Electron's WebContents never emits it. Measured with a
 * probe that armed both: `contents` fired 0 times, `session` fired twice for the same
 * two downloads. So `bytedance://` downloads were reaching the Windows shell, which is
 * exactly the "需要新应用以打开此链接" dialog this app exists to prevent.
 *
 * Two jobs therefore live here, both on the session:
 *
 *  1. refuse anything that is not http(s), so no custom scheme can escape;
 *  2. serve `GM_download` - give the file the name the script asked for, and report
 *     progress / completion / cancellation back to the frame that asked for it.
 *
 * Point 2 matters because the userscript's download UI is built entirely on those
 * callbacks: it shows a progress percentage, reports failure, and cancels the transfer
 * when the user closes the toast. Answering with an immediate `onload()` told the user
 * "下载已完成" before the transfer had even started.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { isWebUrl } = require('./url-policy');
const log = require('../diagnostics/logger');

/** Characters Windows rejects in a filename. Also blocks `..` from escaping the folder. */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/**
 * A filename that is safe to write into the downloads folder.
 *
 * @param {string} name what the script asked for
 * @param {string} fallback the name Chromium derived from the URL
 */
function safeFileName(name, fallback) {
  const cleaned = path.basename(String(name || '')).replace(ILLEGAL_FILENAME_CHARS, '_').trim();
  if (cleaned && cleaned !== '.' && cleaned !== '..') return cleaned;
  const fallbackName = path.basename(String(fallback || '')).replace(ILLEGAL_FILENAME_CHARS, '_').trim();
  return fallbackName || `download-${Date.now()}`;
}

/**
 * Never overwrite: `setSavePath` replaces the target silently, so a second download of
 * the same video would destroy the first one.
 */
function uniqueSavePath(directory, fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidate = path.join(directory, fileName);
  let index = 1;
  while (fs.existsSync(candidate) && index < 1000) {
    candidate = path.join(directory, `${stem} (${index})${extension}`);
    index += 1;
  }
  return candidate;
}

/**
 * @param {{ log?: object }} [options]
 */
function createDownloadBroker(options = {}) {
  const logger = options.log || log;

  /** url -> queue of `{ requestId, name, sender }`, in arrival order. */
  const pending = new Map();
  /** requestId -> DownloadItem, while it is in flight. */
  const active = new Map();

  /**
   * Register a `GM_download` call.
   *
   * Queued per URL rather than globally: `downloadURL` resolves asynchronously, so a
   * single FIFO would hand the wrong name to the wrong file as soon as two downloads
   * overlap.
   *
   * @returns {boolean} false when the URL may not be downloaded at all
   */
  function request({ url, name, requestId, sender }) {
    if (!url || !requestId || !isWebUrl(url)) return false;
    const queue = pending.get(url) || [];
    queue.push({ requestId, name, sender });
    pending.set(url, queue);
    return true;
  }

  /** Cancel an in-flight download, as `GM_download`'s returned `abort()` promises. */
  function abort(requestId) {
    const item = active.get(requestId);
    if (!item) return false;
    try {
      item.cancel();
    } catch (error) {
      logger.warn('取消下载失败', { requestId, error: String((error && error.message) || error) });
      return false;
    }
    return true;
  }

  const sendTo = (sender, channel, payload) => {
    try {
      if (sender && !sender.isDestroyed()) sender.send(channel, payload);
    } catch {
      // The frame went away mid-download; nothing to report to.
    }
  };

  /**
   * The single `will-download` handler for a session.
   *
   * @param {import('electron').Session} targetSession
   */
  function attach(targetSession) {
    targetSession.on('will-download', (event, item) => {
      const url = item.getURL();

      // Custom schemes must never reach the OS - this is the whole reason the handler
      // exists, and it is the part that was dead when it lived on the webContents.
      if (!isWebUrl(url)) {
        event.preventDefault();
        logger.warn('已拦截下载', { url });
        return;
      }

      const queue = pending.get(url);
      const request_ = queue && queue.shift();
      if (!request_) return; // Not ours: leave Chromium's default behaviour alone.

      const directory = app.getPath('downloads');
      let savePath;
      try {
        fs.mkdirSync(directory, { recursive: true });
        savePath = uniqueSavePath(directory, safeFileName(request_.name, item.getFilename()));
        item.setSavePath(savePath);
      } catch (error) {
        logger.warn('无法为下载指定保存位置，改用默认行为', {
          error: String((error && error.message) || error),
        });
        savePath = null;
      }

      active.set(request_.requestId, item);

      item.on('updated', (_event, state) => {
        sendTo(request_.sender, 'gm-download-progress', {
          requestId: request_.requestId,
          state,
          loaded: item.getReceivedBytes(),
          total: item.getTotalBytes(),
        });
      });

      item.on('done', (_event, state) => {
        active.delete(request_.requestId);
        sendTo(request_.sender, 'gm-download-done', {
          requestId: request_.requestId,
          state,
          path: savePath,
        });
      });
    });
  }

  return { abort, attach, request };
}

/**
 * The broker the app actually uses.
 *
 * A single instance, for the same reason storage/userscript-store.js is one: the IPC
 * layer queues requests into it while the session handler drains them, so a second
 * instance would mean the two halves never meet.
 */
const downloadBroker = createDownloadBroker();

module.exports = {
  ILLEGAL_FILENAME_CHARS,
  createDownloadBroker,
  downloadBroker,
  safeFileName,
  uniqueSavePath,
};
