'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createWindowDragController, getWindowBounds, setWindowBounds } = require('../src/modules/windowDrag');
const { pointInBounds, railBounds, snapWidgetToGrid } = require('../src/modules/edgeDockGeometry');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function loadFunctions(context, start, end) {
  const from = main.indexOf(start), to = main.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Locate ${start}`);
  vm.runInContext(main.slice(from, to), context);
}

function visibilityFixture() {
  const calls = [], registered = new Map(), shortcutAttempts = [];
  const settings = { showOnlyWhenGameFocused: true, hideWhenGameClosed: true,
    widgetOpen: { map: true, calendar: false }, clickThrough: true, interactionHotkey: 'Shift+F1' };
  const surface = (name, visible = true, widgetId) => ({ name, visible, focused: false, destroyed: false,
    _widgetId: widgetId, isVisible() { return this.visible; }, isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized === true; }, restore() { this.minimized = false; },
    hide() { this.visible = false; calls.push([name, 'hide']); },
    showInactive() { this.visible = true; calls.push([name, 'show']); } });
  const rail = surface('rail'), panel = surface('map', true, 'map'), closedPanel = surface('calendar', false, 'calendar');
  const settingsWindow = surface('settings'), closedPopout = surface('closed-popout', false);
  settingsWindow.webContents = { send() {} };
  const windows = [rail, panel, closedPanel, settingsWindow, closedPopout];
  let registrationResult = true;
  const context = vm.createContext({ tutorialWindow: null, updateWindow: null,
    OverlayShortcuts: require('../src/modules/overlayShortcuts'), registeredShortcut: null, overlayShortcutWarning: '',
    overlayHiddenByUser: false, gameHiddenActive: false, mainHiddenForFocus: false, gameFocusRequest: null,
    appStatus: 'connected', gameFocusedActive: true, platformSupport: { gameConnection: true, gameFocusTracking: true },
    isAnyOverlayWindowFocused: () => windows.some(win => win.focused), isCollapsed: false, mainWindow: rail,
    widgetWindows: new Map([['map', panel], ['calendar', closedPanel]]), dockWindow: null, alertWindows: new Set(),
    settingsWindow, changelogWindow: null, widgetsWindow: null, groupFinderWindow: null, marketWindow: null, dailyBriefWindow: null,
    wikiWindow: null, mapWindow: null, dungeonOverlayWindow: null, calendarSettingsWindow: null, tray: null, shiftStartTimer: null,
    dockAutoHidden: false, overlayInteractive: false,
    BrowserWindow: { getAllWindows: () => windows }, clearTimeout() {}, log() {}, syncAlertVisibility() {},
    config: { get: (key, fallback) => settings[key] ?? fallback },
    setLayoutEditing: active => calls.push(['layout', active]), setDockAutoHidden: hidden => calls.push(['auto-hide', hidden]),
    syncWidgetWindows() {
      calls.push(['sync-panels']);
      for (const win of [panel, closedPanel]) {
        if (settings.widgetOpen[win._widgetId] && !context.overlayHiddenByUser && !context.gameHiddenActive && rail.visible) win.showInactive();
        else win.hide();
      }
    },
    createTray() { context.tray = {}; calls.push(['tray', 'create']); },
    destroyTray() { context.tray = null; calls.push(['tray', 'destroy']); },
    registeredVisibilityShortcut: null, visibilityShortcutWarning: '', shortcutCapture: false,
    globalShortcut: {
      register(key, handler) {
        shortcutAttempts.push(key);
        if (registrationResult instanceof Error) throw registrationResult;
        if (registrationResult) registered.set(key, handler);
        return registrationResult;
      },
      unregister(key) { registered.delete(key); calls.push(['unregister', key]); },
    },
    pushDockState: () => calls.push(['dock-state']), pushStateToRenderer: () => calls.push(['state']),
  });
  loadFunctions(context, 'function applyGameHiddenState()', 'function pushStateToRenderer()');
  loadFunctions(context, 'function updateGameFocus(', '/** Check whether any overlay-related window');
  loadFunctions(context, 'function bindOverlayAccelerator(', 'function updateGameFocus(');
  loadFunctions(context, 'function setOverlayHidden(', 'function endShortcutCapture()');
  return { context, calls, settings, rail, panel, closedPanel, settingsWindow, closedPopout, registered, shortcutAttempts,
    run: code => vm.runInContext(code, context), registration: value => { registrationResult = value; } };
}

test('focus-only visibility re-hides a restored rail even when its hidden-for-focus flag is already set', () => {
  const f = visibilityFixture();
  f.context.gameFocusedActive = false;
  f.context.mainHiddenForFocus = true;
  f.context.gameHiddenActive = true;
  assert.equal(f.rail.visible, true, 'A previous restore can make the rail visible before focus is checked');
  f.run('applyGameHiddenState()');
  assert.equal(f.rail.visible, false);
  assert.deepEqual(f.calls, [['rail', 'hide']]);
  assert.equal(f.context.mainHiddenForFocus, true);
  assert.equal(f.context.gameHiddenActive, true);
});

test('manual overlay hiding remains authoritative across waiting, focus loss and later game state updates', () => {
  const f = visibilityFixture();
  f.run('setOverlayHidden(true)');
  assert.equal(f.rail.visible, false);
  assert.equal(f.panel.visible, false);
  assert.equal(f.settingsWindow.visible, false);
  f.calls.length = 0;
  for (const [status, focused] of [['waiting', false], ['connected', false], ['connected', true]]) {
    f.context.appStatus = status;
    f.context.gameFocusedActive = focused;
    f.context.mainHiddenForFocus = true;
    f.context.gameHiddenActive = true;
    f.run('applyGameHiddenState()');
  }
  assert.deepEqual(f.calls, [], 'Background state changes neither reveal nor re-hide manually hidden windows');
  assert.equal(f.context.overlayHiddenByUser, true);
  assert.equal(f.rail.visible, false);
  assert.equal(f.panel.visible, false);
});

test('focus-only visibility follows focus from an overlay menu directly to another app', () => {
  const f = visibilityFixture();
  f.settingsWindow.focused = true;
  f.run('updateGameFocus(false)');
  assert.equal(f.rail.visible, true);
  assert.equal(f.panel.visible, true);
  f.settingsWindow.focused = false;
  f.run('updateGameFocus(false)');
  assert.equal(f.rail.visible, false);
  assert.equal(f.panel.visible, false);
  f.run('updateGameFocus(true)');
  assert.equal(f.rail.visible, true);
  assert.equal(f.panel.visible, true);
});

test('showing the overlay restores previously open windows and keeps closed panels and popouts hidden', () => {
  const f = visibilityFixture();
  f.run('setOverlayHidden(true); setOverlayHidden(true); setOverlayHidden(false)');
  assert.equal(f.context.overlayHiddenByUser, false);
  assert.equal(f.rail.visible, true);
  assert.equal(f.panel.visible, true);
  assert.equal(f.settingsWindow.visible, true);
  assert.equal(f.closedPanel.visible, false);
  assert.equal(f.closedPopout.visible, false);
  assert.equal(f.context.tray, null);
  assert.deepEqual(f.settings.widgetOpen, { map: true, calendar: false });
});

test('manual reveal still obeys focus-only visibility after the user returns to another application', () => {
  const f = visibilityFixture();
  f.context.gameFocusedActive = false;
  f.context.mainHiddenForFocus = true;
  f.context.gameHiddenActive = true;
  f.run('setOverlayHidden(true); setOverlayHidden(false)');
  assert.equal(f.context.overlayHiddenByUser, false);
  assert.equal(f.rail.visible, false, 'Revealing does not override the configured Soulframe focus rule');
  assert.equal(f.panel.visible, false);
});

test('the independent visibility shortcut defaults to Shift+F2, toggles all overlay windows and can be replaced', () => {
  const f = visibilityFixture();
  f.run('registerVisibilityShortcut()');
  assert.deepEqual(f.shortcutAttempts, ['Shift+F2']);
  f.registered.get('Shift+F2')();
  assert.equal(f.context.overlayHiddenByUser, true);
  assert.equal(f.rail.visible, false);
  f.registered.get('Shift+F2')();
  assert.equal(f.context.overlayHiddenByUser, false);
  assert.equal(f.rail.visible, true);
  f.settings.overlayVisibilityHotkey = 'Ctrl+Alt+O';
  f.run('registerVisibilityShortcut()');
  assert.equal(f.registered.has('Shift+F2'), false);
  assert.equal(f.registered.has('Ctrl+Alt+O'), true);
  assert.equal(f.settings.interactionHotkey, 'Shift+F1');
  assert.equal(f.settings.clickThrough, true);
  f.context.shortcutCapture = true;
  f.run('registerVisibilityShortcut()');
  assert.equal(f.registered.size, 0, 'Shortcut recording temporarily unregisters the visibility chord');
});

test('visibility shortcut failures report availability without changing overlay visibility or interaction settings', () => {
  for (const result of [false, new Error('Invalid accelerator')]) {
    const f = visibilityFixture();
    f.registration(result);
    f.run('registerVisibilityShortcut()');
    assert.match(f.context.visibilityShortcutWarning, /Choose another/);
    assert.equal(f.context.registeredVisibilityShortcut, null);
    assert.equal(f.context.overlayHiddenByUser, false);
    assert.equal(f.rail.visible, true);
    assert.equal(f.settings.clickThrough, true);
    assert.ok(f.calls.some(([event]) => event === 'state'));
  }
});

test('late timer alerts cannot create a window while the overlay is manually or automatically hidden', () => {
  for (const hidden of ['overlayHiddenByUser', 'gameHiddenActive']) {
    let created = 0;
    const context = vm.createContext({ tutorialWindow: null, updateWindow: null, overlayHiddenByUser: false, gameHiddenActive: false,
      mainWindow: { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true },
      marketShutdownStarted: false, config: { get: (_key, fallback) => fallback },
      BrowserWindow: class { constructor() { created++; } } });
    loadFunctions(context, 'function canShowAlerts()', '/** Re-stack remaining alert windows');
    vm.runInContext('const lateTimerAlert = () => createAlertWindow({name:"Completed crafting"});', context);
    context[hidden] = true;
    vm.runInContext('lateTimerAlert()', context);
    assert.equal(created, 0, hidden);
  }
});

test('global Shift requires current overlay focus at key-down and after its debounce', () => {
  let focused = false, pending;
  const calls = [];
  const context = vm.createContext({ tutorialWindow: null, updateWindow: null, layoutEditing: false, overlayHiddenByUser: false,
    mainWindow: { isVisible: () => true, isDestroyed: () => false, setIgnoreMouseEvents() {}, webContents: { send() {} } },
    isAnyOverlayWindowFocused: () => focused, shortcutCapture: false, settingsWindow: null,
    gameHiddenActive: false, appStatus: 'connected', widgetWindows: new Map(), layoutMovedWidgets: new Set(),
    redockTarget: false, shiftStartTimer: null, config: { get: (_key, fallback) => fallback },
    clearTimeout: () => { pending = undefined; }, setTimeout: callback => { pending = callback; return 1; },
    setDockAutoHidden() {}, showLayoutGrid: () => calls.push('grid-on'), destroyLayoutGrid: () => calls.push('grid-off'),
    layoutDockedPanels() {}, raiseLayoutWindows() {}, pushDockState() {}, finishWidgetDrag() {}, applyOverlayMousePolicy() {}, Date,
  });
  loadFunctions(context, 'function setLayoutEditing(', 'function startDockRuntime()');
  vm.runInContext('onGlobalShift(true)', context);
  assert.equal(pending, undefined);
  focused = true;
  vm.runInContext('onGlobalShift(true)', context);
  const stalePress = pending;
  focused = false;
  stalePress();
  assert.equal(context.layoutEditing, false, 'Focus must still belong to the overlay when the delay ends');
  focused = true;
  vm.runInContext('onGlobalShift(true)', context);
  pending();
  assert.equal(context.layoutEditing, true);
  vm.runInContext('onGlobalShift(false)', context);
  assert.equal(context.layoutEditing, false);
  assert.deepEqual(calls, ['grid-on', 'grid-off']);
});

test('blur ends held-Shift editing only when focus leaves all overlay windows; native minimize hides the overlay', () => {
  let focused = true;
  const timers = [], calls = [], win = new EventEmitter();
  const context = vm.createContext({ tutorialWindow: null, updateWindow: null, dailyBriefWindow: null, mainWindow: null,
    platformSupport: { platform: 'win32' }, configureOverlayPopout() {},
    config: { get: () => false }, overlayInteractive: true, dungeonOverlayWindow: null, overlayFocusRequestedAt: 0,
    shiftStartTimer: 4, isAnyOverlayWindowFocused: () => focused,
    setTimeout: callback => { timers.push(callback); }, clearTimeout() {},
    setLayoutEditing: active => calls.push(['editing', active]),
    toggleOverlayInteraction: force => calls.push(['interaction-off', force]),
    setOverlayHidden: hidden => calls.push(['hidden', hidden]), win,
  });
  loadFunctions(context, 'function attachOverlayBlurHandler(', 'function focusOverlay()');
  vm.runInContext('attachOverlayBlurHandler(win)', context);
  win.emit('blur'); timers.splice(0).forEach(callback => callback());
  assert.deepEqual(calls, [], 'Switching between overlay windows retains layout mode');
  focused = false;
  win.emit('blur'); timers.splice(0).forEach(callback => callback());
  assert.deepEqual(calls, [['editing', false], ['interaction-off', true]]);
  win.emit('minimize');
  assert.deepEqual(calls.at(-1), ['hidden', true]);
});

function dragFixture(initiallyDocked = true, { laggingBounds = false } = {}) {
  const writes = [], callbacks = new Set(), settings = { widgetDocked: { wiki: initiallyDocked } };
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1200, height: 900 }, workArea: { x: 0, y: 0, width: 1200, height: 900 } };
  const secondDisplay = { id: 2, bounds: { x: -1200, y: 0, width: 1200, height: 900 }, workArea: { x: -1200, y: 0, width: 1200, height: 900 } };
  let cursor = { x: 120, y: 110 }, bounds = { x: 100, y: 100, width: 300, height: 200 }, broadcasts = 0, layouts = 0;
  const win = new EventEmitter();
  Object.assign(win, { _widgetId: 'wiki', webContents: new EventEmitter(), isDestroyed: () => false,
    getBounds: () => ({ ...bounds }), setBounds: next => { if (!laggingBounds) bounds = { ...next }; writes.push({ ...next }); } });
  win.webContents.send = () => {};
  const screen = { getCursorScreenPoint: () => cursor, getDisplayMatching: target => target.x < 0 ? secondDisplay : display };
  const windowDrag = createWindowDragController({ screen, nativeCursor: true,
    schedule: callback => { callbacks.add(callback); return callback; }, cancel: callback => callbacks.delete(callback) });
  const moved = new Set();
  const context = vm.createContext({ tutorialWindow: null, updateWindow: null, windowDrag, getWindowBounds, screen, dockDisplay: () => display, railBounds, pointInBounds,
    config: { get: (key, fallback) => settings[key] ?? fallback, set: (key, value) => { settings[key] = value; } },
    layoutMovedWidgets: moved, layoutEditing: true, redockTarget: true,
    broadcastDockConfig: () => { broadcasts++; }, layoutDockedPanels: () => { layouts++; }, win,
    widgetWindows: new Map([['wiki', win]]), destroyLayoutGrid() {}, snapWidgetToGrid, setWindowBounds,
    mainWindow: null, applyOverlayMousePolicy() {}, pushDockState() {}, Date });
  loadFunctions(context, 'function finishWidgetDrag(', 'function setLayoutEditing(');
  loadFunctions(context, 'function setLayoutEditing(', 'function onGlobalShift(');
  win._layoutDragOrigin = { ...bounds };
  windowDrag.start(win, { snap: false });
  return { context, win, settings, moved, writes, callbacks, display, secondDisplay, run: code => vm.runInContext(code, context),
    cursor: value => { cursor = value; }, get broadcasts() { return broadcasts; }, get layouts() { return layouts; } };
}

test('ending a native drag flushes its final free movement before deciding to float the panel', () => {
  const f = dragFixture();
  f.cursor({ x: 134, y: 141 });
  assert.deepEqual(f.writes, [], 'No polling tick occurred before the drag release');
  f.run('finishWidgetDrag(win)');
  assert.deepEqual(f.writes, [{ x: 114, y: 131, width: 300, height: 200 }]);
  assert.equal(f.settings.widgetDocked.wiki, false, 'The final flushed movement counts as a drag');
  assert.deepEqual([...f.moved], ['wiki'], 'Alignment is queued for Shift release');
  assert.equal(f.win._isDragging, false);
  assert.equal(f.win._layoutDragOrigin, null);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.broadcasts, 1);
  assert.equal(f.layouts, 0, 'Holding Shift leaves the free position unsnapped');
});

test('a fast release still undocks when the final native configure reply has not arrived', () => {
  const f = dragFixture(true, { laggingBounds: true });
  f.cursor({ x: 134, y: 141 });
  f.run('finishWidgetDrag(win)');
  assert.deepEqual(f.win.getBounds(), { x: 100, y: 100, width: 300, height: 200 }, 'The native rectangle still reports the origin');
  assert.deepEqual(f.writes, [{ x: 114, y: 131, width: 300, height: 200 }]);
  assert.equal(f.settings.widgetDocked.wiki, false, 'The requested final placement must count as movement');
  assert.deepEqual([...f.moved], ['wiki']);
});

test('Shift release snaps the last requested position on the target monitor before native bounds catch up', () => {
  const f = dragFixture(true, { laggingBounds: true });
  f.cursor({ x: -577, y: 142 });
  f.run('setLayoutEditing(false)');
  const final = { x: -597, y: 132, width: 300, height: 200 };
  const snapped = snapWidgetToGrid(final, f.secondDisplay, 'bottom', false);
  assert.deepEqual(f.writes[0], final);
  assert.deepEqual(f.writes.at(-1), snapped, 'The old primary-monitor rectangle must not drive grid alignment');
  assert.equal(f.settings.widgetDocked.wiki, false);
  assert.deepEqual(f.settings.widgetBounds_wiki, snapped);
  assert.equal(f.context.layoutEditing, false);
  assert.equal(f.win._layoutDragBounds, null, 'The deferred placement is cleared after alignment');
});

test('accepted content dimensions survive grid alignment after a drag with lagging native bounds', () => {
  const f = dragFixture(true, { laggingBounds: true });
  f.cursor({ x: -577, y: 142 });
  f.run('finishWidgetDrag(win)');
  // A content fit can update the intended size while Shift remains held.
  setWindowBounds(f.win, { x: -597, y: 132, width: 410, height: 230 });
  f.run('setLayoutEditing(false)');
  assert.deepEqual(f.writes.at(-1), { x: -600, y: 144, width: 410, height: 230 });
});

test('a final native drag over the rail redocks the same panel while cancellation and stationary clicks keep its state', () => {
  const redocked = dragFixture(false);
  redocked.cursor({ x: 150, y: 880 });
  redocked.run('finishWidgetDrag(win)');
  assert.equal(redocked.settings.widgetDocked.wiki, true);
  assert.equal(redocked.moved.size, 0);
  assert.equal(redocked.broadcasts, 1);
  assert.equal(redocked.context.redockTarget, false);
  for (const cancelled of [false, true]) {
    const f = dragFixture(false);
    if (cancelled) f.cursor({ x: 150, y: 880 });
    f.run(`finishWidgetDrag(win, ${cancelled})`);
    assert.equal(f.settings.widgetDocked.wiki, false);
    assert.deepEqual(f.writes, []);
    assert.equal(f.broadcasts, 0);
    assert.equal(f.moved.size, 0);
    assert.equal(f.callbacks.size, 0);
  }
});
