'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

test('Linux passive input policy never queries Windows-only native focusability', () => {
  const ignored = [];
  const context = vm.createContext({ platformSupport: { platform: 'linux' } });
  vm.runInContext(main.slice(main.indexOf('function applyWindowMousePolicy('), main.indexOf('function focusOverlay()')), context);
  context.win = { setIgnoreMouseEvents: value => ignored.push(value),
    isFocusable() { throw new Error('Windows-only focusability query'); },
    setFocusable() { throw new Error('Windows-only focusability mutation'); } };
  vm.runInContext('applyWindowMousePolicy(win, true); applyWindowMousePolicy(win, false)', context);
  assert.deepEqual(ignored, [true, false]);
});
const { configureOverlayWorkspace, configureOverlayPopout, refreshOverlayStack } = require('../src/modules/overlayWindowPolicy');
function overlayContext(values) {
  return vm.createContext({ platformSupport: { platform: 'win32' }, appStatus: 'waiting', registeredShortcut: null,
    BrowserWindow: { getAllWindows: () => [] },
    ...require('../src/modules/overlayDisplays'), broadcastOverlayDisplays() {},
    appearanceSession: { effectiveConfig: () => values.config?.getAll?.() || {} },
    nativeOverlayForeground: null, tutorialWindow: null, settingsWindow: null, changelogWindow: null, widgetsWindow: null,
    alertWindows: new Set(),
    groupFinderWindow: null, marketWindow: null, dailyBriefWindow: null, wikiWindow: null, mapWindow: null, calendarSettingsWindow: null, updateWindow: null,
    configureOverlayWorkspace: (win, support) => configureOverlayWorkspace(win, support, { run() {}, warn() {} }),
    configureOverlayPopout, refreshOverlayStack, applyOverlayMousePolicy() {}, scheduleAppTutorial() {},
    raiseAlertWindows() {}, refreshOverlayWindowStack() {}, syncAlertVisibility() {},
    focusReminder: null, launchFocusChordUsed: false, requestWidgetTutorial() {},
    createFocusReminder: () => ({ start() {}, dispose() {}, dismiss() {} }), ...values });
}


test('the Updates popout retains overlay focus during interaction', () => {
  const context = overlayContext({ mainWindow: null, dockWindow: null, widgetWindows: new Map(),
    nativeOverlayForeground: null, overlayFocusRequestedAt: 0,
    settingsWindow: null, changelogWindow: null, widgetsWindow: null, groupFinderWindow: null,
    marketWindow: null, wikiWindow: null, mapWindow: null, dungeonOverlayWindow: null, calendarSettingsWindow: null,
    updateWindow: { isDestroyed: () => false, isFocused: () => true },
  });
  vm.runInContext(main.slice(main.indexOf('function isAnyOverlayWindowFocused()'), main.indexOf('/** Attach a blur handler')), context);
  assert.equal(vm.runInContext('isAnyOverlayWindowFocused()', context), true);
});

test('native foreground ownership overrides stale Electron focus after the focus transfer grace', () => {
  let clock = 1000;
  const context = overlayContext({ nativeOverlayForeground: false, overlayFocusRequestedAt: 0,
    Date: { now: () => clock }, mainWindow: { isDestroyed: () => false, isFocused: () => true },
  });
  vm.runInContext(main.slice(main.indexOf('function isAnyOverlayWindowFocused()'), main.indexOf('/** Attach a blur handler')), context);
  assert.equal(vm.runInContext('isAnyOverlayWindowFocused()', context), false);
  clock = 100;
  assert.equal(vm.runInContext('isAnyOverlayWindowFocused()', context), true, 'A requested focus transfer gets time to complete');
  clock = 1000;
  context.nativeOverlayForeground = null;
  assert.equal(vm.runInContext('isAnyOverlayWindowFocused()', context), true, 'Unavailable native tracking uses Electron focus');
});

function shortcutFixture(register, withDungeon = false) {
  // The interaction and foreground policy use native ownership independently
  // from Chromium's window active flag.
  const data = { clickThrough: true, interactionHotkey: 'Shift+F1' };
  const sent = [], mouse = [], statuses = [], unregistered = [];
  const win = name => ({ isDestroyed: () => false, setIgnoreMouseEvents: value => mouse.push([name, value]),
    webContents: { send: (...args) => sent.push([name, ...args]) } });
  const windows = [win('main'), win('dock'), win('widget')];
  if (withDungeon) windows.push(win('dungeon'));
  const context = overlayContext({ mainWindow: windows[0], dockWindow: windows[1], dungeonOverlayWindow: windows[3] || null, layoutEditing: false, widgetWindows: new Map([['widget', windows[2]]]),
    BrowserWindow: { getAllWindows: () => windows },
    config: { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; }, getAll: () => ({ ...data }) },
    globalShortcut: { register, unregister: hotkey => unregistered.push(hotkey) },
    pushStateToRenderer: () => statuses.push(vm.runInContext('overlayShortcutWarning', context)), log() {},
  });
  vm.runInContext('let registeredShortcut = null; let overlayShortcutWarning = ""; let overlayInteractive = true; let shortcutCapture = false;', context);
  vm.runInContext(main.slice(main.indexOf('function applyOverlayMousePolicy()'), main.indexOf('function focusOverlay()')), context);
  vm.runInContext(main.slice(main.indexOf('function registerOverlayShortcut()'), main.indexOf('/** Check whether any overlay-related')), context);
  return { data, mouse, sent, statuses, unregistered, run: code => vm.runInContext(code, context) };
}

test('Win32 foreground ownership overrides a stale Chromium active flag after focus transfer', () => {
  let clock = 1000;
  const window = { isDestroyed: () => false, isFocused: () => true };
  const context = overlayContext({ mainWindow: window, dockWindow: null, widgetWindows: new Map(),
    settingsWindow: null, changelogWindow: null, widgetsWindow: null, groupFinderWindow: null, marketWindow: null,
    wikiWindow: null, mapWindow: null, dungeonOverlayWindow: null, calendarSettingsWindow: null, updateWindow: null,
    nativeOverlayForeground: false, overlayFocusRequestedAt: 950, Date: { now: () => clock },
  });
  vm.runInContext(main.slice(main.indexOf('function isAnyOverlayWindowFocused()'), main.indexOf('/** Attach a blur handler')), context);
  assert.equal(vm.runInContext('isAnyOverlayWindowFocused()', context), true, 'An explicit focus transfer gets a brief grace period');
  clock = 1200;
  assert.equal(vm.runInContext('isAnyOverlayWindowFocused()', context), false, 'A stale Chromium active flag cannot override another foreground process');
  context.nativeOverlayForeground = true;
  assert.equal(vm.runInContext('isAnyOverlayWindowFocused()', context), true);
});

test('native foreground samples release stale interaction and layout even with the launcher hidden', () => {
  let clock = 1000;
  const calls = [];
  const context = overlayContext({ nativeOverlayForeground: null, overlayFocusRequestedAt: 950,
    overlayInteractive: true, shiftStartTimer: 3, process: { pid: 123 }, Date: { now: () => clock },
    clearTimeout: timer => calls.push(['clear', timer]),
    setLayoutEditing: active => calls.push(['editing', active]),
    toggleOverlayInteraction: force => { context.overlayInteractive = false; calls.push(['off', force]); },
  });
  vm.runInContext(main.slice(main.indexOf('function onNativeForeground('), main.indexOf('function startDockRuntime()')), context);
  vm.runInContext('onNativeForeground(456)', context);
  assert.deepEqual(calls, [], 'Do not cancel a just-requested focus transfer using a queued old sample');
  clock = 1200;
  vm.runInContext('onNativeForeground(456)', context);
  assert.deepEqual(calls, [['clear', 3], ['editing', false], ['off', true]]);
  calls.length = 0;
  vm.runInContext('onNativeForeground(123)', context);
  assert.equal(context.nativeOverlayForeground, true);
  assert.deepEqual(calls, [], 'Gaining foreground does not turn on interaction automatically');
});

test('failed or throwing hotkey registration restores widget input and keeps the launcher pass-through', () => {
  for (const register of [() => false, () => { throw new Error('unavailable'); }]) {
    const f = shortcutFixture(register);
    f.run('registerOverlayShortcut()');
    assert.equal(f.data.clickThrough, false);
    assert.deepEqual(f.mouse, [['main', true], ['dock', false], ['widget', false]]);
    assert.equal(f.sent.filter(([, channel, config]) => channel === 'config-changed' && config.clickThrough === false).length, 3);
    assert.match(f.statuses[0], /Click-through is off/);
    assert.equal(f.run('overlayInteractive'), false);
  }
});

test('hotkey registration failure cannot leave the fullscreen dungeon capturing mouse input', () => {
  const f = shortcutFixture(() => false, true);
  f.run('registerOverlayShortcut()');
  assert.equal(f.data.clickThrough, false);
  assert.deepEqual(f.mouse.at(-1), ['dungeon', true]);
  assert.ok(f.sent.some(([name, channel, active]) => name === 'dungeon' && channel === 'overlay-interaction-changed' && active === false));
});

test('successful hotkeys retain click-through; retrying clears the previous failure', () => {
  let available = false;
  const f = shortcutFixture(() => available);
  f.run('registerOverlayShortcut()');
  available = true;
  f.data.clickThrough = true;
  f.run('registerOverlayShortcut()');
  assert.equal(f.run('registeredShortcut'), 'Shift+F1');
  assert.equal(f.data.clickThrough, true);
  assert.equal(f.run('overlayShortcutWarning'), '');
  f.run('registerOverlayShortcut()');
  assert.deepEqual(f.unregistered, ['Shift+F1']);
});

test('the interaction shortcut is registered with the fresh Linux click-through default disabled', () => {
  const hotkeys = [];
  const f = shortcutFixture(key => { hotkeys.push(key); return true; });
  f.data.clickThrough = false;
  f.run('registerOverlayShortcut()');
  assert.deepEqual(hotkeys, ['Shift+F1']);
  assert.equal(f.run('registeredShortcut'), 'Shift+F1');
  assert.equal(f.data.clickThrough, false);
  f.data.interactionHotkey = 'Ctrl+F1';
  f.run('registerOverlayShortcut()');
  assert.deepEqual(hotkeys, ['Shift+F1', 'Ctrl+F1']);
  assert.deepEqual(f.unregistered, ['Shift+F1']);
});

function interactionFixture(clickThrough) {
  const calls = [], sent = [];
  const data = { clickThrough, widgetDocked: { widget: false, docked: true, hidden: false } };
  let autoHidden = true;
  const win = (name, visible = true) => ({
    _widgetId: name, focused: false, isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false,
    show: () => calls.push([name, 'show']), moveTop: () => calls.push([name, 'raise']),
    focus() { this.focused = true; calls.push([name, 'focus']); },
    isFocused() { return this.focused; },
    blur() { this.focused = false; calls.push([name, 'blur']); },
    setIgnoreMouseEvents: value => calls.push([name, 'ignore', value]),
    setFocusable: value => calls.push([name, 'focusable', value]),
    setSkipTaskbar: value => calls.push([name, 'taskbar-hidden', value]),
    webContents: { send: (...args) => sent.push([name, ...args]) },
  });
  const mainWindow = win('main'), dockWindow = win('dock'), widget = win('widget'), docked = win('docked'), hidden = win('hidden', false);
  const context = overlayContext({ mainWindow, dockWindow, dungeonOverlayWindow: null, isCollapsed: false, gameFocusRequest: null,
    overlayFocusRequestedAt: 0,
    widgetWindows: new Map([['widget', widget], ['docked', docked], ['hidden', hidden]]),
    config: { get: (key, fallback) => data[key] ?? fallback }, log() {},
    setDockAutoHidden: value => { autoHidden = value; }, clearTimeout() {}, shiftStartTimer: null,
    setLayoutEditing: active => vm.runInContext(`layoutEditing = ${active}`, context),
  });
  vm.runInContext('let overlayInteractive = false; let overlayHiddenByUser = false; let layoutEditing = false;', context);
  vm.runInContext(main.slice(main.indexOf('function applyOverlayMousePolicy()'), main.indexOf('// ─── App lifecycle')), context);
  return { calls, sent, context, data, win, mainWindow, widget, docked, get autoHidden() { return autoHidden; }, run: code => vm.runInContext(code, context) };
}

test('an explicit wiki search unlocks new and existing chrome before native focus and survives game detection', () => {
  const f = interactionFixture(false);
  const wiki = f.win('wiki-browser');
  let created = 0, aborted = 0, searches = 0;
  wiki.on = () => {};
  Object.assign(f.context, { path, __dirname: path.join(__dirname, '../src'),
    Date: { now: () => 1000 }, appStatus: 'connecting', registeredShortcut: 'Shift+F1', services: { wikiWebsite: 'https://wiki.example.org' },
    createWikiBrowser: () => { created++; return wiki; },
    restoredWindowBounds: (_key, bounds) => bounds, trackWindowBounds() {}, attachOverlayBlurHandler() {},
    gameFocusRequest: { abort: () => { aborted++; } },
    loadWikiSearch: (_win, query) => {
      searches++;
      assert.equal(query, 'Bromius');
      assert.equal(f.run('overlayInteractive'), true);
      assert.equal(f.calls.filter(call => call[0] === 'wiki-browser' && call[1] === 'ignore').at(-1)[2], false,
        'Window input must be unlocked before the factory tries to show/focus it');
    },
  });
  f.run(main.slice(main.indexOf('function createWikiWindow('), main.indexOf('// ─── Map window (expanded mini-map)')));
  f.run('createWikiWindow("Bromius")');
  assert.equal(aborted, 1, 'A queued return to the game cannot steal the search focus');
  assert.equal(f.run('overlayFocusRequestedAt'), 1000);
  assert.equal(f.context.gameFocusRequest, null);
  f.run('toggleOverlayInteraction(true)');
  assert.equal(f.calls.filter(call => call[0] === 'wiki-browser' && call[1] === 'ignore').at(-1)[2], true,
    'Returning to the game still releases the wiki toolbar');
  f.run('createWikiWindow("Bromius")');
  assert.equal(created, 1, 'An existing passive wiki is reused and unlocked');
  assert.equal(searches, 2);
  f.run('overlayHiddenByUser = true; createWikiWindow("Bromius")');
  assert.equal(searches, 2, 'A late search cannot reveal an intentionally hidden overlay');
});

test('Settings paints and unlocks before first show, restores passive windows, and cancels late focus', () => {
  const f = interactionFixture(false);
  let aborted = 0;
  class Settings extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.focusable = true; this.minimized = false; this.visible = false;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (...args) => f.calls.push(['settings', 'send', ...args]), invalidate: () => f.calls.push(['settings', 'repaint']),
      });
    }
    isDestroyed() { return false; }
    isFocused() { return false; }
    isFocusable() { return this.focusable; }
    setFocusable(value) { this.focusable = value; f.calls.push(['settings', 'focusable', value]); }
    setIgnoreMouseEvents(value) { this.ignore = value; f.calls.push(['settings', 'ignore', value]); }
    setSkipTaskbar() {}
    setAlwaysOnTop() {}
    loadFile(file, options) { this.file = file; this.loadOptions = options; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; f.calls.push(['settings', 'restore']); }
    show() { this.visible = true; f.calls.push(['settings', 'show']); this.emit('show'); }
    focus() { f.calls.push(['settings', 'focus']); }
  }
  Object.assign(f.context, { path, __dirname: path.join(__dirname, '../src'), BrowserWindow: Settings,
    Date: { now: () => 2000 }, appStatus: 'connected', registeredShortcut: 'Shift+F1',
    gameFocusRequest: { abort: () => { aborted++; } }, screen: {},
    settingsWindowBounds: () => ({ width: 780, height: 650 }), trackWindowBounds() {}, attachOverlayBlurHandler() {}, endShortcutCapture() {},
  });
  f.context.config.set = () => {};
  f.run(main.slice(main.indexOf('function createSettingsWindow('), main.indexOf('// ─── Changelog window')));
  f.run('createSettingsWindow("connections")');
  const settings = f.context.settingsWindow;
  assert.equal(settings.loadOptions.query.section, 'connections');
  settings.webContents.emit('did-finish-load');
  assert.ok(f.calls.some(call => call[1] === 'send' && call[2] === 'settings:section' && call[3] === 'connections'));
  assert.equal(aborted, 1);
  assert.equal(settings.visible, false, 'Wait for the first rendered frame');
  assert.equal(settings.options.backgroundColor, '#1b1b1b');
  assert.equal(settings.options.paintWhenInitiallyHidden, true);
  assert.equal(settings.options.webPreferences.backgroundThrottling, false);
  assert.equal(settings.ignore, false, 'Native input styles are settled before mapping');
  f.run('settingsWindow.emit("ready-to-show")');
  assert.equal(settings.visible, true);
  assert.ok(f.calls.some(call => call[0] === 'settings' && call[1] === 'repaint'));
  f.run('toggleOverlayInteraction(true)');
  assert.equal(settings.focusable, false);
  settings.minimized = true;
  f.calls.length = 0;
  f.run('createSettingsWindow("connections")');
  assert.equal(f.context.settingsWindow, settings, 'Connection links reuse Settings');
  assert.ok(f.calls.some(call => call[1] === 'send' && call[2] === 'settings:section' && call[3] === 'connections'));
  assert.ok(f.calls.findIndex(call => call[0] === 'settings' && call[1] === 'focusable')
    < f.calls.findIndex(call => call[0] === 'settings' && call[1] === 'show'), 'Unlock a cached Settings window before showing it');
  assert.equal(settings.minimized, false);
  assert.equal(settings.focusable, true);
  f.run('toggleOverlayInteraction(true)');
  f.calls.length = 0;
  f.run('showSettingsWindow(settingsWindow)');
  assert.equal(f.calls.length, 0, 'A late ready callback cannot take focus back from the game');
  f.run('overlayHiddenByUser = true; createSettingsWindow()');
  assert.equal(f.calls.length, 0, 'A late open request respects the visibility shortcut');
});

test('with click-through disabled, the hotkey shows/focuses the overlay and raises only visible widgets', () => {
  const f = interactionFixture(false);
  f.run('toggleOverlayInteraction()');
  assert.deepEqual(f.calls.filter(call => ['show', 'raise', 'focus'].includes(call[1])), [['main', 'show'], ['dock', 'raise'], ['widget', 'raise'], ['docked', 'raise'], ['main', 'focus']]);
  assert.equal(f.autoHidden, false, 'Focusing the dock reveals an auto-hidden rail');
  assert.equal(f.run('overlayInteractive'), true);
  f.calls.length = 0;
  f.run('toggleOverlayInteraction(true)');
  assert.equal(f.calls.filter(call => ['show', 'raise', 'focus'].includes(call[1])).length, 0, 'An automatic blur does not steal focus back from the game');
  assert.ok(f.calls.some(call => call[0] === 'widget' && call[1] === 'ignore' && call[2] === false), 'Click-through stays disabled');
});

test('interaction toggles mouse input, focuses the overlay, and releases a focused widget on exit', () => {
  const f = interactionFixture(true);
  f.run('toggleOverlayInteraction()');
  assert.equal(f.run('overlayInteractive'), true);
  assert.equal(f.calls.filter(call => call[1] === 'ignore' && call[2] === false).length, 5);
  assert.deepEqual(f.calls.at(-1), ['main', 'focus']);
  f.calls.length = 0;
  f.mainWindow.focused = false;
  f.widget.focused = true;
  f.run('toggleOverlayInteraction()');
  assert.equal(f.run('overlayInteractive'), false);
  assert.equal(f.calls.filter(call => call[1] === 'ignore' && call[2] === true).length, 5);
  assert.ok(f.calls.some(call => call[0] === 'main' && call[1] === 'ignore' && call[2] === true), 'The sidebar releases input when interaction ends');
  assert.ok(f.calls.some(call => call[0] === 'docked' && call[1] === 'ignore' && call[2] === true), 'Docked widgets restore configured click-through');
  assert.ok(f.calls.some(call => call[0] === 'widget' && call[1] === 'ignore' && call[2] === true), 'Floating widgets restore configured click-through');
  assert.ok(f.calls.some(call => call[0] === 'widget' && call[1] === 'blur'));
});

test('exiting the interaction shortcut ends layout editing and restores all widget click-through', () => {
  const f = interactionFixture(true);
  f.run('layoutEditing = true; overlayInteractive = true; toggleOverlayInteraction(true)');
  assert.equal(f.run('overlayInteractive'), false);
  assert.equal(f.run('layoutEditing'), false);
  assert.ok(f.calls.some(call => call[0] === 'main' && call[1] === 'ignore' && call[2] === true));
  assert.ok(f.calls.some(call => call[0] === 'docked' && call[1] === 'ignore' && call[2] === true));
  assert.ok(f.calls.some(call => call[0] === 'widget' && call[1] === 'ignore' && call[2] === true));
});

test('the launcher requires interaction or layout mode independently of widget click-through', () => {
  for (const clickThrough of [true, false]) {
    const f = interactionFixture(clickThrough);
    const launcherIgnoresMouse = () => f.calls.filter(call => call[0] === 'main' && call[1] === 'ignore').at(-1)?.[2];
    f.run('applyOverlayMousePolicy()');
    assert.equal(launcherIgnoresMouse(), true, 'An inactive sidebar passes mouse input to the game');
    f.run('toggleOverlayInteraction()');
    assert.equal(launcherIgnoresMouse(), false, 'The interaction shortcut enables the sidebar');
    f.run('toggleOverlayInteraction(true)');
    assert.equal(launcherIgnoresMouse(), true, 'Ending interaction restores sidebar click-through');
    f.run('layoutEditing = true; applyOverlayMousePolicy()');
    assert.equal(launcherIgnoresMouse(), false, 'A focused layout session can use the sidebar as a drop target');
    f.run('layoutEditing = false; applyOverlayMousePolicy()');
    assert.equal(launcherIgnoresMouse(), true, 'Ending layout restores sidebar click-through');
  }
});

test('Windows game sessions require the registered chord even with a legacy clickable-widget preference', () => {
  const f = interactionFixture(false);
  f.context.registeredShortcut = 'Shift+F1';
  const settings = f.win('settings'), tutorial = f.win('tutorial'), update = f.win('updates');
  Object.assign(f.context, { settingsWindow: settings, tutorialWindow: tutorial, updateWindow: update,
    nativeOverlayForeground: null });
  for (const status of ['connecting', 'connected', 'permission-denied', 'scan-failed']) {
    f.context.appStatus = status;
    f.run('applyOverlayMousePolicy()');
    for (const name of ['main', 'widget', 'docked', 'settings', 'tutorial', 'updates']) {
      assert.equal(f.calls.filter(call => call[0] === name && call[1] === 'ignore').at(-1)[2], true, status);
      assert.equal(f.calls.filter(call => call[0] === name && call[1] === 'focusable').at(-1)[2], false, status);
    }
  }
  f.calls.length = 0;
  f.run('toggleOverlayInteraction()');
  assert.ok(f.calls.findIndex(call => call[0] === 'main' && call[1] === 'focusable' && call[2])
    < f.calls.findIndex(call => call[0] === 'main' && call[1] === 'focus'), 'Native activation is enabled before focus');
  assert.deepEqual(f.calls.filter(call => call[1] === 'taskbar-hidden'),
    [['main', 'taskbar-hidden', false], ['dock', 'taskbar-hidden', true], ['widget', 'taskbar-hidden', true],
      ['docked', 'taskbar-hidden', true], ['hidden', 'taskbar-hidden', true], ['settings', 'taskbar-hidden', true],
      ['tutorial', 'taskbar-hidden', true], ['updates', 'taskbar-hidden', true]]);
  settings.focused = true;
  f.run('toggleOverlayInteraction(true)');
  assert.ok(f.calls.some(call => call[0] === 'settings' && call[1] === 'blur'), 'Exit also releases a focused popout');
  assert.equal(f.calls.filter(call => call[0] === 'widget' && call[1] === 'ignore').at(-1)[2], true);
  f.context.appStatus = 'waiting';
  f.run('applyOverlayMousePolicy()');
  assert.equal(f.calls.filter(call => call[0] === 'widget' && call[1] === 'ignore').at(-1)[2], false, 'Desktop preference returns after game closes');
  assert.equal(f.calls.filter(call => call[0] === 'main' && call[1] === 'ignore').at(-1)[2], true, 'The launcher still requires the chord');
});

test('a failed Windows game shortcut retains clickable panels and popouts for recovery', () => {
  const f = interactionFixture(false);
  f.context.appStatus = 'connected';
  f.context.settingsWindow = f.win('settings');
  f.run('applyOverlayMousePolicy()');
  assert.equal(f.calls.find(call => call[0] === 'widget' && call[1] === 'ignore')[2], false);
  assert.equal(f.calls.find(call => call[0] === 'settings' && call[1] === 'ignore')[2], false);
  assert.equal(f.calls.find(call => call[0] === 'main' && call[1] === 'ignore')[2], true);
});

test('launcher creation and dock geometry preserve the current mouse interaction policy', () => {
  for (const clickThrough of [true, false]) {
    const calls = [], settings = { clickThrough, dockEdge: 'bottom' };
    const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    class Launcher extends EventEmitter {
      constructor(options) { super(); this.bounds = options; this.webContents = { send() {} }; }
      getBounds() { return { ...this.bounds }; }
      isDestroyed() { return false; }
      setAlwaysOnTop() {}
      loadFile() {}
      showInactive() { calls.push(['show']); }
      setIgnoreMouseEvents(ignore) { calls.push(['ignore', ignore]); }
    }
    const context = overlayContext({ mainWindow: null, BrowserWindow: Launcher, dockDisplay: () => display,
      platformSupport: { platform: 'win32' },
      ...require('../src/modules/edgeDockGeometry'), path, __dirname: path.join(__dirname, '../src'),
      config: { get: (key, fallback) => settings[key] ?? fallback, set: (key, value) => { settings[key] = value; } },
      dockWindow: null, widgetWindows: new Map(), dungeonOverlayWindow: null, overlayInteractive: false, layoutEditing: false,
      overlayHiddenByUser: false, DEBUG: false, rememberWindowSize() {}, attachOverlayBlurHandler() {},
      setInterval: () => 1, getWindowBounds: win => win.bounds, setWindowBounds: (win, bounds) => { win.bounds = bounds; },
      layoutDockedPanels() {}, syncWidgetWindows() {}, pushDockState() {},
    });
    vm.runInContext(main.slice(main.indexOf('function applyOverlayMousePolicy()'), main.indexOf('function focusOverlay()')), context);
    vm.runInContext(main.slice(main.indexOf('function createMainWindow()'), main.indexOf('/** Save window position')), context);
    vm.runInContext(main.slice(main.indexOf('function applyDockGeometry()'), main.indexOf('function layoutDockedPanels()')), context);
    const run = code => vm.runInContext(code, context);
    const ignoresMouse = () => calls.filter(call => call[0] === 'ignore').at(-1)?.[1];
    run('createMainWindow()');
    assert.equal(ignoresMouse(), true, 'A newly created launcher starts pass-through');
    run('mainWindow.emit("ready-to-show")');
    assert.equal(ignoresMouse(), true, 'Showing the sidebar keeps interaction disabled');
    settings.dockEdge = 'left';
    run('applyDockGeometry()');
    assert.equal(ignoresMouse(), true, 'Moving to another edge cannot enable sidebar input');
    run('overlayInteractive = true; applyDockGeometry()');
    assert.equal(ignoresMouse(), false, 'Geometry updates retain explicit interaction');
    run('overlayInteractive = false; applyDockGeometry()');
    assert.equal(ignoresMouse(), true, 'A later geometry update retains pass-through');
  }
});

function nativeLauncherGeometryFixture(platform = 'win32', displayBackend = platform === 'linux' ? 'xwayland' : undefined, showReady = true) {
  const { rememberWindowSize, getWindowBounds, setWindowBounds } = require('../src/modules/windowDrag');
  const timers = new Map(), calls = [], settings = { dockEdge: 'left', clickThrough: true,
    widgetVisibility: { wiki: true }, widgetOpen: { wiki: true }, widgetDocked: { wiki: true } };
  const display = { id: 1, bounds: { x: -1920, y: -100, width: 1920, height: 1080 },
    workArea: { x: -1920, y: -100, width: 1920, height: 1040 } };
  let nextTimer = 1;
  class NativeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, options[key]]));
      this.options = options;
      this.visible = false;
      this.webContents = { send() {} };
    }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) {
      const previous = this.bounds;
      this.bounds = { ...bounds };
      calls.push(['bounds', { ...bounds }]);
      if (previous.width !== bounds.width || previous.height !== bounds.height) this.emit('resize');
      if (previous.x !== bounds.x || previous.y !== bounds.y) this.emit('move');
    }
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    isFocused() { return false; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadFile() {}
    showInactive() { this.visible = true; calls.push(['show']); this.emit('show'); }
    hide() { this.visible = false; }
    setIgnoreMouseEvents(ignore) { this.ignoreMouse = ignore; }
  }
  const panel = new NativeWindow({ x: -1864, y: -92, width: 300, height: 1030 });
  panel._widgetId = 'wiki';
  rememberWindowSize(panel, panel.bounds);
  const screen = new EventEmitter();
  screen.getCursorScreenPoint = () => ({ x: 500, y: 500 });
  const context = overlayContext({ mainWindow: null, BrowserWindow: NativeWindow,
    platformSupport: { platform, displayBackend },
    ...require('../src/modules/edgeDockGeometry'), path,
    __dirname: path.join(__dirname, '../src'), dockDisplay: () => display, screen,
    config: { get: (key, fallback) => settings[key] ?? fallback, set: (key, value) => { settings[key] = value; } },
    dockWindow: null, widgetWindows: new Map([['wiki', panel]]), ALL_WIDGET_IDS: ['wiki'], dungeonOverlayWindow: null,
    overlayInteractive: false, layoutEditing: false, overlayHiddenByUser: false, mainHiddenForFocus: false, gameHiddenActive: false,
    dockAutoHidden: false, DEBUG: false, rememberWindowSize, getWindowBounds, setWindowBounds,
    attachOverlayBlurHandler() {}, pushDockState() {}, onGlobalShift() {},
    startLayoutKeyMonitor: () => ({ stop() {} }), setLayoutEditing: value => { context.layoutEditing = value; },
    setInterval: () => 1, setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), layoutKeyMonitor: null, dockPollTimer: null,
  });
  vm.runInContext(main.slice(main.indexOf('function applyOverlayMousePolicy()'), main.indexOf('function focusOverlay()')), context);
  vm.runInContext(main.slice(main.indexOf('function createMainWindow()'), main.indexOf('/** Save window position')), context);
  vm.runInContext(main.slice(main.indexOf('function watchDockedWidgetGeometry('), main.indexOf('function createWidgetWindow(')), context);
  vm.runInContext(main.slice(main.indexOf('function applyDockGeometry()'), main.indexOf('function applyLayoutMode()')), context);
  vm.runInContext(main.slice(main.indexOf('function startDockRuntime()'), main.indexOf('function setOverlayHidden(')), context);
  const run = code => vm.runInContext(code, context);
  run('createMainWindow(); startDockRuntime();');
  run('watchDockedWidgetGeometry(widgetWindows.get("wiki"))');
  if (showReady) run('mainWindow.emit("ready-to-show")');
  function flush() {
    let rounds = 0;
    while (timers.size) {
      assert.ok(++rounds < 5, 'Native geometry correction must settle rather than loop');
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, callback] of pending) callback();
    }
  }
  flush();
  return { context, settings, display, panel, screen, calls, timers, run, flush, getWindowBounds,
    get rail() { return context.mainWindow; } };
}

test('the launcher uses native-sized Windows icons instead of the full-resolution branding PNG', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const f = nativeLauncherGeometryFixture(platform, undefined, false);
    assert.equal(f.rail.options.icon, path.join(__dirname, '../assets', platform === 'win32' ? 'overkot.ico' : 'overkot.png'));
    assert.equal(f.rail.options.skipTaskbar, false, 'The launcher retains its taskbar recovery entry');
  }
});

test('saved open widgets that load before the Linux rail appear when the rail becomes ready', () => {
  const f = nativeLauncherGeometryFixture('linux', 'xwayland', false);
  f.run('syncWidgetWindows()');
  assert.equal(f.rail.isVisible(), false);
  assert.equal(f.panel.isVisible(), false, 'Widget readiness cannot reveal panels before the hidden rail');
  f.run('mainWindow.emit("ready-to-show")');
  f.flush();
  assert.equal(f.rail.isVisible(), true);
  assert.equal(f.panel.isVisible(), true, 'Saved open panels appear after the launcher maps');
  assert.equal(f.settings.widgetOpen.wiki, true);
  assert.equal(f.settings.widgetDocked.wiki, true);
});

test('Linux compositor movement restores attached widgets but permits Shift editing and floating panels', () => {
  const f = nativeLauncherGeometryFixture('linux');
  const attached = f.panel.getBounds();
  f.panel.setBounds({ ...attached, x: attached.x + 120, y: attached.y + 80 });
  f.flush();
  assert.deepEqual(f.panel.getBounds(), attached, 'A compositor move outside editing returns to the shelf');
  f.context.layoutEditing = true;
  const editing = { ...attached, x: attached.x + 80, y: attached.y + 40 };
  f.panel.setBounds(editing);
  f.flush();
  assert.deepEqual(f.panel.getBounds(), editing, 'Shift editing keeps free native movement');
  f.context.layoutEditing = false;
  f.settings.widgetDocked.wiki = false;
  const floating = { ...attached, x: attached.x + 60, y: attached.y + 30 };
  f.panel.setBounds(floating);
  f.flush();
  assert.deepEqual(f.panel.getBounds(), floating, 'Saved floating panels retain their positions');
});

test('Linux attached widget position rounding settles without repeated configure writes', () => {
  const f = nativeLauncherGeometryFixture('linux');
  const attached = f.panel.getBounds();
  const writes = f.calls.filter(([action]) => action === 'bounds').length;
  f.panel.bounds = { ...attached, x: attached.x + 1, y: attached.y - 1,
    width: attached.width + 1, height: attached.height - 1 };
  f.panel.emit('resize');
  f.panel.emit('move');
  f.flush();
  assert.equal(f.calls.filter(([action]) => action === 'bounds').length, writes);
});

test('native taskbar geometry drift repairs every launcher edge despite cached intended dimensions', () => {
  const f = nativeLauncherGeometryFixture();
  const { railBounds } = require('../src/modules/edgeDockGeometry');
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    f.settings.dockEdge = edge;
    f.run('applyDockGeometry()');
    f.flush();
    const full = railBounds(f.display.bounds, edge);
    const shortened = { ...full, ...(edge === 'left' || edge === 'right' ? { height: full.height - 40 } : { width: full.width - 80 }) };
    // An OS resize changes native bounds without changing windowDrag's cache.
    f.rail.setBounds(shortened);
    assert.equal(f.getWindowBounds(f.rail).height, full.height);
    assert.equal(f.getWindowBounds(f.rail).width, full.width);
    f.flush();
    assert.deepEqual(f.rail.getBounds(), full, `${edge} recovers without recreating the app window`);
    assert.equal(f.rail.ignoreMouse, true, 'Repair keeps the sidebar pass-through');
  }
});

test('taskbar work-area changes keep the rail full-sized and widgets inside the usable desktop', () => {
  const f = nativeLauncherGeometryFixture();
  const full = f.rail.getBounds();
  f.display.workArea.height = 900;
  f.rail.bounds = { ...full, height: 900 }; // Simulate a clamp preceding screen notification.
  f.screen.emit('display-metrics-changed', {}, f.display, ['workArea']);
  f.flush();
  assert.deepEqual(f.rail.getBounds(), full);
  assert.ok(f.panel.getBounds().y + f.panel.getBounds().height <= f.display.workArea.y + f.display.workArea.height);
  assert.equal(f.panel.getBounds().height, f.display.workArea.height - 16, 'Widget layout still honors the taskbar work area');
  f.display.workArea.height = f.display.bounds.height;
  f.screen.emit('display-metrics-changed', {}, f.display, ['workArea']);
  f.flush();
  assert.deepEqual(f.rail.getBounds(), full, 'Auto-hiding the taskbar does not change the rail extent');
});

test('show and restore repair native rail drift without revealing hidden windows or changing interaction', () => {
  const f = nativeLauncherGeometryFixture();
  const full = f.rail.getBounds();
  for (const event of ['show', 'restore', 'resize']) {
    f.rail.hide();
    f.context.dockAutoHidden = true;
    f.context.overlayInteractive = event === 'restore';
    f.rail.bounds = { ...full, y: full.y + 20, height: full.height - 40 };
    const shows = f.calls.filter(([action]) => action === 'show').length;
    f.rail.emit(event);
    f.flush();
    assert.deepEqual(f.rail.getBounds(), full);
    assert.equal(f.rail.isVisible(), false, 'Geometry repair must not reveal an auto-hidden rail');
    assert.equal(f.calls.filter(([action]) => action === 'show').length, shows);
    assert.equal(f.rail.ignoreMouse, !f.context.overlayInteractive, 'Interaction mode survives geometry repair');
  }
});

test('fractional X11 size rounding retains cached launcher dimensions instead of repeatedly resizing', () => {
  const f = nativeLauncherGeometryFixture('linux');
  const full = f.rail.getBounds();
  f.rail.bounds = { ...full, width: full.width - 1, height: full.height - 1 };
  const writes = f.calls.filter(([action]) => action === 'bounds').length;
  f.run('applyDockGeometry(); applyDockGeometry()');
  assert.equal(f.calls.filter(([action]) => action === 'bounds').length, writes);
  assert.equal(f.timers.size, 0);
  assert.equal(f.getWindowBounds(f.rail).width, full.width);
  assert.equal(f.getWindowBounds(f.rail).height, full.height);
});

test('Linux launcher declares a dock and repairs compositor centering on every edge', () => {
  const f = nativeLauncherGeometryFixture('linux');
  const { railBounds } = require('../src/modules/edgeDockGeometry');
  assert.equal(f.rail.options.type, 'dock', 'The rail should be a panel rather than a normal tiled application');
  assert.equal(nativeLauncherGeometryFixture('win32').rail.options.type, undefined);
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    f.settings.dockEdge = edge;
    f.run('applyDockGeometry()');
    f.flush();
    const full = railBounds(f.display.bounds, edge);
    for (const event of ['move', 'show', 'restore']) {
      f.rail.bounds = { ...full, x: -1000, y: 300 };
      f.rail.emit(event);
      f.flush();
      assert.deepEqual(f.rail.getBounds(), full, `${edge} rail returns after ${event}`);
      assert.equal(f.rail.ignoreMouse, true, 'Repair preserves launcher click-through');
    }
  }
});

test('Linux configure events repair position while rounded sizes settle without repeated writes', () => {
  const f = nativeLauncherGeometryFixture('linux');
  const full = f.rail.getBounds();
  const nativeSetBounds = f.rail.setBounds.bind(f.rail);
  f.rail.setBounds = bounds => {
    nativeSetBounds(bounds);
    // X11 can report an enclosing DIP rectangle one pixel larger or smaller.
    f.rail.bounds = { ...bounds, x: bounds.x + 1, y: bounds.y - 1,
      width: bounds.width + 1, height: bounds.height - 1 };
    f.rail.emit('resize');
  };
  const writes = f.calls.filter(([action]) => action === 'bounds').length;
  f.rail.bounds = { ...full, x: full.x + 50, y: full.y + 50 };
  f.rail.emit('move');
  f.flush();
  assert.equal(f.calls.filter(([action]) => action === 'bounds').length, writes + 1);
  assert.deepEqual(f.getWindowBounds(f.rail), { ...full, x: full.x + 1, y: full.y - 1 });
  assert.equal(f.timers.size, 0, 'Configure feedback should settle after the corrected position');
});

test('Linux origin rounding within one DIP does not reconfigure the launcher', () => {
  const f = nativeLauncherGeometryFixture('linux');
  const full = f.rail.getBounds();
  const writes = f.calls.filter(([action]) => action === 'bounds').length;
  for (const delta of [-1, 0, 1]) {
    f.rail.bounds = { ...full, x: full.x + delta, y: full.y - delta };
    f.rail.emit('move');
    f.flush();
    assert.equal(f.calls.filter(([action]) => action === 'bounds').length, writes);
  }
  f.rail.bounds = { ...full, x: full.x + 2, y: full.y - 2 };
  f.rail.emit('move');
  f.flush();
  assert.deepEqual(f.rail.getBounds(), full, 'A larger offset still repairs');
});

test('explicit native Wayland does not poll for unsupported window positioning', () => {
  const f = nativeLauncherGeometryFixture('linux', 'wayland');
  const writes = f.calls.filter(([action]) => action === 'bounds').length;
  for (const event of ['move', 'resize', 'show', 'restore']) {
    f.rail.bounds = { ...f.rail.bounds, x: 0, y: 0 };
    f.rail.emit(event);
  }
  f.flush();
  assert.equal(f.calls.filter(([action]) => action === 'bounds').length, writes);
  assert.equal(f.timers.size, 0);
});

test('the fullscreen dungeon map ignores clicks outside interaction mode even with widget click-through disabled', () => {
  for (const clickThrough of [true, false]) {
    const f = interactionFixture(clickThrough);
    const map = f.win('dungeon');
    f.context.dungeonOverlayWindow = map;
    f.run('toggleOverlayInteraction()');
    assert.equal(map.focused, true);
    assert.ok(f.calls.findIndex(call => call[0] === 'dungeon' && call[1] === 'ignore' && call[2] === false)
      < f.calls.findIndex(call => call[0] === 'dungeon' && call[1] === 'focus'), 'Enable map input before focusing it');
    f.calls.length = 0;
    f.run('toggleOverlayInteraction(true)');
    assert.equal(map.focused, false);
    assert.ok(f.calls.some(call => call[0] === 'dungeon' && call[1] === 'ignore' && call[2] === true));
    assert.deepEqual(f.sent.at(-1), ['dungeon', 'overlay-interaction-changed', false]);
  }
});

test('native foreground samples end interaction with stale widget focus and allow a requested focus transfer', () => {
  const f = interactionFixture(true);
  let clock = 1000;
  Object.assign(f.context, { process: { pid: 123 }, Date: { now: () => clock } });
  f.run('let nativeOverlayForeground = null; let overlayFocusRequestedAt = 0; overlayInteractive = true;');
  f.run(main.slice(main.indexOf('function onNativeForeground('), main.indexOf('function startDockRuntime()')));
  f.widget.focused = true;
  f.run('onNativeForeground(456)');
  assert.equal(f.run('overlayInteractive'), false);
  assert.ok(f.calls.some(call => call[0] === 'widget' && call[1] === 'ignore' && call[2] === true));
  f.run('overlayInteractive = true; overlayFocusRequestedAt = 1000;');
  clock = 1100;
  f.run('onNativeForeground(456)');
  assert.equal(f.run('overlayInteractive'), true);
  clock = 1250;
  f.run('onNativeForeground(123)');
  assert.equal(f.run('overlayInteractive'), true, 'The overlay received native focus during its grace period');
  f.run('onNativeForeground(456)');
  assert.equal(f.run('overlayInteractive'), false);
});

test('the interaction shortcut cannot reveal an overlay hidden by its visibility shortcut', () => {
  for (const clickThrough of [false, true]) {
    const f = interactionFixture(clickThrough);
    f.run('overlayHiddenByUser = true; toggleOverlayInteraction()');
    assert.equal(f.calls.filter(call => ['show', 'raise', 'focus'].includes(call[1])).length, 0);
    assert.equal(f.run('overlayInteractive'), false, 'Hidden overlays do not silently re-enter interaction mode');
    assert.equal(f.autoHidden, true, 'The visibility shortcut remains the authority for showing the overlay');
  }
});

test('auto-hide keeps keyboard navigation visible and resumes after the pointer takes over', () => {
  let poll;
  let clock = 10000;
  const hidden = [];
  const context = overlayContext({
    mainWindow: { isDestroyed: () => false, isVisible: () => true, isFocused: () => true },
    widgetWindows: new Map(), settingsWindow: null, widgetsWindow: null, changelogWindow: null,
    marketWindow: null, wikiWindow: null, groupFinderWindow: null, mapWindow: null,
    calendarSettingsWindow: null, updateWindow: null, dungeonOverlayWindow: null, mainHiddenForFocus: false,
    config: { get: (key, fallback) => ({ dockAutoHide: true, dockEdge: 'bottom' }[key] ?? fallback) },
    screen: { getCursorScreenPoint: () => ({ x: 500, y: 500 }), on() {} },
    dockDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    ...require('../src/modules/edgeDockGeometry'),
    startLayoutKeyMonitor: () => ({ stop() {} }), onGlobalShift() {}, finishWidgetDrag() {},
    isAnyOverlayWindowFocused: () => true,
    setDockAutoHidden: value => hidden.push(value), setLayoutEditing() {}, applyDockGeometry() {}, pushDockState() {}, log() {},
    setInterval: callback => { poll = callback; return 1; }, Date: { now: () => clock },
  });
  vm.runInContext('let layoutKeyMonitor; let dockPollTimer; let overlayInteractive = false; let overlayHiddenByUser = false; let dockAutoHidden = false; let layoutEditing = false; let redockTarget = false; let dockKeyboardActive = true; let lastDockHover = 0;', context);
  vm.runInContext(main.slice(main.indexOf('function startDockRuntime()'), main.indexOf('function setOverlayHidden(')), context);
  vm.runInContext('startDockRuntime()', context);
  poll();
  assert.deepEqual(hidden, [false], 'Focused keyboard navigation reveals the rail even with the cursor elsewhere');
  clock += 1000;
  vm.runInContext('dockKeyboardActive = false;', context);
  poll();
  assert.deepEqual(hidden, [false, true], 'Pointer use permits auto-hide after its normal delay');
});

function dockPointerFixture(edge = 'bottom', clickThrough = true) {
  const f = interactionFixture(clickThrough);
  let poll, clock = 10000, cursor = { x: 500, y: 500 };
  const changes = [];
  const display = { bounds: { x: -1920, y: -100, width: 1920, height: 1080 } };
  Object.assign(f.data, { dockEdge: edge, dockAutoHide: true });
  for (const win of f.context.widgetWindows.values()) win.bounds = { x: -1400, y: 200, width: 300, height: 250 };
  f.mainWindow.isVisible = () => !f.context.dockAutoHidden;
  Object.assign(f.context, {
    dockAutoHidden: true, redockTarget: false, dockKeyboardActive: false, lastDockHover: 9000,
    nativeOverlayForeground: false, layoutKeyMonitor: null, dockPollTimer: null,
    settingsWindow: null, widgetsWindow: null, changelogWindow: null, marketWindow: null, wikiWindow: null,
    groupFinderWindow: null, mapWindow: null, calendarSettingsWindow: null, updateWindow: null,
    mainHiddenForFocus: false, startLayoutKeyMonitor: () => ({ stop() {} }), onGlobalShift() {},
    screen: { getCursorScreenPoint: () => cursor, on() {} }, dockDisplay: () => display,
    ...require('../src/modules/edgeDockGeometry'), getWindowBounds: win => win.bounds,
    setInterval: callback => { poll = callback; return 1; }, Date: { now: () => clock }, pushDockState() {},
    setDockAutoHidden: value => { changes.push(value); f.context.dockAutoHidden = value; },
  });
  f.run(main.slice(main.indexOf('function isAnyOverlayWindowFocused()'), main.indexOf('/** Attach a blur handler')));
  f.run(main.slice(main.indexOf('function startDockRuntime()'), main.indexOf('function setOverlayHidden(')));
  f.run('startDockRuntime()');
  return { ...f, display, changes, poll: () => poll(), cursor: point => { cursor = point; },
    advance: ms => { clock += ms; },
    edgePoint() {
      const bounds = f.context.railBounds(display.bounds, edge, true);
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    } };
}

test('inactive game movement and drags cannot reveal or prolong the sidebar on any edge', () => {
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    for (const clickThrough of [true, false]) {
      const f = dockPointerFixture(edge, clickThrough);
      f.widget._isDragging = true; // A held button/stale drag must not authorize reveal.
      f.cursor(f.edgePoint());
      f.poll();
      assert.equal(f.context.dockAutoHidden, true, `${edge}: game movement does not reveal the rail`);
      assert.equal(f.context.lastDockHover, 9000, 'Game pointer movement does not refresh the hide timer');
      assert.equal(f.context.redockTarget, false);
      f.context.dockAutoHidden = false;
      f.context.lastDockHover = 10000;
      f.advance(500);
      f.poll();
      assert.equal(f.context.lastDockHover, 10000, 'Inactive hover over a visible bar does not prolong it');
      f.cursor({ x: f.widget.bounds.x + 10, y: f.widget.bounds.y + 10 });
      f.widget.focused = true;
      f.context.nativeOverlayForeground = true;
      f.advance(400);
      f.poll();
      assert.equal(f.context.dockAutoHidden, true, 'Hovering a widget cannot extend an inactive sidebar session');
      assert.equal(f.context.lastDockHover, 10000);
      f.run('applyOverlayMousePolicy()');
      const widgetPolicy = f.calls.filter(call => call[0] === 'widget' && call[1] === 'ignore').at(-1);
      assert.equal(widgetPolicy[2], clickThrough, 'The widget click-through setting remains authoritative');
    }
  }
});

test('focused interaction and layout sessions can reveal the sidebar by pointer on every edge', () => {
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    for (const mode of ['overlayInteractive', 'layoutEditing']) {
      const f = dockPointerFixture(edge);
      f.run(`${mode} = true`);
      f.widget.focused = true;
      f.context.nativeOverlayForeground = true;
      f.cursor(f.edgePoint());
      f.poll();
      assert.equal(f.context.dockAutoHidden, false, `${edge}: focused ${mode} reveals the rail`);
      assert.equal(f.context.lastDockHover, 10000);
      f.context.dockKeyboardActive = false;
      f.cursor({ x: f.widget.bounds.x + 10, y: f.widget.bounds.y + 10 });
      f.advance(1000);
      f.poll();
      assert.equal(f.context.dockAutoHidden, false, 'Active panel interaction keeps the sidebar visible');
    }
  }
});

test('native foreground ownership blocks stale pointer, layout, keyboard and popout reveal', () => {
  for (const activity of ['interaction', 'layout', 'keyboard', 'popout']) {
    const f = dockPointerFixture('left');
    f.mainWindow.focused = true; // Chromium's stale flag disagrees with Win32.
    f.context.dockKeyboardActive = activity === 'keyboard';
    if (activity === 'interaction') f.run('overlayInteractive = true');
    if (activity === 'layout') { f.run('layoutEditing = true'); f.widget._isDragging = true; }
    if (activity === 'popout') f.context.wikiWindow = f.win('wiki-browser');
    if (f.context.wikiWindow) f.context.wikiWindow.focused = true;
    f.cursor(f.edgePoint());
    f.poll();
    assert.equal(f.context.dockAutoHidden, true, `${activity}: stale focus cannot reveal the sidebar`);
    assert.equal(f.context.lastDockHover, 9000);
    assert.equal(f.context.redockTarget, false);
  }
});

test('the interaction hotkey explicitly reveals the hidden rail and keeps focused keyboard navigation active', () => {
  const f = dockPointerFixture('right');
  f.run('toggleOverlayInteraction()');
  assert.equal(f.context.dockAutoHidden, false, 'The hotkey reveals immediately without waiting for pointer activity');
  assert.equal(f.mainWindow.focused, true);
  f.context.nativeOverlayForeground = true;
  f.advance(1000);
  f.poll();
  assert.equal(f.context.dockAutoHidden, false, 'The focused keyboard session remains visible with the cursor elsewhere');
});

test('genuine popout focus preserves the sidebar while disabling auto-hide keeps it visible outside the overlay', () => {
  const focused = dockPointerFixture();
  focused.context.wikiWindow = focused.win('wiki-browser');
  focused.context.wikiWindow.focused = true;
  focused.context.nativeOverlayForeground = true;
  focused.poll();
  assert.equal(focused.context.dockAutoHidden, false, 'A focused popout retains normal sidebar visibility');
  const disabled = dockPointerFixture();
  disabled.data.dockAutoHide = false;
  disabled.cursor(disabled.edgePoint());
  disabled.poll();
  assert.equal(disabled.context.dockAutoHidden, false, 'Disabling auto-hide leaves the bar visible without activating input');
  assert.equal(disabled.context.lastDockHover, 9000, 'Inactive mouse movement still does not create an interaction session');
});

test('focus-loss polling releases stale fullscreen interaction even while the launcher is hidden', () => {
  let poll;
  const f = interactionFixture(true);
  const map = f.win('dungeon');
  f.context.dungeonOverlayWindow = map;
  Object.assign(f.context, {
    startLayoutKeyMonitor: () => ({ stop() {} }),
    onGlobalShift() {},
    setInterval: callback => { poll = callback; return 1; },
    screen: { on() {} }, isAnyOverlayWindowFocused: () => false,
  });
  f.mainWindow.isVisible = () => false;
  f.run('let layoutKeyMonitor, dockPollTimer; let dockAutoHidden = false; overlayInteractive = true;');
  f.run(main.slice(main.indexOf('function startDockRuntime()'), main.indexOf('function setOverlayHidden(')));
  f.run('startDockRuntime()');
  poll();
  assert.equal(f.run('overlayInteractive'), false);
  assert.ok(f.calls.some(call => call[0] === 'dungeon' && call[1] === 'ignore' && call[2] === true));
  assert.ok(f.calls.some(call => call[0] === 'docked' && call[1] === 'ignore' && call[2] === true));
});

test('focus reconciliation lets an explicit hotkey transfer settle before releasing input', () => {
  let poll, clock = 1000;
  const f = interactionFixture(true);
  Object.assign(f.context, {
    startLayoutKeyMonitor: () => ({ stop() {} }), onGlobalShift() {},
    setInterval: callback => { poll = callback; return 1; }, screen: { on() {} },
    isAnyOverlayWindowFocused: () => false, Date: { now: () => clock },
  });
  f.mainWindow.isVisible = () => false;
  f.run('let layoutKeyMonitor, dockPollTimer; let dockAutoHidden = false; overlayInteractive = true; overlayFocusRequestedAt = 950;');
  f.run(main.slice(main.indexOf('function startDockRuntime()'), main.indexOf('function setOverlayHidden(')));
  f.run('startDockRuntime()');
  poll();
  assert.equal(f.run('overlayInteractive'), true, 'Do not undo the native focus request before it settles');
  clock = 1200;
  poll();
  assert.equal(f.run('overlayInteractive'), false, 'A failed transfer still releases input after the grace period');
});

test('native monitor failure releases editing and notifies every live overlay renderer', () => {
  let callbacks;
  const edits = [], sent = [], cancelled = [], logs = [];
  const win = name => ({ isDestroyed: () => false, webContents: { send: (...args) => sent.push([name, ...args]) } });
  const context = overlayContext({ mainWindow: win('rail'),
    widgetWindows: new Map([['wiki', win('wiki')], ['closed', { isDestroyed: () => true }]]),
    startLayoutKeyMonitor: options => { callbacks = options; return { stop() {} }; },
    setLayoutEditing: active => edits.push(active), onGlobalShift() {}, finishWidgetDrag() {},
    setInterval: () => 1, clearTimeout: timer => cancelled.push(timer),
    screen: { on() {} }, log: (...args) => logs.push(args),
  });
  vm.runInContext('let nativeLayoutTracking = true; let layoutKeyMonitor; let dockPollTimer; let shiftStartTimer = 77;', context);
  vm.runInContext(main.slice(main.indexOf('function startDockRuntime()'), main.indexOf('function setOverlayHidden(')), context);
  vm.runInContext('startDockRuntime()', context);
  callbacks.onError(new Error('PowerShell stopped'));
  assert.equal(vm.runInContext('nativeLayoutTracking', context), false);
  assert.deepEqual(cancelled, [77], 'A pending Shift debounce cannot reactivate editing after failure');
  assert.deepEqual(edits, [false]);
  assert.deepEqual(sent, [['rail', 'layout-key-monitor-status', false], ['wiki', 'layout-key-monitor-status', false]]);
  assert.match(logs[0][1], /using renderer events.*PowerShell stopped/);
});

test('renderer Shift release is accepted after native tracking fails and only from overlay surfaces', () => {
  let request;
  const edits = [];
  const rail = {}, widget = { _widgetId: 'wiki' }, unrelated = {};
  const context = overlayContext({ mainWindow: rail, layoutEditing: false,
    BrowserWindow: { fromWebContents: sender => sender },
    ipcMain: { on: (_channel, callback) => { request = callback; } },
    setLayoutEditing: active => edits.push(active),
  });
  vm.runInContext('let nativeLayoutTracking = true;', context);
  vm.runInContext(main.slice(main.indexOf("ipcMain.on('layout-editing-request'"), main.indexOf('function resetWidgetPositions()')), context);
  request({ sender: widget }, false);
  assert.deepEqual(edits, [], 'Healthy Windows native tracking owns Shift release');
  vm.runInContext('nativeLayoutTracking = false;', context);
  request({ sender: rail }, true);
  request({ sender: widget }, false);
  request({ sender: unrelated }, true);
  assert.deepEqual(edits, [true, false], 'Fallback events activate and release editing, without admitting unrelated windows');
});

test('focus-only hiding reconciles a rail restored while the game remains unfocused', () => {
  let visible = true;
  let hides = 0;
  const mainWindow = { isDestroyed: () => false, isVisible: () => visible,
    hide() { visible = false; hides++; }, showInactive() { visible = true; } };
  const context = overlayContext({ mainWindow, platformSupport: { gameConnection: true, gameFocusTracking: true },
    config: { get: (key, fallback) => ({ showOnlyWhenGameFocused: true, hideWhenGameClosed: false }[key] ?? fallback) },
    isAnyOverlayWindowFocused: () => false, setLayoutEditing() {}, log() {}, syncWidgetWindows() {},
    tray: null, dockWindow: null, widgetWindows: new Map(), alertWindows: new Set(),
    settingsWindow: null, changelogWindow: null, widgetsWindow: null, groupFinderWindow: null,
    marketWindow: null, wikiWindow: null, mapWindow: null, dungeonOverlayWindow: null, calendarSettingsWindow: null, dockAutoHidden: false,
  });
  vm.runInContext('let overlayHiddenByUser = false; let appStatus = "connected"; let gameFocusedActive = false; let mainHiddenForFocus = false; let gameHiddenActive = false; let isCollapsed = false;', context);
  vm.runInContext(main.slice(main.indexOf('function applyGameHiddenState()'), main.indexOf('function pushStateToRenderer()')), context);
  vm.runInContext('applyGameHiddenState()', context);
  assert.equal(visible, false);
  mainWindow.showInactive(); // Visibility shortcut restores the native window first.
  vm.runInContext('applyGameHiddenState()', context);
  assert.equal(visible, false, 'The existing hide flag must not bypass current focus policy');
  assert.equal(hides, 2);
});

test('scanner failures have explicit states, slow retry, recovery, and process-exit handling', () => {
  const context = overlayContext({ platformSupport: { platform: 'linux' } });
  vm.runInContext('let appStatus = "connecting"; function setStatus(value) { appStatus = value; }', context);
  vm.runInContext(main.slice(main.indexOf('function applyCredentialScanStatus('), main.indexOf('function setStatus(')), context);
  const run = code => vm.runInContext(code, context);
  assert.equal(run('applyCredentialScanStatus({scanError: "permission-denied"})'), true);
  assert.equal(run('appStatus'), 'permission-denied');
  assert.equal(run('credentialScanRetryDelay()'), 10000);
  assert.equal(run('applyCredentialScanStatus({scanError: "scan-failed"})'), true);
  assert.equal(run('appStatus'), 'scan-failed');
  assert.equal(run('applyCredentialScanStatus({})'), true);
  assert.equal(run('appStatus'), 'connecting');
  assert.equal(run('credentialScanRetryDelay()'), 2000);
  assert.equal(run('applyCredentialScanStatus({scanError: "process-gone"})'), false);
  run('platformSupport.platform = "win32"');
  assert.equal(run('credentialScanRetryDelay()'), 100);
});

test('the dock exposes process denial and shortcut failure through visible status, tooltip, and accessibility text', () => {
  const elements = new Map();
  const context = overlayContext({ window: {}, TRANSLATIONS: { en: {} }, document: { addEventListener() {}, querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', dataset: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
    return elements.get(selector);
  } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/widget-icons.js'), 'utf8'), context);
  context.window.WidgetIcons = context.WidgetIcons;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8'), context);
  vm.runInContext('currentStatus = "permission-denied"; overlayShortcutWarning = "Click-through is off."; config = { overlayVisibilityHotkey: "Ctrl+F2" }; renderStatus();', context);
  assert.match(elements.get('#dock-status-text').textContent, /Access blocked/);
  assert.match(elements.get('#dock-status').title, /process permissions/);
  assert.match(elements.get('#dock-status').title, /Click-through is off/);
  assert.match(elements.get('#dock-status').title, /Ctrl\+F2: show \/ hide overlay/);
  assert.match(elements.get('#dock-status').attributes['aria-label'], /process permissions/);
  assert.match(elements.get('#dock-status-announcement').textContent, /Access blocked\. Click-through is off/);
  assert.equal(elements.get('#dock-status').dataset.status, 'warning');
});
