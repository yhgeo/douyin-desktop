// Finds the code that *shows* the "是否保存登录信息？" dialog and, more
// importantly, the confirm/cancel handlers it is given - that is what runs when
// the user clicks, and therefore what blocks.
//
// Usage: node tools/inspect/find-dialog-caller.js [--wait=26000]
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const electron = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const PORT = 9347;
const waitMs = Number((process.argv.find((a) => a.startsWith('--wait=')) || '--wait=26000').slice(7));

const EXPRESSION = `(async () => {
  const urls = [...new Set([
    ...[...document.scripts].map((s) => s.src).filter(Boolean),
    ...performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\\.js(\\?|$)/.test(n)),
  ])];

  const needles = ['save_guide'];
  const hits = [];

  for (const url of urls) {
    let text;
    try {
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) continue;
      text = await response.text();
    } catch { continue; }

    for (const needle of needles) {
      let from = 0;
      let count = 0;
      while (count < 2) {
        const at = text.indexOf(needle, from);
        if (at === -1) break;
        hits.push({ url, needle, context: text.slice(Math.max(0, at - 1500), at + 900) });
        from = at + needle.length;
        count += 1;
      }
    }
    if (hits.length >= 4) break;
  }

  return { scriptCount: urls.length, hitCount: hits.length, hits };
})()`;

async function cdpEvaluate(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || ''));
  if (!page) return { error: 'no douyin page target' };

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error('cdp timeout')); }, 150000);
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

  // Isolated profile: never touch the user's own session.
  const userDataDir = path.join(os.tmpdir(), `douyin-caller-probe-${Date.now()}`);
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

  process.stdout.write(`CALLER_PROBE=${JSON.stringify(result)}\n`);
  process.exit(0);
})();
