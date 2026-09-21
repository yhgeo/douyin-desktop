'use strict';

/**
 * Give this build its own data folder, next to the executable.
 *
 * Called from `app/main.js` **before anything else**, because `platform/constants.js` resolves
 * every path at load time - that eagerness is what keeps the dev tree and the builds on one
 * profile, so it is also what makes this the only place the switch can be thrown.
 *
 * The rules live in `platform/profile-dir.js`, which has no `electron` import and is unit
 * tested. This module only does the parts that need `app`.
 *
 * Nothing here is allowed to be fatal. Every failure path falls back to Electron's default
 * location and says so in the log: a wrong data directory is a nuisance, an app that will not
 * start is not.
 */

const fs = require('node:fs');
const { app } = require('electron');
const {
  copyProfile,
  hasProfile,
  isWritableDirectory,
  resolveProfileDir,
} = require('../platform/profile-dir');

/** A note collected before the logger exists, replayed once it does. */
function note(level, message, data) {
  return { level, message, data };
}

/** Write the collected notes through a logger. Kept separate: the logger needs `userData`. */
function reportNotes(log, notes) {
  for (const item of notes) {
    const write = typeof log[item.level] === 'function' ? log[item.level] : log.info;
    write.call(log, item.message, item.data);
  }
}

/**
 * Carry an existing `%APPDATA%` profile over, once.
 *
 * Without this the switch would silently log the user out and drop their script
 * configuration - the exact kind of quiet data loss this project keeps legislating against.
 * The copy is one-way and leaves the source untouched, so the worst case is a duplicated
 * profile, not a lost one.
 */
function adoptExistingProfile(legacyDir, targetDir) {
  if (hasProfile(targetDir)) return { adopted: false, notes: [] };
  if (!hasProfile(legacyDir)) return { adopted: false, notes: [] };

  const result = copyProfile(legacyDir, targetDir);
  const data = {
    from: legacyDir,
    to: targetDir,
    files: result.files,
    kb: Math.round(result.bytes / 1024),
  };
  if (result.error) {
    return {
      adopted: false,
      notes: [note('warn', '复制已有数据未完成，将以全新配置启动（原目录未改动）', { ...data, error: result.error })],
    };
  }
  return {
    adopted: true,
    notes: [note('info', '已把已有数据复制到新目录，登录与脚本配置一并保留（原目录未改动）', data)],
  };
}

/**
 * @returns {{ dir: string, adopted: boolean, notes: object[] }}
 */
function useLocalProfile() {
  const defaultDir = app.getPath('userData');
  const target = resolveProfileDir({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    defaultDir,
  });

  if (target === defaultDir) {
    return {
      adopted: false,
      dir: defaultDir,
      notes: [note('info', '数据目录', { dir: defaultDir, layout: 'appdata（开发运行）' })],
    };
  }

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    return {
      adopted: false,
      dir: defaultDir,
      notes: [note('warn', '无法创建随应用的数据目录，回退到 %APPDATA%', {
        tried: target,
        dir: defaultDir,
        error: String((error && error.message) || error),
      })],
    };
  }

  if (!isWritableDirectory(target)) {
    return {
      adopted: false,
      dir: defaultDir,
      notes: [note('warn', '随应用的数据目录不可写，回退到 %APPDATA%', { tried: target, dir: defaultDir })],
    };
  }

  const adopted = adoptExistingProfile(defaultDir, target);
  app.setPath('userData', target);

  return {
    adopted: adopted.adopted,
    dir: target,
    notes: [
      ...adopted.notes,
      note('info', '数据目录', { dir: target, layout: 'beside-the-app' }),
    ],
  };
}

module.exports = { reportNotes, useLocalProfile };
