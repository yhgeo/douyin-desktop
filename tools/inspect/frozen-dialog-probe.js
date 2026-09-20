// Inspects a STILL-FROZEN dialog in an already-running instance of the app.
//
// Start the app with a debug port first:
//   .\node_modules\electron\dist\electron.exe . --remote-debugging-port=9222
// then reproduce the freeze and run:
//   node tools/inspect/frozen-dialog-probe.js
//
// It answers the two questions that decide the fix:
//   1. Is the dialog still in the DOM, and is anything covering its buttons?
//   2. Is this instance still throttling the page (i.e. does it have the fix)?
'use strict';

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));

const EXPRESSION = `(async () => {
  const measureThrottle = async (ms) => {
    let timerTicks = 0;
    const interval = setInterval(() => { timerTicks += 1; }, 100);
    await new Promise((resolve) => setTimeout(resolve, ms));
    clearInterval(interval);
    return { timerTicks, expected: Math.round(ms / 100) };
  };

  const describeAt = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return { selector, found: false };
    const rect = el.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const style = getComputedStyle(el);
    return {
      selector,
      found: true,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      spinnerPresent: Boolean(el.querySelector('svg, [class*="loading" i], [class*="spin" i]')),
      elementAtCenter: top ? top.tagName.toLowerCase() + '.' + (typeof top.className === 'string' ? top.className : '') : null,
      isButtonOnTop: Boolean(top && (top === el || el.contains(top))),
      pointerEvents: style.pointerEvents,
      display: style.display,
      visibility: style.visibility,
    };
  };

  const dialog = document.getElementById('trust-logout-dialog');
  const mask = document.querySelector('.trust-login-dialog-mask');

  return {
    href: location.href,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),

    dialogInDom: Boolean(dialog),
    dialogChildCount: dialog ? dialog.children.length : -1,
    // React marks the container it rendered into; a lingering attribute means the
    // root was never unmounted, which is exactly what the close path does first.
    reactRootAttribute: dialog
      ? [...dialog.attributes].map((a) => a.name).filter((n) => n.startsWith('_react') || n.startsWith('__react'))
      : [],

    maskInDom: Boolean(mask),
    maskPointerEvents: mask ? getComputedStyle(mask).pointerEvents : null,
    maskZIndex: mask ? getComputedStyle(mask).zIndex : null,

    cancelButton: describeAt('.trust-login-dialog-button-cancel'),
    confirmButton: describeAt('.trust-login-dialog-button-confirm'),

    // Other full-screen overlays that could be eating clicks.
    fullScreenOverlays: [...document.querySelectorAll('div,section')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < window.innerWidth * 0.9 || rect.height < window.innerHeight * 0.9) return false;
        const style = getComputedStyle(el);
        return (style.position === 'fixed' || style.position === 'absolute')
          && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      })
      .slice(0, 6)
      .map((el) => ({
        id: el.id || null,
        className: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
        zIndex: getComputedStyle(el).zIndex,
        pointerEvents: getComputedStyle(el).pointerEvents,
      })),

    // If the fix is active, timers keep full rate even when the window is occluded.
    throttle: await measureThrottle(2000),
  };
})()`;

async function cdp(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || ''));
  if (!page) return { error: 'no douyin page target', targets: targets.map((t) => t.url) };

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error('cdp timeout')); }, 30000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      resolve(message.result?.result?.value ?? message);
    });
    socket.addEventListener('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

(async () => {
  let result;
  try {
    result = await cdp(EXPRESSION);
  } catch (error) {
    result = { error: String(error?.message || error), hint: `Is the app running with --remote-debugging-port=${PORT}?` };
  }
  process.stdout.write(`FROZEN_PROBE=${JSON.stringify(result)}\n`);
  process.exit(0);
})();
