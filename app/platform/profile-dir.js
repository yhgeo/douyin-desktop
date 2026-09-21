'use strict';

/**
 * Where a packaged build keeps its data, and how an existing profile is carried over.
 *
 * Electron's default is `%APPDATA%\<package name>`, which is the *same* directory for
 * `npm start`, the portable build and the installed build. That was a deliberate choice once
 * (login and script configuration carry across all three), but it has two costs that only
 * show up when the app is installed for real:
 *
 *  - the dev tree and the installed app cannot run at the same time, because Chromium's
 *    profile is a LevelDB and the single-instance lock is per profile;
 *  - clearing site data in one clears it in the other.
 *
 * So a packaged build keeps its data **next to itself** instead:
 *
 *   installed / unpacked   ->  <folder holding 抖音.exe>\data
 *   portable               ->  <folder holding the portable exe>\data
 *   development            ->  unchanged (`%APPDATA%\douyin-desktop`)
 *
 * The dev run keeps the historical location on purpose: working on the app must never touch
 * the installed app's login.
 *
 * **Uninstalling removes the install folder, and therefore this data.** That is inherent to
 * keeping the data inside it - a backup is copying the `data` folder - and it is why
 * `deleteAppDataOnUninstall` stays false: the *legacy* `%APPDATA%` profile must survive an
 * uninstall even though nothing reads it any more.
 *
 * Free of `electron` imports, because none of this needs one and the rules below are exactly
 * the kind that should be unit tested rather than trusted.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The data folder that sits beside the executable. */
const DATA_DIR_NAME = 'data';

/**
 * Chromium's cache directories.
 *
 * Worth naming rather than ignoring: a used profile measured 647 MB, of which 640 MB was
 * `Cache` (378 MB) and `Code Cache` (255 MB) plus the GPU caches. All of it is reproducible,
 * so skipping it turns the one-time carry-over from a multi-second copy into a ~8 MB one.
 */
const SKIP_DIRS = new Set([
  'BrowserMetrics',
  'Cache',
  'Code Cache',
  'Crashpad',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GraphiteDawnCache',
  'GrShaderCache',
  'ShaderCache',
  'blob_storage',
  'component_crx_cache',
  'extensions_crx_cache',
]);

/**
 * Chromium's own lock and port files. Copying these makes a brand-new profile look like it is
 * already open, which is a confusing way to fail.
 */
const SKIP_FILES = new Set([
  'DevToolsActivePort',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'lockfile',
]);

/**
 * Where should this build keep its data?
 *
 * @param {{ isPackaged: boolean, execPath?: string, portableDir?: string, defaultDir: string }} input
 * @returns {string} the directory to use as `userData`
 */
function resolveProfileDir(input) {
  const { isPackaged, execPath, portableDir, defaultDir } = input;
  if (!isPackaged) return defaultDir;

  // electron-builder's portable target runs from a temp copy and sets this to the folder the
  // portable .exe actually lives in - which is the one the user thinks of as "the app".
  const base = portableDir || (execPath ? path.dirname(execPath) : '');
  if (!base) return defaultDir;
  return path.join(base, DATA_DIR_NAME);
}

/**
 * Can this process actually write here?
 *
 * Checked rather than assumed: an install into a protected folder (or onto a read-only
 * share) would otherwise produce an app that starts and then cannot save anything - which is
 * the failure mode this whole project keeps trying to avoid.
 */
function isWritableDirectory(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this directory already hold a profile?
 *
 * `Preferences` is what Chromium writes on every run, so it is the honest signal. Used to
 * decide whether a carry-over is needed, not to decide whether the app works.
 */
function hasProfile(dir) {
  try {
    return fs.existsSync(path.join(dir, 'Preferences'));
  } catch {
    return false;
  }
}

/**
 * Copy a profile, skipping caches and lock files.
 *
 * One-way and non-destructive: the source is left alone. If anything goes wrong the caller
 * still has a usable app (an empty profile means one re-login), which is the right way round
 * for a step whose only job is to save the user some inconvenience.
 *
 * @returns {{ files: number, bytes: number, error: string|null }}
 */
function copyProfile(from, to) {
  let files = 0;
  let bytes = 0;

  const walk = (source, target) => {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(source, entry.name), path.join(target, entry.name));
        continue;
      }
      if (SKIP_FILES.has(entry.name)) continue;
      const source_ = path.join(source, entry.name);
      const target_ = path.join(target, entry.name);
      try {
        fs.copyFileSync(source_, target_);
        files += 1;
        bytes += fs.statSync(target_).size;
      } catch {
        // A file that is locked or vanished is not worth failing the whole carry-over for.
      }
    }
  };

  try {
    walk(from, to);
  } catch (error) {
    return { files, bytes, error: String((error && error.message) || error) };
  }
  return { files, bytes, error: null };
}

module.exports = {
  DATA_DIR_NAME,
  SKIP_DIRS,
  SKIP_FILES,
  copyProfile,
  hasProfile,
  isWritableDirectory,
  resolveProfileDir,
};
