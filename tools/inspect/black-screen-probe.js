// Diagnose a black window: is the document actually rendered, or did the renderer
// never paint? Reports DOM state plus the console/log backlog the page produced
// before we attached (a black screen is usually an early error, long gone by the
// time you open DevTools).
//
// Usage: node tools/inspect/black-screen-probe.js [--port=9222] [--wait=4000]
'use strict';

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));
const WAIT = Number((process.argv.find((a) => a.startsWith('--wait=')) || '--wait=4000').slice(7));

const STATE = `(() => {
  const html = document.documentElement;
  const body = document.body;
  const cs = body ? getComputedStyle(body) : null;
  const root = document.getElementById('root') || document.querySelector('[id*=root],#app,.app');
  return {
    readyState: document.readyState,
    title: document.title,
    href: location.href,
    htmlLength: html ? html.outerHTML.length : -1,
    bodyChildren: body ? body.childElementCount : -1,
    bodyText: body ? (body.innerText || '').trim().slice(0, 200) : '',
    bodyBg: cs ? cs.backgroundColor : null,
    bodyDisplay: cs ? cs.display : null,
    bodyVisibility: cs ? cs.visibility : null,
    bodyOpacity: cs ? cs.opacity : null,
    bodyRect: body ? JSON.stringify(body.getBoundingClientRect()) : null,
    rootFound: Boolean(root),
    rootId: root ? root.id : null,
    rootChildren: root ? root.childElementCount : -1,
    rootHtmlLength: root ? root.innerHTML.length : -1,
    visibilityState: document.visibilityState,
    hasUserscriptMarkers: {
      scriptTag: Boolean(document.querySelector('script[data-douyin-shell]')),
      gmBridge: typeof window.GM_setValue === 'function' || typeof window.unsafeWindow !== 'undefined',
    },
    viewport: window.innerWidth + 'x' + window.innerHeight,
    dpr: window.devicePixelRatio,
    scriptCount: document.scripts.length,
    styleSheetCount: document.styleSheets.length,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    process.stdout.write('BLACK={"error":"no page target"}\n');
    process.exit(0);
  }

  const events = [];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); });
  });

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      events.push({
        kind: 'exception',
        text: d.text,
        url: d.url,
        line: d.lineNumber,
        desc: (d.exception && (d.exception.description || d.exception.value)) || '',
        stack: ((d.stackTrace && d.stackTrace.callFrames) || []).slice(0, 3)
          .map((f) => `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').pop()}:${f.lineNumber}`),
      });
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => {
        if (a.type === 'string') return a.value;
        if (a.value !== undefined) return String(a.value);
        return a.description || a.type;
      }).join(' ');
      if (/error|warn/i.test(m.params.type) || /fail|error|黑屏|undefined/i.test(text)) {
        events.push({ kind: 'console.' + m.params.type, text: text.slice(0, 400) });
      }
    } else if (m.method === 'Log.entryAdded') {
      const en = m.params.entry || {};
      events.push({ kind: 'log.' + en.level + (en.source ? '/' + en.source : ''), text: (en.text || '').slice(0, 400), url: (en.url || '').split('/').pop() });
    }
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evalExpr = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text };
    return r.result && r.result.value;
  };

  const backlog = events.slice();
  const before = await evalExpr(STATE);

  // Nudge the page and see whether anything reacts - distinguishes "blank but alive"
  // from "renderer wedged".
  const alive = await evalExpr(`(() => {
    const t0 = performance.now();
    for (let i = 0; i < 1e6; i++) { Math.sqrt(i); }
    return { jsAlive: true, jsMs: Math.round(performance.now() - t0), now: Math.round(performance.now()) };
  })()`);

  await sleep(WAIT);
  const after = await evalExpr(STATE);

  process.stdout.write('BLACK=' + JSON.stringify({
    before,
    after,
    alive,
    backlogCount: backlog.length,
    backlog: backlog.slice(0, 25),
    eventsDuringWait: events.slice(backlog.length).slice(0, 20),
  }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('BLACK=' + JSON.stringify({ error: String(e && e.message || e) }) + '\n');
  process.exit(0);
});
