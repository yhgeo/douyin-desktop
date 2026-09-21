'use strict';

/**
 * A minimal `electron` module, so modules that import it can be unit tested.
 *
 * Outside Electron, `require('electron')` resolves to the *path of the binary* rather
 * than to the API - so `const { app } = require('electron')` yields `undefined` and
 * `platform/constants.js`, which resolves every path eagerly at load, throws before a
 * single assertion runs. That eagerness is deliberate in production (see the comment in
 * constants.js: it is what keeps the dev tree and the portable build on one profile),
 * so the fix belongs in the tests, not in the code under test.
 *
 * The alternative used elsewhere in this repo is to extract the pure part into its own
 * electron-free module - `main/titles.js` exists for exactly that reason. That works
 * when the interesting behaviour is pure. It does not work here: what needs pinning in
 * `platform/downloads.js` is the reaction to a *session event*, and the session is the
 * electron-shaped part.
 *
 * This is a fixture, not a mock of Electron. It implements only the calls the modules
 * under test actually make, and it fails loudly on anything else rather than silently
 * returning `undefined`.
 */

const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * @param {{ window?: object, downloads?: string, userData?: string }} [options]
 *   `window` is what `BrowserWindow.fromWebContents()` returns.
 */
function createElectronStub(options = {}) {
  const userData = options.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-stub-'));
  const downloads = options.downloads || path.join(userData, 'downloads');

  const app = {
    getPath: (name) => {
      if (name === 'downloads') return downloads;
      if (name === 'userData') return userData;
      throw new Error(`electron stub: unexpected app.getPath(${JSON.stringify(name)})`);
    },
    getVersion: () => '0.0.0-stub',
    isPackaged: false,
    setName() {},
    on() {},
    quit() {},
  };

  const BrowserWindow = {
    fromWebContents: () => options.window || null,
  };

  return { app, BrowserWindow, downloads, userData };
}

/**
 * Make `require('electron')` return the stub for the rest of this process.
 *
 * `node --test` gives every test file its own process, so patching the loader here
 * cannot leak into another file.
 *
 * @param {Parameters<typeof createElectronStub>[0]} [options]
 */
function installElectronStub(options = {}) {
  const stub = createElectronStub(options);
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return stub;
    return original.call(this, request, parent, isMain);
  };
  return {
    restore: () => {
      Module._load = original;
    },
    stub,
  };
}

module.exports = { createElectronStub, installElectronStub };
