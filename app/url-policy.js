'use strict';

// Central URL/scheme policy for the desktop shell.
//
// Keeping this in one pure module (no Electron imports) means the rules that
// decide "may this URL reach the operating system?" are unit-testable, instead
// of being scattered across event handlers where they are easy to miss.

/** Schemes that may ever be handled by the app or the OS. */
const WEB_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Schemes the renderer resolves internally and therefore never forwards to the
 * operating system. Navigations using these are allowed; everything else is
 * blocked so it can never reach the Windows shell.
 */
const INTERNAL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'about:',
  'blob:',
  'data:',
  'filesystem:',
  'chrome:',
  'devtools:',
]);

/**
 * ByteDance-owned domains. The Douyin web page routinely calls `window.open`
 * for these (login, client promotion, live room, share panels, download
 * landing pages...). Inside a single-window desktop shell every one of them
 * shows up as a stray popup window, so popups targeting them are dropped.
 */
const BYTEDANCE_DOMAINS = [
  'douyin.com',
  'iesdouyin.com',
  'douyinpic.com',
  'douyinvod.com',
  'douyinlive.com',
  'douyincdn.com',
  'amemv.com',
  'bytedance.com',
  'bytedance.net',
  'bytednsdoc.com',
  'bytegoofy.com',
  'byteimg.com',
  'toutiao.com',
  'ixigua.com',
  'snssdk.com',
  'snssdk1128.com',
  'pstatp.com',
  'ipstatp.com',
  'zijieapi.com',
  'huoshan.com',
  'volces.com',
  'volccdn.com',
  'feishu.cn',
];

/** Domains the app itself is allowed to display. */
const DOUYIN_DOMAINS = ['douyin.com', 'iesdouyin.com'];

function parseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function hostInList(hostname, domains) {
  if (!hostname) return false;
  return domains.some((domain) => hostMatches(hostname, domain));
}

function isDouyinHost(hostname) {
  return hostInList(hostname, DOUYIN_DOMAINS);
}

function isByteDanceHost(hostname) {
  return hostInList(hostname, BYTEDANCE_DOMAINS);
}

/** True only for real web navigation (`http`/`https`). */
function isWebUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  return Boolean(url) && WEB_PROTOCOLS.has(url.protocol);
}

/** True for custom schemes such as `bytedance://` or `snssdk1128://`. */
function isCustomScheme(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  return !WEB_PROTOCOLS.has(url.protocol);
}

/**
 * True when a *navigation* may proceed. This is deliberately more permissive
 * than `isWebUrl`, because the renderer handles `about:`/`blob:`/`data:`
 * internally and they never leave the process. Anything outside this list -
 * including `bytedance://`, `snssdk1128://`, `file:` and unparseable input -
 * is refused so the OS is never asked to resolve it.
 */
function isSafeNavigationUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  return Boolean(url) && INTERNAL_PROTOCOLS.has(url.protocol);
}

/**
 * Classify a URL into a single decision the shell can act on.
 *
 * - `web`             a normal http(s) page that is not ByteDance-owned
 * - `douyin`          a Douyin page the app itself may display
 * - `bytedance-popup` a ByteDance page reached through `window.open`
 * - `custom-scheme`   a non-web scheme; must never reach the OS
 * - `invalid`         unparseable, treated the same as `custom-scheme`
 */
function classifyUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return { kind: 'invalid', url: null };

  if (!WEB_PROTOCOLS.has(url.protocol)) {
    return { kind: 'custom-scheme', url, protocol: url.protocol };
  }
  if (isDouyinHost(url.hostname)) return { kind: 'douyin', url };
  if (isByteDanceHost(url.hostname)) return { kind: 'bytedance-popup', url };
  return { kind: 'web', url };
}

module.exports = {
  WEB_PROTOCOLS,
  INTERNAL_PROTOCOLS,
  BYTEDANCE_DOMAINS,
  DOUYIN_DOMAINS,
  classifyUrl,
  isByteDanceHost,
  isCustomScheme,
  isDouyinHost,
  isSafeNavigationUrl,
  isWebUrl,
  parseUrl,
};
