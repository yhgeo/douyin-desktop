'use strict';

const { BrowserWindow } = require('electron');
const {
  classifyUrl,
  isSafeNavigationUrl,
  isWebUrl,
} = require('./url-policy');

/**
 * Apply the app's navigation and popup policy to a single `webContents`.
 *
 * The rule that matters for the Windows "需要新应用以打开此链接" prompt is simple:
 * an unhandled custom scheme only reaches the OS if *we* hand it over. So every
 * route Chromium can use to escape the renderer is closed here:
 *
 *  - `setWindowOpenHandler` covers `window.open` / `target="_blank"`. Douyin's
 *    own helper windows are allowed (its dialogs depend on them), ordinary
 *    third-party links go to the user's browser, and custom schemes are dropped.
 *  - `will-frame-navigate` covers *every* frame. `will-navigate` alone is
 *    main-frame only, which is how an iframe on douyin.com could still send a
 *    `bytedance://` URL to Windows.
 *  - `will-redirect` covers server-side redirects to a custom scheme.
 *  - `will-download` covers `<a download>` pointing at a custom scheme.
 *
 * @param {import('electron').WebContents} contents
 * @param {{ openExternal?: (url: string) => void, onBlocked?: (info: object) => void }} [options]
 * @returns {() => void} detaches the handlers
 */
function hardenWebContents(contents, options = {}) {
  const openExternal = typeof options.openExternal === 'function' ? options.openExternal : () => {};
  const onBlocked = typeof options.onBlocked === 'function' ? options.onBlocked : () => {};

  const report = (reason, rawUrl, extra = {}) => {
    const { kind } = classifyUrl(rawUrl);
    onBlocked({ reason, kind, url: rawUrl, ...extra });
    return kind;
  };

  contents.setWindowOpenHandler(({ url }) => {
    const { kind } = classifyUrl(url);

    if (kind === 'douyin') {
      // Douyin's own dialogs (login, verification, share, ...) open helper
      // windows on its own domain. Denying those leaves the dialog's mask stuck
      // over the page: clicks stop working until the page is reloaded. They are
      // allowed, exactly as before, and the new window is hardened too because
      // `web-contents-created` applies this same policy to it.
      report('popup-allowed', url);
      return { action: 'allow' };
    }

    if (kind === 'web' || kind === 'bytedance-popup') {
      // Ordinary third-party link: hand it to the user's browser rather than
      // spawning an unmanaged Electron window.
      openExternal(url);
      report('popup-external', url);
      return { action: 'deny' };
    }

    // Custom schemes must never be forwarded to the OS.
    report('popup-blocked', url);
    return { action: 'deny' };
  });

  const blockUnsafeNavigation = (event, rawUrl, isMainFrame) => {
    if (isSafeNavigationUrl(rawUrl)) return;
    event.preventDefault();
    report('navigation-blocked', rawUrl, { isMainFrame: Boolean(isMainFrame) });
  };

  // Fires for the main frame *and* every subframe.
  const onFrameNavigate = (details) => {
    blockUnsafeNavigation(details, details?.url, details?.isMainFrame);
  };
  // Redundant safety net for the main frame.
  const onNavigate = (details, legacyUrl) => {
    blockUnsafeNavigation(details, details?.url ?? legacyUrl, details?.isMainFrame ?? true);
  };
  // Server-side redirects can also land on a custom scheme.
  const onRedirect = (details, legacyUrl) => {
    blockUnsafeNavigation(details, details?.url ?? legacyUrl, details?.isMainFrame ?? true);
  };

  contents.on('will-frame-navigate', onFrameNavigate);
  contents.on('will-navigate', onNavigate);
  contents.on('will-redirect', onRedirect);

  // `<a download href="bytedance://...">` would otherwise hand the URL to the OS.
  const onWillDownload = (event, item) => {
    const url = item?.getURL?.() ?? '';
    if (isWebUrl(url)) return;
    event.preventDefault();
    report('download-blocked', url);
  };
  contents.on('will-download', onWillDownload);

  // Keep the window title stable no matter what the page sets.
  const onTitleUpdated = (event) => {
    event.preventDefault();
    BrowserWindow.fromWebContents(contents)?.setTitle(options.title || '抖音');
  };
  contents.on('page-title-updated', onTitleUpdated);

  return () => {
    contents.removeListener('will-frame-navigate', onFrameNavigate);
    contents.removeListener('will-navigate', onNavigate);
    contents.removeListener('will-redirect', onRedirect);
    contents.removeListener('will-download', onWillDownload);
    contents.removeListener('page-title-updated', onTitleUpdated);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  };
}

module.exports = { hardenWebContents };
