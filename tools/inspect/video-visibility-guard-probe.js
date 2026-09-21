'use strict';

/**
 * Does the video-visibility guard actually fire in a real renderer?
 *
 * The unit tests cover the predicate and the sweep against a fake document. What they cannot
 * cover is the DOM integration - a real `<style>` in a real stylesheet, `cssRules` access, and
 * the MutationObserver noticing the insertion - and that is where this kind of fix goes wrong
 * quietly.
 *
 * So this builds the exact structure the bug needs, injects the exact rule shape the userscript
 * injects, and reports whether the guard removed it. It needs no login and no real feed: the
 * point is the mechanism, not the site.
 *
 * Usage: node tools/inspect/video-visibility-guard-probe.js [--port=9222]
 */

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '9222'));

/**
 * Build a video holder two levels under `.slider-video`, hide it with the bug's selector shape,
 * then look again after the guard's debounce has had time to run.
 */
const SYNTHETIC = `(async () => {
  const host = document.createElement('div');
  host.className = 'playerContainer';
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:200px;z-index:-1';
  host.innerHTML = '<div class="slider-video"><div><div id="__guard_probe_holder"><video muted></video></div></div></div>';
  document.body.appendChild(host);

  const holder = document.getElementById('__guard_probe_holder');

  // The shape the userscript injects: a descendant match that lands on the video holder.
  const style = document.createElement('style');
  style.textContent = '.playerContainer .slider-video > div > div:has(video) { display: none !important; }';
  document.head.appendChild(style);

  const before = getComputedStyle(holder).display;

  // Longer than the guard's debounce, so a "still hidden" result is a real miss.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const after = getComputedStyle(holder).display;
  const ruleStillPresent = [...document.styleSheets].some((sheet) => {
    try {
      return [...sheet.cssRules].some((rule) => String(rule.selectorText || '').includes(':has(video)'));
    } catch { return false; }
  });

  host.remove();
  style.remove();

  return {
    // hidden before is what makes the test meaningful: nothing to fix if the rule never applied.
    hiddenBefore: before === 'none',
    displayAfter: after,
    restored: after !== 'none',
    ruleStillPresent,
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

    const r = await send('Runtime.evaluate', { expression: SYNTHETIC, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    out.result = r.result && r.result.value;
    out.verdict = out.result && out.result.hiddenBefore && out.result.restored && !out.result.ruleStillPresent
      ? 'guard works: the rule was removed and the video holder is visible again'
      : 'guard did NOT do its job';
    ws.close();
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  process.stdout.write(`PROBE=${JSON.stringify(out, null, 1)}\n`);
  process.exit(0);
})();
