'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APP_ID,
  EXPORT_FORMAT,
  buildExportPayload,
  isPlainObject,
  parseImportPayload,
  suggestFileName,
} = require('../app/storage/config-transfer');

const SAMPLE = {
  GM_Panel: { panel: { 'douyin-optimization': { enable: true } } },
  'short-cut': [{ key: 'a', value: 1 }],
};

test('buildExportPayload wraps the values with identifying metadata', () => {
  const payload = buildExportPayload(SAMPLE, { scriptName: '抖音优化', scriptVersion: '1.2.3' });
  assert.equal(payload.app, APP_ID);
  assert.equal(payload.format, EXPORT_FORMAT);
  assert.equal(payload.script.name, '抖音优化');
  assert.equal(payload.script.version, '1.2.3');
  assert.deepEqual(payload.values, SAMPLE);
  assert.match(payload.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('buildExportPayload copies the values instead of aliasing them', () => {
  const payload = buildExportPayload(SAMPLE);
  payload.values.GM_Panel = 'mutated';
  assert.deepEqual(SAMPLE.GM_Panel, { panel: { 'douyin-optimization': { enable: true } } });
});

test('buildExportPayload tolerates junk input', () => {
  assert.deepEqual(buildExportPayload(null).values, {});
  assert.deepEqual(buildExportPayload([1, 2]).values, {});
});

test('export round-trips through import', () => {
  const text = JSON.stringify(buildExportPayload(SAMPLE, { scriptName: '抖音优化' }));
  const result = parseImportPayload(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, SAMPLE);
  assert.deepEqual(result.keys, ['GM_Panel', 'short-cut']);
  assert.equal(result.format, EXPORT_FORMAT);
});

test('import accepts the userscript own bare {key: value} export', () => {
  // This is exactly what the bundled script writes from its "导出至文件" action,
  // so backups stay interchangeable with Tampermonkey.
  const result = parseImportPayload(JSON.stringify(SAMPLE));
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, SAMPLE);
  assert.equal(result.format, null);
});

test('import rejects malformed input with a usable message', () => {
  assert.match(parseImportPayload('').error, /为空/);
  assert.match(parseImportPayload('   ').error, /为空/);
  assert.match(parseImportPayload('{oops').error, /JSON/);
  assert.match(parseImportPayload('[1,2,3]').error, /JSON 对象/);
  assert.match(parseImportPayload('"text"').error, /JSON 对象/);
  assert.match(parseImportPayload('42').error, /JSON 对象/);
  assert.match(parseImportPayload('{}').error, /为空/);
  assert.equal(parseImportPayload(undefined).ok, false);
  assert.equal(parseImportPayload(null).ok, false);
});

test('import refuses oversized files before parsing them', () => {
  const huge = `{"a":"${'x'.repeat(9 * 1024 * 1024)}"}`;
  assert.match(parseImportPayload(huge).error, /过大/);
});

test('a wrapper without our app id is treated as plain values, not a wrapper', () => {
  // Guards against swallowing a legitimate key that happens to be called `values`.
  const result = parseImportPayload(JSON.stringify({ values: { a: 1 } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, { values: { a: 1 } });
});

test('a bare config whose keys collide with the wrapper names is reported, not half-imported', () => {
  // Measured before the fix: three keys in, one key imported. The file carried our app
  // marker *and* a `values` object, so it was read as a wrapper and its own fields became
  // the payload - `fontSize` was dropped and `theme` was imported under the wrong name.
  //
  // A marker without a format number cannot be confirmed either way, and guessing wrong
  // loses the user's configuration, so it is refused with an explanation instead.
  const result = parseImportPayload(JSON.stringify({
    app: APP_ID,
    values: { theme: 'dark' },
    fontSize: 16,
  }));
  assert.equal(result.ok, false);
  assert.match(result.error, /format/);
});

test('a wrapper carrying the format number is still read as a wrapper', () => {
  const text = JSON.stringify({ app: APP_ID, format: EXPORT_FORMAT, values: { theme: 'dark' } });
  const result = parseImportPayload(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, { theme: 'dark' });
});

test('a bare config that happens to use the name `app` is still plain values', () => {
  // `app` alone is not a marker: the app id has to match as well.
  const result = parseImportPayload(JSON.stringify({ app: 'something-else', values: { a: 1 } }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, { app: 'something-else', values: { a: 1 } });
});

test('isPlainObject accepts objects and rejects everything else', () => {
  // Used by the IPC layer to validate a payload arriving from the renderer.
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject('{"a":1}'), false);
  assert.equal(isPlainObject(1), false);
  assert.equal(isPlainObject(true), false);
});

test('suggestFileName is filesystem-safe and timestamped', () => {
  const date = new Date(2026, 8, 20, 10, 15, 0);
  const name = suggestFileName('抖音优化', date);
  assert.equal(name, '抖音优化_配置备份_20260920_101500.json');
  assert.ok(!/[\\/:*?"<>|]/.test(suggestFileName('a/b:c*d?e"f<g>h|i')));
});
