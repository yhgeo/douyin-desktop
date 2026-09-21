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
const { injectUserscript } = require('./inject');

const isDouyin = /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(location.hostname);
const isTopFrame = window.top === window;
const scriptEnabled = isDouyin && ipcRenderer.sendSync('get-script-enabled') !== false;
// Identifies this frame so we can ignore the echo of our own writes.
const frameId = `frame-${Math.random().toString(36).slice(2)}-${Date.now()}`;

// Douyin's "是否保存登录信息？" prompt can hang in its own close path, leaving a
// full-screen mask over a page whose buttons are all disabled - unrecoverable without a
// reload. Watch for that and recover it; see recovery/stuck-dialog.js for the chain.
if (isTopFrame) {
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
  injectUserscript({ isTopFrame });
}
