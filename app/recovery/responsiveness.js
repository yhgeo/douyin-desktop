'use strict';

/**
 * Recover from a frozen page.
 *
 * Douyin's own dialogs can leave the page unresponsive: its "是否保存登录信息？"
 * prompt hides itself and *then* runs the caller's confirm/cancel handler, so if
 * that handler blocks, the hide never renders and the dialog's mask keeps
 * swallowing clicks. Waiting out the countdown works because that path never runs
 * the handler at all.
 *
 * The main process keeps running while the renderer is blocked, so Chromium tells
 * us about it and we can offer a reload instead of leaving a dead window that the
 * user has to fix by hand.
 *
 * Kept free of UI so the behaviour is testable: the caller decides how to ask,
 * and the tests pass a recorder instead of a modal.
 *
 * @param {import('electron').WebContents} contents
 * @param {object} [options]
 * @param {number} [options.graceMs] how long to wait before asking; a long
 *   synchronous task is not a dead page, and a prompt for every hiccup would be
 *   worse than the hiccup
 * @param {() => Promise<boolean>} [options.confirmReload] resolves true to reload
 * @param {(event: { type: string }) => void} [options.onEvent] telemetry for tests
 * @param {(message: string, error?: unknown) => void} [options.log]
 * @returns {() => void} detaches the handlers
 */
function attachResponsivenessHandlers(contents, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 5000;
  const confirmReload = typeof options.confirmReload === 'function' ? options.confirmReload : async () => false;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};

  let prompting = false;
  let graceTimer = null;

  const clearGrace = () => {
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  const onUnresponsive = () => {
    onEvent({ type: 'unresponsive' });
    if (prompting) return;
    clearGrace();
    graceTimer = setTimeout(async () => {
      graceTimer = null;
      if (contents.isDestroyed()) return;
      prompting = true;
      onEvent({ type: 'prompt' });
      try {
        const shouldReload = await confirmReload();
        if (shouldReload && !contents.isDestroyed()) {
          onEvent({ type: 'reload' });
          contents.reload();
        }
      } catch (error) {
        log('[抖音] 页面无响应提示失败', error);
      } finally {
        prompting = false;
      }
    }, graceMs);
    // Same rule as the blank-page watcher: a pending timer must not keep the process
    // alive on its own. It only matters for the grace period, which is why it is easy
    // to forget - and it is exactly why the rule is worth stating once and following
    // everywhere.
    if (graceTimer.unref) graceTimer.unref();
  };

  const onResponsive = () => {
    onEvent({ type: 'responsive' });
    // Recovered on its own - cancel the pending prompt.
    clearGrace();
  };

  contents.on('unresponsive', onUnresponsive);
  contents.on('responsive', onResponsive);

  return () => {
    clearGrace();
    contents.removeListener('unresponsive', onUnresponsive);
    contents.removeListener('responsive', onResponsive);
  };
}

module.exports = { attachResponsivenessHandlers };
