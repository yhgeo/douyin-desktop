'use strict';

// Integration test for the backup/restore path: it drives the production GmStore
// and the production serialisation together, which is exactly what the
// 「导出配置到文件」 / 「从文件导入配置」 menu items do once the file dialog
// returns a path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GmStore } = require('../app/storage/gm-store');
const { buildExportPayload, parseImportPayload } = require('../app/storage/config-transfer');

function tempStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `douyin-backup-${name}-`));
  return { dir, file: path.join(dir, 'userscript-config.json') };
}

test('export then import restores the configuration exactly', () => {
  const { dir, file } = tempStore('roundtrip');

  const store = new GmStore(file);
  store.set('GM_Panel', { panel: { 'douyin-optimization': { enable: true } }, nested: { deep: [1, 2, 3] } });
  store.set('short-cut', [{ key: 'a', value: 1 }]);
  const before = store.getAll();

  // Export: what the menu writes to disk.
  const backupPath = path.join(dir, 'backup.json');
  fs.writeFileSync(backupPath, JSON.stringify(buildExportPayload(before, { scriptName: '抖音优化' }), null, 2), 'utf8');

  // Simulate the user losing/changing everything in the meantime.
  store.replaceAll({});
  assert.deepEqual(store.getAll(), {});

  // Import: what the menu does after the file dialog resolves.
  const parsed = parseImportPayload(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(parsed.ok, true);
  store.replaceAll(parsed.values);

  assert.deepEqual(store.getAll(), before);

  // And it must survive a restart, i.e. be on disk.
  const reopened = new GmStore(file);
  assert.deepEqual(reopened.getAll(), before);
  assert.equal(reopened.initialized, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a backup written by the userscript itself can be imported', () => {
  const { dir, file } = tempStore('userscript');

  // Tampermonkey's "导出至文件" produces a bare { key: value } object.
  const bare = { GM_Panel: { panel: {} }, 'short-cut': [{ key: 'k', value: 'v' }] };
  const backupPath = path.join(dir, 'tampermonkey.json');
  fs.writeFileSync(backupPath, JSON.stringify(bare), 'utf8');

  const store = new GmStore(file);
  const parsed = parseImportPayload(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(parsed.ok, true);
  store.replaceAll(parsed.values);

  assert.deepEqual(new GmStore(file).getAll(), bare);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rejected backup leaves the existing configuration untouched', () => {
  const { dir, file } = tempStore('reject');

  const store = new GmStore(file);
  store.set('GM_Panel', { keep: true });

  const badPath = path.join(dir, 'broken.json');
  fs.writeFileSync(badPath, '{ not json', 'utf8');

  const parsed = parseImportPayload(fs.readFileSync(badPath, 'utf8'));
  assert.equal(parsed.ok, false);
  // The caller only replaces the store when parsing succeeded.
  if (parsed.ok) store.replaceAll(parsed.values);

  assert.deepEqual(store.getAll(), { GM_Panel: { keep: true } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the store writes atomically and reports initialisation', () => {
  const { dir, file } = tempStore('atomic');

  const store = new GmStore(file);
  assert.equal(store.initialized, false, 'a fresh store has no backing file yet');

  store.set('a', 1);
  assert.equal(store.initialized, true);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no temp file is left behind');

  store.clear();
  assert.deepEqual(new GmStore(file).getAll(), {});

  fs.rmSync(dir, { recursive: true, force: true });
});
