// Invokes the stuck dialog button's own React onClick handler and watches what
// happens, instrumenting the DOM removal calls that the close path depends on.
//
// The close path is:
//   confirmHandler -> async call -> .then(h) / .catch(h)
//   h() = s() + n?.()
//   s() = unmountComponentAtNode(u) + u.remove()
// so if the dialog survives, either h() never ran or s() threw before removing.
//
// Usage: node tools/inspect/invoke-dialog-handler.js [--port=9222] [--button=confirm|cancel]
'use strict';

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '--port=9222').slice(7));
const BUTTON = (process.argv.find((a) => a.startsWith('--button=')) || '--button=confirm').slice(9);
const SELECTOR = BUTTON === 'cancel'
  ? '.trust-login-dialog-button-cancel'
  : '.trust-login-dialog-button-confirm';

const EXPRESSION = `(async () => {
  const out = {};
  const log = [];

  // Instrument the two APIs s() uses, so we can see whether removal was attempted.
  if (!window.__removeInstrumented) {
    window.__removeInstrumented = true;
    const origRemove = Element.prototype.remove;
    Element.prototype.remove = function () {
      log.push({ call: 'Element.remove', id: this.id || null, className: typeof this.className === 'string' ? this.className.slice(0, 60) : null });
      return origRemove.apply(this, arguments);
    };
    const origRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function (child) {
      log.push({ call: 'removeChild', parentId: this.id || null, childId: child && child.id || null });
      return origRemoveChild.apply(this, arguments);
    };
    const origUnmount = Node.prototype.remove;
    Node.prototype.remove = function () {
      log.push({ call: 'Node.remove', id: this.id || null });
      return origUnmount.apply(this, arguments);
    };
  }

  const errors = [];
  const onError = (e) => errors.push({ type: 'error', message: e.message, stack: (e.error && e.error.stack || '').slice(0, 500) });
  const onRejection = (e) => errors.push({ type: 'unhandledrejection', reason: String(e.reason && e.reason.stack || e.reason).slice(0, 500) });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  const button = document.querySelector('${SELECTOR}');
  if (!button) { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); return { error: 'button not found' }; }

  // React keeps the element's props on a __reactProps$<random> key.
  const propsKey = Object.keys(button).find((k) => k.startsWith('__reactProps'));
  out.propsKey = propsKey || null;
  const props = propsKey ? button[propsKey] : null;
  out.hasOnClick = Boolean(props && typeof props.onClick === 'function');

  const container = document.getElementById('trust-logout-dialog');
  const containerPropsKey = container ? Object.keys(container).find((k) => k.startsWith('__react')) : null;
  out.containerReactKeys = container ? Object.keys(container).filter((k) => k.startsWith('__react')) : [];

  out.dialogBefore = Boolean(container);

  if (out.hasOnClick) {
    try {
      props.onClick();
      out.invokeReturned = 'ok';
    } catch (error) {
      out.invokeThrew = String(error && error.stack || error).slice(0, 700);
    }
  }

  // Let the promise chain (if any) settle.
  await new Promise((resolve) => setTimeout(resolve, 4000));

  out.dialogAfter = Boolean(document.getElementById('trust-logout-dialog'));
  out.removalCalls = log.slice(0, 20);
  out.errors = errors.slice(0, 6);

  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onRejection);
  return out;
})()`;

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || ''));
  if (!page) { process.stdout.write('INVOKE={"error":"no page"}\n'); process.exit(0); }

  const result = await new Promise((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error('cdp timeout')); }, 40000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: EXPRESSION, returnByValue: true, awaitPromise: true },
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

  process.stdout.write(`INVOKE=${JSON.stringify(result)}\n`);
  process.exit(0);
})();
