// Measure how long the stuck dialog takes to disappear, on the real app against the
// real Douyin page.
//
// The complaint was "I waited and it never closed". The watcher used to poll every 2s
// and require the state to hold for 6s, so up to 8s could pass. This injects the exact
// shapes into a live page and times the recovery, so the improvement is measured
// rather than asserted.
//
// Usage: node tools/inspect/measure-dialog-close.js [--port=9230]
'use strict';

const arg = (k, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const PORT = Number(arg('port', '9230'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The shape measured on the real stuck dialog: Semi's loading state. */
const LOADING_STUCK = `<div id="trust-logout-dialog">
<div class="trust-login-dialog-mask" style="position:fixed;inset:0;z-index:505">
<div class="trust-login-dialog-title">是否保存登录信息？（0）</div>
<div class="trust-login-dialog-button">
<button class="semi-button trust-login-dialog-button-cancel"><span class="semi-button-content">取消</span></button>
<button class="semi-button semi-button-loading trust-login-dialog-button-confirm" style="pointer-events:none"><span class="semi-button-content">保存</span></button>
</div></div></div>`;

/** Only a spinner - no loading class, no inline pointer-events. */
const SPINNER_STUCK = `<div id="trust-logout-dialog">
<div class="trust-login-dialog-mask" style="position:fixed;inset:0;z-index:505">
<div class="trust-login-dialog-title">是否保存登录信息？（0）</div>
<div class="trust-login-dialog-button">
<button class="semi-button trust-login-dialog-button-cancel"><span class="semi-button-content">取消</span></button>
<button class="semi-button trust-login-dialog-button-confirm"><span class="semi-spin"></span><span class="semi-button-content">保存</span></button>
</div></div></div>`;

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
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
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result && r.result.value;
  };

  const measure = async (label, html) => {
    const injected = await evaluate(`(() => {
      document.getElementById('trust-logout-dialog')?.remove();
      document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)});
      const d = document.getElementById('trust-logout-dialog');
      const buttons = [...d.querySelectorAll('button')];
      return {
        present: Boolean(d),
        buttons: buttons.map((b) => ({
          cls: b.className,
          pointerEvents: getComputedStyle(b).pointerEvents,
          hasSpinner: Boolean(b.querySelector('.semi-spin, .semi-spinner, [class*="loading"]')),
        })),
      };
    })()`);

    const started = Date.now();
    let elapsedMs = null;
    for (let i = 0; i < 200; i++) {
      const gone = await evaluate(`!document.getElementById('trust-logout-dialog')`).catch(() => false);
      if (gone) { elapsedMs = Date.now() - started; break; }
      await sleep(50);
    }
    const maskGone = await evaluate(`!document.querySelector('.trust-login-dialog-mask')`).catch(() => null);
    return { label, injected, elapsedMs, maskGone };
  };

  const report = {
    href: await evaluate(`location.href`),
    title: await evaluate(`document.title`),
    loadingShape: await measure('loading', LOADING_STUCK),
    spinnerShape: await measure('spinner', SPINNER_STUCK),
  };

  process.stdout.write('CLOSE_TIME=' + JSON.stringify(report) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('CLOSE_TIME=' + JSON.stringify({ error: String((e && e.message) || e) }) + '\n');
  process.exit(0);
});
