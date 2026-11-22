/**
 * Persistent configuration store.
 * Stored in the native application data directory resolved by appPaths.
 */

const fs = require('fs');
const { APP_DIR, CONFIG_PATH } = require('./appPaths');
const { writeEncryptedJSON, readEncryptedJSON } = require('./fileEncryption');
const { normalizeTitleTrackerPreferences, normalizeTemperTrackerPreferences } = require('./trackerPreferences');
const { normalizeTutorialCompleted } = require('./tutorials');
const { migrateWidgetConfiguration } = require('./widgetMigration');
const Appearance = require('./appearance');
const { normalizeSavedLayouts } = require('./layouts');
const WidgetSizing = require('./widgetSizing');
const MoonsteelAlertSettings = require('./moonsteelAlertSettings');
const { normalizeDisplayId } = require('./overlayDisplays');
const OverlayShortcuts = require('./overlayShortcuts');

const isWindowCloseFocus = value => ['game', 'overlay', 'desktop'].includes(value);

class ConfigStore {
  constructor() {
    this._dir = APP_DIR;
    this._path = CONFIG_PATH;
    this.isFirstRun = !fs.existsSync(this._path);
    this._data = this._load();
  }

  /** Default config values – mirrors Rust Config::default() */
  static defaults(platform = process.platform) {
    return {
      compactMode: false,
      tutorialsEnabled: true,
      tutorialCompleted: {},
      temperTrackerPreferences: normalizeTemperTrackerPreferences(),
      titleTrackerPreferences: normalizeTitleTrackerPreferences(),
      hideBars: false,
      hideCountdown: false,
      calendarShowOfferings: true,
      livePlayerTracking: true,
      showWorldDrops: true,
      moonsteelAlert: MoonsteelAlertSettings.normalize(),
      playerMarkerColor: '#f4b642',
      playerMarkerOutlineColor: '#241708',
      dungeonMapAutoSwitch: true,
      dungeonMapProgressiveReveal: true,
      dungeonMapSeeThrough: false,
      dungeonMapBackgroundOpacity: 45,
      dungeonMapOutlineColor: '#d8d8d8',
      language: 'en',
      theme: 'classic',
      appearance: Appearance.normalize(),
      appearancePresets: [],
      accountId: null,
      savedTimers: [],
      backgroundOpacity: 100,
      widgetOutlineOpacity: 100,
      fontColor: 'default',
      barColor: 'green',
      enableAlertPopup: true,
      enableAlertSound: true,
      showAlertsWhenHidden: false,
      launchToTray: false,
      clickThrough: platform === 'win32',
      hideWhenGameClosed: platform === 'win32',
      automaticUpdates: false,
      dockDisplayId: null,
      marketRememberSession: true,
      eeLogPath: '',
      screenshotDir: '',
      showOnlyWhenGameFocused: false,
      windowCloseFocus: 'game',
      dockEdge: 'bottom',
      dockAutoHide: false,
      dockWidgetOrder: [],
      savedLayouts: [],
      startupLayoutId: null,
      widgetSizes: {},
      widgetResizeMode: 'grid',
      dailyAutoLogin: true,
      dailyAutoReset: true,
      dailyBriefVersion: 1,
      widgetVisibility: { daily: true },
      allowSingleKeyShortcuts: false,
      ...OverlayShortcuts.defaults,
      widgetDocked: {},
      widgetOpen: { daily: false },
      dockParadigmVersion: 1,
      windowBounds: null,
      lastSize: [480, 300],
    };
  }

  _load() {
    try {
      const data = readEncryptedJSON(this._path);
      // Migrate the saved profile before filling defaults, so a new paradigm
      // version does not mask the absence of that version in an older profile.
      if (data) return { ...ConfigStore.defaults(), ...ConfigStore.migrate(data) };
    } catch (e) {
      console.error('[Config] Failed to load:', e.message);
    }
    return { ...ConfigStore.defaults() };
  }

  static migrate(data) {
    data = migrateWidgetConfiguration(data);
    data.automaticUpdates = false;
    data.dockDisplayId = normalizeDisplayId(data.dockDisplayId);
    if (!isWindowCloseFocus(data.windowCloseFocus)) data.windowCloseFocus = 'game';
    data.tutorialsEnabled = data.tutorialsEnabled !== false;
    data.dungeonMapProgressiveReveal = data.dungeonMapProgressiveReveal !== false;
    data.tutorialCompleted = normalizeTutorialCompleted(data.tutorialCompleted);
    data.temperTrackerPreferences = normalizeTemperTrackerPreferences(data.temperTrackerPreferences);
    data.titleTrackerPreferences = normalizeTitleTrackerPreferences(data.titleTrackerPreferences);
    // Upgrade the former default once. The new outline field distinguishes this
    // older palette from a later deliberate choice of that same gold colour.
    if (!Object.hasOwn(data, 'playerMarkerOutlineColor') && typeof data.playerMarkerColor === 'string'
      && data.playerMarkerColor.toLowerCase() === '#f2d59b') data.playerMarkerColor = '#f4b642';
    for (const [key, fallback] of [['playerMarkerColor', '#f4b642'], ['playerMarkerOutlineColor', '#241708'], ['dungeonMapOutlineColor', '#d8d8d8']]) {
      data[key] = typeof data[key] === 'string' && /^#[0-9a-f]{6}$/i.test(data[key]) ? data[key].toLowerCase() : fallback;
    }
    // Dungeon maps now live inside the minimap. Keep an enabled map visible
    // after upgrading, while retaining any existing minimap position/settings.
    const retired = 'dungeon-map';
    for (const key of ['widgetVisibility', 'moduleVisibility']) {
      if (!data[key] || typeof data[key] !== 'object' || !Object.hasOwn(data[key], retired)) continue;
      data[key] = { ...data[key] };
      if (data[key][retired] === true) data[key].minimap = true;
      delete data[key][retired];
    }
    if (data.widgetCollapsed && Object.hasOwn(data.widgetCollapsed, retired)) {
      data.widgetCollapsed = { ...data.widgetCollapsed };
      if (!Object.hasOwn(data.widgetCollapsed, 'minimap')) data.widgetCollapsed.minimap = data.widgetCollapsed[retired];
      delete data.widgetCollapsed[retired];
    }
    for (const key of ['widgetDocked', 'widgetOpen']) {
      if (!data[key] || typeof data[key] !== 'object' || !Object.hasOwn(data[key], retired)) continue;
      data[key] = { ...data[key] };
      if (!Object.hasOwn(data[key], 'minimap')) data[key].minimap = data[key][retired];
      delete data[key][retired];
    }
    const bounds = 'widgetBounds_' + retired;
    if (data[bounds] && !data.widgetBounds_minimap) data.widgetBounds_minimap = data[bounds];
    delete data[bounds];
    if (Array.isArray(data.gridLayout?.columns) && data.gridLayout.columns.some(column => Array.isArray(column?.widgets) && column.widgets.includes(retired))) {
      const hasMinimap = data.gridLayout.columns.some(column => Array.isArray(column?.widgets) && column.widgets.includes('minimap'));
      let replaced = hasMinimap;
      data.gridLayout = { ...data.gridLayout, columns: data.gridLayout.columns.map(column => ({ ...column,
        widgets: (Array.isArray(column?.widgets) ? column.widgets : []).flatMap(id => {
          if (id !== retired) return [id];
          if (replaced) return [];
          replaced = true; return ['minimap'];
        }),
      })).filter((column, index) => column.widgets.length || !data.gridLayout.columns[index]?.widgets?.includes(retired)) };
    }
    // Enabled widgets become dock icons. Opening a panel is independent of
    // enabling its icon; legacy collapsed headers do not decide panel state.
    const isMap = value => value && typeof value === 'object' && !Array.isArray(value);
    const widgetIds = new Set([
      ...Object.keys(isMap(data.widgetVisibility) ? data.widgetVisibility : {}),
      ...Object.keys(isMap(data.moduleVisibility) ? data.moduleVisibility : {}),
      ...Object.keys(isMap(data.widgetDocked) ? data.widgetDocked : {}),
      ...Object.keys(isMap(data.widgetOpen) ? data.widgetOpen : {}),
    ]);
    const upgraded = data.dockParadigmVersion !== 1;
    const consolidatedChoices = map => Object.fromEntries(['player', 'daily']
      .filter(id => typeof map?.[id] === 'boolean').map(id => [id, map[id]]));
    const docked = upgraded || !isMap(data.widgetDocked) ? consolidatedChoices(data.widgetDocked) : { ...data.widgetDocked };
    const open = upgraded || !isMap(data.widgetOpen) ? consolidatedChoices(data.widgetOpen) : { ...data.widgetOpen };
    for (const id of widgetIds) {
      if (typeof docked[id] !== 'boolean') docked[id] = true;
      if (typeof open[id] !== 'boolean') open[id] = false;
    }
    data.widgetDocked = docked;
    data.widgetOpen = open;
    data.dockParadigmVersion = 1;
    if (!['top', 'bottom', 'left', 'right'].includes(data.dockEdge)) data.dockEdge = 'bottom';
    data.dockAutoHide = data.dockAutoHide === true;
    data.showWorldDrops = data.showWorldDrops !== false;
    data.moonsteelAlert = MoonsteelAlertSettings.normalize(data.moonsteelAlert);
    data.widgetOutlineOpacity = Number.isFinite(data.widgetOutlineOpacity)
      ? Math.max(0, Math.min(100, data.widgetOutlineOpacity)) : 100;
    // Sparse appearance overrides preserve the selected palette and legacy
    // opacity choices. Explicit zero radius, border and opacity values survive.
    data.appearance = Appearance.extract(data);
    data.appearancePresets = Appearance.normalizePresets(data.appearancePresets);
    data.savedLayouts = normalizeSavedLayouts(data.savedLayouts);
    data.startupLayoutId = typeof data.startupLayoutId === 'string'
      && data.savedLayouts.some(layout => layout.id === data.startupLayoutId) ? data.startupLayoutId : null;
    // Before explicit size preferences, card windows remembered width only;
    // map and data windows also kept a manually chosen height. Migrate once,
    // so an intentional empty map continues to mean automatic/default sizing.
    data.widgetSizes = Object.hasOwn(data, 'widgetSizes') ? WidgetSizing.normalizeSizes(data.widgetSizes)
      : WidgetSizing.sizesFromLegacyBounds(Object.fromEntries(WidgetSizing.WIDGET_IDS
        .map(id => [id, data['widgetBounds_' + id]])));
    data.widgetResizeMode = WidgetSizing.normalizeMode(data.widgetResizeMode);
    // Retain disabled widgets' positions in the saved order for re-enabling.
    data.dockWidgetOrder = [...new Set((Array.isArray(data.dockWidgetOrder) ? data.dockWidgetOrder : [])
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim() === retired ? 'minimap' : id.trim()))];
    Object.assign(data, OverlayShortcuts.normalizeShortcuts(data));
    return data;
  }

  _save() {
    try {
      fs.mkdirSync(this._dir, { recursive: true });
      const temp = `${this._path}.${process.pid}.tmp`;
      writeEncryptedJSON(temp, this._data);
      fs.renameSync(temp, this._path);
      return true;
    } catch (e) {
      console.error('[Config] Failed to save:', e.message);
      return false;
    }
  }

  get(key, fallback) {
    const val = this._data[key];
    return val !== undefined ? val : fallback;
  }

  set(key, value) {
    return this.setMany({ [key]: value });
  }

  setMany(values) {
    const previous = { ...this._data };
    let changed = false;
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(this._data[key]) === JSON.stringify(value)) continue;
      this._data[key] = value;
      changed = true;
    }
    if (changed && !this._save()) { this._data = previous; return false; }
    return true;
  }

  getAll() {
    return { ...this._data };
  }
}

module.exports = { ConfigStore, isWindowCloseFocus };
