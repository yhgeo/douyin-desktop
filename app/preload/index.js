'use strict';

/**
 * Preload entry: decides what this frame is, then hands off to the two modules that do
 * the actual work.
 *
 * In practice this runs only in the top frame. Electron does not inject preloads into
 * sub-frames unless `nodeIntegrationInSubFrames` is set, and window.js does not set it -
 * measured with a page holding one same-origin iframe: one `get-script-enabled` call
 * without the flag, two with it (and with the flag, the whole userscript also landed in
 * the iframe). The host and top-frame checks below stay anyway: they are what keeps
 * turning that flag on from becoming a silent cost, and they are what the code below
 * relies on to mean anything.
 */

const { ipcRenderer } = require('electron');
const { whenDocumentElementAvailable } = require('../platform/dom-ready');
const { installStuckDialogWatch, recoverStuckDialog } = require('../recovery/stuck-dialog');
const { installGmApi } = require('./gm-api');
const { injectUserscript, injectExperienceEnhancer } = require('./inject');
const { installVideoVisibilityGuard } = require('./video-visibility-guard');
const { installStyleCostGuard } = require('./style-cost-guard');
const { installPlayerProbe } = require('../diagnostics/player-probe');

const isDouyin = /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(location.hostname);
const isTopFrame = window.top === window;
const scriptEnabled = isDouyin && ipcRenderer.sendSync('get-script-enabled') !== false;
// Identifies this frame so we can ignore the echo of our own writes.
const frameId = `frame-${Math.random().toString(36).slice(2)}-${Date.now()}`;

// Douyin's "是否保存登录信息？" prompt can hang in its own close path, leaving a
// full-screen mask over a page whose buttons are all disabled - unrecoverable without a
// reload. Watch for that and recover it; see recovery/stuck-dialog.js for the chain.
//
// Gated on the site as well as the frame: this also runs on the local loading document in
// main/window.js, where there is no dialog to watch and a 400 ms poll would be pure cost.
if (isTopFrame && isDouyin) {
  whenDocumentElementAvailable(() => {
    installStuckDialogWatch({
      onRecovered: (info) => {
        console.warn(`[抖音] 已关闭卡住的弹窗（${info.via}，卡住 ${Math.round(info.stuckMs / 1000)} 秒）`);
        ipcRenderer.send('stuck-dialog-recovered', info);
      },
      // A dialog that never looks stuck is a detection miss: nothing happens and nothing
      // is logged, which is impossible to diagnose after the fact. Report the shape once
      // so a recurrence is visible in the log.
      onDiagnostic: (info) => {
        console.warn(`[抖音] 弹窗一直未被判定为卡住：${JSON.stringify(info)}`);
      },
    });
  });

  ipcRenderer.on('recover-stuck-dialog', () => {
    ipcRenderer.send('stuck-dialog-recovery-result', recoverStuckDialog());
  });
}

if (scriptEnabled) {
  if (isTopFrame) ipcRenderer.send('gm-menu-reset');
  installGmApi({ frameId, isTopFrame });
  // Installed only alongside the script: its whole job is to neutralise the script's CSS, and
  // the shell does not otherwise touch the page's stylesheets. See the module for the
  // measurement behind it.
  installVideoVisibilityGuard();
  // Same reasoning, different problem: the script's stylesheet also carries selector branches
  // for pages the user is not on, and `:has()` makes every recalculation pay for them. Both
  // guards are installed before the bundle is evaluated so their observers are already in
  // place when the stylesheet lands.
  installStyleCostGuard();
  injectUserscript({ isTopFrame });
}

// The player diagnostic recorder. Off unless switched on from 工具, and independent of the
// script switch: the thing being recorded is the site's own player, and the interesting
// question is often "does this still happen with the script off?".
if (isTopFrame && isDouyin) {
  let stopProbe = null;
  const start = () => {
    if (stopProbe) return;
    stopProbe = installPlayerProbe({
      onSample: (sample) => ipcRenderer.send('player-probe-sample', sample),
      // Read lazily: the user can change the mode in the middle of a run, and that change is
      // exactly what a snapshot needs to explain. The script keeps its switches inside one
      // `GM_Panel` object, so `fullScreen` is one level down - reading the top level returns
      // undefined and the log would claim the mode is unknown.
      readImmersiveMode: () => {
        try {
          if (typeof window.GM_getValue !== 'function') return null;
          const panel = window.GM_getValue('GM_Panel');
          return panel && typeof panel === 'object' ? panel.fullScreen : null;
        } catch {
          return null;
        }
      },
    });
  };
  const stop = () => {
    if (!stopProbe) return;
    stopProbe();
    stopProbe = null;
  };

  ipcRenderer.on('player-probe-set', (_event, enabled) => (enabled ? start() : stop()));
  if (ipcRenderer.sendSync('get-player-probe') === true) start();
}

if (isDouyin && isTopFrame && ipcRenderer.sendSync('get-experience-enhancer-enabled') === true) {
  injectExperienceEnhancer({ isTopFrame, hostname: location.hostname });
}
