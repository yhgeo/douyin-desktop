'use strict';

/**
 * Send a message to every frame, not just the top one.
 *
 * Douyin runs iframes of its own, and each frame keeps its own mirror of the userscript
 * values. Broadcasting to all of them is what stops a frame from serving a stale value
 * after a write elsewhere.
 */

const { webContents } = require('electron');

function broadcast(channel, payload) {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(channel, payload);
  }
}

module.exports = { broadcast };
