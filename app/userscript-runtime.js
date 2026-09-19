const { contextBridge } = require('electron');
// Reserved for future app controls. The userscript is injected in preload.js at document-start.
if (contextBridge) {
  // Keep this file intentionally minimal: the remote page receives only the APIs it needs.
}
