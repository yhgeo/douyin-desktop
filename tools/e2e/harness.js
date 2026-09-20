// Shared plumbing for the Electron end-to-end tests.
//
// Chromium's HSTS preload list upgrades `douyin.com` to HTTPS, so every harness
// serves a throwaway page over TLS on a mapped `www.douyin.com` origin. This
// module owns the TLS server, the certificate, and an IPC surface that mirrors
// what app/main.js provides to app/preload/index.js, so the tests exercise the real
// preload instead of a reimplementation of it.
'use strict';

const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { app, ipcMain } = require('electron');

const CERT_DIR = path.join(__dirname, 'certs');

/** The self-signed cert is never committed; generate it on demand. */
function ensureCerts() {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) return true;

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '3650',
    '-subj', '/CN=douyin.com',
    '-addext', 'subjectAltName=DNS:douyin.com,DNS:*.douyin.com',
  ], { cwd: CERT_DIR, encoding: 'utf8' });

  return result.status === 0 && fs.existsSync(cert);
}

/**
 * Apply the Chromium switches every harness needs.
 *
 * `host-resolver-rules` points www.douyin.com at our local server, and
 * `no-proxy-server` is essential: if the machine has a proxy configured,
 * Chromium hands the request to the proxy instead of resolving it locally, the
 * mapping is ignored, and the tests would silently run against the *real*
 * douyin.com. Every stub page also sets `window.__localStub`, and the runner
 * asserts on it, so an escape can never pass unnoticed again.
 *
 * `ignore-certificate-errors` accepts the self-signed cert. GPU is disabled
 * because the CI/agent machines have no usable GPU process.
 */
function applyHarnessSwitches(port) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('ignore-certificate-errors');
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('host-resolver-rules', `MAP www.douyin.com 127.0.0.1:${port}`);
}

/** Set by every stub page; lets a test prove it is not talking to the real site. */
const STUB_MARKER = '__douyinDesktopLocalStub';

/** Start the fake douyin.com origin. Resolves once it is listening. */
async function serveDouyinPage(port, html) {
  return serveDouyinOrigin(port, (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
  });
}

/**
 * Start the fake douyin.com origin with a per-request handler.
 *
 * Needed to reproduce a server that refuses the document: the first navigation gets
 * an empty body, and only after the site storage has been reset does a real page
 * come back.
 *
 * @param {number} port
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} handler
 */
async function serveDouyinOrigin(port, handler) {
  if (!ensureCerts()) throw new Error('e2e certificate unavailable (is openssl installed?)');

  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
      cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
    },
    (request, response) => handler(request, response),
  );

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

/** Read a `PREFIX=payload` line from captured stdout. */
function readLine(stdout, prefix) {
  const line = String(stdout).split('\n').find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

function parseLine(stdout, prefix) {
  return JSON.parse(readLine(stdout, prefix) || 'null');
}

/**
 * Mirror the IPC surface app/main.js exposes to app/preload/index.js.
 *
 * @param {object} [options]
 * @param {{ getAll: Function, initialized: boolean, set: Function, delete: Function,
 *           replaceAll: Function }} [options.store] userscript value store; when
 *           omitted a plain in-memory stand-in is used.
 */
function installPreloadIpc(options = {}) {
  const store = options.store || (() => {
    let values = {};
    return {
      initialized: false,
      getAll: () => ({ ...values }),
      set: (key, value) => { const oldValue = values[key]; values[key] = value; return { oldValue }; },
      delete: (key) => { const oldValue = values[key]; delete values[key]; return { oldValue }; },
      replaceAll: (next) => { values = { ...(next || {}) }; },
    };
  })();

  const received = {
    userscriptLoadStates: [],
    storageErrors: [],
    menuCommands: [],
    actions: [],
  };

  ipcMain.on('get-script-enabled', (event) => { event.returnValue = options.scriptEnabled !== false; });
  ipcMain.on('gm-menu-reset', () => {});
  ipcMain.on('gm-menu-register', (_event, command) => { received.menuCommands.push(command); });
  ipcMain.on('gm-menu-unregister', () => {});
  ipcMain.on('userscript-loaded', (_event, state) => { received.userscriptLoadStates.push(state); });
  ipcMain.on('userscript-storage-error', (_event, info) => { received.storageErrors.push(info); });
  ipcMain.handle('gm-http-request', async () => ({ ok: false, error: 'disabled in test' }));
  ipcMain.on('gm-download', () => {});

  ipcMain.on('gm-store-read', (event) => {
    event.returnValue = { values: store.getAll(), initialized: Boolean(store.initialized) };
  });
  ipcMain.on('gm-store-import', (_event, values) => { store.replaceAll(values); });
  ipcMain.on('gm-store-set', (_event, { key, value }) => { store.set(key, value); });
  ipcMain.on('gm-store-delete', (_event, { key }) => { store.delete(key); });

  return { store, received };
}

/** Page with inline scripts, so tests can tell whether injection beat the page. */
const PAGE_WITH_SCRIPTS = `<!doctype html><html><head><title>douyin</title>
<script>window.${STUB_MARKER} = true; window.__pageScriptsRan = (window.__pageScriptsRan || 0) + 1;</script>
</head><body><div id="app"></div>
<script>window.__pageScriptsRan = (window.__pageScriptsRan || 0) + 1;</script>
</body></html>`;

/** Deliberately style-free page, so any <style> can only come from the userscript. */
const PAGE_PLAIN = `<!doctype html><html><head><title>douyin</title>
<script>window.${STUB_MARKER} = true;</script>
</head><body><div id="app"></div></body></html>`;

module.exports = {
  CERT_DIR,
  PAGE_PLAIN,
  PAGE_WITH_SCRIPTS,
  STUB_MARKER,
  applyHarnessSwitches,
  ensureCerts,
  installPreloadIpc,
  parseLine,
  readLine,
  serveDouyinOrigin,
  serveDouyinPage,
};
