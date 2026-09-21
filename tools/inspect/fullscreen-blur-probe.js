'use strict';

/**
 * Which element do the two "屏蔽" selectors actually match, and what is blurring?
 *
 * Third time this bug has been looked at, so this time it answers the question directly rather
 * than reasoning about `:has()`:
 *
 *  - the site draws its own frosted-glass backdrop (`img` with `filter: blur(60px)`) behind the
 *    video, so anything that stops the video being painted reads as "超级模糊";
 *  - `blockCloseFullScreenButton` hides `.playerContainer .slider-video > div > div:has(path[d=…])`,
 *    and `:has()` matches *any* ancestor containing that icon - including, possibly, the wrapper
 *    that also holds the `<video>`.
 *
 * So: report every element each selector matches, and whether it contains a video.
 *
 * Usage:
 *   node tools/inspect/fullscreen-blur-probe.js [--port=9222] [--url=...] [--steps=2]
 */

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '9222'));
const URL = arg('url', 'https://www.douyin.com/?recommend=1');
const STEPS = Number(arg('steps', '2'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a playing video, clicking one if the feed has not started. */
const WAIT_FOR_VIDEO = `(async () => {
  const playing = () => {
    const v = [...document.querySelectorAll('video')].find((el) => el.videoWidth > 0);
    return v ? { ok: true, intrinsic: [v.videoWidth, v.videoHeight] } : { ok: false };
  };
  const deadline = Date.now() + 25000;
  let clicked = false;
  while (Date.now() < deadline) {
    if (playing().ok) return { ...playing(), clicked };
    if (!clicked) {
      const c = document.querySelector('video') || document.querySelector('[data-e2e="feed-active-video"]');
      if (c) { c.click(); clicked = true; }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, clicked };
})()`;

/** Enter "网页全屏" - a CSS class, so a synthetic click is enough. */
const ENTER_PAGE_FULLSCREEN = `(async () => {
  const candidates = ['[class*="pageFullScreen" i]', '[class*="page-fullscreen" i]', '.xgplayer-page-full-screen'];
  let el = null, used = null;
  for (const s of candidates) { const f = document.querySelector(s); if (f) { el = f; used = s; break; } }
  if (!el) return { clicked: false, reason: 'no page-fullscreen control' };
  el.click();
  await new Promise((r) => setTimeout(r, 1500));
  return {
    clicked: true, used,
    htmlClass: document.documentElement.className.slice(0, 120),
    slidelistClass: (document.querySelector('#slidelist') || {}).className || null,
  };
})()`;

/**
 * The report.
 *
 * `d^="M17.448"` approximates the script's full `d="…"` attribute selector: enough to find the
 * same elements without pasting a 250-character path into the probe.
 */
const REPORT = `(() => {
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 90),
      size: [Math.round(r.width), Math.round(r.height)],
      display: cs.display,
      visibility: cs.visibility,
      filter: cs.filter === 'none' ? null : cs.filter,
      containsVideo: !!el.querySelector('video'),
      videoCount: el.querySelectorAll('video').length,
      containsBlurImg: [...el.querySelectorAll('img')].some((i) => /blur/.test(getComputedStyle(i).filter)),
    };
  };

  const selectors = {
    searchFloatingBar_slideMode: '#slideMode + div',
    searchFloatingBar_player: '.playerContainer .slider-video>div>div:has([data-e2e="searchbar-button"])',
    closeFullScreen_scoped: '.playerContainer .slider-video > div > div:has(path[d^="M17.448"])',
    closeFullScreen_generic: 'div:has(>svg path[d^="M17.448"])',
  };

  const matched = {};
  for (const [name, sel] of Object.entries(selectors)) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(sel)]; } catch (e) { matched[name] = { error: String(e.message) }; continue; }
    matched[name] = {
      count: nodes.length,
      // The question that matters: does our own hide-CSS land on something holding the video?
      hitsContainingVideo: nodes.filter((n) => n.querySelector('video')).length,
      elements: nodes.slice(0, 6).map(describe),
    };
  }

  // The site's frosted-glass backdrop - the thing that *looks* like the bug.
  const blurLayers = [...document.querySelectorAll('img, div')]
    .filter((el) => /blur/.test(getComputedStyle(el).filter))
    .slice(0, 8)
    .map((el) => ({ ...describe(el), filter: getComputedStyle(el).filter, opacity: getComputedStyle(el).opacity }));

  const videos = [...document.querySelectorAll('video')].map((v) => {
    const r = v.getBoundingClientRect();
    const cs = getComputedStyle(v);
    const holder = v.closest('div');
    return {
      intrinsic: [v.videoWidth, v.videoHeight],
      displayed: [Math.round(r.width), Math.round(r.height)],
      display: cs.display,
      opacity: cs.opacity,
      filter: cs.filter === 'none' ? null : cs.filter,
      // If an ancestor of the video is hidden, the video is not painted and the backdrop shows.
      hiddenAncestor: (() => {
        for (let el = v.parentElement; el && el !== document.body; el = el.parentElement) {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') return { cls: String(el.className || '').slice(0, 90), display: s.display };
        }
        return null;
      })(),
      holderClass: holder ? String(holder.className || '').slice(0, 90) : null,
    };
  });

  return {
    url: location.href,
    fullscreenElement: document.fullscreenElement ? String(document.fullscreenElement.className).slice(0, 90) : null,
    matched,
    blurLayers,
    videos,
  };
})()`;

/**
 * Where the pieces actually are.
 *
 * The four selectors above came back empty on a logged-out feed, which is itself an answer but
 * not a useful one: it says the script's selectors do not match *here*, not why. So dump the
 * real structure - where the close icon lives, what sits inside `.slider-video`, and whether
 * the search-bar button exists at all.
 */
const STRUCTURE = `(() => {
  const path = 'M17.448';
  const chain = (el) => {
    const out = [];
    for (let n = el; n && n !== document.body && out.length < 8; n = n.parentElement) {
      out.push(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).trim().split(/\\s+/).slice(0, 3).join('.') : ''));
    }
    return out;
  };

  const icons = [...document.querySelectorAll('path[d^="' + path + '"]')].slice(0, 10).map((p) => ({
    chain: chain(p),
    ancestorAtSliderDepth: (() => {
      const slider = p.closest('.slider-video');
      if (!slider) return null;
      let n = p;
      while (n.parentElement && n.parentElement.parentElement && n.parentElement.parentElement !== slider) n = n.parentElement;
      return { tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 80), containsVideo: !!n.querySelector('video') };
    })(),
    ancestorAtPlayerDepth: (() => {
      const pc = p.closest('.playerContainer');
      if (!pc) return null;
      let n = p;
      while (n.parentElement && n.parentElement !== pc) n = n.parentElement;
      return { tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 80), containsVideo: !!n.querySelector('video') };
    })(),
  }));

  const slider = document.querySelector('.slider-video');
  const sliderChildren = slider
    ? [...slider.children].slice(0, 8).map((c) => ({
      tag: c.tagName.toLowerCase(),
      cls: String(c.className || '').slice(0, 80),
      childCount: c.children.length,
      grandchildren: [...c.children].slice(0, 4).map((g) => ({
        tag: g.tagName.toLowerCase(),
        cls: String(g.className || '').slice(0, 80),
        hasVideo: !!g.querySelector('video'),
        hasCloseIcon: !!g.querySelector('path[d^="' + path + '"]'),
      })),
    }))
    : null;

  const searchButton = [...document.querySelectorAll('[data-e2e="searchbar-button"]')].slice(0, 4).map((b) => {
    // The element the script's search-bar selector would hide, at its fixed depth.
    const slider = b.closest('.slider-video');
    let atDepth = null;
    if (slider) {
      let n = b;
      while (n.parentElement && n.parentElement.parentElement && n.parentElement.parentElement !== slider) n = n.parentElement;
      atDepth = { tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 80), containsVideo: !!n.querySelector('video') };
    }
    return { chain: chain(b), ancestorAtSliderDepth: atDepth, insidePlayerLayer: !!b.closest('.douyin-player') };
  });

  /**
   * Does a candidate fix actually avoid the video?
   *
   * The whole bug is display:none landing on an element that holds the video element, so the
   * test of a selector is not "does it match" but "does what it matches contain the video".
   * (No backticks in here: this whole block is a template literal.)
   */
  const P = 'M17.448';
  const candidates = {
    current_scoped: '.playerContainer .slider-video > div > div:has(path[d^="' + P + '"])',
    current_generic: 'div:has(>svg path[d^="' + P + '"])',
    fix_icon_depth: '.playerContainer .slider-video div:has(>svg path[d^="' + P + '"])',
    fix_not_video: '.playerContainer .slider-video > div > div:has(path[d^="' + P + '"]):not(:has(video))',
  };
  const trySelector = (sel) => {
    try {
      const nodes = [...document.querySelectorAll(sel)];
      return {
        count: nodes.length,
        hitsContainingVideo: nodes.filter((n) => n.querySelector('video')).length,
        sample: nodes.slice(0, 3).map((n) => ({ tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 70), size: [Math.round(n.getBoundingClientRect().width), Math.round(n.getBoundingClientRect().height)] })),
      };
    } catch (e) { return { error: String(e.message) }; }
  };
  const candidateResults = {};
  for (const [name, sel] of Object.entries(candidates)) candidateResults[name] = trySelector(sel);

  return {
    sliderExists: !!slider,
    sliderChildren,
    closeIconCount: document.querySelectorAll('path[d^="' + path + '"]').length,
    icons,
    searchBarButton: document.querySelectorAll('[data-e2e="searchbar-button"]').length,
    searchBarInput: document.querySelectorAll('[data-e2e="searchbar-input"]').length,
    searchButtons: searchButton,
    candidateResults,
    slideMode: !!document.querySelector('#slideMode'),
    playerContainer: !!document.querySelector('.playerContainer'),
  };
})()`;

(async () => {
  const out = {};
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || ''));
    if (!page) throw new Error('no douyin page target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws timeout')), 15000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', (e) => { clearTimeout(t); rej(e); });
    });

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result && r.result.value;
    };

    if (URL) {
      await send('Page.enable');
      await send('Page.navigate', { url: URL });
      await sleep(8000);
    }

    out.videoReady = await evaluate(WAIT_FOR_VIDEO);
    out.enterFullscreen = await evaluate(ENTER_PAGE_FULLSCREEN);

    // Swipe forward: the report is about "the third video onwards", so the feed has to be
    // advanced far enough for the swiper to have mounted more slides than it starts with.
    for (let i = 0; i < STEPS; i += 1) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
      await sleep(2500);
    }

    out.report = await evaluate(REPORT);
    out.structure = await evaluate(STRUCTURE);
    ws.close();
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  process.stdout.write(`PROBE=${JSON.stringify(out, null, 1)}\n`);
  process.exit(0);
})();
