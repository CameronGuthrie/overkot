'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OverkotTheme = require('../src/renderer/theme');
const script = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');

function settings(config = {}, { save = async () => true, platform = 'win32' } = {}) {
  const elements = new Map(), captureStates = [], patches = [];
  const documentEvents = {}, windowEvents = {};
  let focusedElement;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', dataset: {}, attributes: {},
      addEventListener(key, cb) { this[key] = cb; }, setAttribute(key, value) { this.attributes[key] = value; },
      focus() { if (focusedElement !== this) { focusedElement?.blur?.(); focusedElement = this; } } });
    return elements.get(selector);
  };
  const document = { querySelector: element, hasFocus: () => true,
    addEventListener(key, cb) { (documentEvents[key] ||= []).push(cb); } };
  const context = vm.createContext({ document, window: { OverlayShortcuts: require('../src/modules/overlayShortcuts'),
    addEventListener(key, cb) { windowEvents[key] = cb; }, api: {
      setShortcutCapture(active) { captureStates.push(active); },
      saveConfig(patch) { patches.push(JSON.parse(JSON.stringify(patch))); return save(patch); },
    } }, setTimeout, clearTimeout, initialConfig: config, platform, OverkotTheme });
  const run = code => vm.runInContext(code, context);
  vm.runInContext(script, context);
  run('config = {...initialConfig}; confirmedConfig = {...config}; platformSupport = {platform}; initialized = true; loadTranslations = populateLanguageDropdown = () => {}; applyConfigToDOM = renderOverlayHotkey; bindEvents(); renderOverlayHotkey()');
  function dispatch(type, values, handler) {
    const event = { type, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    if (handler) handler(event);
    else for (const listener of documentEvents[type]) listener(event);
    return event;
  }
  return { element, captureStates, patches, run, dispatch, windowEvents, document,
    start(action = 'overlay') { element('#' + action + '-hotkey-capture').click(); },
    key(values) { dispatch('keydown', values); dispatch('keyup', values); },
    mouse(type, values) { context.mouseEvent = { type, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...values };
      run('captureMouseEvent(mouseEvent)'); return context.mouseEvent; },
  };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('moving focus directly between recorder buttons only cancels capture on the button being left', async () => {
  const ui = settings({ allowSingleKeyShortcuts: true });
  ui.start('interaction'); ui.key({ key: 'F9', code: 'F9' });
  await turn();
  ui.start('overlay');
  assert.equal(ui.element('#overlay-hotkey-capture').attributes['aria-pressed'], 'true');
  ui.key({ key: 'F10', code: 'F10' });
  await turn();
  assert.deepEqual(ui.patches, [{ interactionHotkey: 'F9' }, { overlayVisibilityHotkey: 'F10' }]);
  ui.start('interaction');
  ui.element('#interaction-hotkey-capture').blur();
  assert.equal(ui.element('#interaction-hotkey-capture').attributes['aria-pressed'], 'false');
});

test('chord mode records on release, ignores modifiers and leaves the other action alone', async () => {
  const ui = settings({ interactionHotkey: 'Shift+F1', overlayVisibilityHotkey: 'Shift+F2' });
  ui.start();
  assert.equal(ui.element('#overlay-hotkey-capture').attributes['aria-pressed'], 'true');
  ui.key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
  const key = { key: 'o', code: 'KeyO', ctrlKey: true, altKey: true };
  ui.dispatch('keydown', key);
  ui.dispatch('keydown', { ...key, repeat: true });
  assert.deepEqual(ui.patches, []);
  ui.dispatch('keyup', { ...key, ctrlKey: false });
  await turn();
  assert.deepEqual(ui.patches, [{ overlayVisibilityHotkey: 'Ctrl+Alt+O' }]);
  assert.deepEqual(ui.captureStates, [true, false]);
  assert.equal(ui.element('#overlay-hotkey-capture').textContent, 'Ctrl + Alt + O');
  assert.equal(ui.element('#interaction-hotkey-capture').textContent, 'Shift + F1');
});

test('default mode rejects single keys and mouse input, Escape and focus loss restore bindings', () => {
  const ui = settings();
  ui.start();
  ui.key({ key: 'o', code: 'KeyO' });
  assert.match(ui.element('#overlay-hotkey-hint').textContent, /modifier/);
  assert.equal(ui.mouse('mousedown', { button: 0 }).prevented, undefined);
  ui.run("commitMouseShortcut('Mouse4')");
  ui.key({ key: 'Escape', code: 'Escape' });
  assert.deepEqual(ui.captureStates, [true, false]);
  ui.start('interaction');
  ui.dispatch('keydown', { key: 'a', code: 'KeyA', ctrlKey: true });
  ui.windowEvents.blur();
  ui.dispatch('keyup', { key: 'a', code: 'KeyA' });
  assert.equal(ui.element('#interaction-hotkey-capture').attributes['aria-pressed'], 'false');
  assert.equal(ui.element('#overlay-hotkey-hint').dataset.error, 'false');
  assert.deepEqual(ui.patches, []);
});

test('enabling single-key mode preserves chords and both actions can capture keyboard inputs', async () => {
  const ui = settings({ interactionHotkey: 'Alt+F1' });
  const toggle = ui.element('#chk-allow-single-key-shortcuts');
  toggle.checked = true; toggle.change();
  await turn();
  assert.deepEqual(ui.patches, [{ allowSingleKeyShortcuts: true }]);
  assert.equal(ui.element('#interaction-hotkey-capture').textContent, 'Alt + F1');
  ui.start('interaction'); ui.key({ key: 'F9', code: 'F9' });
  await turn();
  ui.start(); ui.key({ key: '5', code: 'Numpad5' });
  await turn();
  assert.deepEqual(ui.patches.slice(1), [{ interactionHotkey: 'F9' }, { overlayVisibilityHotkey: 'num5' }]);
  ui.start(); ui.key({ key: 'q', code: 'KeyA', ctrlKey: true });
  await turn();
  assert.deepEqual(ui.patches.at(-1), { overlayVisibilityHotkey: 'Ctrl+Q' });
});

test('normalization from the main process wins when disabling single-key mode', async () => {
  const ui = settings({ allowSingleKeyShortcuts: true, interactionHotkey: 'F10', overlayVisibilityHotkey: 'Ctrl+F8' }, {
    save() { ui.run("receiveConfig({ allowSingleKeyShortcuts: false, interactionHotkey: 'Shift+F1', overlayVisibilityHotkey: 'Ctrl+F8' })"); return true; },
  });
  const toggle = ui.element('#chk-allow-single-key-shortcuts');
  toggle.checked = false; toggle.change();
  await turn();
  assert.deepEqual(ui.patches, [{ allowSingleKeyShortcuts: false }]);
  assert.equal(ui.element('#interaction-hotkey-capture').textContent, 'Shift + F1');
  assert.equal(ui.element('#overlay-hotkey-capture').textContent, 'Ctrl + F8');
});

test('canonical collisions and rejected saves keep the previously confirmed binding', async () => {
  const ui = settings({ overlayVisibilityHotkey: 'Control+Shift+F2', interactionHotkey: 'Shift+F1' }, { save: async () => false });
  ui.start('interaction');
  ui.key({ key: 'F2', code: 'F2', ctrlKey: true, shiftKey: true });
  assert.deepEqual(ui.patches, []);
  assert.match(ui.element('#overlay-hotkey-hint').textContent, /different interact hotkey/);
  ui.key({ key: 'F4', code: 'F4', altKey: true });
  await turn();
  assert.deepEqual(ui.patches, [{ interactionHotkey: 'Alt+F4' }]);
  assert.equal(ui.element('#interaction-hotkey-capture').textContent, 'Shift + F1');
  assert.match(ui.element('#overlay-hotkey-hint').textContent, /Could not save this shortcut/);
});

test('reset buttons change only the selected shortcut', async () => {
  const ui = settings({ interactionHotkey: 'Alt+F1', overlayVisibilityHotkey: 'Ctrl+O' });
  ui.element('#overlay-hotkey-reset').click();
  await turn();
  assert.deepEqual(ui.patches, [{ overlayVisibilityHotkey: 'Shift+F2' }]);
  assert.equal(ui.element('#interaction-hotkey-capture').textContent, 'Alt + F1');
  ui.element('#interaction-hotkey-reset').click();
  await turn();
  assert.deepEqual(ui.patches[1], { interactionHotkey: 'Shift+F1' });
});

test('Windows captures all standard mouse buttons on release and deduplicates native and DOM events', async () => {
  const ui = settings({ allowSingleKeyShortcuts: true });
  for (const [button, expected] of [[0, 'Mouse1'], [1, 'Mouse3'], [2, 'Mouse2'], [3, 'Mouse4'], [4, 'Mouse5']]) {
    ui.start();
    assert.equal(ui.mouse('mousedown', { button, ctrlKey: true }).prevented, true);
    const before = ui.patches.length;
    ui.mouse('mouseup', { button });
    ui.run("commitMouseShortcut('Ctrl+" + expected + "')");
    assert.equal(ui.mouse(button === 0 ? 'click' : 'auxclick', { button, detail: 1 }).prevented, true);
    await turn();
    assert.deepEqual(ui.patches.slice(before), [{ overlayVisibilityHotkey: 'Ctrl+' + expected }]);
  }
  assert.equal(ui.element('#overlay-hotkey-capture').textContent, 'Ctrl + Mouse 5 (Forward)');
});

test('scroll directions, key modifiers, stale native events and non-Windows behavior', async () => {
  const ui = settings({ allowSingleKeyShortcuts: true });
  for (const [deltaX, deltaY, expected] of [[0, -1, 'Up'], [0, 1, 'Down'], [-1, 0, 'Left'], [1, 0, 'Right']]) {
    ui.start('interaction');
    ui.mouse('wheel', { deltaX, deltaY, shiftKey: true });
    await turn();
    assert.deepEqual(ui.patches.at(-1), { interactionHotkey: 'Shift+Wheel' + expected });
  }
  ui.start();
  ui.document.hasFocus = () => false;
  ui.run("commitMouseShortcut('Mouse2')");
  ui.document.hasFocus = () => true;
  ui.run("commitMouseShortcut('Mouse6'); commitMouseShortcut('Ctrl+Mouse4')");
  await turn();
  assert.equal(ui.patches.length, 5);
  assert.deepEqual(ui.patches.at(-1), { overlayVisibilityHotkey: 'Ctrl+Mouse4' });

  const linux = settings({ allowSingleKeyShortcuts: true }, { platform: 'linux' });
  linux.start(); linux.run("commitMouseShortcut('Mouse4')");
  assert.equal(linux.mouse('wheel', { deltaX: 0, deltaY: 1 }).prevented, undefined);
  assert.match(linux.element('#overlay-hotkey-hint').textContent, /typing/);
  assert.doesNotMatch(linux.element('#overlay-hotkey-hint').textContent, /mouse/i);
  assert.deepEqual(linux.patches, []);
});

test('focus loss cancels a pending mouse press and keyboard activation after a capture still works', async () => {
  const ui = settings({ allowSingleKeyShortcuts: true });
  ui.start();
  ui.mouse('mousedown', { button: 0 });
  ui.windowEvents.blur();
  ui.mouse('mouseup', { button: 0 });
  ui.run("commitMouseShortcut('Mouse1')");
  assert.deepEqual(ui.patches, []);
  ui.start();
  ui.mouse('mousedown', { button: 0 });
  ui.mouse('mouseup', { button: 0 });
  await turn();
  assert.equal(ui.mouse('click', { button: 0, detail: 1 }).prevented, true);
  assert.equal(ui.mouse('click', { button: 0, detail: 0 }).prevented, undefined);
});

test('an unavailable global input shows a warning while capture still accepts the keyboard', async () => {
  const ui = settings({ allowSingleKeyShortcuts: true });
  ui.start('interaction');
  ui.run("receiveShortcutWarnings({ visibilityShortcutWarning: 'Mouse inputs are unavailable.' })");
  assert.match(ui.element('#overlay-hotkey-hint').textContent, /unavailable/);
  ui.key({ key: 'AudioVolumeMute', code: 'AudioVolumeMute' });
  await turn();
  assert.deepEqual(ui.patches, [{ interactionHotkey: 'VolumeMute' }]);
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
