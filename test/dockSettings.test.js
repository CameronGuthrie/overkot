'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OverkotTheme = require('../src/renderer/theme');
const script = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');

function settings(config = {}) {
  const elements = new Map(), captureStates = [], patches = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', dataset: {}, attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; }, focus() {} });
    return elements.get(selector);
  };
  const select = element('#hotkey-select');
  select.options = ['Shift+F1', 'Shift+F2', 'Alt+F1', 'Ctrl+F1'].map(value => ({ value, dataset: {} }));
  select.querySelector = () => select.options.find(option => option.dataset.custom);
  select.append = option => { option.remove = () => { select.options = select.options.filter(item => item !== option); }; select.options.push(option); };
  const context = vm.createContext({ document: { querySelector: element, addEventListener() {}, createElement: () => ({ dataset: {} }) },
    window: { api: { setShortcutCapture: active => captureStates.push(active) } }, setTimeout, clearTimeout,
    initialConfig: config, OverkotTheme, savePatch: patch => patches.push(JSON.parse(JSON.stringify(patch))) });
  vm.runInContext(script, context);
  vm.runInContext('config = initialConfig; queueConfig = patch => { config = { ...config, ...patch }; savePatch(patch); };', context);
  return { element, captureStates, patches, run: code => vm.runInContext(code, context),
    press(value) {
      context.keyEvent = { preventDefault() {}, stopPropagation() {}, ...value };
      vm.runInContext('captureOverlayHotkey(keyEvent)', context);
    } };
}

test('visibility recorder suspends registered shortcuts and saves the new chord independently', () => {
  const ui = settings({ interactionHotkey: 'Shift+F1', overlayVisibilityHotkey: 'Shift+F2' });
  ui.run('startOverlayHotkeyCapture()');
  assert.deepEqual(ui.captureStates, [true]);
  assert.equal(ui.element('#overlay-hotkey-capture').attributes['aria-pressed'], 'true');
  ui.press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
  assert.deepEqual(ui.patches, []);
  ui.press({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true });
  assert.deepEqual(ui.patches, [{ overlayVisibilityHotkey: 'Ctrl+Alt+O' }]);
  assert.deepEqual(ui.captureStates, [true, false]);
  assert.equal(ui.element('#overlay-hotkey-capture').textContent, 'Ctrl + Alt + O');
});

test('visibility recorder rejects conflicting or modifier-free keys and Escape restores shortcuts', () => {
  const ui = settings({ interactionHotkey: 'Ctrl+Shift+F1' });
  ui.run('startOverlayHotkeyCapture()');
  ui.press({ key: 'F1', code: 'F1', shiftKey: true, ctrlKey: true });
  assert.deepEqual(ui.patches, []);
  assert.match(ui.element('#overlay-hotkey-hint').textContent, /different from/);
  assert.equal(ui.element('#overlay-hotkey-hint').dataset.error, 'true');
  ui.press({ key: 'o', code: 'KeyO' });
  assert.deepEqual(ui.patches, []);
  assert.match(ui.element('#overlay-hotkey-hint').textContent, /modifier/);
  ui.press({ key: 'Escape', code: 'Escape' });
  assert.deepEqual(ui.captureStates, [true, false]);
  assert.equal(ui.element('#overlay-hotkey-capture').attributes['aria-pressed'], 'false');
  assert.equal(ui.element('#overlay-hotkey-hint').dataset.error, 'false');
});

test('reset restores Shift+F2 and preserves the interaction shortcut', () => {
  const ui = settings({ interactionHotkey: 'Alt+F1', overlayVisibilityHotkey: 'Ctrl+O' });
  assert.equal(ui.run("changeOverlayHotkey('Shift+F2')"), true);
  assert.deepEqual(ui.patches, [{ overlayVisibilityHotkey: 'Shift+F2' }]);
  assert.equal(ui.run('config.interactionHotkey'), 'Alt+F1');
});

test('interaction choices reserve the visibility shortcut and refresh when its chord changes', () => {
  const ui = settings({ interactionHotkey: 'Shift+F1' });
  ui.run('populateInteractionHotkey()');
  const select = ui.element('#hotkey-select');
  assert.equal(select.options.find(option => option.value === 'Shift+F2').disabled, true);
  assert.match(select.options.find(option => option.value === 'Shift+F2').title, /show \/ hide/);
  assert.equal(select.options.find(option => option.value === 'Ctrl+F1').disabled, false);
  ui.run("changeOverlayHotkey('Control+F1')");
  assert.equal(select.options.find(option => option.value === 'Shift+F2').disabled, false);
  assert.equal(select.options.find(option => option.value === 'Ctrl+F1').disabled, true,
    'Equivalent modifier aliases reserve the same shortcut');
});

test('interaction collisions give clear feedback, keep the confirmed selection and never save', () => {
  const ui = settings({ interactionHotkey: 'Shift+F1', overlayVisibilityHotkey: 'Control+Shift+F2' });
  ui.element('#hotkey-select').value = 'Shift+Ctrl+F2';
  assert.equal(ui.run("changeInteractionHotkey('Shift+Ctrl+F2')"), false);
  assert.deepEqual(ui.patches, []);
  assert.equal(ui.element('#hotkey-select').value, 'Shift+F1');
  assert.match(ui.element('#overlay-hotkey-hint').textContent, /different interact hotkey/);
  assert.equal(ui.element('#overlay-hotkey-hint').dataset.error, 'true');
  assert.equal(ui.run("changeInteractionHotkey('Alt+F1')"), true);
  assert.deepEqual(ui.patches, [{ interactionHotkey: 'Alt+F1' }]);
  assert.equal(ui.run('config.overlayVisibilityHotkey'), 'Control+Shift+F2');
  assert.equal(ui.element('#overlay-hotkey-hint').dataset.error, 'false');
});

// Appearance opacity now belongs to the transactional editor and is covered by
// appearanceTheme.test.js plus the real native Settings check. Map preferences
// remain independent autosaved settings, including their explicit zero value.
test('map opacity remains independently configurable to zero in High Contrast', () => {
  const ui = settings({ theme: 'high-contrast', dungeonMapBackgroundOpacity: 0 });
  ui.run('updateOpacityControls()');
  assert.equal(ui.element('#slider-dungeon-opacity').value, 0);
  assert.equal(ui.element('#dungeon-opacity-value').textContent, '0%');
  assert.deepEqual(ui.patches, []);
  const defaultUI = settings();
  defaultUI.run('updateOpacityControls()');
  assert.equal(defaultUI.element('#slider-dungeon-opacity').value, 45);
});
