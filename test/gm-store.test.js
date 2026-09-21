'use strict';

// The store's own semantics.
//
// `test/config-backup.test.js` covers the export/import path end to end; this file pins
// how the store handles *keys*, which is where a hostile or merely unlucky name used to
// do damage.
//
// Measured before the fix: on a plain object literal, `set('__proto__', { injected: 'x' })`
// invoked the inherited `__proto__` setter and replaced the prototype instead of adding a
// key. `get('injected')` then returned `'x'` while `has('injected')` said no, and nothing
// reached the file - `JSON.stringify` does not serialise a prototype. The store now holds
// its values on a null-prototype object, where `__proto__` is an ordinary key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GmStore, LEGACY_VALUES_KEY, toValueStore } = require('../app/storage/gm-store');

function tempStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `douyin-store-${name}-`));
  return { dir, file: path.join(dir, 'userscript-config.json') };
}

/** Cleanup says nothing about the code under test. */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not a test failure.
  }
}

// ---------------------------------------------------------------------------
// Prototype safety
// ---------------------------------------------------------------------------

test('a __proto__ key is stored as an ordinary key, not as a prototype rewrite', () => {
  const { dir, file } = tempStore('proto');
  try {
    const store = new GmStore(file);
    store.set('__proto__', { injected: 'x' });

    assert.equal(Object.getPrototypeOf(store.values), null, 'the store must have no prototype to trip');
    assert.equal(store.has('__proto__'), true);
    assert.deepEqual(store.get('__proto__'), { injected: 'x' });

    // The two symptoms of the old behaviour.
    assert.equal(store.has('injected'), false, 'the payload must not become a store key');
    assert.equal({}.injected, undefined, 'and must never reach Object.prototype');
  } finally {
    cleanup(dir);
  }
});

test('a __proto__ key survives a restart', () => {
  const { dir, file } = tempStore('proto-restart');
  try {
    const store = new GmStore(file);
    store.set('__proto__', { injected: 'x' });

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(raw), ['__proto__'], 'it must be written, not silently dropped');

    const reopened = new GmStore(file);
    assert.equal(reopened.has('__proto__'), true);
    assert.deepEqual(reopened.get('__proto__'), { injected: 'x' });
    assert.equal({}.injected, undefined);
  } finally {
    cleanup(dir);
  }
});

test('a value read from disk cannot introduce a prototype either', () => {
  const { dir, file } = tempStore('proto-on-disk');
  try {
    // A hand-edited or Tampermonkey-written backup can contain anything. Written as a
    // string on purpose: an object literal would interpret `__proto__` as a prototype.
    fs.writeFileSync(file, '{"constructor":{"bad":true},"__proto__":{"injected":"y"}}', 'utf8');
    const store = new GmStore(file);

    assert.equal(Object.getPrototypeOf(store.values), null);
    assert.equal(store.has('constructor'), true, 'even Object members are plain keys here');
    assert.deepEqual(store.get('__proto__'), { injected: 'y' });
    assert.equal({}.injected, undefined);
  } finally {
    cleanup(dir);
  }
});

test('replaceAll applies the same rule', () => {
  const { dir, file } = tempStore('replace-all');
  try {
    const store = new GmStore(file);
    store.replaceAll(JSON.parse('{"__proto__":{"injected":"z"},"a":1}'));

    assert.equal(Object.getPrototypeOf(store.values), null);
    assert.deepEqual(store.keys().sort(), ['__proto__', 'a']);
    assert.equal({}.injected, undefined);
  } finally {
    cleanup(dir);
  }
});

test('toValueStore always produces a prototype-free copy', () => {
  assert.equal(Object.getPrototypeOf(toValueStore({ a: 1 })), null);
  assert.equal(Object.getPrototypeOf(toValueStore(null)), null);
  assert.equal(Object.getPrototypeOf(toValueStore(undefined)), null);
  // Spread before comparing: `deepStrictEqual` checks prototypes, and these deliberately
  // have none.
  assert.deepEqual({ ...toValueStore(null) }, {});
  assert.deepEqual({ ...toValueStore({ a: 1 }) }, { a: 1 });
  assert.deepEqual(Object.keys(toValueStore({ a: 1 })), ['a']);

  const source = { a: 1 };
  const copy = toValueStore(source);
  copy.a = 2;
  assert.equal(source.a, 1, 'the source is copied, not aliased');
});

// ---------------------------------------------------------------------------
// Ordinary behaviour
// ---------------------------------------------------------------------------

test('set reports the previous value', () => {
  const { dir, file } = tempStore('set');
  try {
    const store = new GmStore(file);
    assert.deepEqual(store.set('a', 1), { oldValue: undefined, newValue: 1 });
    assert.deepEqual(store.set('a', 2), { oldValue: 1, newValue: 2 });
  } finally {
    cleanup(dir);
  }
});

test('setMany applies every key and reports each change', () => {
  const { dir, file } = tempStore('set-many');
  try {
    const store = new GmStore(file);
    store.set('a', 1);
    const changes = store.setMany({ a: 10, b: 20 });

    assert.deepEqual(changes, [
      { key: 'a', oldValue: 1, newValue: 10 },
      { key: 'b', oldValue: undefined, newValue: 20 },
    ]);
    assert.deepEqual(store.getAll(), { a: 10, b: 20 });
    assert.deepEqual(new GmStore(file).getAll(), { a: 10, b: 20 }, 'and it is on disk');
  } finally {
    cleanup(dir);
  }
});

test('setMany tolerates junk input', () => {
  const { dir, file } = tempStore('set-many-junk');
  try {
    const store = new GmStore(file);
    assert.deepEqual(store.setMany(null), []);
    assert.deepEqual(store.setMany(undefined), []);
    assert.deepEqual(store.getAll(), {});
  } finally {
    cleanup(dir);
  }
});

test('delete removes the key and reports what was there', () => {
  const { dir, file } = tempStore('delete');
  try {
    const store = new GmStore(file);
    store.set('a', 1);
    assert.deepEqual(store.delete('a'), { oldValue: 1, newValue: undefined });
    assert.equal(store.has('a'), false);
    assert.deepEqual(new GmStore(file).getAll(), {});
  } finally {
    cleanup(dir);
  }
});

test('getAll hands back a copy, so a caller cannot mutate the store by accident', () => {
  const { dir, file } = tempStore('get-all');
  try {
    const store = new GmStore(file);
    store.set('a', 1);
    const snapshot = store.getAll();
    snapshot.a = 999;
    snapshot.b = 999;
    assert.equal(store.get('a'), 1);
    assert.equal(store.has('b'), false);
  } finally {
    cleanup(dir);
  }
});

test('a corrupt backing file is treated as empty rather than fatal', () => {
  const { dir, file } = tempStore('corrupt');
  try {
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const store = new GmStore(file);
    assert.deepEqual(store.getAll(), {});
    // And it can still be written to, which is what recovers the situation.
    store.set('a', 1);
    assert.deepEqual(new GmStore(file).getAll(), { a: 1 });
  } finally {
    cleanup(dir);
  }
});

test('a JSON array on disk is not mistaken for a store', () => {
  const { dir, file } = tempStore('array');
  try {
    fs.writeFileSync(file, '[1,2,3]', 'utf8');
    assert.deepEqual(new GmStore(file).getAll(), {});
  } finally {
    cleanup(dir);
  }
});

test('initialized tracks whether the backing file exists yet', () => {
  const { dir, file } = tempStore('initialized');
  try {
    const store = new GmStore(file);
    assert.equal(store.initialized, false, 'nothing has been written yet');
    store.set('a', 1);
    assert.equal(store.initialized, true);
    assert.equal(new GmStore(file).initialized, true);
  } finally {
    cleanup(dir);
  }
});

test('the legacy localStorage key is still named, so the one-time migration can find it', () => {
  // Renaming this would silently orphan the configuration of every existing install.
  assert.equal(LEGACY_VALUES_KEY, 'douyin-desktop:gm-values');
});
