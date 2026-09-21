'use strict';

/**
 * Settings in the bundled userscript that are known to break this app.
 *
 * There is exactly one so far, and it is worth naming because of what it cost. The script
 * offers a switch whose own description is "阻止触发验证弹窗（maybe）" - a guess - and whose
 * default is off. Turning it on makes the script delete `__ac_signature`, `__ac_referer` and
 * `__ac_nonce` on every page load (`removeCookie()`, wired through `Panel.execMenu`, so it runs
 * on every navigation).
 *
 * Those three cookies are the anti-crawl signature the server issues to *this* client. Delete
 * them and the next request arrives from a client the server recognises, carrying no signature,
 * and the answer is `200` with an empty body - the black window this project has a whole
 * recovery system for. Measured end to end: a profile that failed on every launch loaded
 * normally as soon as this one flag was turned off, on the same machine and the same build.
 *
 * It also explains the comparison every user makes - "Edge refreshes fine, so it is not the
 * server". Edge keeps the cookie. This app was throwing it away.
 *
 * So the app does not stay quiet about it: it warns in the log at startup, and offers a menu
 * action to turn it off. It does not silently rewrite the user's configuration - the flag is
 * the user's to set - but it will not let a known-broken setting look like a server outage.
 *
 * Free of `electron` imports, because the rules are the part worth testing.
 */

/** The userscript keeps its panel switches under this single key. */
const PANEL_KEY = 'GM_Panel';

/** The switch that deletes the anti-crawl signature cookies. */
const ANTI_CRAWL_COOKIE_REMOVAL = 'dy-cookie-remove__ac__';

/**
 * Is the anti-crawl cookie removal switched on?
 *
 * @param {Record<string, unknown>} values the whole userscript value store
 */
function isAntiCrawlCookieRemovalOn(values) {
  const panel = values ? values[PANEL_KEY] : null;
  if (!panel || typeof panel !== 'object') return false;
  return Boolean(panel[ANTI_CRAWL_COOKIE_REMOVAL]);
}

/**
 * The same values with that switch turned off.
 *
 * Returns a new object and leaves the input alone: the caller decides whether to persist it.
 *
 * @param {Record<string, unknown>} values
 */
function withoutAntiCrawlCookieRemoval(values) {
  const panel = values && typeof values[PANEL_KEY] === 'object' && values[PANEL_KEY] !== null
    ? values[PANEL_KEY]
    : {};
  return {
    ...(values || {}),
    [PANEL_KEY]: { ...panel, [ANTI_CRAWL_COOKIE_REMOVAL]: false },
  };
}

module.exports = {
  ANTI_CRAWL_COOKIE_REMOVAL,
  PANEL_KEY,
  isAntiCrawlCookieRemovalOn,
  withoutAntiCrawlCookieRemoval,
};
