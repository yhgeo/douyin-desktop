'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APP_ID,
  EXPORT_FORMAT,
  buildExportPayload,
  parseImportPayload,
  suggestFileName,
} = require('../app/config-transfer');

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

test('suggestFileName is filesystem-safe and timestamped', () => {
  const date = new Date(2026, 8, 20, 10, 15, 0);
  const name = suggestFileName('抖音优化', date);
  assert.equal(name, '抖音优化_配置备份_20260920_101500.json');
  assert.ok(!/[\\/:*?"<>|]/.test(suggestFileName('a/b:c*d?e"f<g>h|i')));
});
