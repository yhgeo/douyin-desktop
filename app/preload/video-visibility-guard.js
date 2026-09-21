'use strict';

/**
 * Stop an injected stylesheet from hiding the video.
 *
 * The bundled userscript hides overlays with selectors shaped like
 *
 *   .playerContainer .slider-video > div > div:has(path[d="M17.448 …"])
 *
 * and `:has()` matches any **ancestor** containing that icon, not the icon's own container. On
 * the recommend feed the close button lives inside `div.douyin-player`, which also holds the
 * `<video>` - so `display: none` lands on the player layer itself. What stays visible is its
 * sibling `div.imgBackground`, the player's own frosted-glass backdrop (`filter: blur(60px)`,
 * `opacity: .8`), so the picture looks smeared from the third video onwards in fullscreen. The
 * same happens to the search-bar switch, whose button is inside `div.douyin-player` too.
 *
 * Measured against the live feed rather than reasoned about: the close-button selector matched
 * exactly one element and that element contained a video; the icon's own container
 * (`div.kUuOoS7g`, matched by a `>svg` selector) contains none.
 *
 * **The fix is here, not in the bundle.** The script is a dependency whose author keeps
 * updating it, so patching its selectors would be a change we have to re-apply on every
 * update - and would silently revert to the bug if we forgot. The shell drops the offending
 * *rule* instead, which also restores the site's own styling: overriding `display` would have
 * to guess what it should have been, and a wrong guess breaks the layout instead.
 *
 * The scope is deliberately narrow - a rule is dropped only when all three hold:
 *
 *  1. it sets `display: none`;
 *  2. it matches by descendant (`:has(`) inside the feed player (`.slider-video`), which is the
 *     shape that can land on an ancestor;
 *  3. the element it is currently hiding really does contain a `<video>`.
 *
 * The site's own CSS does not hide the player through `:has()`, so a legitimate hide cannot
 * satisfy all three, and every dropped selector is reported to the page console - which the
 * shell already captures into the log - so it is visible rather than guessed at.
 */

/**
 * The shape that can land on an ancestor of the icon instead of on the icon itself.
 *
 * `.slider-video` scopes it to the feed player: that is the structure where the video and the
 * blurred backdrop are siblings, so hiding the wrong one is what produces the symptom.
 */
const ANCESTOR_HIDE = /\.slider-video[^{]*:has\(/;

/** How long to wait after a stylesheet is added before sweeping. */
const DEBOUNCE_MS = 300;

/**
 * Would this rule hide something by matching one of its descendants?
 *
 * Pure, so the guard can be tested against the real selectors from the bundle rather than
 * against strings invented for the test.
 *
 * @param {{ selectorText?: string, display?: string }} rule
 */
function isDangerousRule(rule) {
  if (!rule) return false;
  if (String(rule.display || '') !== 'none') return false;
  return ANCESTOR_HIDE.test(String(rule.selectorText || ''));
}

/**
 * Drop every dangerous rule that is hiding a video right now.
 *
 * @param {object} options
 * @param {Document} options.doc
 * @param {(message: string, data?: object) => void} options.log
 * @param {Set<string>} options.dropped selectors already reported, so the log says it once
 * @returns {number} how many rules were removed
 */
function sweepStylesheets({ doc, log, dropped }) {
  let removed = 0;

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules;
    try {
      // A cross-origin sheet throws on access; it is also not where an injected style lives.
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;

    // Backwards: deleteRule shifts the ones after it.
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index];
      if (!isDangerousRule({ selectorText: rule.selectorText, display: rule.style && rule.style.display })) {
        continue;
      }

      let matches;
      try {
        matches = Array.from(doc.querySelectorAll(rule.selectorText));
      } catch {
        continue;
      }

      // Condition 3, and the one that keeps this honest: only act on a rule that is hiding a
      // video at this moment, not on every rule that looks like it could.
      const view = doc.defaultView || globalThis;
      const hidesVideo = matches.some((element) => (
        element.querySelector('video') && view.getComputedStyle(element).display === 'none'
      ));
      if (!hidesVideo) continue;

      try {
        sheet.deleteRule(index);
        removed += 1;
        if (!dropped.has(rule.selectorText)) {
          dropped.add(rule.selectorText);
          log('已移除会隐藏视频的样式规则（脚本的 :has 选择器命中了播放器层）', {
            selector: String(rule.selectorText).slice(0, 200),
          });
        }
      } catch {
        // A rule that refuses to be removed is not worth breaking the page over.
      }
    }
  }

  return removed;
}

/**
 * Watch for injected styles and keep the video visible.
 *
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {(message: string, data?: object) => void} [options.log]
 * @returns {() => void} detaches
 */
function installVideoVisibilityGuard(options = {}) {
  const doc = options.doc || document;
  // console.warn, not console.log: the shell captures warning-level page console output into
  // the log, and this is something the user should be able to find afterwards. The data is
  // stringified because the capture keeps the message text, not the arguments - logging an
  // object would put "[object Object]" in the log, which is exactly where the selector needs
  // to be.
  const log = options.log || ((message, data) => console.warn(
    `[抖音] ${message}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`,
  ));
  const dropped = new Set();
  let timer = null;
  let stopped = false;

  const run = () => {
    if (stopped) return;
    try {
      sweepStylesheets({ doc, log, dropped });
    } catch (error) {
      log('检查样式规则失败', { error: String((error && error.message) || error) });
    }
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; run(); }, DEBOUNCE_MS);
    if (timer.unref) timer.unref();
  };

  // Styles land in <head>, with a documentElement fallback in the vendor's addStyle. Watching
  // only those two keeps this cheap: watching the whole tree would mean a callback on every
  // mutation of a page that mutates constantly, to notice something that only happens when a
  // stylesheet is added.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'STYLE' || node.tagName === 'LINK') {
          schedule();
          return;
        }
      }
    }
  });

  const observe = () => {
    const roots = [doc.head, doc.documentElement].filter(Boolean);
    for (const root of roots) {
      try {
        observer.observe(root, { childList: true });
      } catch {
        // Nothing to observe yet; the DOMContentLoaded sweep below still runs.
      }
    }
    run();
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', observe, { once: true });
  } else {
    observe();
  }
  doc.addEventListener('load', schedule, { once: true });

  return () => {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    observer.disconnect();
  };
}

module.exports = {
  ANCESTOR_HIDE,
  DEBOUNCE_MS,
  installVideoVisibilityGuard,
  isDangerousRule,
  sweepStylesheets,
};
