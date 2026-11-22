/**
 * Preload script – exposes a safe bridge between renderer and main process.
 * Mirrors the shared state pattern from Rust's Arc<Mutex<...>>.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ─── Load i18n data synchronously from main process ───────
const i18nData = ipcRenderer.sendSync('get-i18n');
contextBridge.exposeInMainWorld('i18n', {
  translations: i18nData.translations,
  languages: i18nData.languages,
  localeTags: Object.fromEntries((i18nData.languages || []).map(({ code, locale }) => [code, locale || code])),
  titleTrackerEnabled: i18nData.titleTrackerEnabled === true,
});

contextBridge.exposeInMainWorld('api', {
  wikiAvailable: i18nData.wikiAvailable === true,
  buildWebsiteHost: i18nData.buildWebsiteHost || '',

  // State
  getState: () => ipcRenderer.invoke('get-state'),
  getDataSnapshot: kind => ipcRenderer.invoke('data-snapshot:get', kind),
  refreshDataSnapshot: kind => ipcRenderer.invoke('data-snapshot:refresh', kind),
  onStateUpdate: (callback) => {
    ipcRenderer.on('state-update', (_e, data) => callback(data));
  },

  // Config
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  widgetSizesGet: () => ipcRenderer.invoke('widget-sizing:get'),
  widgetSizesSet: values => ipcRenderer.invoke('widget-sizing:set', values),
  widgetSizesReset: values => ipcRenderer.invoke('widget-sizing:reset', values),
  widgetSizesResetAll: () => ipcRenderer.invoke('widget-sizing:reset-all'),
  widgetSizesMode: mode => ipcRenderer.invoke('widget-sizing:mode', mode),
  appearancePreview: appearance => ipcRenderer.invoke('appearance:preview', appearance),
  appearanceApply: values => ipcRenderer.invoke('appearance:apply', values),
  appearanceCancel: () => ipcRenderer.invoke('appearance:cancel'),
  appearanceImport: () => ipcRenderer.invoke('appearance:import'),
  appearanceExport: preset => ipcRenderer.invoke('appearance:export', preset),
  layoutsList: () => ipcRenderer.invoke('layouts:list'),
  layoutsSetStartup: id => ipcRenderer.invoke('layouts:startup', id),
  layoutsSave: values => ipcRenderer.invoke('layouts:save', values),
  layoutsApply: id => ipcRenderer.invoke('layouts:apply', id),
  layoutsRename: values => ipcRenderer.invoke('layouts:rename', values),
  layoutsDelete: id => ipcRenderer.invoke('layouts:delete', id),
  layoutsImport: () => ipcRenderer.invoke('layouts:import'),
  layoutsExport: id => ipcRenderer.invoke('layouts:export', id),
  onWidgetLayoutApplied: callback => {
    ipcRenderer.on('layout-widget-bounds', (_event, bounds) => callback(bounds));
  },
  toggleDockWidget: id => ipcRenderer.invoke('dock-toggle-widget', id),
  setDockKeyboardActive: active => ipcRenderer.send('dock-keyboard-active', !!active),
  setShortcutCapture: active => ipcRenderer.send('shortcut-capture', !!active),
  onShortcutMouseCaptured: callback => {
    const listener = (_event, binding) => callback(binding);
    ipcRenderer.on('shortcut-mouse-captured', listener);
    return () => ipcRenderer.removeListener('shortcut-mouse-captured', listener);
  },
  setLayoutEditing: active => ipcRenderer.send('layout-editing-request', !!active),
  onLayoutEditing: callback => {
    ipcRenderer.on('layout-editing', (_event, active) => callback(active));
  },
  onLayoutKeyMonitorStatus: callback => {
    ipcRenderer.on('layout-key-monitor-status', (_event, active) => callback(active));
  },
  onDockState: callback => {
    ipcRenderer.on('dock-state', (_event, state) => callback(state));
  },
  gamePathsGet: () => ipcRenderer.invoke('game-paths:get'),
  gamePathsChoose: kind => ipcRenderer.invoke('game-paths:choose', kind),
  gamePathsSave: values => ipcRenderer.invoke('game-paths:save', values),
  onConfigChanged: (callback) => {
    ipcRenderer.on('config-changed', (_e, data) => callback(data));
  },
  // Sent from main when it wants the renderer to re-measure and refit the
  // main window (e.g. after switching widget layout mode).
  onRefitMainWindow: (callback) => {
    ipcRenderer.on('refit-main-window', () => callback());
  },

  getBuildExportStatus: () => ipcRenderer.invoke('build-export:status'),
  exportCurrentBuild: () => ipcRenderer.invoke('build-export:current'),
  onBuildExportChanged: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('build-export-changed', listener);
    return () => ipcRenderer.removeListener('build-export-changed', listener);
  },

  getTemperTracker: () => ipcRenderer.invoke('temper-tracker:get'),
  getTitleTracker: () => ipcRenderer.invoke('title-tracker:get'),
  onTitleTrackerChanged: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('title-tracker-changed', listener);
    return () => ipcRenderer.removeListener('title-tracker-changed', listener);
  },
  onTemperTrackerChanged: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('temper-tracker-changed', listener);
    return () => ipcRenderer.removeListener('temper-tracker-changed', listener);
  },

  getDailyBrief: () => ipcRenderer.invoke('daily-brief:get'),
  refreshDailyBrief: () => ipcRenderer.invoke('daily-brief:refresh'),
  dismissDailyBrief: () => ipcRenderer.invoke('daily-brief:dismiss'),
  onDailyBriefChanged: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('daily-brief-changed', listener);
    return () => ipcRenderer.removeListener('daily-brief-changed', listener);
  },

  getInventoryWidget: id => ipcRenderer.invoke('inventory-widget:get', id),
  onGameArtworkAvailable: callback => {
    const listener = () => callback();
    ipcRenderer.on('game-artwork-available', listener);
    return () => ipcRenderer.removeListener('game-artwork-available', listener);
  },
  inventoryWidgetAction: (id, action) => ipcRenderer.invoke('inventory-widget:action', id, action),
  onInventoryWidgetChanged: (id, callback) => {
    const listener = (_event, widgetId, snapshot) => { if (widgetId === id) callback(snapshot); };
    ipcRenderer.on('inventory-widget-changed', listener);
    return () => ipcRenderer.removeListener('inventory-widget-changed', listener);
  },

  getWolfTraining: () => ipcRenderer.invoke('wolf-training:get'),
  onWolfTrainingChanged: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('wolf-training-changed', listener);
    return () => ipcRenderer.removeListener('wolf-training-changed', listener);
  },

  getDungeonState: () => ipcRenderer.invoke('dungeon:state'),
  getDungeonMap: () => ipcRenderer.invoke('dungeon:map'),
  onDungeonStateChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('dungeon-state-changed', listener);
    return () => ipcRenderer.removeListener('dungeon-state-changed', listener);
  },

  getWorldClock: () => ipcRenderer.invoke('clock:get'),
  onWorldClockChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on('world-clock-changed', listener);
    return () => ipcRenderer.removeListener('world-clock-changed', listener);
  },

  getWeatherForecast: () => ipcRenderer.invoke('weather:get'),
  onWeatherChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on('weather-changed', listener);
    return () => ipcRenderer.removeListener('weather-changed', listener);
  },

  // Calendar: only the selected day and unlock flags cross the bridge.
  getCalendarDay: date => ipcRenderer.invoke('calendar:get-day', date),
  getCalendarSettings: () => ipcRenderer.invoke('calendar:get-settings'),
  setCalendarAncestor: (name, unlocked) => ipcRenderer.invoke('calendar:set-ancestor', name, unlocked),
  resetCalendarAncestors: () => ipcRenderer.invoke('calendar:reset'),
  openCalendarSettings: () => ipcRenderer.send('calendar:open-settings'),
  onCalendarChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on('calendar-changed', listener);
    return () => ipcRenderer.removeListener('calendar-changed', listener);
  },

  onThemeChanged: callback => {
    const listener = (_event, config) => callback(config);
    ipcRenderer.on('theme-changed', listener);
    return () => ipcRenderer.removeListener('theme-changed', listener);
  },

  // Game data
  checkForDataUpdates: () => ipcRenderer.invoke('check-data-updates'),

  // App updates: the renderer chooses actions, never download URLs or paths.
  openUpdates: () => ipcRenderer.send('updates:open'),
  getUpdateState: () => ipcRenderer.invoke('updates:state'),
  checkAppUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadAppUpdate: () => ipcRenderer.invoke('updates:download'),
  installAppUpdate: () => ipcRenderer.invoke('updates:install'),
  getOverlayDisplays: () => ipcRenderer.invoke('overlay-displays:get'),
  onOverlayDisplaysChanged: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('overlay-displays-changed', listener);
    return () => ipcRenderer.removeListener('overlay-displays-changed', listener);
  },
  downloadInstaller: () => ipcRenderer.send('updates:installer'),
  onUpdateChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updates:changed', listener);
    return () => ipcRenderer.removeListener('updates:changed', listener);
  },

  // Changelog
  getChangelog: () => ipcRenderer.invoke('get-changelog'),

  // Window controls (borderless)
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowClose: () => ipcRenderer.send('window-close'),
  windowCollapse: (collapsed) => ipcRenderer.send('window-collapse', collapsed),
  windowMoveBy: (dx, dy, snap) => ipcRenderer.send('window-move-by', dx, dy, !!snap),
  windowDragStart: (threshold, snap) => ipcRenderer.send('window-drag-start', threshold, !!snap),
  windowDragEnd: (cancelled) => ipcRenderer.send('window-drag-end', !!cancelled),

  // Popout windows
  openSettings: section => ipcRenderer.send('open-settings', section === 'connections' ? section : undefined),
  onSettingsSection: callback => {
    const listener = (_event, section) => callback(section);
    ipcRenderer.on('settings:section', listener);
    return () => ipcRenderer.removeListener('settings:section', listener);
  },
  openChangelog: () => ipcRenderer.send('open-changelog'),
  openWidgets: () => ipcRenderer.send('open-widgets'),
  onWidgetConnectionsChanged: callback => {
    const listener = (_event, ids) => callback(ids);
    ipcRenderer.on('widget-connections-changed', listener);
    return () => ipcRenderer.removeListener('widget-connections-changed', listener);
  },
  openGroupFinder: () => ipcRenderer.send('open-group-finder'),
  openTutorial: (id = 'app') => ipcRenderer.invoke('tutorial:open', id),
  completeTutorial: id => ipcRenderer.invoke('tutorial:complete', id),
  setTutorialsEnabled: enabled => ipcRenderer.invoke('tutorial:set-enabled', enabled),

  // avakot.dev account sign-in uses the browser; account tokens stay in main.
  avakotAccountState: () => ipcRenderer.invoke('avakot-account:state'),
  avakotAccountLogin: () => ipcRenderer.invoke('avakot-account:login'),
  avakotAccountReconnect: () => ipcRenderer.invoke('avakot-account:reconnect'),
  marketConnectionRetry: () => ipcRenderer.invoke('market:connection-retry'),
  avakotAccountCancel: () => ipcRenderer.invoke('avakot-account:cancel'),
  avakotAccountLogout: () => ipcRenderer.invoke('avakot-account:logout'),
  avakotAccountOpen: () => ipcRenderer.invoke('avakot-account:open'),
  onAvakotAccountState: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('avakot-account:state', listener);
    return () => ipcRenderer.removeListener('avakot-account:state', listener);
  },

  // Market credentials and game inventory stay in the main process.
  openMarket: () => ipcRenderer.send('market:open'),
  marketGetState: () => ipcRenderer.invoke('market:state'),
  marketRefresh: () => ipcRenderer.invoke('market:refresh'),
  marketLogin: credentials => ipcRenderer.invoke('market:login', credentials),
  marketAvakotLogin: options => ipcRenderer.invoke('market:avakot-login', options),
  marketAvakotCancel: () => ipcRenderer.invoke('market:avakot-cancel'),
  marketLogout: () => ipcRenderer.invoke('market:logout'),
  marketBrowse: query => ipcRenderer.invoke('market:browse', query),
  marketCreateListing: draft => ipcRenderer.invoke('market:create', draft),
  marketUpdateListing: draft => ipcRenderer.invoke('market:update', draft),
  marketCloseListing: id => ipcRenderer.invoke('market:update', { id, status: 'CLOSED' }),
  marketCopyContact: id => ipcRenderer.invoke('market:copy-contact', id),
  openMarketWebsite: section => ipcRenderer.invoke('market:website', section),
  onMarketChanged: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('market:changed', listener);
    return () => ipcRenderer.removeListener('market:changed', listener);
  },

  // Tray
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),

  // Auto-fit window size
  fitWindowSize: (width, height) => ipcRenderer.send('fit-window-size', width, height),

  // Notify main process about widget collapse state
  widgetSetCollapsed: (widgetId, collapsed) => ipcRenderer.send('widget-set-collapsed', widgetId, collapsed),

  // Reset all widget positions to center of screen
  resetWidgetPositions: () => ipcRenderer.send('reset-widget-positions'),

  // Resize widget window to absolute target size
  windowResizeTo: (width, height, options) => ipcRenderer.send('window-resize-to', width, height, options),

  // Reset all widget sizes to defaults
  resetWidgetSizes: () => ipcRenderer.send('reset-widget-sizes'),

  // Listen for widget size reset notification
  onResetWidgetSizes: (callback) => {
    ipcRenderer.on('reset-widget-sizes', () => callback());
  },

  // ─── Group Finder IPC ────────────────────────────────────
  gfGetState: () => ipcRenderer.invoke('gf:get-state'),
  gfOnStateUpdate: (callback) => {
    ipcRenderer.on('gf:state-update', (_e, data) => callback(data));
  },
  gfGetProfile: () => ipcRenderer.invoke('gf:get-profile'),
  gfSavePreferences: (prefs) => ipcRenderer.invoke('gf:save-preferences', prefs),
  gfCreateListing: (data) => ipcRenderer.invoke('gf:create-listing', data),
  gfUpdateListing: (updates) => ipcRenderer.invoke('gf:update-listing', updates),
  gfCloseListing: () => ipcRenderer.invoke('gf:close-listing'),
  gfRequestJoin: (listingId) => ipcRenderer.invoke('gf:request-join', listingId),
  gfCancelRequest: (listingId) => ipcRenderer.invoke('gf:cancel-request', listingId),
  gfAcceptRequest: (listingId, playerId) => ipcRenderer.invoke('gf:accept-request', listingId, playerId),
  gfDeclineRequest: (listingId, playerId) => ipcRenderer.invoke('gf:decline-request', listingId, playerId),
  gfMarkInvited: (listingId, playerId) => ipcRenderer.invoke('gf:mark-invited', listingId, playerId),
  gfMarkJoined: (listingId, playerId) => ipcRenderer.invoke('gf:mark-joined', listingId, playerId),
  gfGetSuggestions: () => ipcRenderer.invoke('gf:get-suggestions'),

  // Wiki search
  openWikiSearch: (query) => ipcRenderer.send('open-wiki-search', query),

  // Timer alert floating windows
  showAlert: (data) => ipcRenderer.send('show-alert', data),
  // Used inside the alert-window.html renderer to receive its payload and
  // dismiss itself. The alert window uses the same preload (contextIsolation)
  // pattern as every other window in the app — do NOT switch it back to
  // nodeIntegration:true (require('electron') is unavailable in Electron 28+
  // unless sandbox:false is also set, and that breaks the inline script).
  onAlertData: (callback) => {
    ipcRenderer.on('alert-data', (_e, data) => callback(data));
  },
  dismissAlert: () => ipcRenderer.send('alert-dismiss'),
  previewMoonsteelAlert: settings => ipcRenderer.invoke('moonsteel-alert:preview', settings),

  // Map window (expanded mini-map)
  openMapWindow: () => ipcRenderer.send('open-map-window'),
  openDungeonOverlay: () => ipcRenderer.send('open-dungeon-overlay'),
  closeDungeonOverlay: () => ipcRenderer.send('close-dungeon-overlay'),
  exitDungeonOverlayInteraction: () => ipcRenderer.send('exit-dungeon-overlay-interaction'),
  getMapTiles: () => ipcRenderer.invoke('get-map-tiles'),
  getMapData: (name) => ipcRenderer.invoke('get-map-data', name),
  onMapLanguageUpdated: (callback) => {
    ipcRenderer.on('map-language-updated', (_e, locale) => callback(locale));
  },
  onMapTilesUpdated: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('map-tiles-updated', listener);
    return () => ipcRenderer.removeListener('map-tiles-updated', listener);
  },

  // Live character location with an explicit F6 capture fallback.
  locatePlayer: () => ipcRenderer.invoke('locate-player'),
  cancelLocatePlayer: () => ipcRenderer.send('cancel-locate-player'),
  getPlayerLocation: () => ipcRenderer.invoke('get-player-location'),
  onPlayerLocation: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on('player-location', listener);
    return () => ipcRenderer.removeListener('player-location', listener);
  },
  getPlayerTracking: () => ipcRenderer.invoke('get-player-tracking'),
  copyPlayerTrackingReport: () => ipcRenderer.invoke('copy-player-tracking-report'),
  onPlayerTrackingChanged: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on('player-tracking-changed', listener);
    return () => ipcRenderer.removeListener('player-tracking-changed', listener);
  },
  getDungeonDiscovery: data => ipcRenderer.invoke('dungeon-discovery:get', data),
  saveDungeonDiscovery: data => ipcRenderer.invoke('dungeon-discovery:save', data),
  addDungeonAlignmentPoint: data => ipcRenderer.invoke('dungeon-discovery:align', data),
  resetDungeonAlignment: data => ipcRenderer.invoke('dungeon-discovery:reset', data),
  onDungeonDiscoveryChanged: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on('dungeon-discovery-changed', listener);
    return () => ipcRenderer.removeListener('dungeon-discovery-changed', listener);
  },

  // Live Gods & Ghosts ancestor markers from EE.log
  getAncestors: () => ipcRenderer.invoke('get-ancestors'),
  onAncestors: (callback) => {
    ipcRenderer.on('ancestor-markers', (_e, data) => callback(data));
  },

  // Location name resolution
  resolveLocationNames: (locTags) => ipcRenderer.invoke('resolve-location-names', locTags),

  // Click-through overlay interaction (global shortcut toggle)
  onOverlayInteraction: (callback) => {
    ipcRenderer.on('overlay-interaction-changed', (_e, interactive) => callback(interactive));
  },
  exitInteractiveMode: () => ipcRenderer.send('exit-interactive-mode'),

  // Arena status and detection-source updates
  onArenaStatus: (callback) => {
    ipcRenderer.on('arena-status', (_e, status, source) => callback(status, source));
  },
  // Arena wave counter updates ({wave, tier, total} | null)
  onArenaWave: (callback) => {
    ipcRenderer.on('arena-wave', (_e, wave) => callback(wave));
  },

  // Dock window (grid layout mode)
  dockResizeRequest: (width, height) => ipcRenderer.send('dock-resize-request', width, height),
  getDockMaxHeight: () => ipcRenderer.invoke('dock-get-max-height'),
  onDockMaxHeight: (callback) => {
    ipcRenderer.on('dock-max-height', (_e, h) => callback(h));
  },
});
