'use strict';

/**
 * Serialisation for the userscript's configuration backup files.
 *
 * Kept free of Electron imports so the format and its validation can be unit
 * tested without launching the app.
 */

const APP_ID = 'douyin-desktop';
const EXPORT_FORMAT = 1;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build the object written to a backup file.
 *
 * @param {Record<string, unknown>} values GM values, i.e. the whole store
 * @param {{ scriptName?: string, scriptVersion?: string }} [meta]
 */
function buildExportPayload(values, meta = {}) {
  return {
    app: APP_ID,
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    script: {
      name: meta.scriptName || '抖音优化',
      version: meta.scriptVersion || '',
    },
    values: isPlainObject(values) ? { ...values } : {},
  };
}

/** Suggested file name, e.g. `抖音优化_配置备份_2026-09-20_10-15-00.json`. */
function suggestFileName(scriptName, date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
  const safeName = String(scriptName || '抖音优化').replace(/[\\/:*?"<>|]/g, '_');
  return `${safeName}_配置备份_${stamp}.json`;
}

/**
 * Parse a backup file.
 *
 * Accepts both this app's wrapper format and a bare `{ key: value }` object,
 * which is what the userscript's own "导出至文件" produces - so backups are
 * interchangeable between the desktop shell and Tampermonkey.
 *
 * @param {string} text
 * @returns {{ ok: true, values: object, keys: string[], format: number|null }
 *          | { ok: false, error: string }}
 */
function parseImportPayload(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: '配置文件为空' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
    return { ok: false, error: '配置文件过大（超过 8 MB）' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `不是合法的 JSON：${error.message}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: '配置内容必须是 JSON 对象' };
  }

  const isWrapper = parsed.app === APP_ID && isPlainObject(parsed.values);
  const values = isWrapper ? parsed.values : parsed;
  if (!isPlainObject(values)) {
    return { ok: false, error: '配置内容必须是 JSON 对象' };
  }

  const keys = Object.keys(values);
  if (keys.length === 0) {
    return { ok: false, error: '配置内容为空，未导入' };
  }

  return { ok: true, values, keys, format: isWrapper ? parsed.format ?? EXPORT_FORMAT : null };
}

module.exports = {
  APP_ID,
  EXPORT_FORMAT,
  MAX_IMPORT_BYTES,
  buildExportPayload,
  isPlainObject,
  parseImportPayload,
  suggestFileName,
};
