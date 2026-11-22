'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OverlayShortcuts = require('../src/modules/overlayShortcuts');
const main = fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8');
const { defaults, normalizeShortcuts, validShortcut, shortcutPatch, shortcutIdentity } = OverlayShortcuts;

test('chord migration preserves existing chords, repairs old modifier-only bindings and defaults to chords', () => {
  assert.deepEqual(normalizeShortcuts({}), { allowSingleKeyShortcuts: false, ...defaults });
  assert.deepEqual(normalizeShortcuts({ allowSingleKeyShortcuts: 'true', interactionHotkey: 'Alt', overlayVisibilityHotkey: 'Shift+F1' }),
    { allowSingleKeyShortcuts: false, interactionHotkey: 'Shift+F2', overlayVisibilityHotkey: 'Shift+F1' });
  const current = { allowSingleKeyShortcuts: true, interactionHotkey: 'Control+Alt+F10', overlayVisibilityHotkey: 'num8' };
  assert.deepEqual(normalizeShortcuts(current), current);
  assert.deepEqual(shortcutPatch(current, { allowSingleKeyShortcuts: false }), { overlayVisibilityHotkey: 'Shift+F2' });
  assert.equal(shortcutPatch(current, { allowSingleKeyShortcuts: 'false' }), null);
  assert.equal(shortcutPatch(current, { overlayVisibilityHotkey: 'Alt+Ctrl+F10' }), null);
  assert.equal(shortcutIdentity('CommandOrControl+F1', 'darwin'), shortcutIdentity('Super+F1', 'darwin'));
  assert.equal(shortcutIdentity('CmdOrCtrl+F1', 'win32'), shortcutIdentity('Control+F1', 'win32'));
});

test('single-key and mouse bindings require opt-in; mouse requires Windows and a supported button or wheel event', () => {
  for (const key of ['0', 'A', 'F24', 'num9', 'Space', 'Left', 'numadd', 'MediaPlayPause', 'PrintScreen', ';']) {
    assert.equal(validShortcut(key, false, 'win32'), false, key);
    assert.equal(validShortcut(key, true, 'linux'), true, key);
  }
  for (const key of ['Mouse1', 'Mouse2', 'Mouse3', 'Mouse4', 'Mouse5', 'WheelUp', 'WheelDown', 'WheelLeft', 'WheelRight', 'Alt+Shift+Mouse4']) {
    assert.equal(validShortcut(key, true, 'win32'), true, key);
    assert.equal(validShortcut(key, false, 'win32'), false, key);
    assert.equal(validShortcut(key, true, 'linux'), false, key);
  }
  for (const key of ['Alt', 'Shift', 'Esc', 'Escape', 'Mouse6', 'Ctrl+Mouse4+F1', 'AltGr+Mouse1', 'Ctrl+Control+F1', 'Bogus+F1']) {
    assert.equal(validShortcut(key, true, 'win32'), false, key);
  }
  assert.equal(OverlayShortcuts.nativeMouseBinding('Shift+Control+Mouse4', 'win32'), 'Ctrl+Shift+Mouse4');
});

function fixture() {
  const config = { allowSingleKeyShortcuts: false, ...defaults };
  const held = new Map(), busy = new Set(), actions = [];
  const win = { isDestroyed: () => false, webContents: { send() {} } };
  let save, capture;
  const ctx = vm.createContext({
    // This runtime fixture represents Windows even when the host runs Linux.
    OverlayShortcuts: { ...OverlayShortcuts, shortcutPatch: (current, patch) => shortcutPatch(current, patch, 'win32') },
    TITLE_TRACKER_ENABLED: false, platformSupport: { platform: 'win32' }, playerTracking: { pid: 4321 },
    settingsWindow: { ...win, isFocused: () => true, getNativeWindowHandle: () => Buffer.from([33, 0, 0, 0, 0, 0, 0, 0]) },
    BrowserWindow: { fromWebContents: () => ctx.settingsWindow, getAllWindows: () => [win] },
    mainWindow: win, calendarSettingsWindow: null, dungeonOverlayWindow: null, marketWindow: null, dailyBriefWindow: null,
    widgetsWindow: null, mapWindow: null, dockWindow: null, tutorialWindow: null, widgetWindows: new Map(),
    overlayHiddenByUser: false, shortcutCapture: false, registeredShortcut: null, registeredVisibilityShortcut: null, mouseFocusGraceUntil: 0,
    overlayShortcutWarning: '', visibilityShortcutWarning: '', launchFocusChordUsed: false, focusReminder: null,
    config: { get: (k, fallback) => config[k] ?? fallback, getAll: () => ({ ...config }),
      setMany: patch => { if (ctx.failWrite) return false; Object.assign(config, patch); return true; } },
    globalShortcut: {
      register: (hotkey, fn) => {
        if (busy.has(hotkey) || held.has(hotkey)) return false;
        assert.equal(OverlayShortcuts.isMouseShortcut(hotkey), false);
        held.set(hotkey, fn);
        return true;
      },
      unregister: hotkey => { assert.equal(OverlayShortcuts.isMouseShortcut(hotkey), false); held.delete(hotkey); },
    },
    mouseShortcuts: { setState(next) {
      if (ctx.mouseUnavailable && (next.interactionHotkey || next.overlayVisibilityHotkey || next.capture)) return false;
      ctx.mouseState = next;
      return true;
    } },
    ipcMain: { handle(name, fn) { assert.equal(name, 'save-config'); save = fn; }, on(name, fn) { assert.equal(name, 'shortcut-capture'); capture = fn; } },
    setOverlayHidden: () => actions.push('visibility'), toggleOverlayInteraction: () => actions.push('interaction'),
    appearanceSession: { effectiveConfig: () => ({ ...config }) }, broadcastTheme() {}, setLayoutEditing() {},
    applyOverlayMousePolicy() {}, pushDockState() {}, pushStateToRenderer() {}, scheduleAppTutorial() {}, log() {},
  });
  for (const [start, end] of [
    ['function registerOverlayShortcut()', 'function updateGameFocus('],
    ['function registerVisibilityShortcut()', "ipcMain.on('layout-editing-request'"],
    ["ipcMain.handle('save-config'", "ipcMain.handle('get-changelog'"],
  ]) vm.runInContext(main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start))), ctx);
  vm.runInContext('registerOverlayShortcut(); registerVisibilityShortcut();', ctx);
  return { ctx, config, held, busy, actions, save: patch => save({ sender: ctx.settingsWindow.webContents }, patch),
    capture: active => capture({ sender: ctx.settingsWindow.webContents }, active) };
}

test('save-config keeps old registrations through OS conflicts and failed writes, including capture, and swaps actions atomically', () => {
  const f = fixture();
  assert.equal(f.save({ interactionHotkey: 'F9' }), false);
  assert.equal(f.save({ allowSingleKeyShortcuts: true, interactionHotkey: 'F9' }), true);
  f.busy.add('F8');
  assert.equal(f.save({ interactionHotkey: 'F7', overlayVisibilityHotkey: 'F8' }), false);
  assert.deepEqual([...f.held.keys()].sort(), ['F9', 'Shift+F2']);
  f.ctx.failWrite = true;
  assert.equal(f.save({ overlayVisibilityHotkey: 'F10' }), false);
  assert.deepEqual([...f.held.keys()].sort(), ['F9', 'Shift+F2']);
  f.ctx.failWrite = false;
  f.capture(true);
  assert.equal(f.save({ interactionHotkey: 'F8' }), false);
  f.capture(false);
  assert.deepEqual([...f.held.keys()].sort(), ['F9', 'Shift+F2']);
  assert.equal(f.save({ overlayVisibilityHotkey: 'F9', interactionHotkey: 'Shift+F2' }), true);
  f.held.get('F9')();
  f.held.get('Shift+F2')();
  assert.deepEqual(f.actions, ['visibility', 'interaction']);
  assert.equal(f.save({ allowSingleKeyShortcuts: false }), true);
  assert.equal(f.config.interactionHotkey, 'Shift+F2');
  assert.equal(f.config.overlayVisibilityHotkey, 'Shift+F1');
});

test('mouse bindings follow config and capture, restore prior state on failures and release when switching to chords', () => {
  const f = fixture();
  assert.equal(f.save({ allowSingleKeyShortcuts: true, interactionHotkey: 'Ctrl+Mouse4', overlayVisibilityHotkey: 'WheelRight' }), true);
  assert.equal(f.ctx.mouseState.interactionHotkey, 'Ctrl+Mouse4');
  assert.equal(f.ctx.mouseState.settingsHwnd, '33');
  assert.equal(f.ctx.mouseState.gamePid, 4321);
  vm.runInContext("dispatchOverlayShortcut('Ctrl+Mouse4'); dispatchOverlayShortcut('WheelRight')", f.ctx);
  assert.deepEqual(f.actions, ['interaction', 'visibility']);
  f.capture(true);
  assert.equal(f.ctx.mouseState.capture, true);
  vm.runInContext("dispatchOverlayShortcut('Ctrl+Mouse4')", f.ctx);
  assert.deepEqual(f.actions, ['interaction', 'visibility']);
  f.capture(false);
  assert.equal(f.ctx.mouseState.capture, false);
  assert.equal(f.ctx.mouseState.overlayVisibilityHotkey, 'WheelRight');
  f.ctx.failWrite = true;
  assert.equal(f.save({ interactionHotkey: 'Mouse1' }), false);
  assert.equal(f.ctx.mouseState.interactionHotkey, 'Ctrl+Mouse4');
  f.ctx.failWrite = false;
  assert.equal(f.save({ allowSingleKeyShortcuts: false }), true);
  assert.equal(f.ctx.mouseState.interactionHotkey, null);
  assert.equal(f.ctx.mouseState.overlayVisibilityHotkey, null);
  assert.deepEqual([...f.held.keys()].sort(), ['Shift+F1', 'Shift+F2']);
  f.ctx.mouseUnavailable = true;
  assert.equal(f.save({ allowSingleKeyShortcuts: true, overlayVisibilityHotkey: 'Mouse3' }), false);
  assert.deepEqual([...f.held.keys()].sort(), ['Shift+F1', 'Shift+F2']);
  assert.equal(f.config.allowSingleKeyShortcuts, false);
});

test('only a mouse interaction activation offers its selected window for native foreground handoff', () => {
  const f = fixture(), requests = [];
  assert.equal(f.save({ allowSingleKeyShortcuts: true, interactionHotkey: 'Mouse3', overlayVisibilityHotkey: 'Mouse4' }), true);
  const target = { getNativeWindowHandle: () => Buffer.from([0x78, 0x56, 0x34, 0x12, 1, 0, 0, 0]) };
  f.ctx.toggleOverlayInteraction = () => target;
  f.ctx.Date = { now: () => 1000 };
  f.ctx.requestFocus = hwnd => { requests.push(hwnd); return true; };
  vm.runInContext("dispatchOverlayShortcut('Mouse3', requestFocus); dispatchOverlayShortcut('Mouse4', requestFocus)", f.ctx);
  assert.deepEqual(requests, [String(0x112345678)]);
  assert.equal(f.ctx.mouseFocusGraceUntil, 2400);
  f.ctx.mouseFocusGraceUntil = 0;
  vm.runInContext("dispatchOverlayShortcut('Mouse3', () => false)", f.ctx);
  assert.equal(f.ctx.mouseFocusGraceUntil, 0, 'No grace is granted without an accepted native request');
  f.ctx.toggleOverlayInteraction = () => undefined;
  vm.runInContext("dispatchOverlayShortcut('Mouse3', requestFocus)", f.ctx);
  assert.equal(requests.length, 1, 'Turning interaction off has no native focus target');
  f.capture(true);
  f.ctx.toggleOverlayInteraction = () => target;
  vm.runInContext("dispatchOverlayShortcut('Mouse3', requestFocus)", f.ctx);
  assert.equal(requests.length, 1);
});
