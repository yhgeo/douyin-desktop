// Regression guard for the userscript injection timing.
//
// Proves three things:
//   1. at the raw preload moment the document has no root element, which is what
//      made the bundled userscript abort, and
//   2. the shipped `whenDocumentElementAvailable` helper defers past that point, and
//   3. deferring still injects *before* any page script runs, so document-start
//      semantics are preserved.
const fs = require('node:fs');
const path = require('node:path');

const { whenDocumentElementAvailable } = require('../../app/dom-ready');

const root = path.join(__dirname, '..', '..');
const USERSCRIPT = 'assets/douyin-optimization.user.js';

const report = {
  hasDocumentElementAtPreload: Boolean(document.documentElement),
  hasHeadAtPreload: Boolean(document.head),
  childNodeCountAtPreload: document.childNodes.length,
  rawInjectionOk: false,
  rawInjectionError: null,
  rawPageScriptsRanAtInject: null,
  deferredInjectionOk: false,
  deferredInjectionError: null,
  deferredPageScriptsRan: null,
  hasDocumentElementAtInject: null,
};

const values = {};
globalThis.GM_getValue = (key, fallback) =>
  (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback);
globalThis.GM_setValue = (key, value) => { values[key] = value; return Promise.resolve(); };
globalThis.GM_setValues = (input) => { Object.assign(values, input || {}); };
globalThis.GM_deleteValue = (key) => { delete values[key]; };
globalThis.GM_listValues = () => Object.keys(values);
globalThis.GM_addValueChangeListener = () => 1;
globalThis.GM_removeValueChangeListener = () => {};
globalThis.GM_registerMenuCommand = () => 'id';
globalThis.GM_unregisterMenuCommand = () => {};
globalThis.GM_getResourceText = () => undefined;
globalThis.GM_xmlhttpRequest = () => ({ abort() {} });
globalThis.GM_download = () => {};
globalThis.GM_info = { script: { name: '抖音优化', version: 'test' }, scriptHandler: '抖音' };
globalThis.unsafeWindow = globalThis;

const evaluateBundled = (file) => (0, eval)(fs.readFileSync(path.join(root, file), 'utf8'));

// Dependencies are DOM-free at load time, so they can be evaluated up front.
for (const file of ['vendor/domutils.umd.js', 'vendor/pops.umd.js', 'vendor/utils.umd.js', 'vendor/qmsg.umd.js']) {
  evaluateBundled(file);
}

// 1. The raw moment: expected to throw, exactly as the shipped code used to.
report.rawPageScriptsRanAtInject = globalThis.__pageScriptsRan ?? 0;
try {
  evaluateBundled(USERSCRIPT);
  report.rawInjectionOk = true;
} catch (error) {
  report.rawInjectionError = error.message;
}

// 2 + 3. The shipped deferral helper, exercised against the real userscript.
whenDocumentElementAvailable(() => {
  report.hasDocumentElementAtInject = Boolean(document.documentElement);
  report.deferredPageScriptsRan = globalThis.__pageScriptsRan ?? 0;
  try {
    evaluateBundled(USERSCRIPT);
    report.deferredInjectionOk = true;
  } catch (error) {
    report.deferredInjectionError = error.message;
  }
});

// Evaluated lazily so the stub marker (set by the page's own inline script) is
// already present when the harness reads the report.
globalThis.__injectionTimingReport = () => ({
  ...report,
  isLocalStub: Boolean(globalThis.__douyinDesktopLocalStub),
});
