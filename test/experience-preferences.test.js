'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/douyin-experience-enhancer.user.js'), 'utf8');
const start = source.indexOf('var ConfigManager = class');
const end = source.indexOf('// src/core/selectors.js', start);
function fixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  const ConfigManager = vm.runInNewContext(source.slice(start, end) + '\nConfigManager', { localStorage });
  return { ConfigManager, values };
}
test('a toolbar choice survives a fresh enhancer instance', () => {
  const { ConfigManager } = fixture();
  const first = new ConfigManager();
  assert.equal(first.isEnabled('skipLive'), true);
  first.setEnabled('skipLive', false, true);
  assert.equal(first.getSessionButtonStates().skipLive, 'disabled');
  const next = new ConfigManager();
  assert.equal(next.isEnabled('skipLive'), false);
  next.setEnabled('skipLive', true, true);
  assert.equal(new ConfigManager().isEnabled('skipLive'), true);
});
test('remembered choices preserve other disabled and hidden controls', () => {
  const { ConfigManager } = fixture({ douyin_default_toggle_states: JSON.stringify({ skipAd: 'hidden', aiPreference: 'disabled' }) });
  const config = new ConfigManager();
  config.setEnabled('skipLive', false, true);
  const next = new ConfigManager();
  assert.equal(next.getDefaultButtonStates().skipAd, 'hidden');
  assert.equal(next.isEnabled('aiPreference'), false);
});
test('temporary automatic fallbacks do not overwrite the saved preference', () => {
  const { ConfigManager } = fixture();
  const config = new ConfigManager();
  config.setEnabled('autoHighRes', false);
  assert.equal(config.isEnabled('autoHighRes'), false);
  assert.equal(new ConfigManager().isEnabled('autoHighRes'), true);
});
