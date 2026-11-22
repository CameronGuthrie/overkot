'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { layoutDockedWidgets } = require('../src/modules/edgeDockGeometry');
const { configureOverlayWorkspace } = require('../src/modules/overlayWindowPolicy');
const WidgetSizing = require('../src/modules/widgetSizing');
const { constrainBounds, restoreBounds } = require('../src/modules/windowGeometry');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function widgetsFixture() {
  const settings = { widgetVisibility: { 'world-watch': true, clock: false, weather: false, calendar: false },
    widgetOpen: {}, widgetDocked: {}, dockEdge: 'bottom', clickThrough: false };
  const windows = new Map();
  const display = { id: 1, bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
  const dock = { isDestroyed: () => false, isVisible: () => true, setIgnoreMouseEvents() {}, webContents: { send() {} } };
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.destroyed = false; this.visible = false; this.webContents = { send() {} }; }
    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(ignored) { this.ignored = ignored; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    loadFile(file, options) { this.query = options.query; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    static getAllWindows() { return [dock, ...windows.values()]; }
  }
  const context = vm.createContext({
    TITLE_TRACKER_ENABLED: false,
    COLLECTION_WIDGET_IDS: [],
    inventoryWidgets: new Map(),
    platformSupport: { platform: 'win32' },
    appStatus: 'waiting', registeredShortcut: null, dockWindow: null,
    settingsWindow: null, tutorialWindow: null, changelogWindow: null, widgetsWindow: null,
    groupFinderWindow: null, marketWindow: null, dailyBriefWindow: null, wikiWindow: null, mapWindow: null,
    calendarSettingsWindow: null, updateWindow: null, configureOverlayWorkspace, requestWidgetTutorial() {},
    widgetWindows: windows, BrowserWindow: Window, path, __dirname: path.join(__dirname, '../src'), overlayInteractive: false,
    layoutEditing: false, overlayHiddenByUser: false, gameHiddenActive: false, mainWindow: dock,
    dockAutoHidden: false, dungeonOverlayWindow: null,
    config: { get: (key, fallback) => settings[key] ?? fallback, set: (key, value) => { settings[key] = value; return true; },
      setMany: values => { Object.assign(settings, values); return true; }, getAll: () => settings },
    WidgetSizing, constrainBounds, restoreBounds, screen: { getDisplayMatching: () => display },
    restoredWindowBounds: (_key, defaults) => ({ x: 100, y: 100, ...defaults }),
    rememberWindowSize() {}, trackWindowBounds() {}, attachOverlayBlurHandler() {}, log() {}, raiseAlertWindows() {},
    getWindowBounds: win => ({ ...win.bounds }), setWindowBounds: (win, bounds) => { win.bounds = { ...bounds }; },
    dockDisplay: () => display, layoutDockedWidgets, setDockAutoHidden() {}, broadcastDockConfig() {}, lastDockHover: 0,
  });
  vm.runInContext(main.slice(main.indexOf('function applyOverlayMousePolicy()'), main.indexOf('function focusOverlay()')), context);
  vm.runInContext(main.slice(main.indexOf('const ALL_WIDGET_IDS ='), main.indexOf('// Every panel keeps')), context);
  vm.runInContext(main.slice(main.indexOf('function layoutDockedPanels()'), main.indexOf('function applyLayoutMode()')), context);
  vm.runInContext(main.slice(main.indexOf('function toggleDockWidget('), main.indexOf("ipcMain.handle('dock-toggle-widget'")), context);
  return { settings, windows, display, run: code => vm.runInContext(code, context) };
}

test('World Watch can be selected alone without enabling the three separate widgets', () => {
  const f = widgetsFixture();
  f.run('syncWidgetWindows()');
  assert.equal(f.windows.size, 0, 'Enabling an icon does not open its panel');
  assert.equal(f.run("toggleDockWidget('weather')"), false, 'Only enabled icons can open a panel');
  assert.equal(f.run("toggleDockWidget('world-watch')"), true);
  assert.deepEqual([...f.windows.keys()], ['world-watch']);
  const win = f.windows.get('world-watch');
  assert.equal(win.options.width, 350);
  assert.equal(win.options.height, 300);
  assert.equal(win.options.minWidth, 300);
  assert.equal(win.visible, true);
  assert.equal(win.ignored, false, 'Attached panels remain clickable');
  assert.deepEqual(JSON.parse(JSON.stringify(win.query)), { widget: 'world-watch' });
  assert.deepEqual(f.settings.widgetVisibility, { 'world-watch': true, clock: false, weather: false, calendar: false });

  f.settings.widgetVisibility.clock = true;
  f.run('syncWidgetWindows()');
  assert.deepEqual([...f.windows.keys()], ['world-watch'], 'An independently enabled icon starts closed');
  f.run("toggleDockWidget('clock')");
  assert.deepEqual([...f.windows.keys()], ['world-watch', 'clock'], 'The standalone clock remains independently selectable');
  f.settings.widgetVisibility['world-watch'] = false;
  f.run('syncWidgetWindows()');
  assert.deepEqual([...f.windows.keys()], ['clock']);
});

test('World Watch retains one mounted panel and its input while floating, hiding and redocking', () => {
  const f = widgetsFixture();
  f.run("toggleDockWidget('world-watch')");
  const win = f.windows.get('world-watch');
  const attached = { ...win.bounds };
  win.draft = 'Keep this panel input';
  f.settings.clickThrough = true;
  f.settings.widgetDocked = { 'world-watch': false };
  win.bounds = { x: -1200, y: 200, width: 350, height: 300 };
  const floating = { ...win.bounds };
  f.run('syncWidgetWindows()');
  assert.equal(win.ignored, true, 'Floating panels respect click-through');
  assert.deepEqual(win.bounds, floating, 'Shelf layout leaves a floating panel in place');
  f.run("toggleDockWidget('world-watch')");
  assert.equal(win.visible, false);
  assert.equal(f.windows.get('world-watch'), win, 'Hiding keeps the same panel mounted');
  assert.equal(f.settings.widgetVisibility['world-watch'], true, 'Hiding retains the icon');
  f.run("toggleDockWidget('world-watch')");
  assert.equal(win.visible, true);
  assert.deepEqual(win.bounds, floating);
  f.settings.widgetDocked['world-watch'] = true;
  f.run('syncWidgetWindows()');
  assert.equal(f.windows.size, 1);
  assert.equal(f.windows.get('world-watch'), win, 'Redocking preserves the panel renderer');
  assert.deepEqual(win.bounds, attached);
  assert.equal(win.ignored, true, 'Redocking preserves configured click-through');
  f.run('overlayInteractive = true; syncWidgetWindows()');
  assert.equal(win.ignored, false, 'Interaction mode enables a redocked panel');
  f.run('overlayInteractive = false; syncWidgetWindows()');
  assert.equal(win.ignored, true, 'Returning focus to the game restores redocked click-through');
  assert.equal(win.draft, 'Keep this panel input');
});

test('manual data refresh includes the calendar when only World Watch is enabled docked or floating', async () => {
  for (const docked of [true, false]) {
    const requested = [], refreshed = [];
    const settings = { widgetVisibility: { 'world-watch': true }, widgetDocked: { 'world-watch': docked }, language: 'fr' };
    const context = vm.createContext({
      normalizeLocale: require('../src/modules/gameLocales').normalizeLocale,
      services: {}, TITLE_TRACKER_ENABLED: false,
      COLLECTION_WIDGET_IDS: [],
      config: { get: (key, fallback) => settings[key] ?? fallback }, mapWindow: null,
      dataManager: {
        checkForUpdates: async () => ({ updated: false }),
        refreshCachedAssets: async keys => { requested.push(...keys); return { failed: [], updated: false }; },
        ensureAsset: async () => {}, readJSON: () => ({}), getInfo: () => ({}),
      },
      calendar: { refresh: async () => refreshed.push('calendar') }, setTimerDurations() {},
      ensureNamesForLanguage: async () => ({}), pushStateToRenderer() {}, broadcastMapTilesUpdated() {},
      log: (_tag, error) => { throw new Error(error); },
    });
    vm.runInContext('let dataRefreshPromise = null; let namesMap = {};', context);
    vm.runInContext(main.slice(main.indexOf('function refreshGameData('), main.indexOf('let manualDataRefreshPromise')), context);
    const result = await vm.runInContext('refreshGameData({force:true})', context);
    assert.equal(result.status, 'current');
    assert.ok(requested.includes('calendar/calendar.json'), `docked=${docked}`);
    assert.deepEqual(refreshed, ['calendar'], `docked=${docked}`);
    assert.deepEqual(settings.widgetVisibility, { 'world-watch': true });
  }
});

test('state updates reach every dock cell even if another frame closes during the broadcast', () => {
  const sent = [];
  const frame = name => ({ send: (channel, value) => sent.push({ name, channel, value }) });
  const window = name => ({ isDestroyed: () => false, webContents: frame(name) });
  const timerState = { timers: [{ tag: 'UPGRADEGIVEN_GODANDGHOST', expiryTime: 1_800_000_000 }] };
  const context = vm.createContext({
    timerState, calendar: { updateInventory() {} }, calendarAccountId: 'fixture', calendarInventoryCached: true,
    TITLE_TRACKER_ENABLED: false,
    updateInventoryWidgets() {}, dailyBrief: { update() {} },
    buildExporter: { update() {} }, marketWindow: null, config: { get: () => ({}) },
    appStatus: 'connected', overlayShortcutWarning: null, visibilityShortcutWarning: '', namesMap: {}, getTimerDurations: () => ({}),
    arenaStatus: null, arenaDetectionSource: 'none', arenaWave: null, ancestorMarkers: [], mainWindow: window('main'),
    widgetWindows: new Map([['world-watch', window('floating')]]),
    dockWindow: { isDestroyed: () => false, webContents: { mainFrame: { framesInSubtree: [
      frame('dock'), { send() { throw new Error('Frame detached'); } }, frame('world-watch'), frame('other-timers'),
    ] } } },
  });
  vm.runInContext(main.slice(main.indexOf('function pushStateToRenderer()'), main.indexOf('function broadcastArenaStatus()')), context);
  vm.runInContext('pushStateToRenderer()', context);
  assert.deepEqual(sent.map(item => item.name), ['main', 'floating', 'dock', 'world-watch', 'other-timers']);
  for (const item of sent) {
    assert.equal(item.channel, 'state-update');
    assert.equal(item.value.timers, timerState.timers, 'All layouts receive the same current account state');
  }
});
