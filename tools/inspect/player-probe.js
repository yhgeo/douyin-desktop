// Inspect Douyin's player before and after entering fullscreen.
//
// The report is about the *rendering* chain rather than the video itself:
// intrinsic resolution vs displayed size (an upscaled low-definition stream looks
// exactly like a broken renderer), the page's zoom / devicePixelRatio, and any CSS
// transform on the player that would rasterise at one size and scale to another.
//
// Usage: node tools/inspect/player-probe.js [--port=9250] [--fullscreen] [--wait=6000]
'use strict';

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '9250'));
const ENTER_FULLSCREEN = process.argv.includes('--fullscreen');
const WAIT = Number(arg('wait', '6000'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a video is actually playing.
 *
 * The feed loads its player late, and probing before that reports `videoWidth: 0`,
 * which looks like a broken renderer but is just an empty page. Click the first video
 * if nothing is playing yet.
 */
const WAIT_FOR_VIDEO = `(async () => {
  const playing = () => {
    const v = [...document.querySelectorAll('video')].find((el) => el.videoWidth > 0);
    return v ? { ok: true, intrinsic: [v.videoWidth, v.videoHeight], paused: v.paused } : { ok: false };
  };
  const deadline = Date.now() + 25000;
  let clicked = false;
  while (Date.now() < deadline) {
    const state = playing();
    if (state.ok) return { ...state, clicked };
    if (!clicked) {
      const candidate = document.querySelector('video') || document.querySelector('[data-e2e="feed-active-video"]');
      if (candidate) { candidate.click(); clicked = true; }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, clicked, timedOut: true };
})()`;

const MEASURE = `(() => {
  const round = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
  const videos = [...document.querySelectorAll('video')].map((v) => {
    const rect = v.getBoundingClientRect();
    const style = getComputedStyle(v);
    const parentStyle = v.parentElement ? getComputedStyle(v.parentElement) : null;
    // Douyin keeps one <video> per definition and stacks them, so the layout rect alone
    // does not say which one is painting. Visibility does.
    const visible = style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) > 0
      && (!parentStyle || (parentStyle.display !== 'none' && parentStyle.visibility !== 'hidden'));
    return {
      intrinsic: [v.videoWidth, v.videoHeight],
      displayed: [Math.round(rect.width), Math.round(rect.height)],
      client: [v.clientWidth, v.clientHeight],
      objectFit: style.objectFit,
      transform: style.transform,
      filter: style.filter,
      imageRendering: style.imageRendering,
      paused: v.paused,
      currentTime: round(v.currentTime),
      readyState: v.readyState,
      cls: String(v.className).slice(0, 60),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      zIndex: style.zIndex,
      parentCls: v.parentElement ? String(v.parentElement.className).slice(0, 60) : null,
      parentOpacity: parentStyle ? parentStyle.opacity : null,
      visible,
      // The stream's own resolution compared with what it is stretched to: a ratio
      // well above 1 means the picture is being enlarged, which reads as blur.
      upscale: v.videoWidth ? round(rect.width / v.videoWidth) : null,
    };
  });

  // Anything between the video and the page that scales it would show up here.
  const scaledAncestors = [];
  const first = document.querySelector('video');
  for (let el = first && first.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.transform && style.transform !== 'none') {
      scaledAncestors.push({ tag: el.tagName, cls: String(el.className).slice(0, 80), transform: style.transform });
    }
  }

  const fsCandidates = [...document.querySelectorAll('[class*="fullscreen" i], [aria-label*="全屏"], [data-e2e*="fullscreen" i]')]
    .slice(0, 8)
    .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 70), aria: el.getAttribute('aria-label') }));

  return {
    href: location.href,
    devicePixelRatio: window.devicePixelRatio,
    zoom: window.outerWidth ? round(window.outerWidth / window.innerWidth) : null,
    inner: [window.innerWidth, window.innerHeight],
    outer: [window.outerWidth, window.outerHeight],
    screen: [window.screen.width, window.screen.height, window.screen.availWidth, window.screen.availHeight],
    visualViewportScale: window.visualViewport ? round(window.visualViewport.scale) : null,
    fullscreenElement: document.fullscreenElement ? document.fullscreenElement.className || document.fullscreenElement.tagName : null,
    videos,
    scaledAncestors,
    fsCandidates,
    playerCount: document.querySelectorAll('xg-video-container, .xgplayer').length,
  };
})()`;

const ENTER = `(async () => {
  // Douyin has two fullscreens: the real Fullscreen API one, and "网页全屏" (a CSS class
  // on #slidelist, \`isCssFullScreen\`). They fail differently, so the caller picks which
  // one to drive.
  const pageMode = ${JSON.stringify(process.argv.includes('--page'))};
  const candidates = pageMode
    ? ['[class*="pageFullScreen" i]', '[class*="page-fullscreen" i]', '.xgplayer-page-full-screen']
    : ['.xgplayer-fullscreen', '.xg-get-fullscreen', '[data-e2e*="fullscreen" i]', '[aria-label*="全屏"]'];
  let el = null;
  let used = null;
  for (const selector of candidates) {
    const found = document.querySelector(selector);
    if (found) { el = found; used = selector; break; }
  }
  if (!el) return { clicked: false, reason: 'no fullscreen control found' };

  const before = {
    fullscreenElement: document.fullscreenElement ? String(document.fullscreenElement.className).slice(0, 80) : null,
    inner: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio,
  };
  el.click();
  await new Promise((r) => setTimeout(r, 1500));
  return {
    clicked: true,
    used,
    tag: el.tagName,
    cls: String(el.className).slice(0, 80),
    before,
    after: {
      fullscreenElement: document.fullscreenElement ? String(document.fullscreenElement.className).slice(0, 80) : null,
      inner: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
    },
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
      if (!m.id) return;
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

    // A direct video URL is far more reliable than the feed, which may never start
    // playing on a profile that is not logged in.
    const navigateTo = arg('url', '');
    if (navigateTo) {
      await send('Page.enable');
      await send('Page.navigate', { url: navigateTo });
      await sleep(6000);
    }

    out.videoReady = await evaluate(WAIT_FOR_VIDEO);
    out.before = await evaluate(MEASURE);
    if (ENTER_FULLSCREEN) {
      out.enter = await evaluate(ENTER);
      await sleep(WAIT);
      out.after = await evaluate(MEASURE);
    }
    ws.close();
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  process.stdout.write('PLAYER=' + JSON.stringify(out) + '\n');
  process.exit(0);
})();
