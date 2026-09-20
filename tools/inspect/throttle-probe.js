// Measures whether the page inside the app is being throttled by Chromium.
//
// Opening DevTools makes a stuck dialog disappear, and the biggest thing DevTools
// changes is that it stops throttling the page. This probe measures the actual
// timer / rAF rate and the visibility state so we can confirm or rule that out.
//
// Usage: node tools/inspect/throttle-probe.js [--wait=25000]
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const electron = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const PORT = 9345;
const waitMs = Number((process.argv.find((a) => a.startsWith('--wait=')) || '--wait=25000').slice(7));

const EXPRESSION = `(async () => {
  const measure = async (ms) => {
    const started = performance.now();
    let timerTicks = 0;
    let rafTicks = 0;
    let rafRunning = true;
    const bump = () => { rafTicks += 1; if (rafRunning) requestAnimationFrame(bump); };
    requestAnimationFrame(bump);
    const interval = setInterval(() => { timerTicks += 1; }, 100);
    await new Promise((resolve) => setTimeout(resolve, ms));
    clearInterval(interval);
    rafRunning = false;
    return {
      ms: Math.round(performance.now() - started),
      timerTicks,
      expectedTimerTicks: Math.round(ms / 100),
      rafTicks,
      expectedRafTicks: Math.round(ms / 16.7),
    };
  };

  return {
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    // Two samples: the first is taken right away, the second after the window has
    // had time to settle, which is when occlusion throttling usually kicks in.
    sampleA: await measure(1500),
    sampleB: await measure(1500),
  };
})()`;

async function cdpEvaluate(expression) {
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
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const userDataDir = path.join(os.tmpdir(), `douyin-throttle-probe-${Date.now()}`);
  const child = spawn(electron, [
    '.',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--in-process-gpu',
  ], { cwd: ROOT, env, stdio: 'ignore' });

  let result;
  try {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    result = await cdpEvaluate(EXPRESSION);
  } catch (error) {
    result = { error: String(error?.message || error) };
  } finally {
    child.kill();
  }

  process.stdout.write(`THROTTLE_PROBE=${JSON.stringify(result)}\n`);
  process.exit(0);
})();
