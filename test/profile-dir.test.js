'use strict';

// Where a build keeps its data, and how an existing profile is carried over.
//
// Both halves matter more than they look:
//
//  * getting the location wrong means the installed app and the dev tree fight over one
//    Chromium profile - the LevelDB that must never have two writers;
//  * getting the carry-over wrong means the user is silently logged out and loses their
//    script configuration, which is the failure this project spends the most effort avoiding.
//
// The copy is also the slow part of a first launch, so what it skips is asserted rather than
// left to whoever edits the list next.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DATA_DIR_NAME,
  SKIP_DIRS,
  SKIP_FILES,
  copyProfile,
  hasProfile,
  isWritableDirectory,
  resolveProfileDir,
} = require('../app/platform/profile-dir');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `douyin-profile-${label}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not a test failure.
  }
}

// ---------------------------------------------------------------------------
// Where the data goes
// ---------------------------------------------------------------------------

test('a development run keeps the historical location', () => {
  // Working on the app must never touch the installed app's login.
  assert.equal(
    resolveProfileDir({ isPackaged: false, execPath: 'C:/proj/node_modules/electron/dist/electron.exe', defaultDir: 'C:/appdata/douyin-desktop' }),
    'C:/appdata/douyin-desktop',
  );
});

test('an installed build keeps its data beside the executable', () => {
  const dir = resolveProfileDir({
    isPackaged: true,
    execPath: path.join('D:', 'Apps', '抖音', '抖音.exe'),
    defaultDir: 'C:/appdata/douyin-desktop',
  });
  assert.equal(dir, path.join('D:', 'Apps', '抖音', DATA_DIR_NAME));
});

test('a portable build keeps its data beside the portable exe, not the temp copy', () => {
  // The portable target runs from an unpacked temp copy, so `execPath` points at a directory
  // that is deleted on exit. `PORTABLE_EXECUTABLE_DIR` is the folder the user actually has.
  const dir = resolveProfileDir({
    isPackaged: true,
    execPath: path.join('C:', 'Users', 'x', 'AppData', 'Local', 'Temp', 'abc123', '抖音.exe'),
    portableDir: path.join('E:', '抖音'),
    defaultDir: 'C:/appdata/douyin-desktop',
  });
  assert.equal(dir, path.join('E:', '抖音', DATA_DIR_NAME));
  assert.ok(!dir.includes('Temp'));
});

test('without a usable base it falls back instead of inventing a path', () => {
  const fallback = 'C:/appdata/douyin-desktop';
  assert.equal(resolveProfileDir({ isPackaged: true, execPath: '', defaultDir: fallback }), fallback);
  assert.equal(resolveProfileDir({ isPackaged: true, defaultDir: fallback }), fallback);
});

// ---------------------------------------------------------------------------
// Writability
// ---------------------------------------------------------------------------

test('writability is checked, not assumed', () => {
  const dir = tempDir('writable');
  try {
    assert.equal(isWritableDirectory(dir), true);
    // An install into a protected folder, or onto a read-only share.
    assert.equal(isWritableDirectory(path.join(dir, 'does', 'not', 'exist')), false);
    const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.write-probe'));
    assert.deepEqual(leftovers, [], 'the probe file is removed again');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Carrying an existing profile over
// ---------------------------------------------------------------------------

/** A stand-in for a used Chromium profile, cache weight included. */
function seedProfile(dir) {
  fs.mkdirSync(path.join(dir, 'Network'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Local Storage', 'leveldb'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Cache', 'Cache_Data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Code Cache', 'js'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'GPUCache'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
  fs.writeFileSync(path.join(dir, 'userscript-config.json'), '{"GM_Panel":{}}');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"scriptEnabled":true}');
  fs.writeFileSync(path.join(dir, 'Network', 'Cookies'), 'the login lives here');
  fs.writeFileSync(path.join(dir, 'Local Storage', 'leveldb', '000005.ldb'), 'site data');
  fs.writeFileSync(path.join(dir, 'Cache', 'Cache_Data', 'data_0'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(dir, 'Code Cache', 'js', 'index'), 'y'.repeat(2048));
  fs.writeFileSync(path.join(dir, 'GPUCache', 'data_0'), 'z'.repeat(2048));
  fs.writeFileSync(path.join(dir, 'SingletonLock'), '');
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '9222');
}

test('the carry-over keeps what the user would miss and skips what is reproducible', () => {
  const from = tempDir('from');
  const to = tempDir('to');
  try {
    seedProfile(from);
    const result = copyProfile(from, to);

    assert.equal(result.error, null);
    // The things that are not reproducible: the login, the site data, our own configuration.
    assert.equal(fs.readFileSync(path.join(to, 'Network', 'Cookies'), 'utf8'), 'the login lives here');
    assert.equal(fs.existsSync(path.join(to, 'Local Storage', 'leveldb', '000005.ldb')), true);
    assert.equal(fs.readFileSync(path.join(to, 'userscript-config.json'), 'utf8'), '{"GM_Panel":{}}');
    assert.equal(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"scriptEnabled":true}');
    assert.equal(fs.readFileSync(path.join(to, 'Preferences'), 'utf8'), '{}');

    // The things that are: ~640 MB of a 647 MB profile when this was written.
    for (const skipped of ['Cache', 'Code Cache', 'GPUCache']) {
      assert.equal(fs.existsSync(path.join(to, skipped)), false, `${skipped} must not be copied`);
    }
    // And Chromium's locks, which would make a fresh profile look already open.
    for (const skipped of SKIP_FILES) {
      assert.equal(fs.existsSync(path.join(to, skipped)), false, `${skipped} must not be copied`);
    }

    // The copy is small on purpose: that is what keeps a first launch quick.
    assert.ok(result.bytes < 8192, `expected a small copy, got ${result.bytes} bytes`);
    // Exactly the five files seeded above that are not caches or locks.
    assert.equal(result.files, 5, 'Preferences, the two config files, the cookies and site data');
  } finally {
    cleanup(from);
    cleanup(to);
  }
});

test('the carry-over never touches the source', () => {
  // One-way on purpose: the worst case is a duplicated profile, never a lost one.
  const from = tempDir('keep-from');
  const to = tempDir('keep-to');
  try {
    seedProfile(from);
    const before = fs.readdirSync(from).sort();
    copyProfile(from, to);
    assert.deepEqual(fs.readdirSync(from).sort(), before);
    assert.equal(fs.readFileSync(path.join(from, 'Network', 'Cookies'), 'utf8'), 'the login lives here');
  } finally {
    cleanup(from);
    cleanup(to);
  }
});

test('a profile that is already there is not overwritten', () => {
  // The caller decides this, via hasProfile - so the signal has to be right.
  const dir = tempDir('has-profile');
  try {
    assert.equal(hasProfile(dir), false, 'an empty directory is not a profile');
    fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
    assert.equal(hasProfile(dir), true);
  } finally {
    cleanup(dir);
  }
});

test('the skip lists are the ones that matter, not an accident', () => {
  // Named so that adding a cache directory is a deliberate act.
  for (const name of ['Cache', 'Code Cache', 'GPUCache', 'Crashpad']) {
    assert.equal(SKIP_DIRS.has(name), true, `${name} should be skipped`);
  }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    assert.equal(SKIP_FILES.has(name), true, `${name} should be skipped`);
  }
  assert.equal(SKIP_DIRS.has('Network'), false, 'the cookies are not a cache');
  assert.equal(SKIP_DIRS.has('Local Storage'), false, 'nor is site data');
});
