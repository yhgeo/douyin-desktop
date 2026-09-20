// Runs the Electron end-to-end checks and asserts their output.
//
// These exercise the two things that were broken:
//   1. the bundled userscript aborting during injection (so no setting ever
//      took effect), and
//   2. custom schemes / ByteDance popups escaping to the OS.
//
// Usage: node tools/e2e/run-all.js
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const electron = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const CERT_DIR = path.join(__dirname, 'certs');

const failures = [];
let checks = 0;

/**
 * The harness serves a throwaway page over TLS on a `www.douyin.com` origin,
 * because Chromium's HSTS preload list upgrades douyin.com to HTTPS. The cert is
 * self-signed and never committed, so generate it on demand.
 */
function ensureCerts() {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) return;

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '3650',
    '-subj', '/CN=douyin.com',
    '-addext', 'subjectAltName=DNS:douyin.com,DNS:*.douyin.com',
  ], { cwd: CERT_DIR, encoding: 'utf8' });

  if (result.status !== 0 || !fs.existsSync(cert)) {
    process.stdout.write(
      `\nCould not generate the e2e TLS certificate.\n` +
      `Install openssl, or place a self-signed cert for *.douyin.com at:\n  ${CERT_DIR}\n` +
      `openssl stderr: ${result.stderr || result.error || 'unknown'}\n`,
    );
    process.exit(1);
  }
}

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ok  ${label}\n`);
  } else {
    process.stdout.write(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}\n`);
    failures.push(label);
  }
}

function runElectron(script, extraArgs = []) {
  // Some shells (and agent sandboxes) export ELECTRON_RUN_AS_NODE=1, which makes
  // the Electron binary behave as plain Node and every test fail confusingly.
  // NODE_OPTIONS can likewise inject a preload that is not valid inside Electron.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const result = spawnSync(electron, [path.join(__dirname, script), ...extraArgs], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 180000,
  });
  const stdout = `${result.stdout || ''}${result.stderr || ''}`;
  const read = (prefix) => {
    const line = stdout.split('\n').find((item) => item.startsWith(prefix));
    return line ? line.slice(prefix.length) : null;
  };
  return { stdout, read, status: result.status };
}

function tempDir(name) {
  const dir = path.join(os.tmpdir(), `douyin-desktop-e2e-${name}-${Date.now()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

// ---------------------------------------------------------------------------
ensureCerts();

process.stdout.write('\n[1/4] popup + custom scheme blocking\n');
// ---------------------------------------------------------------------------
{
  const { read } = runElectron('popup-guard-main.js');
  const parse = (prefix) => JSON.parse(read(prefix) || 'null');

  const vectors = parse('POPUP_VECTORS=');
  const openExternal = parse('POPUP_OPEN_EXTERNAL=') || [];
  const blocked = parse('POPUP_BLOCKED=') || [];
  const navEvents = parse('POPUP_NAV_EVENTS=') || [];
  const windowCount = Number(read('POPUP_WINDOW_COUNT='));

  // Hermeticity: if a proxy or resolver quirk let the request escape to the real
  // douyin.com, every later assertion would be meaningless. Fail loudly instead.
  check('page loaded from the local stub, not the real site', vectors?.__diag?.isLocalStub === true, JSON.stringify(vectors?.__diag));
  check('page loaded and produced results', Boolean(vectors?.popupBytedance));
  check('no extra Electron windows were created', windowCount === 1, `windowCount=${windowCount}`);

  check(
    'no custom scheme was ever handed to the OS',
    openExternal.every((url) => /^https?:\/\//.test(url)),
    JSON.stringify(openExternal),
  );
  check(
    'no bytedance/snssdk URL reached the OS',
    !openExternal.some((url) => /bytedance:|snssdk|douyin:/i.test(url)),
    JSON.stringify(openExternal),
  );
  check(
    'ordinary external link still opens in the system browser',
    openExternal.includes('https://example.com/page'),
    JSON.stringify(openExternal),
  );

  check('window.open(bytedance://) was denied', vectors?.popupBytedance === 'null');
  check('window.open(snssdk1128://) was denied', vectors?.popupSnssdk === 'null');
  check('ByteDance toutiao.com popup was denied', vectors?.popupToutiao === 'null');
  check('douyin.com popup window was denied', vectors?.popupDouyin === 'null');
  check('<a target="_blank" href="bytedance://"> was denied', blocked.some((item) => item.url.includes('blank-target')));

  check('subframe bytedance:// navigation was blocked', vectors?.iframeLocation === 'about:blank', vectors?.iframeLocation);
  check(
    'subframe navigation was reported as non-main-frame',
    blocked.some((item) => item.url.includes('iframe-navigate') && item.isMainFrame === false),
  );
  check('top frame stayed on douyin', vectors?.topLocation === 'https://www.douyin.com/', vectors?.topLocation);
  check(
    'same-frame bytedance:// link click did not navigate',
    vectors?.topLocationAfterClick === 'https://www.douyin.com/',
    vectors?.topLocationAfterClick,
  );

  // Documents why the previous guard leaked: subframe navigations never emit
  // `will-navigate`, which was the only navigation event the old code listened to.
  const subframeEvents = navEvents.filter((item) => item.isMainFrame === false);
  check('will-frame-navigate fired for subframe custom schemes', subframeEvents.length >= 2, JSON.stringify(navEvents));
  check(
    'will-navigate never fired for those subframe navigations',
    !navEvents.some((item) => item.event === 'will-navigate' && /bytedance:|snssdk/i.test(item.url) && item.isMainFrame === false),
  );
}

// ---------------------------------------------------------------------------
process.stdout.write('\n[2/4] userscript injection timing (root cause of the old failure)\n');
// ---------------------------------------------------------------------------
{
  const { read } = runElectron('injection-timing-main.js');
  const report = JSON.parse(read('INJECTION_TIMING=') || 'null');

  check('page loaded from the local stub, not the real site', report?.isLocalStub === true);
  check('document has no root element at the raw preload moment', report?.hasDocumentElementAtPreload === false);
  check('injecting at the raw preload moment fails', report?.rawInjectionOk === false);
  check(
    'the old failure is the DOMUtils childNodes crash',
    /childNodes/.test(report?.rawInjectionError || ''),
    report?.rawInjectionError,
  );
  check('deferring until <html> exists injects successfully', report?.deferredInjectionOk === true, report?.deferredInjectionError);
  check('deferred injection still beats every page script', report?.deferredPageScriptsRan === 0, `pageScriptsRan=${report?.deferredPageScriptsRan}`);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n[3/4] userscript injection + settings persistence\n');
// ---------------------------------------------------------------------------
{
  const userData = tempDir('persist');

  const writeRun = runElectron('main.js', [`--e2e-user-data=${userData}`, '--e2e-phase=write']);
  const writeResult = JSON.parse(writeRun.read('E2E_WRITE=') || 'null');
  const writeStates = JSON.parse(writeRun.read('E2E_USERSCRIPT_STATES=') || '[]');
  const writeConsoleErrors = JSON.parse(writeRun.read('E2E_CONSOLE_ERRORS=') || '[]');

  check('page loaded from the local stub, not the real site', writeResult?.isLocalStub === true);
  check('userscript injection reported success', writeStates.some((state) => state.ok === true), JSON.stringify(writeStates));
  check('no userscript load error in the console', writeConsoleErrors.length === 0, JSON.stringify(writeConsoleErrors));
  check(
    'the previously-crashing addStyle path ran (a <style> was inserted)',
    (writeResult?.styleCount ?? 0) >= 1,
    `styleCount=${writeResult?.styleCount}`,
  );
  check('settings were written and read back in-process', writeResult?.readBack?.marker > 0, JSON.stringify(writeResult?.readBack));
  check(
    'settings no longer live in page localStorage',
    writeResult?.legacyKeyPresent === false,
    `legacyKeyPresent=${writeResult?.legacyKeyPresent}`,
  );

  // Full process restart.
  const readRun = runElectron('main.js', [`--e2e-user-data=${userData}`, '--e2e-phase=read']);
  const readResult = JSON.parse(readRun.read('E2E_READ=') || 'null');
  const readStates = JSON.parse(readRun.read('E2E_USERSCRIPT_STATES=') || '[]');

  check('page loaded from the local stub, not the real site', readResult?.isLocalStub === true);
  check('userscript injection still succeeds after restart', readStates.some((state) => state.ok === true), JSON.stringify(readStates));
  check(
    'settings survived the restart',
    Boolean(readResult?.panel) && readResult.panel.marker === writeResult?.readBack?.marker,
    `written=${writeResult?.readBack?.marker} read=${readResult?.panel?.marker}`,
  );
  check('secondary key survived the restart', Array.isArray(readResult?.shortCut) && readResult.shortCut.length === 1);
  check('both keys are listed after restart', JSON.stringify(readResult?.keys) === JSON.stringify(['GM_Panel', 'short-cut']), JSON.stringify(readResult?.keys));

  fs.rmSync(userData, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
process.stdout.write('\n[4/4] clearing web data vs script data are independent\n');
// ---------------------------------------------------------------------------
{
  const userData = tempDir('clear');
  const { read } = runElectron('clear-data-main.js', [`--e2e-user-data=${userData}`]);
  const report = JSON.parse(read('CLEAR_REPORT=') || 'null');

  const afterWeb = report?.afterClearWebData;
  const afterScript = report?.afterClearScriptData;

  check('page loaded from the local stub, not the real site', report?.isLocalStub === true);
  check('script setting was seeded', report?.seeded?.scriptValue?.marker === 4242);
  check('site data was seeded', report?.seeded?.siteFlag === '1' && report?.seeded?.cookieCount > 0);

  // 「清除抖音网页数据」
  check('clearing web data wiped the site localStorage flag', afterWeb?.siteFlag === null);
  check('clearing web data wiped cookies', afterWeb?.cookieCount === 0);
  check(
    'clearing web data KEPT the script configuration',
    afterWeb?.scriptValue?.marker === 4242,
    JSON.stringify(afterWeb?.scriptValue),
  );
  check('clearing web data KEPT the script store on disk', report?.storeAfterClearWebData?.GM_Panel?.marker === 4242);

  // 「清除脚本配置数据」
  check(
    'clearing script data removed the script configuration',
    afterScript?.scriptValue === 'FALLBACK',
    JSON.stringify(afterScript?.scriptValue),
  );
  check(
    'clearing script data removed it from disk too',
    !('GM_Panel' in (report?.storeAfterClearScriptData || {})),
    JSON.stringify(report?.storeAfterClearScriptData),
  );

  fs.rmSync(userData, { recursive: true, force: true });
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`);
if (failures.length) {
  process.stdout.write(`FAILED:\n${failures.map((item) => `  - ${item}`).join('\n')}\n`);
  process.exitCode = 1;
}
