const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const encryption = require('../src/modules/fileEncryption');
const preferences = require('../src/modules/trackerPreferences');
const tutorials = require('../src/modules/tutorials');
const widgetMigration = require('../src/modules/widgetMigration');
const appearance = require('../src/modules/appearance');
const layouts = require('../src/modules/layouts');
const widgetSizing = require('../src/modules/widgetSizing');
const moonsteelAlertSettings = require('../src/modules/moonsteelAlertSettings');
const overlayDisplays = require('../src/modules/overlayDisplays');

function configClass() {
  const commonjs = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/modules/config.js'), 'utf8'), {
    module: commonjs, process, console,
    require: name => name === './appPaths' ? {} : name === './overlayDisplays' ? overlayDisplays : name === './moonsteelAlertSettings' ? moonsteelAlertSettings : name === './widgetSizing' ? widgetSizing : name === './layouts' ? layouts : name === './appearance' ? appearance : name === './fileEncryption' ? encryption : name === './trackerPreferences' ? preferences : name === './tutorials' ? tutorials : name === './widgetMigration' ? widgetMigration : require(name),
  });
  return commonjs.exports.ConfigStore;
}

function migration(data) {
  return JSON.parse(JSON.stringify(configClass().migrate(JSON.parse(JSON.stringify(data)))));
}

test('all tutorials default on and preserve an explicit off preference without discarding completion', () => {
  assert.equal(migration({}).tutorialsEnabled, true);
  for (const invalid of [null, 'false', 0, {}, []]) assert.equal(migration({ tutorialsEnabled: invalid }).tutorialsEnabled, true);
  const completed = { app: true, clock: true };
  const disabled = migration({ tutorialsEnabled: false, tutorialCompleted: completed });
  assert.equal(disabled.tutorialsEnabled, false);
  assert.deepEqual(disabled.tutorialCompleted, completed);
  assert.deepEqual(migration(disabled), disabled);
});

test('app updates are always manual and a valid preferred monitor survives reload', () => {
  for (const automaticUpdates of [undefined, true, false, 'true']) assert.equal(migration({ automaticUpdates }).automaticUpdates, false);
  assert.equal(migration({ dockDisplayId: 1234 }).dockDisplayId, 1234);
  for (const dockDisplayId of [null, undefined, '1234', -1, {}, Infinity]) assert.equal(migration({ dockDisplayId }).dockDisplayId, null);
});

test('nearby weapon markers default on and preserve an explicit opt-out across reloads', () => {
  assert.equal(migration({}).showWorldDrops, true);
  const disabled = migration({ showWorldDrops: false });
  assert.equal(disabled.showWorldDrops, false);
  assert.equal(migration(disabled).showWorldDrops, false);
});

test('window close focus defaults to the game and retains valid saved choices on reload', () => {
  assert.equal(configClass().defaults().windowCloseFocus, 'game');
  assert.equal(migration({}).windowCloseFocus, 'game');
  for (const value of ['desktop', 'overlay', 'game']) assert.equal(migration({ windowCloseFocus: value }).windowCloseFocus, value);
  for (const invalid of ['previous', null, false, {}]) assert.equal(migration({ windowCloseFocus: invalid }).windowCloseFocus, 'game');
});

test('progressive dungeon reveal defaults on and preserves only an explicit opt-out across reloads', () => {
  const ConfigStore = configClass();
  for (const platform of ['win32', 'linux', 'darwin']) assert.equal(ConfigStore.defaults(platform).dungeonMapProgressiveReveal, true);
  assert.equal(migration({}).dungeonMapProgressiveReveal, true);
  for (const invalid of [null, 'false', 0, {}, []]) {
    assert.equal(migration({ dungeonMapProgressiveReveal: invalid }).dungeonMapProgressiveReveal, true);
  }
  const disabled = migration({ dungeonMapProgressiveReveal: false });
  assert.equal(disabled.dungeonMapProgressiveReveal, false);
  assert.equal(migration(disabled).dungeonMapProgressiveReveal, false);
});

test('Moonsteel alerts migrate per field and retain their own saved controls', () => {
  assert.deepEqual(migration({}).moonsteelAlert, moonsteelAlertSettings.DEFAULTS);
  const preferences = { enabled: false, color: '#E098FB', volume: 0, opacity: 0, monitor: 'all', blur: 72 };
  const saved = migration({ moonsteelAlert: preferences });
  assert.deepEqual(saved.moonsteelAlert, { ...moonsteelAlertSettings.DEFAULTS, ...preferences, color: '#e098fb' });
  assert.deepEqual(migration(saved), saved);
  const repaired = migration({ moonsteelAlert: { enabled: false, volume: 5, color: 'invalid' } });
  assert.equal(repaired.moonsteelAlert.enabled, false);
  assert.equal(repaired.moonsteelAlert.volume, .5);
  assert.equal(repaired.moonsteelAlert.color, '#da75ff');
});

test('legacy widths migrate once while card heights stay automatic and map/data heights remain fixed', () => {
  const before = { dockParadigmVersion: 1, widgetBounds_clock: { x: 10, y: 20, width: 437, height: 91 },
    widgetBounds_resources: { x: 20, y: 30, width: 513, height: 621 },
    widgetBounds_minimap: { x: 30, y: 40, width: 477, height: 399 },
    'widgetBounds_data-inventory': { x: 40, y: 50, width: 661, height: 577 },
    widgetBounds_daily: { x: 100, y: 200, width: 700, height: 500 } };
  const data = migration(before);
  assert.deepEqual(data.widgetSizes, { clock: { width: 437, height: null }, resources: { width: 513, height: null },
    minimap: { width: 477, height: 399 }, 'data-inventory': { width: 661, height: 577 } });
  assert.equal(data.widgetResizeMode, 'grid');
  assert.deepEqual(data.widgetBounds_clock, before.widgetBounds_clock);
  assert.deepEqual(migration(data), data);
});

test('explicit automatic sizing survives reload and corrupt closed widget preferences recover per axis', () => {
  const bounds = { x: 10, y: 20, width: 437, height: 91 };
  const automatic = migration({ widgetBounds_clock: bounds, widgetSizes: {}, widgetResizeMode: 'free' });
  assert.deepEqual(automatic.widgetSizes, {});
  assert.equal(automatic.widgetResizeMode, 'free');
  assert.deepEqual(migration(automatic).widgetSizes, {});
  const partial = migration({ widgetSizes: { clock: { width: null, height: 119 }, resources: { width: 499, height: null },
    minimap: { width: -1, height: 367 }, daily: { width: 700, height: 500 }, unknown: { width: 400 } }, widgetResizeMode: 'corrupt' });
  assert.deepEqual(partial.widgetSizes, { clock: { width: null, height: 119 }, resources: { width: 499, height: null }, minimap: { width: null, height: 367 } });
  assert.equal(partial.widgetResizeMode, 'grid');
  assert.deepEqual(migration(partial), partial);
});

test('saved layout migration recovers corrupt library entries without replacing the current arrangement', () => {
  const data = migration({ dockParadigmVersion: 1, dockEdge: 'right', widgetVisibility: { boss: true },
    savedLayouts: [null, { id: 'one', name: '  Explore  ', layout: { dockEdge: 'left', widgetVisibility: { minimap: true } } },
      { id: 'one', name: 'Duplicate', layout: {} }, { id: 'broken', name: '', layout: {} }] });
  assert.equal(data.dockEdge, 'right');
  assert.equal(data.widgetVisibility.boss, true);
  assert.deepEqual(data.savedLayouts.map(item => [item.id, item.name]), [['one', 'Explore']]);
  assert.equal(data.savedLayouts[0].layout.dockEdge, 'left');
  assert.equal(data.savedLayouts[0].layout.widgetVisibility.minimap, true);
  assert.deepEqual(migration(data), data);
  assert.deepEqual(migration({ savedLayouts: { corrupted: true } }).savedLayouts, []);
});

test('startup layout migration retains a known saved choice and falls back to the last arrangement for stale choices', () => {
  const base = { dockEdge: 'bottom', widgetVisibility: { minimap: true },
    savedLayouts: [{ id: 'explore', name: 'Explore', layout: { dockEdge: 'left' } }] };
  assert.equal(migration({ ...base, startupLayoutId: 'explore' }).startupLayoutId, 'explore');
  for (const startupLayoutId of [undefined, null, '', 'removed', 42, {}]) {
    const data = migration({ ...base, startupLayoutId });
    assert.equal(data.startupLayoutId, null);
    assert.equal(data.dockEdge, 'bottom', 'migration never applies a layout or loses the current arrangement');
    assert.equal(data.widgetVisibility.minimap, true);
  }
});

test('appearance migration preserves legacy choices, explicit sharp geometry and named presets', () => {
  const legacy = migration({ theme: 'midnight', backgroundOpacity: 0, fontOpacity: 42, barOpacity: 86, widgetOutlineOpacity: -15 });
  assert.equal(legacy.appearance.base, 'midnight');
  assert.deepEqual(legacy.appearance.global, { backgroundOpacity: 0, textOpacity: 42, barOpacity: 86, widgetOutlineOpacity: 0 });
  assert.deepEqual(legacy.appearancePresets, []);
  const saved = migration({ appearance: { version: 1, base: 'dark-mint', global: { cornerShape: 'sharp', cornerRadius: 0, borderWidth: 0 },
    widgets: { boss: { cornerShape: 'pill', borderOpacity: 0 } } },
    appearancePresets: [{ id: 'own-style', name: 'My style', appearance: appearance.builtins.obsidian.appearance }], language: 'de' });
  assert.equal(saved.appearance.global.cornerRadius, 0);
  assert.equal(saved.appearance.global.borderWidth, 0);
  assert.equal(saved.appearance.widgets.boss.borderOpacity, 0);
  assert.equal(saved.appearancePresets[0].appearance.global.cornerRadius, 0);
  assert.equal(saved.language, 'de');
  assert.deepEqual(migration(saved), saved);
});

test('config batches edits, skips identical values, and preserves the last file when a write fails', t => {
  const root = path.resolve(__dirname, '..', '.build', 'config-tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'profile-'));
  const configPath = path.join(dir, 'config.json');
  t.after(() => {
    assert.equal(path.dirname(dir), root);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let writes = 0;
  let fail = false;
  const commonjs = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/modules/config.js'), 'utf8'), {
    module: commonjs, process, console: { error() {} },
    require(name) {
      if (name === './appPaths') return { APP_DIR: dir, CONFIG_PATH: configPath };
      if (name === './trackerPreferences') return preferences;
      if (name === './tutorials') return tutorials;
      if (name === './widgetMigration') return widgetMigration;
      if (name === './appearance') return appearance;
      if (name === './layouts') return layouts;
      if (name === './widgetSizing') return widgetSizing;
      if (name === './moonsteelAlertSettings') return moonsteelAlertSettings;
      if (name === './overlayDisplays') return overlayDisplays;
      if (name === './fileEncryption') return { ...encryption, writeEncryptedJSON(file, value) {
        writes++;
        encryption.writeEncryptedJSON(file, value);
        if (fail) throw new Error('Simulated interrupted write');
      } };
      return require(name);
    },
  });
  const { ConfigStore } = commonjs.exports;
  const config = new ConfigStore();
  assert.deepEqual(JSON.parse(JSON.stringify(config.get('savedLayouts'))), []);
  assert.equal(config.get('showAlertsWhenHidden'), false);
  assert.equal(config.setMany({ language: 'fr', showAlertsWhenHidden: true, windowBounds: { x: -300, y: 20, width: 300, height: 80 } }), true);
  assert.equal(writes, 1);
  config.setMany({ language: 'fr', windowBounds: { x: -300, y: 20, width: 300, height: 80 } });
  assert.equal(writes, 1);
  assert.equal(new ConfigStore().get('language'), 'fr');
  assert.equal(new ConfigStore().get('showAlertsWhenHidden'), true);
  const savedLayouts = layouts.normalizeSavedLayouts([{ id: 'night', name: 'Night', layout: { dockEdge: 'left',
    widgetVisibility: { minimap: true }, widgetOpen: { minimap: true }, widgetDocked: { minimap: false },
    widgetBounds: { minimap: { x: -1500, y: 80, width: 420, height: 360 } } } }]);
  assert.equal(config.set('savedLayouts', savedLayouts), true);
  assert.deepEqual(JSON.parse(JSON.stringify(new ConfigStore().get('savedLayouts'))), savedLayouts);
  fail = true;
  assert.equal(config.set('language', 'de'), false);
  assert.equal(writes, 3);
  assert.equal(config.get('language'), 'fr', 'Failed persistence rolls back the in-memory transaction too');
  assert.equal(new ConfigStore().get('language'), 'fr');
});

test('retired dungeon widget upgrades to a single minimap without changing existing minimap bounds', () => {
  const data = migration({ widgetVisibility: { boss: true, minimap: false, 'dungeon-map': true },
    widgetCollapsed: { minimap: false, 'dungeon-map': true },
    widgetBounds_minimap: { x: 20, width: 350 }, 'widgetBounds_dungeon-map': { x: 40, width: 420 },
    gridLayout: { columns: [{ widgets: ['boss', 'dungeon-map'] }, { widgets: ['minimap', 'dungeon-map'] }] } });
  assert.deepEqual(data.widgetVisibility, { boss: true, minimap: true, daily: true });
  assert.deepEqual(data.widgetCollapsed, { minimap: false });
  assert.deepEqual(data.widgetBounds_minimap, { x: 20, width: 350 });
  assert.equal(Object.hasOwn(data, 'widgetBounds_dungeon-map'), false);
  assert.deepEqual(data.gridLayout.columns, [{ widgets: ['boss'] }, { widgets: ['minimap'] }]);
  assert.deepEqual(migration(data), data, 'Repeating the upgrade is harmless');
});

test('a dungeon-only profile retains the map position and dock order when upgraded', () => {
  const data = migration({ widgetVisibility: { 'dungeon-map': true }, widgetCollapsed: { 'dungeon-map': true },
    'widgetBounds_dungeon-map': { x: 40, width: 420 },
    gridLayout: { columns: [{ widgets: ['boss', 'dungeon-map', 'clock'] }] } });
  assert.deepEqual(data.widgetVisibility, { minimap: true, daily: true });
  assert.deepEqual(data.widgetCollapsed, { minimap: true });
  assert.deepEqual(data.widgetBounds_minimap, { x: 40, width: 420 });
  assert.deepEqual(data.gridLayout.columns, [{ widgets: ['boss', 'minimap', 'clock'] }]);
  assert.deepEqual(migration({ widgetVisibility: { 'dungeon-map': false, minimap: false } }).widgetVisibility, { minimap: false, daily: true });
});

test('map migration preserves unrelated empty dock columns and column settings', () => {
  const unrelated = { gridLayout: { columns: [{ widgets: [], width: 200 }, { widgets: ['boss'] }] } };
  assert.deepEqual(migration(unrelated).gridLayout, unrelated.gridLayout);
  assert.deepEqual(migration({ gridLayout: { columns: [{ widgets: [], width: 200 }, { widgets: ['dungeon-map'] }] } }).gridLayout.columns,
    [{ widgets: [], width: 200 }, { widgets: ['minimap'] }]);
});

test('edge dock migration retains enabled widgets and separates icons from opening panels', () => {
  const saved = { layoutMode: 'grid', widgetVisibility: { boss: true, minimap: true, clock: false },
    widgetCollapsed: { boss: false, minimap: true }, widgetBounds_boss: { x: 45, y: 60, width: 320, height: 200 } };
  const data = migration(saved);
  assert.deepEqual(data.widgetVisibility, { ...saved.widgetVisibility, daily: true });
  assert.deepEqual(data.widgetBounds_boss, saved.widgetBounds_boss);
  assert.deepEqual(data.widgetDocked, { boss: true, minimap: true, clock: true, daily: true });
  assert.deepEqual(data.widgetOpen, { boss: false, minimap: false, clock: false, daily: false });
  assert.equal(data.dockEdge, 'bottom');
  assert.equal(data.dockAutoHide, false);
  assert.equal(data.overlayVisibilityHotkey, 'Shift+F2');
  assert.equal(data.dockParadigmVersion, 1);
  assert.deepEqual(migration(data), data, 'Opening again preserves the migrated profile');
});

test('existing edge dock choices survive reload and malformed docking settings recover safely', () => {
  const data = migration({ dockParadigmVersion: 1, dockEdge: 'left', dockAutoHide: true,
    overlayVisibilityHotkey: 'Ctrl+Alt+O', widgetVisibility: { boss: true, minimap: true },
    widgetDocked: { boss: false }, widgetOpen: { boss: true, minimap: true }, widgetCollapsed: { boss: true } });
  assert.equal(data.dockEdge, 'left');
  assert.equal(data.dockAutoHide, true);
  assert.equal(data.overlayVisibilityHotkey, 'Ctrl+Alt+O');
  assert.deepEqual(data.widgetDocked, { boss: false, minimap: true, daily: true });
  assert.deepEqual(data.widgetOpen, { boss: true, minimap: true, daily: false });
  const recovered = migration({ dockParadigmVersion: 1, dockEdge: 'diagonal', dockAutoHide: 'yes',
    overlayVisibilityHotkey: '', widgetDocked: [], widgetOpen: null, widgetVisibility: { boss: true } });
  assert.equal(recovered.dockEdge, 'bottom');
  assert.equal(recovered.dockAutoHide, false);
  assert.equal(recovered.overlayVisibilityHotkey, 'Shift+F2');
  assert.deepEqual(recovered.widgetDocked, { boss: true, daily: true });
  assert.deepEqual(recovered.widgetOpen, { boss: false, daily: false });
});

test('widget outline opacity defaults, preserves invisible outlines and clamps malformed saved values', () => {
  assert.equal(migration({}).widgetOutlineOpacity, 100);
  assert.equal(migration({ widgetOutlineOpacity: 0 }).widgetOutlineOpacity, 0);
  assert.equal(migration({ widgetOutlineOpacity: 42 }).widgetOutlineOpacity, 42);
  assert.equal(migration({ widgetOutlineOpacity: -15 }).widgetOutlineOpacity, 0);
  assert.equal(migration({ widgetOutlineOpacity: 150 }).widgetOutlineOpacity, 100);
  assert.equal(migration({ widgetOutlineOpacity: 'invisible' }).widgetOutlineOpacity, 100);
});

test('map colours preserve six-digit selections and recover malformed saved values independently', () => {
  const defaults = migration({});
  assert.equal(defaults.playerMarkerColor, '#f4b642');
  assert.equal(defaults.playerMarkerOutlineColor, '#241708');
  assert.equal(defaults.dungeonMapOutlineColor, '#d8d8d8');
  const chosen = migration({ playerMarkerColor: '#AD12FE', playerMarkerOutlineColor: '#3A271B', dungeonMapOutlineColor: '#112233' });
  assert.equal(chosen.playerMarkerColor, '#ad12fe');
  assert.equal(chosen.playerMarkerOutlineColor, '#3a271b');
  assert.equal(chosen.dungeonMapOutlineColor, '#112233');
  assert.deepEqual(migration(chosen), chosen);
  for (const invalid of [null, false, {}, [], 123, '', 'cyan', '#fff', '#ffffff00', '#12345g', ' #112233', '#112233;']) {
    const restored = migration({ playerMarkerColor: invalid, dungeonMapOutlineColor: '#123456' });
    assert.equal(restored.playerMarkerColor, '#f4b642');
    assert.equal(restored.dungeonMapOutlineColor, '#123456');
    assert.equal(migration({ dungeonMapOutlineColor: invalid }).dungeonMapOutlineColor, '#d8d8d8');
    assert.equal(migration({ playerMarkerOutlineColor: invalid }).playerMarkerOutlineColor, '#241708');
  }
});

test('the former default palette upgrades once while deliberate fill and outline selections survive', () => {
  const upgraded = migration({ playerMarkerColor: '#F2D59B' });
  assert.equal(upgraded.playerMarkerColor, '#f4b642');
  assert.equal(upgraded.playerMarkerOutlineColor, '#241708');
  assert.deepEqual(migration(upgraded), upgraded);
  assert.equal(migration({ playerMarkerColor: '#cc7733' }).playerMarkerColor, '#cc7733');
  const chosen = migration({ playerMarkerColor: '#f2d59b', playerMarkerOutlineColor: '#241708' });
  assert.equal(chosen.playerMarkerColor, '#f2d59b');
  assert.deepEqual(migration(chosen), chosen);
});

test('dock icon order retains disabled widget positions and normalizes duplicate or retired IDs', () => {
  assert.deepEqual(migration({}).dockWidgetOrder, []);
  const data = migration({ widgetVisibility: { boss: false, wiki: true },
    dockWidgetOrder: ['wiki', ' boss ', 'wiki', '', null, 4, 'dungeon-map', 'minimap', 'market'] });
  assert.deepEqual(data.dockWidgetOrder, ['wiki', 'boss', 'minimap', 'market']);
  assert.deepEqual(data.widgetVisibility, { boss: false, wiki: true, daily: true });
  assert.deepEqual(migration(data).dockWidgetOrder, data.dockWidgetOrder);
  assert.deepEqual(migration({ dockWidgetOrder: { boss: 1 } }).dockWidgetOrder, []);
});

test('tracker preferences migrate with pins, visibility and each temper grouping intact', () => {
  const input = { titleTrackerPreferences: { showCompleted: false, showIncomplete: true, pinnedOnly: true,
    pinned: ['FlavourItems.CogahTitle', 'FlavourItems.AbilitySoulStealTitle'], search: 'soul' },
  temperTrackerPreferences: { view: 'weapons', filter: 'missing', groupings: { blacksmith: 'name', weapons: 'weapon' },
    hiddenStatuses: ['unlocked'], collapsed: ['weapon:Vetch'], search: 'Swift' } };
  const result = migration(input);
  assert.deepEqual(result.titleTrackerPreferences, input.titleTrackerPreferences);
  assert.deepEqual(result.temperTrackerPreferences, input.temperTrackerPreferences);
  assert.deepEqual(migration(result).titleTrackerPreferences, input.titleTrackerPreferences);
  const invalid = migration({ titleTrackerPreferences: [], temperTrackerPreferences: { view: 'invalid', filter: null } });
  assert.deepEqual(invalid.titleTrackerPreferences, preferences.normalizeTitleTrackerPreferences());
  assert.deepEqual(invalid.temperTrackerPreferences, preferences.normalizeTemperTrackerPreferences());
});
