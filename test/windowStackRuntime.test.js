'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { refreshOverlayStack } = require('../src/modules/overlayWindowPolicy');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function fixture() {
  const calls = [], pending = [], windows = [], settings = {};
  const window = (name, values = {}) => {
    const win = Object.assign(new EventEmitter(), {
      name, visible: true, minimized: false, destroyed: false, focused: false,
      isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; },
      isMinimized() { return this.minimized; }, isFocused() { return this.focused; },
      moveTop() { calls.push(name); },
      show() { this.visible = true; calls.push(`${name}:show`); },
      showInactive() { this.visible = true; calls.push(`${name}:showInactive`); },
      hide() { this.visible = false; calls.push(`${name}:hide`); },
      restore() { this.minimized = false; },
      focus() { this.focused = true; calls.push(`${name}:focus`); },
    }, values);
    windows.push(win);
    return win;
  };
  const rail = window('menu'), dungeon = window('dungeon'), widget = window('widget', { _widgetId: 'widget' });
  const settingsWindow = window('settings', { focused: true }), mapWindow = window('map');
  const alert = window('alert', { _alertReady: true });
  const context = vm.createContext({
    platformSupport: { platform: 'win32', gameConnection: true, gameFocusTracking: true }, refreshOverlayStack,
    mainWindow: rail, dockWindow: null, dungeonOverlayWindow: dungeon, widgetWindows: new Map([['widget', widget]]),
    settingsWindow, mapWindow, tutorialWindow: null, changelogWindow: null, widgetsWindow: null,
    groupFinderWindow: null, marketWindow: null, dailyBriefWindow: null, wikiWindow: null, calendarSettingsWindow: null, updateWindow: null,
    alertWindows: new Set([alert]), layoutGridWindows: new Map(), setImmediate: callback => pending.push(callback),
    overlayHiddenByUser: false, gameHiddenActive: false, mainHiddenForFocus: false, dockAutoHidden: false,
    marketShutdownStarted: false, appStatus: 'connected', gameFocusedActive: true, gameFocusRequest: null,
    config: { get: (key, fallback) => settings[key] ?? fallback }, BrowserWindow: { getAllWindows: () => windows },
    isCollapsed: false, overlayInteractive: false, isAnyOverlayWindowFocused: () => false,
    setLayoutEditing() {}, clearTimeout() {}, shiftStartTimer: null,
    setDockAutoHidden() {}, createTray() {}, destroyTray() {}, log() {}, syncWidgetWindows() {},
  });
  const load = (start, end) => vm.runInContext(main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start))), context);
  load('function raiseAlertWindows()', '// ─── App lifecycle');
  load('function canShowAlerts()', 'function createAlertWindow(');
  return { context, calls, pending, settings, rail, dungeon, widget, settingsWindow, mapWindow, alert, window, load,
    run: code => vm.runInContext(code, context), flush: () => { while (pending.length) pending.shift()(); } };
}

test('a focused large dungeon stays below widgets and menu while the focused popout and alerts stay above', () => {
  const f = fixture();
  f.dungeon.focused = true;
  const hidden = f.window('hidden', { visible: false });
  f.context.widgetWindows.set('hidden', hidden);
  f.context.alertWindows.add(f.window('hidden-alert', { visible: false }));
  f.run('refreshOverlayWindowStack()');
  assert.deepEqual(f.calls, ['dungeon', 'widget', 'menu', 'map', 'settings', 'alert']);
  assert.equal(f.dungeon.focused, true, 'Repairs keep map keyboard focus');
  assert.equal(hidden.visible, false, 'Repairs do not expose closed panels');
});

test('show and focus repairs run after native window operations; temporary pickers only raise alerts', () => {
  const f = fixture();
  f.context.win = f.dungeon;
  f.run('watchOverlayStack(win)');
  for (const event of ['show', 'focus']) {
    f.calls.length = 0;
    f.dungeon.emit(event);
    assert.deepEqual(f.calls, []);
    f.flush();
    assert.deepEqual(f.calls, ['dungeon', 'widget', 'menu', 'map', 'settings', 'alert']);
  }
  const picker = f.window('picker');
  f.context.win = picker;
  f.run('watchOverlayStack(win)');
  f.calls.length = 0;
  picker.emit('show');
  f.flush();
  assert.deepEqual(f.calls, ['alert'], 'The settings stack cannot cover a newly opened native picker');
  picker.emit('focus');
  picker.destroyed = true;
  f.calls.length = 0;
  f.flush();
  assert.deepEqual(f.calls, [], 'A closed window cannot trigger a late repair');
});

test('re-entering an already-visible dungeon repairs menu ordering after the final native focus', () => {
  const f = fixture();
  f.settingsWindow.focused = false;
  f.load('function focusOverlay()', 'function toggleOverlayInteraction(');
  f.run('focusOverlay()');
  assert.deepEqual(f.calls, ['menu:show', 'widget', 'dungeon:focus', 'dungeon', 'widget', 'menu', 'settings', 'map', 'alert']);
  assert.equal(f.dungeon.focused, true);
});

test('periodic repair preserves focused native dropdowns while keeping alerts above their host', () => {
  const f = fixture();
  let tick;
  f.context.setInterval = callback => { tick = callback; };
  f.context.isAnyOverlayWindowFocused = () => true;
  f.load('  const alwaysOnTopTimer = setInterval(', "  mainWindow.on('closed',");
  tick();
  assert.deepEqual(f.calls, ['alert'], 'Only alerts may cover a focused native dropdown');
});

test('layout raises keep the menu above widgets and alerts above the scrim and menu', () => {
  const f = fixture();
  f.context.layoutGridWindows.set(1, f.window('scrim'));
  f.load('function raiseLayoutWindows()', 'function showLayoutGrid()');
  f.run('raiseLayoutWindows()');
  assert.deepEqual(f.calls, ['scrim', 'widget', 'menu', 'alert']);
});

test('manual and game-driven hides share the hidden-alert opt-in for existing popups', () => {
  for (const override of [false, true]) {
    const f = fixture();
    f.settings.showAlertsWhenHidden = override;
    f.load('function setOverlayHidden(', 'function registerVisibilityShortcut()');
    f.load('function applyGameHiddenState()', 'function pushStateToRenderer()');
    f.run('setOverlayHidden(true)');
    assert.equal(f.alert.visible, override);
    assert.equal(f.rail.visible, false);
    f.run('setOverlayHidden(false)');
    assert.equal(f.alert.visible, true);
    f.settings.showOnlyWhenGameFocused = true;
    f.context.gameFocusedActive = false;
    f.run('applyGameHiddenState()');
    assert.equal(f.alert.visible, override);
    assert.equal(f.rail.visible, false);
  }
});
