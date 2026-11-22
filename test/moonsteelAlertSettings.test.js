'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Settings = require('../src/modules/moonsteelAlertSettings');

test('Moonsteel alert defaults use the selected purple with a soft edge flash and audible chime', () => {
  assert.deepEqual(Settings.normalize(), {
    enabled: true, flashEnabled: true, soundEnabled: true, color: '#da75ff',
    opacity: .65, borderWidth: 48, blur: 32, duration: 4, pulseSpeed: 1,
    sound: 'chime', volume: .5, monitor: 'primary',
  });
  assert.equal(Settings.validate(Settings.DEFAULTS), true);
  assert(Object.isFrozen(Settings.DEFAULTS));
});

test('saved alert preferences normalize invalid fields independently without changing valid choices', () => {
  const value = Settings.normalize({ enabled: false, color: '#DA75FF', opacity: 8, borderWidth: 84,
    blur: -1, duration: '4', pulseSpeed: .25, sound: 'soft', volume: 0, monitor: 'all', arbitrary: 'ignored' });
  assert.deepEqual(value, { ...Settings.DEFAULTS, enabled: false, borderWidth: 84, pulseSpeed: .25, sound: 'soft', volume: 0, monitor: 'all' });
  for (const input of [null, [], 'purple', false]) assert.deepEqual(Settings.normalize(input), Settings.DEFAULTS);
  const inherited = Object.create({ color: '#ffffff' });
  assert.equal(Settings.normalize(inherited).color, Settings.DEFAULTS.color);
  value.color = '#000000';
  assert.equal(Settings.DEFAULTS.color, '#da75ff');
});

test('alert IPC patches reject unknown fields, invalid types and out-of-range settings', () => {
  for (const input of [null, [], 'yes', { enabled: 1 }, { flashEnabled: 'false' }, { soundEnabled: null },
    { color: 'purple' }, { color: '#fff' }, { color: '#ffffff;background:red' }, { monitor: 'external' },
    { sound: 'file:///private.wav' }, { volume: NaN }, { opacity: Infinity }, { duration: '3' },
    { arbitrary: true }, { __proto__: null, constructor: 'bad' }]) assert.equal(Settings.validate(input), false);
  for (const [key, [min, max]] of Object.entries(Settings.RANGES)) {
    assert.equal(Settings.validate({ [key]: min }), true, key + ': lower boundary');
    assert.equal(Settings.validate({ [key]: max }), true, key + ': upper boundary');
    assert.equal(Settings.validate({ [key]: min - .01 }), false, key + ': below range');
    assert.equal(Settings.validate({ [key]: max + .01 }), false, key + ': above range');
  }
  assert.equal(Settings.validate({}), true, 'An empty patch is harmless');
});

test('partial alert edits preserve existing settings and round-trip through JSON', () => {
  const current = { ...Settings.DEFAULTS, volume: .2, monitor: 'all', sound: 'beacon' };
  const merged = Settings.merge(current, { color: '#AABBCC', duration: 8 });
  assert.deepEqual(merged, { ...current, color: '#aabbcc', duration: 8 });
  assert.deepEqual(Settings.normalize(JSON.parse(JSON.stringify(merged))), merged);
  assert.equal(Settings.merge(current, { volume: 2 }), null);
  assert.equal(current.color, Settings.DEFAULTS.color);
});

test('Settings and the alert renderer share the same model in a sandboxed browser', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/modules/moonsteelAlertSettings.js'), 'utf8'), context);
  const model = context.window.MoonsteelAlertSettings;
  assert.deepEqual(JSON.parse(JSON.stringify(model.DEFAULTS)), Settings.DEFAULTS);
  assert.deepEqual(JSON.parse(JSON.stringify(model.merge({ volume: .1 }, { monitor: 'cursor' }))),
    Settings.merge({ volume: .1 }, { monitor: 'cursor' }));
});
