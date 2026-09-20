// Captures the exception thrown when the stuck trust dialog's button is clicked.
//
// Attach to a running instance that was started with
//   npm start -- --remote-debugging-port=9222
// reproduce the freeze, then run this. It replays the buffered console/exception
// log, clicks the still-clickable 取消 button, and reports what the page throws.
//
// Usage: node tools/inspect/capture-dialog-exception.js [--port=9222]
'use strict';

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));
const CLICK = !process.argv.includes('--no-click');

async function findPage() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return targets.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || ''));
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      entry.resolve(message);
      return;
    }
    if (message.method) events.push(message);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    socket.send(JSON.stringify({ id, method, params }));
  });

  return { ready, send, events, close: () => socket.close() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(events) {
  const out = [];
  for (const event of events) {
    if (event.method === 'Runtime.exceptionThrown') {
      const d = event.params?.exceptionDetails || {};
      out.push({
        kind: 'exception',
        text: d.text,
        description: d.exception?.description?.slice(0, 700),
        url: d.url,
        line: d.lineNumber,
        column: d.columnNumber,
        stack: (d.stackTrace?.callFrames || []).slice(0, 6).map((f) => `${f.functionName || '(anon)'} @ ${f.url?.split('/').pop()}:${f.lineNumber}`),
      });
    } else if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
      out.push({
        kind: 'console.error',
        text: (event.params.args || []).map((a) => a.description || a.value).join(' ').slice(0, 400),
      });
    } else if (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error') {
      out.push({
        kind: 'log.error',
        text: event.params.entry.text?.slice(0, 300),
        url: event.params.entry.url,
      });
    }
  }
  return out;
}

(async () => {
  const result = {};
  try {
    const page = await findPage();
    if (!page) throw new Error('no douyin page target');

    const client = connect(page.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Runtime.enable');
    await client.send('Log.enable');

    // Buffered entries from before we attached.
    await sleep(2500);
    result.backlog = summarize(client.events);
    client.events.length = 0;

    if (CLICK) {
      result.beforeClick = (await client.send('Runtime.evaluate', {
        expression: `(() => {
          const b = document.querySelector('.trust-login-dialog-button-cancel');
          if (!b) return 'no cancel button';
          b.click();
          return 'clicked';
        })()`,
        returnByValue: true,
      })).result?.result?.value;

      await sleep(3500);
      result.afterClick = summarize(client.events);
    }

    result.stillStuck = (await client.send('Runtime.evaluate', {
      expression: `Boolean(document.getElementById('trust-logout-dialog'))`,
      returnByValue: true,
    })).result?.result?.value;

    client.close();
  } catch (error) {
    result.error = String(error?.message || error);
  }

  process.stdout.write(`DIALOG_EXCEPTION=${JSON.stringify(result)}\n`);
  process.exit(0);
})();
