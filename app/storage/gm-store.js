'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Key the userscript's GM values used to live under in the page's
 * `localStorage`. Kept only so existing installs can be migrated once.
 */
const LEGACY_VALUES_KEY = 'douyin-desktop:gm-values';

/**
 * Hold the values on a null-prototype object.
 *
 * A plain object literal has `Object.prototype` in its chain, so `values['__proto__'] = x`
 * invokes the inherited setter and *replaces the prototype* instead of adding a key.
 * Measured: after `set('__proto__', { injected: 'x' })`, `get('injected')` returned the
 * value while `has('injected')` said no - and the value never reached the file, because
 * `JSON.stringify` does not serialise a prototype. A null prototype has no setter to trip,
 * so `__proto__` becomes an ordinary key like any other.
 */
function toValueStore(source) {
  return Object.assign(Object.create(null), source || {});
}

/**
 * Persistent store for the userscript's GM_* values.
 *
 * It deliberately lives outside the browser session: keeping it in the page's
 * `localStorage` entangled it with Douyin's own site data, so "clear site data"
 * also wiped the script configuration, and the remote page could read or clear
 * it at will. Owning the data in the main process makes the two clearing
 * operations independent, and keeps the values readable synchronously by the
 * preload (the userscript calls GM_getValue synchronously).
 */
class GmStore {
  /**
   * @param {string} filePath absolute path of the JSON backing file
   */
  constructor(filePath) {
    this.filePath = filePath;
    /** True once the backing file exists, i.e. the store has been initialised. */
    this.initialized = fs.existsSync(filePath);
    /** @type {Record<string, unknown>} */
    this.values = toValueStore(this.#read());
  }

  #read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return {};
    } catch {
      return {};
    }
  }

  #persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Write-then-rename so a crash mid-write cannot leave a truncated file.
      const temporary = `${this.filePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.values, null, 2), 'utf8');
      fs.renameSync(temporary, this.filePath);
      this.initialized = true;
      return true;
    } catch (error) {
      console.error('[抖音] 保存脚本配置失败', this.filePath, error);
      return false;
    }
  }

  getAll() {
    return { ...this.values };
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.values, key);
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    const oldValue = this.values[key];
    this.values[key] = value;
    this.#persist();
    return { oldValue, newValue: value };
  }

  setMany(input) {
    const changes = [];
    for (const [key, value] of Object.entries(input || {})) {
      changes.push({ key, ...this.set(key, value) });
    }
    return changes;
  }

  delete(key) {
    const oldValue = this.values[key];
    delete this.values[key];
    this.#persist();
    return { oldValue, newValue: undefined };
  }

  keys() {
    return Object.keys(this.values);
  }

  /** Replace the whole store (used by migration and by "clear script data"). */
  replaceAll(next) {
    this.values = toValueStore(next);
    this.#persist();
  }

  clear() {
    this.replaceAll({});
  }
}

module.exports = { GmStore, LEGACY_VALUES_KEY, toValueStore };
