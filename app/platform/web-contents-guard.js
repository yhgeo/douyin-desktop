'use strict';

const { BrowserWindow } = require('electron');
const path = require('node:path');
const {
  classifyUrl,
  isSafeNavigationUrl,
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
 *
 * Downloads are deliberately *not* handled here. `will-download` is a Session event,
 * so registering it on a webContents does nothing at all - the handler is never
 * called and the custom-scheme download guard was silently absent. It now lives in
 * platform/downloads.js, on the session, together with the GM_download plumbing.
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
      const target = new URL(url);
      const isLiveRoom = (target.hostname === 'live.douyin.com' && /^\/\d+\/?$/.test(target.pathname))
        || (target.hostname === 'www.douyin.com' && /^\/(?:root|follow)\/live(?:\/|$)/.test(target.pathname));
      if (isLiveRoom) {
        // Electron does not inherit the opener's preload. Sidebar live cards use
        // window.open, unlike recommendation rooms that navigate the main window.
        // Apply the same limited page bridge only to live-room windows; login and
        // verification helper windows retain their normal isolated preferences.
        // A room opened from a search result is a browsing window in its own
        // right. Closing the results must not destroy its live stream.
        return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: {
          webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            webviewTag: false,
            backgroundThrottling: false,
          },
        } };
      }
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

  // The live-home renderer's initial popup navigation can return empty audience
  // API responses in a signed-in session. A fresh navigation to the very same
  // room succeeds. Start it immediately after Electron dispatches the initial
  // navigation, keeping native window.open ownership and preferences.
  const onCreatedWindow = (child, details) => {
    const url = canonicalLivePopupUrl(details.url, contents.getURL());
    if (url) setImmediate(() => {
      if (child.isDestroyed()) return;
      child.loadURL(url).catch(() => {
        // Closing the child cancels an in-flight load normally.
      });
    });
  };
  contents.on('did-create-window', onCreatedWindow);

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

  // Keep the window title stable no matter what the page sets.
  //
  // The value comes from `options.title`, which may be a function of the webContents:
  // a window under repair has to keep showing its repair notice, and a constant would
  // erase it on the first title update (the repair's own reload produces one).
  const resolveTitle = typeof options.title === 'function'
    ? options.title
    : () => options.title || '抖音';
  const onTitleUpdated = (event) => {
    event.preventDefault();
    BrowserWindow.fromWebContents(contents)?.setTitle(resolveTitle(contents));
  };
  contents.on('page-title-updated', onTitleUpdated);

  return () => {
    contents.removeListener('will-frame-navigate', onFrameNavigate);
    contents.removeListener('will-navigate', onNavigate);
    contents.removeListener('will-redirect', onRedirect);
    contents.removeListener('page-title-updated', onTitleUpdated);
    contents.removeListener('did-create-window', onCreatedWindow);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  };
}

function canonicalLivePopupUrl(rawUrl, openerUrl) {
  try {
    const target = new URL(rawUrl);
    const opener = new URL(openerUrl);
    if (opener.protocol === 'https:' && opener.hostname === 'live.douyin.com' && opener.pathname === '/'
        && target.protocol === 'https:' && target.hostname === 'live.douyin.com' && /^\/\d+\/?$/.test(target.pathname)) {
      return target.origin + target.pathname;
    }
  } catch { /* No committed or supported URL. */ }
  return null;
}

module.exports = { hardenWebContents, canonicalLivePopupUrl };
