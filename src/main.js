/**
 * Overkot – Electron Main Process
 * 
 * Equivalent of Rust main.rs: creates the overlay window, spawns background
 * threads for game detection, memory scanning, log watching, and API polling.
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, globalShortcut, session, protocol } = require('electron');
const path = require('path');
const { services } = require('./modules/serviceConfig');
const { IS_BETA, TITLE_TRACKER_ENABLED } = require('./modules/buildChannel');
const { normalizeTitleTrackerPreferences, normalizeTemperTrackerPreferences } = require('./modules/trackerPreferences');
const { getPlatformSupport } = require('./modules/platformSupport');
const { configureLinuxDisplay } = require('./modules/linuxDisplay');
const { configureOverlayWorkspace, configureOverlayPopout, refreshOverlayStack } = require('./modules/overlayWindowPolicy');
const { createFocusReminder } = require('./modules/focusReminder');
const { TUTORIAL_IDS, isTutorialComplete, completeTutorial } = require('./modules/tutorials');
const platformSupport = { ...getPlatformSupport(), ...configureLinuxDisplay({ commandLine: app.commandLine }) };
const { createWikiBrowser, loadWikiSearch } = require('./modules/wikiWindow');
const { createGamePathResolver, setGamePathResolver } = require('./modules/gamePaths');
const { registerGamePathsIpc, settingsWindowBounds } = require('./modules/settingsIpc');
const { registerLayoutIpc } = require('./modules/layoutIpc');
const { createLayoutRuntime } = require('./modules/layoutRuntime');
const WidgetSizing = require('./modules/widgetSizing');
const { registerWidgetSizingIpc } = require('./modules/widgetSizingIpc');
const { createDailyBriefWindow } = require('./modules/dailyBriefWindow');
const Appearance = require('./modules/appearance');
const { createAppearanceSession, registerAppearanceIpc } = require('./modules/appearanceIpc');

// ─── Renderer content restrictions ───
const { initGuard } = require('./modules/guard');
initGuard();

const { ProcessDetector } = require('./modules/processDetector');
const { LogWatcher } = require('./modules/logWatcher');
const { ArenaWatcher } = require('./modules/arenaWatcher');
const { ArenaPresence } = require('./modules/arenaPresence');
const { AncestorWatcher } = require('./modules/ancestorWatcher');
const { MemoryScanner, scannerAvailableSync } = require('./modules/memoryScanner');
const { PlayerTracking } = require('./modules/playerTracking');
const MoonsteelAlertSettings = require('./modules/moonsteelAlertSettings');
const { createMoonsteelAlerts } = require('./modules/moonsteelAlerts');
const { createMoonsteelAlertWindow } = require('./modules/moonsteelAlertWindow');
const { normalizeDisplayId, displayOptions } = require('./modules/overlayDisplays');
const { InventoryPoller, loadCachedTimers } = require('./modules/inventoryPoller');
const { DataSnapshots } = require('./modules/dataSnapshots');
const { collectInventoryNames } = require('./renderer/inventory-format');
const { ApiClient } = require('./modules/apiClient');
const { Updater, CURRENT_VERSION } = require('./modules/updater');
const { mergeChangelog } = require('./modules/releaseNotes');
const { ConfigStore, isWindowCloseFocus } = require('./modules/config');
const { focusDesktop } = require('./modules/desktopFocus');
const { offerStartupLayout, restoreStartupSavedLayout } = require('./modules/startupLayout');
const { CalendarService } = require('./modules/calendar');
const { CalendarFeed } = require('./modules/calendarFeed');
const { WorldClock } = require('./modules/worldClock');
const { WeatherForecast } = require('./modules/weatherForecast');
const { MarketService, MarketTokenStore } = require('./modules/marketService');
const { readMarketApiKey } = require('./modules/marketConfig');
const { registerMarketIpc, marketWindowBounds } = require('./modules/marketIpc');
const { MARKET_SCHEME, MARKET_ORIGIN, createMarketProtocolHandler, registerMarketFrontendIpc, configureMarketNavigation,
  marketFrontendState, accountConnectionState } = require('./modules/marketFrontend');
const { AvakotAccountService, AvakotTokenStore } = require('./modules/avakotAccount');
const { MarketAccountConnection } = require('./modules/marketAccountConnection');
const { registerAvakotAccountIpc, publicAvakotAccountState } = require('./modules/avakotAccountIpc');
const { BuildExporter, setBuildExportCatalog } = require('./modules/buildExporter');
const { TemperTracker, setTemperCatalog, getTemperCatalog } = require('./modules/temperTracker');
const { TitleTracker, setTitleCatalog } = require('./modules/titleTracker');
const { EpithetsData, getBundledTitleCatalog } = require('./modules/epithetsData');
const { WolfTraining, setWolfTrainingCatalog } = require('./modules/wolfTraining');
const { InventoryWidgetService } = require('./modules/inventoryWidgetService');
const { getCollectionCatalog } = require('./modules/collectionCatalog');
const { createCollectionTrackerModel } = require('./modules/collectionTracker');
const { createMasteryTrackerModel, discoveryProgress } = require('./modules/masteryTracker');
const { createMasterySessionsModel, createMasteryHistoryStore } = require('./modules/masterySessions');
const { createResourcesModel, createEnhancementsModel, createCraftingPlannerModel, createActivityModel, createCraftingLogModel } = require('./modules/collectionExtras');
const { DailyBrief } = require('./modules/dailyBrief');
const { DailyVendors } = require('./modules/dailyVendors');
const { createSessionGainsModel } = require('./modules/sessionGains');
const { createEquipmentProgressModel } = require('./modules/equipmentProgress');
const { createActiveBoonsModel } = require('./modules/activeBoons');
const { createAccountWalletModel } = require('./modules/accountWallet');
const { createStorageCapacityModel } = require('./modules/storageCapacity');
const { DungeonWatcher } = require('./modules/dungeonWatcher');
const { DungeonMap } = require('./modules/dungeonMap');
const { openBuildDraft } = require('./modules/buildDraftBrowser');
const { normalizeLocale } = require('./modules/gameLocales');
const { getLocaleTag, windowMessages } = require('./modules/localization');
const { catalogAsset, localizedCatalog } = require('./modules/localizedCatalogs');
const { ensureNamesForLanguage, downloadLanguage, lookupName, loadLanguageData, setDataManager, setDebug: setLangDebug } = require('./modules/languageNames');
const { MapTileManager } = require('./modules/mapTiles');
const { DataUpdateManager, MANIFEST_URL, POI_FILES } = require('./modules/dataUpdates');
const { GameDataAccess } = require('./modules/gameDataAccess');
const { createTemperIconHandler } = require('./modules/temperIconProtocol');
const { SCHEME: GAME_DATA_SCHEME } = require('./modules/gameDataImages');
const { APP_DIR } = require('./modules/appPaths');
const groupFinder = require('./modules/groupFinderService');
const firebaseConfig = require('./modules/firebaseConfig');
const { GroupFinderIdentity } = require('./modules/playerIdentity');
const { UsageAnalytics } = require('./modules/usageAnalytics');
const { sendUsage } = require('./modules/usageTransport');
const { getTimerDurations, setTimerDurations } = require('./modules/timerDurations');

// ─── Globals ──────────────────────────────────────────────
let mainWindow = null;
let activeInventoryPoller = null;
let settingsWindow = null;
let tutorialWindow = null;
let focusReminder = null;
let launchFocusChordUsed = false;
const pendingWidgetTutorials = new Set();
let updateWindow = null;
let updater = null;
let calendarSettingsWindow = null;
let changelogWindow = null;
let widgetsWindow = null;
let groupFinderWindow = null;
let marketWindow = null;
let dailyBriefWindow = null;
let tray = null;
const config = new ConfigStore();
const appearanceSession = createAppearanceSession({ config, broadcast: current => broadcastAppearance(current) });
// Briefs are opened by login/reset or the dock, never restored from yesterday.
config.set('widgetOpen', { ...config.get('widgetOpen', {}), daily: false });
let gamePaths = null;
const dataSnapshots = new DataSnapshots({
  getSession: () => activeInventoryPoller,
  getLogPath: () => gamePaths?.status().eeLog.path,
  getLanguage: () => config.get('language', 'en'),
  getNames: async (inventory, language) => collectInventoryNames(inventory,
    await ensureNamesForLanguage(language, { network: false }),
    loadLanguageData(language, { compact: false }),
    localizedCatalog(dataManager, 'tempers', language, loadLanguageData),
    localizedCatalog(dataManager, 'wolf-training', language, loadLanguageData),
    epithetsData?.getCatalog()),
});
const serviceDirectory = services.storageScope ? path.join(APP_DIR, 'services', services.storageScope) : APP_DIR;
firebaseConfig.configureAuthStorage({ directory: serviceDirectory, safeStorage: require('electron').safeStorage });
const avakotAccount = new AvakotAccountService({ getSession: () => activeInventoryPoller,
  tokenStore: new AvakotTokenStore({ directory: serviceDirectory, safeStorage: require('electron').safeStorage }),
  openExternal: url => require('electron').shell.openExternal(url),
});
const gameDataAccess = new GameDataAccess({ account: avakotAccount });
avakotAccount.on('changed', snapshot => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try { settingsWindow.webContents.send('avakot-account:state', publicAvakotAccountState(snapshot)); } catch { /* Settings closed. */ }
  }
  if (marketWindow && !marketWindow.isDestroyed()) {
    try { marketWindow.webContents.send('market:changed', marketFrontendState(market, snapshot)); } catch { /* Market closed. */ }
  }
});
const market = new MarketService({ getSession: () => activeInventoryPoller, getTemperCatalog,
  sharedAccount: true,
  rememberSession: config.get('marketRememberSession', true),
  tokenStore: new MarketTokenStore({ directory: serviceDirectory, safeStorage: require('electron').safeStorage }),
  readLocalApiKey: app.isPackaged ? undefined : () => readMarketApiKey({
    envFile: path.join(app.getAppPath(), '.env.local'),
  }),
  copyText: value => require('electron').clipboard.writeText(value),
  openExternal: url => require('electron').shell.openExternal(url),
  locale: () => config.get('language', 'en'),
});
const marketAccount = new MarketAccountConnection({ account: avakotAccount, market });
market.getAccountConnection = () => accountConnectionState({ ...avakotAccount.snapshot(), ...marketAccount.snapshot(),
  busy: avakotAccount.busy || marketAccount.busy, error: marketAccount.error || avakotAccount.error });
marketAccount.on('changed', () => market.update());
market.on('changed', snapshot => {
  for (const win of [marketWindow, settingsWindow]) {
    if (!win || win.isDestroyed()) continue;
    try { win.webContents.send('market:changed', snapshot); } catch { /* Window closed during update. */ }
  }
});
market.on('remember-changed', remember => {
  config.set('marketRememberSession', remember);
  for (const win of [settingsWindow, marketWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('config-changed', appearanceSession.effectiveConfig());
  }
});
const DEBUG = process.argv.includes('--log');
const usage = new UsageAnalytics({ enabled: !!services.usageFirebase && app.isPackaged && !IS_BETA, directory: serviceDirectory,
  version: CURRENT_VERSION, send: sendUsage,
  isActive: () => BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && win.isVisible() && win.isFocused()),
});
app.on('will-quit', () => usage.stop());
const calendar = new CalendarService({ config, feed: new CalendarFeed({
  cacheDir: path.join(require('./modules/appPaths').CACHE_DIR, 'calendar'),
  getDataManager: services.calendarManifest ? undefined : () => dataManager,
  log: message => log('CALENDAR', message),
}) });
const worldClock = new WorldClock({ cacheDir: require('./modules/appPaths').CACHE_DIR, log: message => log('CLOCK', message) });
const weather = new WeatherForecast({ cacheDir: require('./modules/appPaths').CACHE_DIR, clock: worldClock, log: message => log('WEATHER', message) });
function broadcastWeather() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('weather-changed'); } catch { /* Frame closed during notification. */ }
    }
  }
}
weather.on('changed', broadcastWeather);
worldClock.on('changed', broadcastWeather);
worldClock.on('changed', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('world-clock-changed'); } catch { /* Frame closed during notification. */ }
    }
  }
});
const buildExporter = new BuildExporter({ getSession: () => activeInventoryPoller,
  openDraft: url => openBuildDraft(url, { shell: require('electron').shell }),
});
buildExporter.on('changed', status => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('build-export-changed', status); } catch { /* Frame closed during notification. */ }
    }
  }
});
const temperTracker = new TemperTracker({ getSession: () => activeInventoryPoller });
temperTracker.on('changed', snapshot => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('temper-tracker-changed', snapshot); } catch { /* Frame closed during notification. */ }
    }
  }
});
const COLLECTION_WIDGET_IDS = ['collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements', 'crafting-planner', 'activity', 'crafting-log', 'session-analysis'];
let collectionNameCache = null;
function getCollectionNames() {
  const language = config.get('language', 'en');
  if (collectionNameCache?.language === language && collectionNameCache?.base === namesMap) return collectionNameCache.names;
  const entries = loadLanguageData(language, { compact: false });
  const names = { ...namesMap }, catalog = getCollectionCatalog();
  const add = row => {
    const translated = entries[row.langKey];
    if (translated) names[row.langKey] = translated;
    names[row.itemType] = translated || names[row.itemType] || row.name;
  };
  for (const row of catalog.items) {
    add(row);
    for (const ingredient of row.recipe?.ingredients || []) add(ingredient);
  }
  for (const row of [...catalog.mastery.items, ...catalog.discoveries]) {
    if (entries[row.langKey]) names[row.langKey] = entries[row.langKey];
  }
  collectionNameCache = { language, base: namesMap, names };
  return names;
}
const collectionLanguageRequests = new Map();
function refreshCollectionLanguage() {
  const language = config.get('language', 'en');
  if (collectionLanguageRequests.has(language)) return collectionLanguageRequests.get(language);
  const task = downloadLanguage(language).then(() => {
    if (config.get('language', 'en') !== language) return;
    collectionNameCache = null;
    const visible = config.get('widgetVisibility', {});
    for (const id of COLLECTION_WIDGET_IDS) if (visible[id]) inventoryWidgets.get(id)?.update(true);
  }).finally(() => collectionLanguageRequests.delete(language));
  collectionLanguageRequests.set(language, task); return task;
}
const masteryModel = createMasteryTrackerModel({ getCatalog: getCollectionCatalog,
  getDiscoveries: (inventory, context) => discoveryProgress(inventory, getCollectionCatalog(), context.names) });
const masterySessions = createMasterySessionsModel({
  getMastery: (inventory, context) => ({ ...masteryModel.read(inventory, context),
    dataVersion: require('node:crypto').createHash('sha256').update(JSON.stringify([
      getCollectionCatalog().source.masterySha256, getCollectionCatalog().source.availabilitySha256, 'p17',
    ])).digest('hex') }),
  ...createMasteryHistoryStore({ filename: path.join(require('./modules/appPaths').CACHE_DIR, 'mastery-sessions.json') }),
});
const inventoryWidgets = new Map([
  ['collection-log', createCollectionTrackerModel({ getCatalog: getCollectionCatalog })],
  ['cosmetics', createCollectionTrackerModel({ getCatalog: getCollectionCatalog, cosmeticsOnly: true })],
  ['mastery-tracker', masteryModel],
  ['session-analysis', masterySessions],
  ['resources', createResourcesModel({ getCatalog: getCollectionCatalog })],
  ['enhancements', createEnhancementsModel({ getCatalog: getCollectionCatalog })],
  ['crafting-planner', createCraftingPlannerModel({ getCatalog: getCollectionCatalog })],
  ['activity', createActivityModel({ getCatalog: getCollectionCatalog })],
  ['crafting-log', createCraftingLogModel({ getCatalog: getCollectionCatalog })],
  ['session-gains', createSessionGainsModel()],
  ['equipment-progress', createEquipmentProgressModel()],
  ['active-boons', createActiveBoonsModel()],
  ['account-wallet', createAccountWalletModel()],
  ['storage-capacity', createStorageCapacityModel()],
].map(([id, model]) => {
  const service = new InventoryWidgetService({ id, model,
    getSession: () => id === 'session-analysis' && !config.get('widgetVisibility', {})[id] ? null : activeInventoryPoller,
    getNames: COLLECTION_WIDGET_IDS.includes(id) ? getCollectionNames : () => namesMap });
  service.on('changed', snapshot => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      for (const frame of win.webContents.mainFrame.framesInSubtree) {
        try { frame.send('inventory-widget-changed', id, snapshot); } catch { /* Frame closed. */ }
      }
    }
  });
  return [id, service];
}));
function updateInventoryWidgets() {
  const visible = config.get('widgetVisibility', {});
  for (const [id, service] of inventoryWidgets) if (id === 'session-analysis' || visible[id] || visible.player && !COLLECTION_WIDGET_IDS.includes(id) || !activeInventoryPoller) service.update();
}
const dailyVendors = new DailyVendors({ getSession: () => activeInventoryPoller, getLanguage: () => config.get('language', 'en'),
  getTemperCatalog: () => localizedCatalog(dataManager, 'tempers', config.get('language', 'en'), loadLanguageData),
  getNames: () => namesMap, cacheDir: path.join(require('./modules/appPaths').CACHE_DIR, 'daily-vendors'), log: message => log('VENDORS', message) });
const dailyBrief = new DailyBrief({ config, calendar, vendors: dailyVendors, getSession: () => activeInventoryPoller,
  canShow: () => !overlayHiddenByUser && !gameHiddenActive && (!!mainWindow?.isVisible() || dockAutoHidden) });
dailyBrief.on('changed', snapshot => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('daily-brief-changed', snapshot); } catch { /* Frame closed. */ }
    }
  }
});
dailyBrief.on('open', () => {
  openDailyBriefWindow({ focus: false });
});

async function refreshDailyBrief(options = {}) {
  await Promise.allSettled([refreshModuleData('temper-tracker'), dailyBrief.refresh(options)]);
  return dailyBrief.getSnapshot();
}
dailyVendors.on('changed', () => dailyBrief.getSnapshot());
calendar.on('changed', () => dailyBrief.getSnapshot());
const wolfTraining = new WolfTraining({ getSession: () => activeInventoryPoller, getLanguage: () => config.get('language', 'en') });
const titleTracker = TITLE_TRACKER_ENABLED ? new TitleTracker({ getSession: () => activeInventoryPoller }) : null;
const epithetsData = TITLE_TRACKER_ENABLED ? new EpithetsData({
  cacheDir: path.join(require('./modules/appPaths').CACHE_DIR, 'epithets'),
  bundledData: getBundledTitleCatalog(),
  http: gameDataAccess.http,
  log: message => log('TITLES', message),
}) : null;
if (epithetsData) setTitleCatalog(epithetsData.getCatalog());
titleTracker?.on('changed', snapshot => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('title-tracker-changed', snapshot); } catch { /* Frame closed during notification. */ }
    }
  }
});
wolfTraining.on('changed', snapshot => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('wolf-training-changed', snapshot); } catch { /* Frame closed during notification. */ }
    }
  }
});
function appearanceFrames() {
  const frames = [];
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      const contents = win.webContents;
      if (!contents || contents.isDestroyed?.()) continue;
      frames.push(...(contents.mainFrame?.framesInSubtree || []));
    } catch { /* Native teardown may detach the main frame before the window. */ }
  }
  return frames;
}

function broadcastTheme(allConfig) {
  const effective = appearanceSession.effectiveConfig(allConfig);
  const theme = { ...Appearance.appearanceConfig(effective), locale: getLocaleTag(effective.language) };
  for (const frame of appearanceFrames()) {
    try { frame.send('theme-changed', theme); } catch { /* Frame closed during the update. */ }
  }
}

function broadcastAppearance(current) {
  const allConfig = appearanceSession.effectiveConfig(current);
  broadcastTheme(allConfig);
  for (const frame of appearanceFrames()) {
    try { frame.send('config-changed', allConfig); } catch { /* Frame closed during editing. */ }
  }
}

let calendarAccountId = null;
let calendarInventoryCached = true;
calendar.on('changed', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // Dock cells have their own preload bridge in child frames.
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('calendar-changed'); } catch { /* Frame closed during notification. */ }
    }
  }
});

/** Active alert windows (each timer alert gets its own floating window) */
const alertWindows = new Set();

/** Standalone widget windows (widgetId → BrowserWindow) */
const widgetWindows = new Map();

/** Current language names map (tag → display name) */
let namesMap = {};
let arenaStatus = 'unknown';
let arenaDetectionSource = 'none';
let arenaWave = null; // { wave, tier, total } while in an active arena run
let arenaWatcher = null;
let arenaPresence = null;
let ancestorMarkers = [];
let ancestorWatcher = null;
let dungeonWatcher = null;

// Logger — only outputs when --debug flag is passed
function log(tag, ...args) {
  if (!DEBUG) return;
  const d = new Date(); const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  console.log(`[${ts}][${tag}]`, ...args);
}

const MAP_TILE_SCHEME = 'overkot-map-tiles';
const dataManager = new DataUpdateManager({
  rootDir: path.join(serviceDirectory, 'data'),
  bundledRoot: path.join(__dirname, '..'),
  manifestUrl: services.dataManifest || MANIFEST_URL,
  compactTemperIcon: require('./modules/temperIconThumbnail').compactTemperIcon,
  http: gameDataAccess.http,
  log: (...args) => log('DATA', ...args),
});
setDataManager(dataManager);
gameDataAccess.on('changed', state => {
  if (state.signedIn && app.isReady()) {
    // A signed-out startup check may still be unwinding and setting backoff.
    // Queue the authorized force refresh after it, just like the Settings action.
    void checkGameDataNow().then(() => Promise.all([
      refreshTitleData({ force: true }),
      warmMapTiles(),
    ])).catch(error => log('DATA', `Post-sign-in refresh failed: ${error.message}`));
  }
});
const dungeonMap = new DungeonMap({ dataManager });
const playerTracking = new PlayerTracking({
  directory: path.join(APP_DIR, 'dungeon-discovery'),
  getState: () => dungeonWatcher?.getState() || { status: 'unknown', active: false },
  getAccountId: () => activeInventoryPoller?.accountId || null,
  getVersion: () => dataManager.getInfo().version,
  getLayoutSnapshot: state => dungeonMap.getLayoutSnapshot(state),
  getScene: state => dungeonMap.getSnapshot(state),
  getNames: getCollectionNames,
});
playerTracking.setEnabled(config.get('livePlayerTracking', true));
const moonsteelAlertWindow = createMoonsteelAlertWindow({ BrowserWindow, screen, platformSupport, configureOverlayWorkspace,
  rendererRoot: path.join(__dirname, 'renderer'), preloadPath: path.join(__dirname, 'moonsteel-alert-preload.js'),
  onError: error => log('MOONSTEEL', error.message) });
const moonsteelAlerts = createMoonsteelAlerts({
  getSettings: () => config.get('moonsteelAlert'),
  onAlert: payload => {
    if (!app.isReady() || marketShutdownStarted) return;
    try { moonsteelAlertWindow.show(payload); } catch (error) { log('MOONSTEEL', error.message); }
  },
});
function broadcastMapEvent(channel, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send(channel, data); } catch { /* Map frame detached. */ }
    }
  }
}
playerTracking.on('location', data => {
  // Detection belongs to the game connection, independent of every map window.
  moonsteelAlerts.receive(data);
  broadcastMapEvent('player-location', data);
});
playerTracking.on('status', data => broadcastMapEvent('player-tracking-changed', data));
playerTracking.on('discovery', data => broadcastMapEvent('dungeon-discovery-changed', data));
app.on('will-quit', () => { playerTracking.stop(); moonsteelAlerts.clear(); moonsteelAlertWindow.dispose(); });
const mapTileManager = new MapTileManager({
  app,
  dataManager,
  bundledTilesDir: path.join(__dirname, '..', 'assets', 'map-tiles'),
  log: (...args) => log('MAPTILES', ...args),
});

let mapTileProtocolRegistered = false;
const serveTemperIcon = createTemperIconHandler(dataManager);
function registerMapTileProtocol() {
  if (mapTileProtocolRegistered) return;
  mapTileProtocolRegistered = true;

  protocol.registerFileProtocol(MAP_TILE_SCHEME, (request, callback) => {
    if (request.url.startsWith(`${MAP_TILE_SCHEME}://data/temper-icons/`)) return serveTemperIcon(request, callback);
    let tileName = '';
    try {
      const url = new URL(request.url);
      const asset = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (url.hostname === 'data' && /^map-icons\/[A-Za-z]+\.png$/.test(asset)) {
        dataManager.checkForUpdates().then(() => dataManager.ensureAsset(asset))
          .then(filename => callback(filename ? { path: filename } : { error: -6 }))
          .catch(() => callback({ error: -6 }));
        return;
      }
      if (url.hostname !== 'tile' || (url.search && !/^\?v=[a-f0-9]{64}$/.test(url.search)) || url.hash || !/^\/\d+\.webp$/.test(url.pathname)) {
        callback({ error: -10 }); return;
      }
      tileName = url.pathname.slice(1);
    } catch {
      callback({ error: -10 }); // ERR_ACCESS_DENIED
      return;
    }

    if (!/^\d+\.webp$/.test(tileName)) {
      callback({ error: -6 }); // ERR_FILE_NOT_FOUND
      return;
    }

    mapTileManager.getTilePath(tileName).then(tilePath => {
      callback(tilePath ? { path: tilePath } : { error: -6 });
    }).catch(() => callback({ error: -6 }));
  });
}

function broadcastMapTilesUpdated(info) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      for (const frame of win.webContents.mainFrame.framesInSubtree) {
        try { frame.send('map-tiles-updated', info); } catch { /* Frame closed during refresh. */ }
      }
    }
  }
}

let dataRefreshPromise = null;
const moduleDataRequests = new Map();
async function refreshTitleData({ force = false } = {}) {
  if (!epithetsData) return;
  try {
    await epithetsData.initialize();
    if (setTitleCatalog(epithetsData.getCatalog())) titleTracker.update();
    await epithetsData.refresh({ force });
    if (setTitleCatalog(epithetsData.getCatalog())) titleTracker.update();
  } catch (error) { log('TITLES', error.message); }
}
function applyTemperCatalog(data) {
  if (!setTemperCatalog(data)) return;
  temperTracker.update();
  market.update();
}

function refreshModuleData(module) {
  if (module === 'build-exporter' && !services.buildWebsite) return;
  const locale = config.get('language', 'en');
  const language = normalizeLocale(locale);
  const section = module === 'temper-tracker' ? 'tempers' : module === 'wolf-training' ? 'wolf-training' : null;
  const key = section ? `${section}/${language}.json` : 'build-export/catalog.json';
  if (moduleDataRequests.has(key)) return moduleDataRequests.get(key);
  const task = (async () => {
    await dataManager.checkForUpdates();
    const asset = section ? catalogAsset(dataManager, section, language) : key;
    await Promise.all([dataManager.ensureAsset(asset), asset !== key && downloadLanguage(language)]);
    const data = section ? localizedCatalog(dataManager, section, language, loadLanguageData) : dataManager.readJSON(key);
    if (module === 'temper-tracker') {
      if (config.get('language', 'en') === locale) applyTemperCatalog(data);
    } else if (module === 'wolf-training') {
      if (config.get('language', 'en') === locale) {
        setWolfTrainingCatalog(data, language);
        wolfTraining.update();
      }
    } else if (setBuildExportCatalog(data)) buildExporter.update();
  })().catch(error => log('DATA', error.message)).finally(() => moduleDataRequests.delete(key));
  moduleDataRequests.set(key, task); return task;
}
function refreshGameData({ force = false } = {}) {
  if (dataRefreshPromise) return dataRefreshPromise;
  dataRefreshPromise = (async () => {
    const result = await dataManager.checkForUpdates({ force });
    let assets = { failed: [], updated: false };
    if (force && !result.error) {
      const locale = config.get('language', 'en');
      const language = normalizeLocale(locale);
      const keys = ['timers/durations.json'];
      for (const key of [`names/${language}.json`, `locations/${language}.json`]) {
        if (!dataManager.manifest || dataManager.manifest.files[key]) keys.push(key);
      }
      const visible = config.get('widgetVisibility', {});
      if (visible['temper-tracker'] || visible.daily || visible.market) keys.push(catalogAsset(dataManager, 'tempers', language));
      if (visible['wolf-training']) keys.push(catalogAsset(dataManager, 'wolf-training', language));
      if (services.buildWebsite && visible['build-exporter']) keys.push('build-export/catalog.json');
      if (visible.daily || visible.calendar || visible['world-watch']) keys.push('calendar/calendar.json');
      if (visible.minimap || (mapWindow && !mapWindow.isDestroyed())) keys.push(...POI_FILES.map(name => `map-json/${name}.json`));
      assets = await dataManager.refreshCachedAssets(keys);
    }
    for (const module of ['temper-tracker', 'build-exporter', 'wolf-training']) {
      if (config.get('widgetVisibility', {})[module] || module === 'temper-tracker' && (config.get('widgetVisibility', {}).daily || config.get('widgetVisibility', {}).market)) await refreshModuleData(module);
    }
    if (COLLECTION_WIDGET_IDS.some(id => config.get('widgetVisibility', {})[id])) await refreshCollectionLanguage();
    if (TITLE_TRACKER_ENABLED && config.get('widgetVisibility', {})['title-tracker']) await refreshTitleData({ force });
    const locale = config.get('language', 'en');
    const visibility = config.get('widgetVisibility', {});
    if (visibility.daily || visibility.calendar || visibility['world-watch']) await calendar.refresh();
    await dataManager.ensureAsset('timers/durations.json');
    setTimerDurations(dataManager.readJSON('timers/durations.json'));
    const names = await ensureNamesForLanguage(locale);
    if (locale === config.get('language', 'en')) {
      namesMap = names;
      if (mapWindow && !mapWindow.isDestroyed()) mapWindow.webContents.send('map-language-updated', locale);
    }
    pushStateToRenderer();
    if (result.updated || force) broadcastMapTilesUpdated({ ...dataManager.getInfo(), reload: force });
    return { status: result.error ? 'error' : assets.failed.length ? 'partial' : result.updated || assets.updated ? 'updated' : 'current' };
  })().catch(error => { log('DATA', error.message); return { status: 'error' }; }).finally(() => { dataRefreshPromise = null; });
  return dataRefreshPromise;
}

let manualDataRefreshPromise = null;
function checkGameDataNow() {
  if (MANIFEST_URL && dataManager.manifestUrl === MANIFEST_URL && !avakotAccount.snapshot().signedIn) {
    return Promise.resolve({ status: 'signin' });
  }
  if (!manualDataRefreshPromise) {
    manualDataRefreshPromise = (async () => {
      // A settings click must still reach the network if an automatic refresh
      // was already using the six-hour cached result.
      if (dataRefreshPromise) await dataRefreshPromise;
      return refreshGameData({ force: true });
    })().finally(() => { manualDataRefreshPromise = null; });
  }
  return manualDataRefreshPromise;
}

let mapUpdatesStopped = false;
let mapWarmupPromise = null;
function warmMapTiles() {
  if (!mapWarmupPromise && !mapUpdatesStopped) {
    mapWarmupPromise = mapTileManager.warmCache({ language: config.get('language', 'en') })
      .then(result => {
        if (!mapUpdatesStopped && result.updated) broadcastMapTilesUpdated({ ...mapTileManager.getInfo(), reload: true });
      }).finally(() => { mapWarmupPromise = null; });
  }
  return mapWarmupPromise;
}

function startMapTileUpdateCheck() {
  const refresh = async () => {
    try {
      await refreshGameData();
      await warmMapTiles();
    } catch (error) { log('MAPTILES', `Background cache warmup failed: ${error.message}`); }
  };
  void refresh();
  const timer = setInterval(refresh, 15 * 60 * 1000 + Math.floor(Math.random() * 60000));
  timer.unref();
  app.once('will-quit', () => {
    mapUpdatesStopped = true;
    clearInterval(timer);
    mapTileManager.stopWarmup();
  });
}

// Shared state (mirrors Rust Arc<Mutex<...>> pattern)
let appStatus = platformSupport.gameConnection ? 'waiting' : 'companion';
let timerState = { timers: [], dailyAffiliation: null, dailyAffiliationOde: null, factions: null, rawInventory: null };
// Polling interval is now randomised internally by InventoryPoller (2-7s)

// ─── Click-through overlay interaction state ─────────────
let overlayInteractive = false;
let gameFocusRequest = null;
let nativeOverlayForeground = null;
let overlayFocusRequestedAt = 0;
let isCollapsed = false;
let registeredShortcut = null;
let overlayShortcutWarning = '';
let registeredVisibilityShortcut = null;
let visibilityShortcutWarning = '';
let shortcutCapture = false;
let overlayHiddenByUser = false;
let layoutEditing = false;
let nativeLayoutTracking = process.platform === 'win32';
let dockAutoHidden = false;
let dockKeyboardActive = false;
let layoutKeyMonitor = null;
let dockPollTimer = null;
let shiftStartTimer = null;
let redockTarget = false;
let lastDockHover = Date.now();
const layoutGridWindows = new Map();
const layoutMovedWidgets = new Set();
const { DOCK_SIZE, EDGES, validEdge, railBounds, layoutDockedWidgets, pointInBounds, snapWidgetToGrid } = require('./modules/edgeDockGeometry');
const { startLayoutKeyMonitor } = require('./modules/layoutKeyMonitor');

/** Whether sub-windows/widgets are hidden because the game is not running */
let gameHiddenActive = false;
/** Whether Soulframe currently owns the foreground window (Windows). */
let gameFocusedActive = true;
/** Whether the main overlay window is currently hidden due to focus-only mode. */
let mainHiddenForFocus = false;
let detector = null;

app.on('will-quit', () => {
  gameDataAccess.dispose();
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  if (registeredVisibilityShortcut) globalShortcut.unregister(registeredVisibilityShortcut);
  layoutKeyMonitor?.stop();
  clearInterval(dockPollTimer);
  clearTimeout(shiftStartTimer);
  detector?.stopForegroundMonitor();
});

let marketShutdownStarted = false;
let marketShutdownComplete = false;
app.on('before-quit', event => {
  if (marketShutdownComplete) return;
  event.preventDefault();
  if (marketShutdownStarted) return;
  marketShutdownStarted = true;
  gameFocusRequest?.abort();
  moonsteelAlertWindow.close();
  syncAlertVisibility();
  // Release the overlay's in-game status before exiting, but slow/offline
  // account services must never hold the app open indefinitely.
  const timeout = setTimeout(finishMarketShutdown, 3000);
  function finishMarketShutdown() {
    if (marketShutdownComplete) return;
    clearTimeout(timeout);
    marketShutdownComplete = true;
    app.quit();
  }
  marketAccount.dispose();
  playerTracking.stop();
  Promise.allSettled([market.dispose(), avakotAccount.dispose(), playerTracking.flush()]).then(finishMarketShutdown, finishMarketShutdown);
});

function registerOverlayShortcut() {
  if (registeredShortcut) {
    globalShortcut.unregister(registeredShortcut);
    registeredShortcut = null;
  }
  if (shortcutCapture) return;

  const previousWarning = overlayShortcutWarning;
  overlayShortcutWarning = '';

  let hotkey = config.get('interactionHotkey', 'Shift+F1');
  if (typeof hotkey !== 'string' || !hotkey.trim() || ['Alt', 'Control', 'Shift'].includes(hotkey)) hotkey = 'Shift+F1';

  try {
    const ok = globalShortcut.register(hotkey, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      launchFocusChordUsed = true;
      focusReminder?.dismiss();
      toggleOverlayInteraction();
      scheduleAppTutorial();
    });
    if (ok) {
      registeredShortcut = hotkey;
      applyOverlayMousePolicy();
      log('HOTKEY', `Registered overlay shortcut: ${hotkey}`);
    } else {
      log('HOTKEY', `Failed to register overlay shortcut: ${hotkey} (in use by another app?)`);
    }
  } catch (e) {
    log('HOTKEY', `Error registering shortcut ${hotkey}: ${e.message}`);
  }
  if (!registeredShortcut) {
    // A pass-through window must never depend on a shortcut that did not bind.
    config.set('clickThrough', false);
    overlayInteractive = false;
    applyOverlayMousePolicy();
    const allConfig = appearanceSession.effectiveConfig();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('config-changed', allConfig);
    }
    overlayShortcutWarning = `${hotkey.replaceAll('+', ' + ')} is unavailable. Click-through is off. Choose another hotkey in Settings.`;
  }
  if (previousWarning !== overlayShortcutWarning) pushStateToRenderer();
}

function updateGameFocus(focused) {
  const changed = focused !== gameFocusedActive;
  gameFocusedActive = focused;
  // Closing a native popup onto another app can leave the game unfocused
  // throughout, without another Electron blur event to update visibility.
  if (!overlayHiddenByUser && (changed || mainHiddenForFocus !== (!focused && !isAnyOverlayWindowFocused()))) {
    applyGameHiddenState();
  }
}

/** Check whether any overlay-related window currently has focus. */
function isAnyOverlayWindowFocused() {
  // Native menus and dialogs can own focus while every BrowserWindow is blurred.
  if (nativeOverlayForeground === true) return true;
  // Allow Chromium to report newly acquired focus before the next native sample.
  if (nativeOverlayForeground === false && Date.now() - overlayFocusRequestedAt >= 200) return false;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return true;
  if (dockWindow && !dockWindow.isDestroyed() && dockWindow.isFocused()) return true;
  for (const [, w] of widgetWindows) {
    if (!w.isDestroyed() && w.isFocused()) return true;
  }
  for (const w of [settingsWindow, tutorialWindow, changelogWindow, widgetsWindow, groupFinderWindow, marketWindow, dailyBriefWindow, wikiWindow, mapWindow, dungeonOverlayWindow, calendarSettingsWindow, updateWindow]) {
    if (w && !w.isDestroyed() && w.isFocused()) return true;
  }
  return false;
}

/** Attach a blur handler that exits interactive mode when focus leaves all overlay windows. */
function attachOverlayBlurHandler(win) {
  configureOverlayPopout(win, mainWindow, platformSupport);
  if (platformSupport.platform === 'win32' && win !== mainWindow) {
    let foregroundClose;
    win.on('close', event => {
      foregroundClose = !win._skipCloseFocus && win.isFocused() && win.isVisible()
        && !overlayHiddenByUser && !marketShutdownStarted ? event : null;
      win._skipCloseFocus = false;
    });
    win.once('closed', () => {
      // Let all synchronous window/discovery cleanup finish before applying the
      // user's destination. A cancelled close or a programmatic destroy never routes.
      if (foregroundClose && !foregroundClose.defaultPrevented) {
        setImmediate(() => { void restoreWindowCloseFocus(); });
      }
    });
  }
  win.on('minimize', () => {
    if (win === dailyBriefWindow) { pushDockState(); return; }
    setOverlayHidden(true);
  });
  win.on('blur', () => {
    setTimeout(() => {
      if (isAnyOverlayWindowFocused() || Date.now() - overlayFocusRequestedAt < 200) return;
      clearTimeout(shiftStartTimer);
      setLayoutEditing(false);
      if (overlayInteractive) toggleOverlayInteraction(true);
    }, 100);

    // Re-evaluate focus-based auto-hide when switching away from Overkot windows.
    setTimeout(() => {
      if (config.get('showOnlyWhenGameFocused', false)) applyGameHiddenState();
    }, 120);
  });

  // Re-evaluate focus-based auto-hide when Overkot gains focus.
  win.on('focus', () => {
    overlayFocusRequestedAt = Date.now();
    if (dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed()) {
      const level = win === dungeonOverlayWindow ? 1 : win === mainWindow ? 3 : win._widgetId ? 2 : 4;
      win.setAlwaysOnTop(true, 'screen-saver', level);
    }
    if (config.get('showOnlyWhenGameFocused', false)) applyGameHiddenState();
  });
  // Popouts left open over a game must obey the same passive-input policy as
  // panels. Reapply after mapping too, before the next foreground sample.
  win.on('show', applyOverlayMousePolicy);
}

function applyOverlayMousePolicy() {
  const ignoreLauncher = !overlayInteractive && !layoutEditing;
  // A saved desktop preference must not let a game click activate Overkot.
  // Lock for the whole game session, including native focus-transfer races.
  // If the chord failed to bind, retain the existing clickable-widget recovery.
  const gameInputLocked = platformSupport.platform === 'win32' && !!registeredShortcut && ignoreLauncher
    && appStatus !== 'waiting' && appStatus !== 'companion';
  const ignoreWidgets = (config.get('clickThrough', true) || gameInputLocked) && ignoreLauncher;
  for (const win of [mainWindow, dockWindow, ...widgetWindows.values(), dungeonOverlayWindow]) {
    if (!win || win.isDestroyed()) continue;
    // The launcher requires interaction or layout mode. Widget panels obey
    // their click-through setting; the dungeon map requires interaction mode.
    const ignore = win === mainWindow ? ignoreLauncher : win === dungeonOverlayWindow ? !overlayInteractive : ignoreWidgets;
    applyWindowMousePolicy(win, ignore, win === dungeonOverlayWindow);
    win.webContents.send('overlay-interaction-changed', overlayInteractive);
  }
  for (const win of [settingsWindow, tutorialWindow, changelogWindow, widgetsWindow, groupFinderWindow,
    marketWindow, dailyBriefWindow, wikiWindow, mapWindow, calendarSettingsWindow, updateWindow]) {
    if (win && !win.isDestroyed()) applyWindowMousePolicy(win, gameInputLocked);
  }
}

function applyWindowMousePolicy(win, ignore, forward = false) {
  win.setIgnoreMouseEvents(ignore, forward ? { forward: true } : undefined);
  const focusable = platformSupport.platform === 'win32' && win.isFocusable ? win.isFocusable() : win._overlayFocusable;
  if (platformSupport.platform === 'win32' && win.setFocusable && focusable !== !ignore) {
    // WS_EX_NOACTIVATE protects against native activation as well as Chromium
    // mouse hit testing. Unlock before show()/focus() in the hotkey path.
    win._overlayFocusable = !ignore;
    win.setFocusable(!ignore);
    // Electron changes taskbar membership in setFocusable. Preserve the main
    // app entry for deliberate recovery and keep auxiliary windows out of it.
    win.setSkipTaskbar?.(win !== mainWindow);
  }
}

function focusOverlay() {
  if (overlayHiddenByUser) return;
  overlayFocusRequestedAt = Date.now();
  dockKeyboardActive = true;
  setDockAutoHidden(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  for (const win of [dockWindow, ...widgetWindows.values()]) {
    if (!isCollapsed && win && !win.isDestroyed() && win.isVisible()) win.moveTop();
  }
  const target = dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed() && dungeonOverlayWindow.isVisible()
    ? dungeonOverlayWindow : mainWindow;
  target.focus();
  if (dungeonOverlayWindow) refreshOverlayWindowStack();
  else raiseAlertWindows();
}

function toggleOverlayInteraction(forceOff = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (overlayHiddenByUser && !forceOff) return;
  if (isCollapsed && !forceOff) {
    if (!forceOff) focusOverlay();
    return;
  }

  if (overlayInteractive || forceOff) {
    clearTimeout(shiftStartTimer);
    setLayoutEditing(false);
    overlayInteractive = false;
    applyOverlayMousePolicy();
    for (const win of [mainWindow, dockWindow, ...widgetWindows.values(), dungeonOverlayWindow,
      settingsWindow, tutorialWindow, changelogWindow, widgetsWindow, groupFinderWindow, marketWindow, dailyBriefWindow,
      wikiWindow, mapWindow, calendarSettingsWindow, updateWindow]) {
      if (win && !win.isDestroyed() && win.isFocused()) win.blur();
    }
    log('HOTKEY', 'Overlay -> click-through');
  } else {
    gameFocusRequest?.abort();
    gameFocusRequest = null;
    overlayInteractive = true;
    applyOverlayMousePolicy();
    focusOverlay();
    log('HOTKEY', 'Overlay -> interactive');
  }
}

function closeWithoutChangingFocus(win) {
  if (win && !win.isDestroyed()) {
    win._skipCloseFocus = true;
    win.close();
  }
}

async function restoreWindowCloseFocus() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || overlayHiddenByUser || marketShutdownStarted) return;
  gameFocusRequest?.abort();
  gameFocusRequest = null;
  const target = config.get('windowCloseFocus', 'game');
  function returnToOverlay() {
    overlayInteractive = true;
    applyOverlayMousePolicy();
    focusOverlay();
  }
  if (target === 'overlay' || (target === 'game' && (!detector || appStatus === 'waiting'))) {
    returnToOverlay();
    return;
  }

  toggleOverlayInteraction(true);
  const request = new AbortController();
  gameFocusRequest = request;
  try {
    if (target === 'desktop') await focusDesktop({ signal: request.signal });
    else if (!await detector.focusGameWindow({ signal: request.signal }) && !request.signal.aborted
        && appStatus === 'waiting' && !overlayHiddenByUser && !marketShutdownStarted
        && mainWindow && !mainWindow.isDestroyed() && isAnyOverlayWindowFocused()) {
      // The game exited during handoff. Only restore our UI if we still own focus.
      returnToOverlay();
    }
  } catch (error) {
    if (!request.signal.aborted) log('FOCUS', `Could not focus ${target}: ${error.message}`);
  } finally {
    if (gameFocusRequest === request) gameFocusRequest = null;
  }
}

/** Restore native z-order without taking keyboard focus from the game or map. */
function raiseAlertWindows() {
  for (const win of alertWindows) {
    if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) win.moveTop();
  }
  for (const win of BrowserWindow.getAllWindows?.() || []) {
    if (win._moonsteelAlert && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) win.moveTop();
  }
}

function refreshOverlayWindowStack() {
  const popouts = [settingsWindow, tutorialWindow, changelogWindow, widgetsWindow, groupFinderWindow,
    marketWindow, dailyBriefWindow, wikiWindow, mapWindow, calendarSettingsWindow, updateWindow];
  const focused = popouts.find(win => win && !win.isDestroyed() && win.isFocused());
  refreshOverlayStack([dungeonOverlayWindow, dockWindow, ...widgetWindows.values(), mainWindow,
    ...popouts.filter(win => win !== focused), focused], platformSupport);
  raiseAlertWindows();
}

function watchOverlayStack(win) {
  const refresh = () => {
    // Run after show/focus callers finish changing native styles and z-order.
    setImmediate(() => {
      if (win.isDestroyed()) return;
      if ([dungeonOverlayWindow, dockWindow, mainWindow, ...widgetWindows.values()].includes(win)) {
        refreshOverlayWindowStack();
      } else {
        // Temporary pickers and other popouts retain their own relative order.
        raiseAlertWindows();
      }
    });
  };
  win.on('show', refresh);
  win.on('focus', refresh);
}

// ─── App lifecycle ────────────────────────────────────────
app.on('browser-window-created', (_event, win) => watchOverlayStack(win));
// Disable Chromium's native Windows occlusion detection. On Windows 11 (and to
// a lesser extent Windows 10) Chromium will sometimes decide that one of our
// BrowserWindows is occluded by another window and stop sending it paint
// frames — even though the window is fully visible to the user. The window
// stays stuck on its `backgroundColor` (white, in the wiki window's case)
// forever, and Reload / Force Reload don't help because the occlusion state
// persists. This switch turns that detection off entirely. Cost: a tiny bit
// of extra GPU work for fully-hidden windows. Benefit: no more blank windows.
// See: https://github.com/electron/electron/issues/25667 and many duplicates.
if (process.platform === 'win32') {
  const disabledFeatures = app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean);
  if (!disabledFeatures.includes('CalculateNativeWinOcclusion')) disabledFeatures.push('CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
}
protocol.registerSchemesAsPrivileged([
  { scheme: GAME_DATA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: MARKET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: MAP_TILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

app.whenReady().then(async () => {
  gamePaths = createGamePathResolver({ getConfig: () => config.getAll(), picturesPath: app.getPath('pictures') });
  setGamePathResolver(gamePaths);
  screenshotWatcher.configureScreenshotPaths(gamePaths);
  usage.start();
  void avakotAccount.initialize();
  // Propagate debug flag to all modules
  firebaseConfig.setDebug(DEBUG);
  groupFinder.setDebug(DEBUG);
  setLangDebug(DEBUG);

  log('INIT', 'Overkot starting...');
  log('INIT', `Debug mode: ${DEBUG}`);
  log('INIT', `Electron: ${process.versions.electron}, Node: ${process.versions.node}`);
  if (platformSupport.platform === 'linux') {
    log('INIT', `Display backend: ${platformSupport.displayBackend} (${platformSupport.displaySelection})`);
  }
  registerMapTileProtocol();
  protocol.handle(GAME_DATA_SCHEME, request => gameDataAccess.imageResponse(request));

  try {
    await dataManager.initialize();
    setTimerDurations(dataManager.readJSON('timers/durations.json'));
    await mapTileManager.initialize();
    log('MAPTILES', `Tile source: ${mapTileManager.getInfo().source}`);
  } catch (e) {
    log('MAPTILES', `Failed to initialize map tile cache: ${e.message}`);
  }

  // Load cached data from disk immediately (show before login)
  const cached = loadCachedTimers();
  if (cached.timers.length > 0) {
    timerState.timers = cached.timers;
    log('INIT', `Restored ${cached.timers.length} cached timer(s) from disk`);
  }
  if (cached.dailyAffiliation != null) {
    timerState.dailyAffiliation = cached.dailyAffiliation;
    log('INIT', `Restored cached daily affiliation remaining: ${cached.dailyAffiliation.remaining}`);
  }
  if (cached.dailyAffiliationOde != null) {
    timerState.dailyAffiliationOde = cached.dailyAffiliationOde;
    log('INIT', `Restored cached daily Ode infamy remaining: ${cached.dailyAffiliationOde.remaining}`);
  }
  if (cached.factions) {
    timerState.factions = cached.factions;
    log('INIT', `Restored ${cached.factions.length} cached faction(s) from disk`);
  }
  if (cached.rawInventory) {
    timerState.rawInventory = cached.rawInventory;
    calendarAccountId = cached.accountId || null;
    calendarInventoryCached = true;
    log('INIT', 'Restored cached raw inventory from disk');
  }

  const scannerOk = platformSupport.gameConnection && scannerAvailableSync();
  log('INIT', `Scanner backend: ${!platformSupport.gameConnection ? 'not supported; companion mode' : scannerOk ? 'ready' : 'unavailable'}`);

  // Open immediately from cache; refresh only the selected language in the background.
  const currentLang = config.get('language', 'en');
  try {
    namesMap = await ensureNamesForLanguage(currentLang, { network: false });
    log('LANG', `Loaded ${Object.keys(namesMap).length} names for ${currentLang}`);
  } catch (e) {
    log('LANG', `Failed to load names: ${e.message}`);
  }

  const restoredStartup = await restoreStartupSavedLayout({ config, onApply: layoutRuntime.apply });
  if (restoredStartup === 'failed' || restoredStartup === 'missing') log('LAYOUT', 'The selected startup layout could not be restored; keeping the last arrangement.');
  createMainWindow();
  startAppUpdates();
  startMapTileUpdateCheck();

  // Launch to tray: hide window and show tray icon on startup
  if (config.get('launchToTray', false)) {
    overlayHiddenByUser = true;
    mainWindow.hide();
    createTray();
  }

  groupFinder.setMainWindow(mainWindow);
  groupFinder.setWidgetWindows(widgetWindows);
  market.setEnabled(config.get('widgetVisibility', {}).market === true);
  applyLayoutMode();
  applyGameHiddenState();
  log('INIT', 'Window created, starting background loop...');

  registerOverlayShortcut();
  registerVisibilityShortcut();
  startDockRuntime();
  startBackgroundLoop();
  void offerStartupLayout({
    config, dialog: require('electron').dialog,
    translations: { ...i18nTranslations.en, ...i18nTranslations[config.get('language', 'en')] },
    onApply: () => {
      market.setEnabled(config.get('widgetVisibility', {}).market === true);
      applyLayoutMode();
      const allConfig = appearanceSession.effectiveConfig();
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        for (const frame of win.webContents.mainFrame.framesInSubtree) {
          try { frame.send('config-changed', allConfig); } catch { /* Window closed. */ }
        }
      }
      applyGameHiddenState();
    },
    onCustomize: createWidgetsWindow,
  }).catch(error => log('LAYOUT', `Could not show initial layout choice: ${error.message}`));
});

app.on('window-all-closed', () => {
  // Only quit when the main window is truly gone.
  // Sub-windows closing while the main window is hidden (tray) should not exit.
  if (!mainWindow || mainWindow.isDestroyed()) {
    app.quit();
  }
});

// App updates run after the overlay opens, including when launched to tray.
function startAppUpdates() {
  const supported = !!services.releases && !IS_BETA && app.isPackaged && process.platform === 'win32' &&
    !process.env.PORTABLE_EXECUTABLE_FILE &&
    require('fs').existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  updater = new Updater({ supported,
    log: message => log('UPDATE', message) });
  let notifiedVersion = null;
  updater.on('changed', state => {
    if (updateWindow && !updateWindow.isDestroyed()) updateWindow.webContents.send('updates:changed', state);
    const shouldNotify = state.phase === 'ready' || state.phase === 'available';
    if (shouldNotify && state.version !== notifiedVersion) {
      notifiedVersion = state.version;
      createUpdateWindow(false);
    }
  });
  updater.on('killswitch', ({ message }) => { log('UPDATE', message); app.quit(); });
  const watchSession = win => win.on('session-end', () => updater.sessionEnding());
  BrowserWindow.getAllWindows().forEach(watchSession);
  app.on('browser-window-created', (_event, win) => watchSession(win));
  if (supported) {
    void updater.check();
  }
}

function createUpdateWindow(focus = true) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    if (focus) { updateWindow.show(); updateWindow.focus(); }
    return;
  }
  updateWindow = new BrowserWindow({ width: 540, height: 600, minWidth: 360, minHeight: 420,
    show: false, frame: false, title: 'Overkot updates',
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  attachOverlayBlurHandler(updateWindow);
  updateWindow.once('ready-to-show', () => {
    if (!updateWindow || updateWindow.isDestroyed()) return;
    if (focus) updateWindow.show(); else updateWindow.showInactive();
  });
  updateWindow.loadFile(path.join(__dirname, 'renderer', 'update-window.html'));
  updateWindow.on('closed', () => { updateWindow = null; });
}

// ─── Window creation (mirrors Rust NativeOptions) ─────────
const { constrainBounds, restoreBounds } = require('./modules/windowGeometry');
const { createWindowDragController, rememberWindowSize, getWindowBounds, setWindowBounds } = require('./modules/windowDrag');

function restoredWindowBounds(configKey, defaults, minimum = {}, fixedSize = false) {
  const saved = config.get(configKey, null);
  const probe = {
    x: Number.isFinite(saved?.x) ? Math.round(saved.x) : screen.getPrimaryDisplay().workArea.x,
    y: Number.isFinite(saved?.y) ? Math.round(saved.y) : screen.getPrimaryDisplay().workArea.y,
    width: defaults.width,
    height: defaults.height,
  };
  const workArea = screen.getDisplayMatching(probe).workArea;
  return restoreBounds(fixedSize ? { ...saved, ...defaults } : saved, defaults, workArea, minimum);
}

function createMainWindow() {
  const initialBounds = railBounds(dockDisplay().bounds, config.get('dockEdge', 'bottom'));
  mainWindow = new BrowserWindow({
    ...initialBounds,
    // Give X11/XWayland compositors a panel hint so they do not tile or center
    // the screen-edge rail as an ordinary application window.
    ...(platformSupport.platform === 'linux' ? { type: 'dock' } : {}),
    minWidth: 1,
    minHeight: 1,
    frame: false,             // borderless
    transparent: true,        // per-pixel transparency
    alwaysOnTop: true,
    maximizable: false,
    resizable: false,
    movable: false,
    show: false,
    hasShadow: false,
    skipTaskbar: false,
    focusable: true,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  rememberWindowSize(mainWindow, initialBounds);
  let dockGeometryTimer = null;
  if (platformSupport.platform === 'win32'
    || (platformSupport.platform === 'linux' && ['x11', 'xwayland'].includes(platformSupport.displayBackend))) {
    const railWindow = mainWindow;
    const reconcileNativeGeometry = () => {
      clearTimeout(dockGeometryTimer);
      dockGeometryTimer = setTimeout(() => {
        dockGeometryTimer = null;
        if (mainWindow === railWindow && !railWindow.isDestroyed()) applyDockGeometry();
      }, 50);
    };
    // Native taskbars and X11 compositors can resize or reposition the rail
    // after mapping/restoring it. Linux does not implement movable:false.
    // Defer repair so native configure events can settle; cached intended
    // dimensions keep fractional X11 size rounding from causing a resize loop.
    for (const event of ['resize', 'move', 'show', 'restore']) mainWindow.on(event, reconcileNativeGeometry);
  }

  // Windows/macOS use the screen-saver level; Linux uses native window hints.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  configureOverlayWorkspace(mainWindow, platformSupport);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!overlayHiddenByUser && !config.get('launchToTray', false)) mainWindow.showInactive();
    applyDockGeometry();
    // Widgets may finish loading before the launcher becomes visible. Refresh
    // their visibility after mapping the rail so saved open panels appear too.
    syncWidgetWindows();
    focusReminder = createFocusReminder({ BrowserWindow, platformSupport,
      rendererDirectory: path.join(__dirname, 'renderer'),
      getDockBounds: () => railBounds(dockDisplay().bounds, config.get('dockEdge', 'bottom')),
      getDisplay: () => dockDisplay().bounds, getEdge: () => config.get('dockEdge', 'bottom'),
      getHotkey: () => registeredShortcut || config.get('interactionHotkey', 'Shift+F1'),
      getWarning: () => overlayShortcutWarning,
      getLanguage: () => config.get('language', 'en'),
      getFontFamily: () => Appearance.resolve(appearanceSession.effectiveConfig()).fontFamily,
      onRaised: raiseAlertWindows,
      canShow: () => !!mainWindow && !mainWindow.isDestroyed() && !overlayHiddenByUser
        && !mainHiddenForFocus && (mainWindow.isVisible() || dockAutoHidden),
    });
    if (launchFocusChordUsed) focusReminder.dismiss();
    else focusReminder.start();
  });

  // Re-assert always-on-top periodically (games can steal z-order)
  // Native dropdowns belong to their focused host. Raising any overlay window
  // over that host can cover the popup, including in floating/docked widgets.
  const alwaysOnTopTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !isAnyOverlayWindowFocused()) {
      const popouts = [settingsWindow, tutorialWindow, changelogWindow, widgetsWindow, groupFinderWindow, marketWindow, dailyBriefWindow, wikiWindow, mapWindow, dungeonOverlayWindow, calendarSettingsWindow, updateWindow];
      mainWindow.setAlwaysOnTop(true, 'screen-saver', dungeonOverlayWindow ? 3 : 0);
      for (const [, wWin] of widgetWindows) {
        if (!wWin.isDestroyed()) wWin.setAlwaysOnTop(true, 'screen-saver', dungeonOverlayWindow ? 2 : 0);
      }
      // Re-assert popout windows above widgets
      for (const w of popouts) {
        if (w && !w.isDestroyed()) w.setAlwaysOnTop(true, 'screen-saver', dungeonOverlayWindow && w !== dungeonOverlayWindow ? 4 : 1);
      }
      // Windows ignores relativeLevel; X11 relies on native fullscreen hints.
      // Explicit passive raises preserve the order within their shared layer.
      refreshOverlayWindowStack();
    }
    // Alerts also stay above focused popouts without raising other panels over
    // their native dropdowns.
    raiseAlertWindows();
  }, 2000);

  mainWindow.on('closed', () => {
    focusReminder?.dispose();
    focusReminder = null;
    clearTimeout(dockGeometryTimer);
    clearInterval(alwaysOnTopTimer);
    clearInterval(dockPollTimer);
    layoutKeyMonitor?.stop();
    destroyLayoutGrid();
    destroyDockWindow();
    mainWindow = null;
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    if (tutorialWindow && !tutorialWindow.isDestroyed()) tutorialWindow.close();
    if (changelogWindow && !changelogWindow.isDestroyed()) changelogWindow.close();
    if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
    if (widgetsWindow && !widgetsWindow.isDestroyed()) widgetsWindow.close();
    if (groupFinderWindow && !groupFinderWindow.isDestroyed()) groupFinderWindow.close();
    if (marketWindow && !marketWindow.isDestroyed()) marketWindow.close();
    if (dailyBriefWindow && !dailyBriefWindow.isDestroyed()) dailyBriefWindow.close();
    if (wikiWindow && !wikiWindow.isDestroyed()) wikiWindow.close();
    if (mapWindow && !mapWindow.isDestroyed()) mapWindow.close();
    if (calendarSettingsWindow && !calendarSettingsWindow.isDestroyed()) calendarSettingsWindow.close();
    closeDungeonOverlay();
    // Close all widget windows
    for (const [, wWin] of widgetWindows) {
      if (!wWin.isDestroyed()) wWin.destroy();
    }
    widgetWindows.clear();
    // Close all alert windows
    for (const win of alertWindows) {
      if (!win.isDestroyed()) win.destroy();
    }
    alertWindows.clear();
  });

  applyOverlayMousePolicy();
  mainWindow.on('blur', () => { dockKeyboardActive = false; });

  attachOverlayBlurHandler(mainWindow);
  mainWindow.on('focus', scheduleAppTutorial);

  if (DEBUG) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

/** Save window position (and optionally size for resizable windows) to config on move/resize. */
function trackWindowBounds(win, configKey, getBounds = () => win.getBounds(), onSaved = () => {}) {
  let timer = null;
  let pendingBounds = null;
  const cancelPending = () => {
    clearTimeout(timer);
    timer = null;
    pendingBounds = null;
  };
  win._cancelPendingBounds = cancelPending;
  const persist = () => {
    clearTimeout(timer);
    timer = null;
    if (win._layoutApplying) { pendingBounds = null; return; }
    const bounds = win.isDestroyed() ? pendingBounds : getBounds();
    pendingBounds = null;
    if (!bounds) return;
    const saved = config.get(configKey, null);
    if (!saved || ['x', 'y', 'width', 'height'].some(key => saved[key] !== bounds[key])) {
      if (config.set(configKey, bounds) !== false) onSaved(bounds);
    }
  };
  const save = () => {
    clearTimeout(timer);
    if (win._layoutApplying) { cancelPending(); return; }
    pendingBounds = getBounds();
    timer = setTimeout(persist, 300);
  };
  win.on('move', save);
  win.on('resize', save);
  win.on('close', persist);
  win.on('closed', persist);
}

// Tutorials begin only after an intentional interaction session. Startup and
// restored panels must not take focus from the game.
function scheduleAppTutorial() {
  setTimeout(() => {
    if (overlayInteractive && !overlayHiddenByUser && isAnyOverlayWindowFocused()
      && !isTutorialComplete(config.get('tutorialCompleted', {}), 'app')) createTutorialWindow('app');
  }, 150);
}

function createTutorialWindow(id = 'app', replay = false) {
  if (!TUTORIAL_IDS.includes(id) || (id === 'title-tracker' && !TITLE_TRACKER_ENABLED)
    || overlayHiddenByUser || (!overlayInteractive && !settingsWindow?.isFocused())) return false;
  if (!replay && (config.get('tutorialsEnabled', true) === false || isTutorialComplete(config.get('tutorialCompleted', {}), id))) return false;
  if (tutorialWindow && !tutorialWindow.isDestroyed()) {
    if (!replay || tutorialWindow._tutorialId === id) {
      // A rapid second chord can release input before the tutorial maps.
      // Resume the existing tour when interaction is enabled again.
      if (!tutorialWindow.webContents.isLoadingMainFrame()) focusTutorialWindow(tutorialWindow);
      return true;
    }
    tutorialWindow.destroy();
  }
  const area = dockDisplay().workArea;
  const width = Math.min(480, area.width), height = Math.min(520, area.height);
  const win = new BrowserWindow({ width, height,
    x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    show: false, frame: false, transparent: false, resizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  tutorialWindow = win;
  win._tutorialId = id;
  win.setAlwaysOnTop(true, 'screen-saver', dungeonOverlayWindow ? 4 : 1);
  attachOverlayBlurHandler(win);
  win.loadFile(path.join(__dirname, 'renderer', 'tutorial.html'), { query: { tour: id } });
  win.once('ready-to-show', () => focusTutorialWindow(win));
  win.once('closed', () => {
    if (tutorialWindow === win) tutorialWindow = null;
    if (!overlayInteractive || !mainWindow || mainWindow.isDestroyed() || overlayHiddenByUser) return;
    if (platformSupport.platform !== 'win32') {
      overlayFocusRequestedAt = Date.now();
      mainWindow.focus();
    }
    setImmediate(showPendingWidgetTutorial);
  });
  return true;
}

function focusTutorialWindow(win) {
  if (win.isDestroyed() || overlayHiddenByUser || (!overlayInteractive && !settingsWindow?.isFocused())) return;
  overlayFocusRequestedAt = Date.now();
  applyOverlayMousePolicy();
  win.show(); win.focus();
}

function showPendingWidgetTutorial() {
  if (config.get('tutorialsEnabled', true) === false || tutorialWindow || !overlayInteractive || !isTutorialComplete(config.get('tutorialCompleted', {}), 'app')) return;
  for (const id of pendingWidgetTutorials) {
    pendingWidgetTutorials.delete(id);
    const win = id === 'market' ? marketWindow : widgetWindows.get(id);
    if (win && !win.isDestroyed() && win.isVisible() && createTutorialWindow(id)) break;
  }
}

function requestWidgetTutorial(id) {
  if (config.get('tutorialsEnabled', true) === false || !overlayInteractive || isTutorialComplete(config.get('tutorialCompleted', {}), id)) return;
  const win = id === 'market' ? marketWindow : widgetWindows.get(id);
  if (!win || win.isDestroyed()) return;
  pendingWidgetTutorials.add(id);
  if (win.webContents.isLoadingMainFrame()) win.once('ready-to-show', showPendingWidgetTutorial);
  else showPendingWidgetTutorial();
}

ipcMain.handle('tutorial:open', (event, id = 'app') => {
  const host = BrowserWindow.fromWebContents(event.sender);
  if (![mainWindow, settingsWindow, tutorialWindow, ...widgetWindows.values()].includes(host)) return false;
  return createTutorialWindow(id, true);
});
ipcMain.handle('tutorial:complete', (event, id) => {
  if (!tutorialWindow || BrowserWindow.fromWebContents(event.sender) !== tutorialWindow || tutorialWindow._tutorialId !== id) return false;
  if (config.set('tutorialCompleted', completeTutorial(config.get('tutorialCompleted', {}), id)) === false) return false;
  broadcastDockConfig();
  return true;
});
ipcMain.handle('tutorial:set-enabled', (event, enabled) => {
  const host = BrowserWindow.fromWebContents(event.sender);
  if (![settingsWindow, tutorialWindow].includes(host) || !host || typeof enabled !== 'boolean') return false;
  if (config.set('tutorialsEnabled', enabled) === false) return false;
  if (!enabled) pendingWidgetTutorials.clear();
  broadcastDockConfig();
  // The renderer closes a tour only after the save has succeeded. Settings
  // can also switch tours off while a tour is open.
  if (!enabled && host === settingsWindow) closeWithoutChangingFocus(tutorialWindow);
  return true;
});

// ─── Settings window ─────────────────────────────────────
function createSettingsWindow(section) {
  const requestedSection = section === 'connections' ? 'connections' : null;
  if (overlayHiddenByUser) return;
  // Opening Settings is an explicit interaction request. Unlock before
  // mapping the window so Windows does not change activation styles on show.
  gameFocusRequest?.abort();
  gameFocusRequest = null;
  overlayInteractive = true;
  overlayFocusRequestedAt = Date.now();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (requestedSection) {
      settingsWindow._settingsSection = requestedSection;
      settingsWindow.webContents.send('settings:section', requestedSection);
    }
    showSettingsWindow(settingsWindow);
    return;
  }
  const win = new BrowserWindow({
    ...settingsWindowBounds(config.get('settingsHubBounds'), screen),
    show: false,
    frame: false, transparent: false, resizable: true, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#1b1b1b', paintWhenInitiallyHidden: true,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false },
  });
  settingsWindow = win;
  win._settingsSection = requestedSection;
  win.webContents.on('did-finish-load', () => {
    if (win._settingsSection) win.webContents.send('settings:section', win._settingsSection);
  });
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  // Keep painting after native focusability/visibility changes, including
  // restoring a previously passive Settings window over a fullscreen game.
  win.on('show', () => win.webContents.invalidate());
  win.once('ready-to-show', () => showSettingsWindow(win));
  trackWindowBounds(win, 'settingsHubBounds');
  win.on('close', () => config.set('settingsHubBounds', win.getBounds()));
  attachOverlayBlurHandler(win);
  win.on('closed', () => { settingsWindow = null; endShortcutCapture(); });
  applyOverlayMousePolicy();
  win.loadFile(path.join(__dirname, 'renderer', 'settings.html'), requestedSection ? { query: { section: requestedSection } } : undefined);
}

function showSettingsWindow(win) {
  if (win.isDestroyed() || overlayHiddenByUser || !overlayInteractive) return;
  overlayFocusRequestedAt = Date.now();
  applyOverlayMousePolicy();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ─── Changelog window ────────────────────────────────────
function createChangelogWindow() {
  if (changelogWindow && !changelogWindow.isDestroyed()) {
    changelogWindow.focus();
    return;
  }

  changelogWindow = new BrowserWindow({
    ...restoredWindowBounds('changelogBounds', { width: 450, height: 500 }, { width: 300, height: 200 }),
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  changelogWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  changelogWindow.loadFile(path.join(__dirname, 'renderer', 'changelog-window.html'));
  trackWindowBounds(changelogWindow, 'changelogBounds');
  attachOverlayBlurHandler(changelogWindow);
  changelogWindow.on('closed', () => { changelogWindow = null; });
}

// ─── Alert window (one per timer completion) ──────────────
function canShowAlerts() {
  if (!mainWindow || mainWindow.isDestroyed() || marketShutdownStarted || config.get('enableAlertPopup', true) === false) return false;
  if (config.get('showAlertsWhenHidden', false) === true) return true;
  return !overlayHiddenByUser && !gameHiddenActive && !mainHiddenForFocus && !mainWindow.isMinimized()
    && (mainWindow.isVisible() || dockAutoHidden);
}

function syncAlertVisibility() {
  const visible = canShowAlerts();
  for (const win of alertWindows) {
    if (win.isDestroyed() || !win._alertReady) continue;
    if (!visible) win.hide();
    else if (!win.isVisible()) win.showInactive();
  }
  raiseAlertWindows();
}

function createAlertWindow(data) {
  if (!canShowAlerts()) return;
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const alertW = 320;
  const alertH = 72;
  const margin = 12;

  // Stack alerts from the bottom-right corner, offset by existing alert count
  const stackIndex = alertWindows.size;
  const xPos = workArea.x + workArea.width - alertW - margin;
  const yPos = Math.max(workArea.y, workArea.y + workArea.height - (alertH + margin) * (stackIndex + 1));

  const alertWin = new BrowserWindow({
    width: alertW,
    height: alertH,
    x: xPos,
    y: yPos,
    frame: false,
    transparent: true,
    show: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // macOS uses relativeLevel; Windows/X11 also need explicit passive raises.
  alertWin.setAlwaysOnTop(true, 'screen-saver', 5);
  configureOverlayWorkspace(alertWin, platformSupport);
  alertWin.loadFile(path.join(__dirname, 'renderer', 'alert-window.html'));

  alertWin.webContents.once('did-finish-load', () => {
    alertWin.webContents.send('alert-data', data);
  });

  alertWindows.add(alertWin);
  alertWin.once('ready-to-show', () => {
    if (alertWin.isDestroyed()) return;
    alertWin._alertReady = true;
    // Visibility can change while the renderer is loading.
    syncAlertVisibility();
  });

  alertWin.on('closed', () => {
    alertWindows.delete(alertWin);
    repositionAlertWindows();
  });

  log('ALERT', `Showing alert for "${data.name}"`);
}

/** Alert buttons dismiss only their own popup, even while the overlay is passive. */
function dismissAlertWindow(event) {
  if (!event?.sender || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !alertWindows.has(win)) return false;
  // The closed handler owns membership and re-stacking. No focus or overlay
  // interaction change is needed to dismiss a nonactivating alert.
  win.destroy();
  return true;
}

/** Re-stack remaining alert windows after one is dismissed */
function repositionAlertWindows() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const alertW = 320;
  const alertH = 72;
  const margin = 12;
  let idx = 0;
  for (const win of alertWindows) {
    if (!win.isDestroyed()) {
      const xPos = workArea.x + workArea.width - alertW - margin;
      const yPos = Math.max(workArea.y, workArea.y + workArea.height - (alertH + margin) * (idx + 1));
      win.setPosition(xPos, yPos);
      idx++;
    }
  }
}

// ─── Widgets window ────────────────────────────────────────
function createCalendarSettingsWindow(sender) {
  if (calendarSettingsWindow && !calendarSettingsWindow.isDestroyed()) {
    calendarSettingsWindow.show(); calendarSettingsWindow.focus(); return;
  }
  const parent = sender && BrowserWindow.fromWebContents(sender);
  const anchor = parent?.getBounds() || mainWindow?.getBounds() || { x: 100, y: 100, width: 300, height: 300 };
  const area = screen.getDisplayMatching(anchor).workArea;
  const saved = config.get('calendarSettingsBounds', {});
  const width = Math.min(area.width, 370), height = Math.min(area.height, 610);
  const x = Math.max(area.x, Math.min(area.x + area.width - width, Number.isFinite(saved.x) ? saved.x : anchor.x + anchor.width + 8));
  const y = Math.max(area.y, Math.min(area.y + area.height - height, Number.isFinite(saved.y) ? saved.y : anchor.y));
  calendarSettingsWindow = new BrowserWindow({
    x, y, width, height, minWidth: 300, minHeight: 320,
    frame: false, transparent: false, resizable: true, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  calendarSettingsWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  calendarSettingsWindow.loadFile(path.join(__dirname, 'renderer', 'calendar-settings.html'));
  trackWindowBounds(calendarSettingsWindow, 'calendarSettingsBounds');
  attachOverlayBlurHandler(calendarSettingsWindow);
  calendarSettingsWindow.on('closed', () => { calendarSettingsWindow = null; });
}

function createWidgetsWindow() {
  if (widgetsWindow && !widgetsWindow.isDestroyed()) {
    widgetsWindow.show();
    widgetsWindow.focus();
    return;
  }

  // A new bounds key replaces the old fixed-width list's saved geometry.
  const saved = config.get('widgetsPickerBounds');
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]));
  const area = valid ? screen.getDisplayMatching(saved).workArea
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const minWidth = Math.min(380, area.width), minHeight = Math.min(300, area.height);
  const width = Math.round(Math.min(area.width, Math.max(minWidth, valid ? saved.width : 720)));
  const height = Math.round(Math.min(area.height, Math.max(minHeight, valid ? saved.height : 620)));
  const x = Math.round(Math.max(area.x, Math.min(valid ? saved.x : area.x + (area.width - width) / 2, area.x + area.width - width)));
  const y = Math.round(Math.max(area.y, Math.min(valid ? saved.y : area.y + (area.height - height) / 2, area.y + area.height - height)));
  const picker = new BrowserWindow({
    x, y, width, height, minWidth, minHeight,
    frame: false,
    transparent: false,
    resizable: true,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  widgetsWindow = picker;
  picker.setAlwaysOnTop(true, 'screen-saver', 1);
  picker.loadFile(path.join(__dirname, 'renderer', 'widgets-window.html'));
  trackWindowBounds(picker, 'widgetsPickerBounds');
  // Persist immediately when closing, including a resize just before close.
  picker.on('close', () => config.set('widgetsPickerBounds', picker.getBounds()));
  attachOverlayBlurHandler(picker);
  picker.on('closed', () => { widgetsWindow = null; });
}

// ─── Standalone widget windows ────────────────────────────
// Market and Daily Brief launch separate pop-outs from their bar icons.
const ALL_WIDGET_IDS = ['boss', 'crafting', 'other', 'affiliation', 'factions', 'odeinfamy', 'wiki', 'groupfinder', 'minimap', 'arena', 'world-watch', 'clock', 'weather', 'build-exporter', 'temper-tracker', 'wolf-training', 'data-inventory', 'data-ee-log', 'player', ...COLLECTION_WIDGET_IDS];
if (TITLE_TRACKER_ENABLED) ALL_WIDGET_IDS.push('title-tracker');

function widgetWindowDimensions(widgetId) {
  return WidgetSizing.widgetDimensions(widgetId);
}

function watchDockedWidgetGeometry(win) {
  if (platformSupport.platform !== 'linux' || !['x11', 'xwayland'].includes(platformSupport.displayBackend)) return;
  let geometryTimer = null;
  const reconcile = () => {
    if (layoutEditing || config.get('widgetDocked', {})[win._widgetId] === false) return;
    clearTimeout(geometryTimer);
    geometryTimer = setTimeout(() => {
      geometryTimer = null;
      // A compositor can move a normal Linux window without our drag IPC.
      // Keep attached panels in their shelf, while Shift editing and saved
      // floating panels continue to own their positions.
      if (!win.isDestroyed() && !layoutEditing && config.get('widgetDocked', {})[win._widgetId] !== false) layoutDockedPanels();
    }, 50);
  };
  for (const event of ['move', 'resize', 'show', 'restore']) win.on(event, reconcile);
  win.once('closed', () => clearTimeout(geometryTimer));
}

function createWidgetWindow(widgetId) {
  if (!ALL_WIDGET_IDS.includes(widgetId)) return null;
  if (widgetWindows.has(widgetId)) {
    const existing = widgetWindows.get(widgetId);
    if (!existing.isDestroyed()) return existing;
    widgetWindows.delete(widgetId);
  }

  const savedKey = `widgetBounds_${widgetId}`;
  const dimensions = widgetWindowDimensions(widgetId);
  const restored = restoredWindowBounds(savedKey,
    { width: dimensions.width, height: dimensions.height },
    { width: dimensions.minWidth, height: dimensions.minHeight });
  const size = WidgetSizing.normalizeSize(widgetId, config.get('widgetSizes', {})[widgetId]);
  const initialBounds = restoreBounds({ ...restored,
    width: size.width ?? restored.width, height: size.height ?? restored.height }, dimensions,
  screen.getDisplayMatching(restored).workArea, { width: dimensions.minWidth, height: dimensions.minHeight });
  if (size.width !== null && size.width !== initialBounds.width || size.height !== null && size.height !== initialBounds.height) {
    config.set('widgetSizes', { ...config.get('widgetSizes', {}), [widgetId]: {
      width: size.width === null ? null : initialBounds.width, height: size.height === null ? null : initialBounds.height } });
  }

  const win = new BrowserWindow({
    ...initialBounds,
    ...(platformSupport.platform === 'linux' ? { type: 'dock' } : {}),
    minWidth: dimensions.minWidth,
    minHeight: dimensions.minHeight,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    maximizable: false,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  rememberWindowSize(win, initialBounds);

  win.setAlwaysOnTop(true, 'screen-saver', dungeonOverlayWindow ? 2 : 0);
  configureOverlayWorkspace(win, platformSupport);
  // Non-resizable Windows windows report their current bounds as native
  // minimums after setBounds. Retain our intended limits separately.
  win._widgetMinimumSize = [dimensions.minWidth, dimensions.minHeight];
  win.loadFile(path.join(__dirname, 'renderer', 'widget-host.html'), { query: { widget: widgetId } });

  win._widgetId = widgetId;
  trackWindowBounds(win, savedKey, () => getWindowBounds(win), () => {
    // Auto-height can settle after a Settings Apply/Reset reply. Keep its
    // current-size readout in sync with the final native geometry.
    if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible()) {
      settingsWindow.webContents.send('config-changed', appearanceSession.effectiveConfig());
    }
  });
  watchDockedWidgetGeometry(win);

  attachOverlayBlurHandler(win);

  win.on('closed', () => {
    widgetWindows.delete(widgetId);
  });
  win.on('focus', () => { if (widgetId !== 'daily') requestWidgetTutorial(widgetId); });

  win.once('ready-to-show', () => {
    syncWidgetWindows();
    win.webContents.send('layout-editing', layoutEditing);
  });
  widgetWindows.set(widgetId, win);
  applyOverlayMousePolicy();
  log('WIDGET', `Created widget window: ${widgetId}`);
  return win;
}

function destroyWidgetWindow(widgetId) {
  const win = widgetWindows.get(widgetId);
  if (win && !win.isDestroyed()) win.destroy();
  widgetWindows.delete(widgetId);
}

// Every panel keeps its existing renderer and can switch between attached and floating.
let dockWindow = null; // Retained for broadcasts to legacy embedded hosts; never created.
function destroyDockWindow() {}

function dockDisplay() {
  const displays = screen.getAllDisplays();
  const savedId = config.get('dockDisplayId');
  return displays.find(display => display.id === savedId)
    || (normalizeDisplayId(savedId) !== null ? screen.getPrimaryDisplay()
      : config.get('windowBounds') ? screen.getDisplayMatching(config.get('windowBounds')) : screen.getPrimaryDisplay());
}

function overlayDisplaysSnapshot() {
  const displays = screen.getAllDisplays(), primary = screen.getPrimaryDisplay();
  const preferredDisplayId = normalizeDisplayId(config.get('dockDisplayId'));
  return { displays: displayOptions(displays, primary.id), selectedDisplayId: dockDisplay().id, preferredDisplayId,
    usingFallback: preferredDisplayId !== null && !displays.some(display => display.id === preferredDisplayId) };
}

function broadcastOverlayDisplays() {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('overlay-displays-changed', overlayDisplaysSnapshot());
}

function dockState() {
  return { edge: validEdge(config.get('dockEdge', 'bottom')), autoHidden: dockAutoHidden,
    layoutEditing, redockTarget, shortcutWarning: visibilityShortcutWarning,
    marketOpen: !!marketWindow && !marketWindow.isDestroyed(),
    dailyOpen: !!dailyBriefWindow && !dailyBriefWindow.isDestroyed() && dailyBriefWindow.isVisible() && !dailyBriefWindow.isMinimized() };
}

function pushDockState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dock-state', dockState());
}

function broadcastDockConfig() {
  const allConfig = appearanceSession.effectiveConfig();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('config-changed', allConfig);
  }
  pushDockState();
}

function applyDockGeometry() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = dockDisplay();
  const bounds = railBounds(display.bounds, config.get('dockEdge', 'bottom'));
  // The intended-size cache protects fractional X11 rounding, but can hide a
  // Windows taskbar clamp. Compare the actual native rail rectangle on Windows.
  const previous = platformSupport.platform === 'win32' ? mainWindow.getBounds() : getWindowBounds(mainWindow);
  // Mapping fractional physical pixels back to DIPs can also round the X11
  // origin by one DIP. Treat that as settled rather than repeatedly configuring
  // the same rectangle; substantial compositor moves still return to the edge.
  const originTolerance = platformSupport.platform === 'linux' ? 1 : 0;
  if (['x', 'y', 'width', 'height'].some(key =>
    Math.abs(bounds[key] - previous[key]) > (key === 'x' || key === 'y' ? originTolerance : 0))) {
    setWindowBounds(mainWindow, bounds);
  }
  // Keep an explicitly selected monitor through a temporary disconnect.
  if (normalizeDisplayId(config.get('dockDisplayId')) === null) config.set('dockDisplayId', display.id);
  if (dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed()) {
    const previousMap = dungeonOverlayWindow.getBounds();
    if (['x', 'y', 'width', 'height'].some(key => display.bounds[key] !== previousMap[key])) dungeonOverlayWindow.setBounds(display.bounds);
  }
  applyOverlayMousePolicy();
  layoutDockedPanels();
  pushDockState();
}

function layoutDockedPanels() {
  if (layoutEditing) return;
  const docked = config.get('widgetDocked', {});
  const open = config.get('widgetOpen', {});
  const order = [...new Set([...config.get('dockWidgetOrder', []), ...ALL_WIDGET_IDS])];
  const items = order.filter(id => open[id] === true && docked[id] !== false && widgetWindows.has(id)
    && !(id === 'minimap' && dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed()))
    .map(id => ({ id, ...getWindowBounds(widgetWindows.get(id)) }));
  const display = dockDisplay();
  for (const next of layoutDockedWidgets(items, display.workArea, config.get('dockEdge', 'bottom'), display.bounds, dockAutoHidden)) {
    const win = widgetWindows.get(next.id);
    const bounds = getWindowBounds(win);
    const originTolerance = platformSupport.platform === 'linux' ? 1 : 0;
    if (['x', 'y', 'width', 'height'].some(key =>
      Math.abs(next[key] - bounds[key]) > (key === 'x' || key === 'y' ? originTolerance : 0))) {
      const { id, ...geometry } = next;
      setWindowBounds(win, geometry);
    }
  }
}

function syncWidgetWindows() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const enabled = config.get('widgetVisibility', {}), open = config.get('widgetOpen', {});
  for (const id of ALL_WIDGET_IDS) {
    const exists = widgetWindows.has(id) && !widgetWindows.get(id).isDestroyed();
    if (enabled[id] !== true) {
      if (exists) destroyWidgetWindow(id);
      continue;
    }
    // Hidden panels remain mounted so toggling doesn't discard in-progress input.
    if (open[id] === true && !exists) createWidgetWindow(id);
    const win = widgetWindows.get(id);
    if (!win || win.isDestroyed()) continue;
    if (open[id] === true && !(id === 'minimap' && dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed())
      && !overlayHiddenByUser && !gameHiddenActive && (mainWindow?.isVisible() || dockAutoHidden)) {
      win.showInactive();
    } else win.hide();
  }
  applyOverlayMousePolicy();
  layoutDockedPanels();
  if (dungeonOverlayWindow) refreshOverlayWindowStack();
  else raiseAlertWindows();
}

function applyLayoutMode() {
  setDockAutoHidden(false);
  applyDockGeometry();
  syncWidgetWindows();
}

function setDockAutoHidden(hidden) {
  if (dockAutoHidden === hidden) return;
  dockAutoHidden = hidden;
  applyDockGeometry();
  if (hidden) mainWindow?.hide();
  else if (!overlayHiddenByUser && !mainHiddenForFocus) mainWindow?.showInactive();
}

function toggleDockWidget(id) {
  if (id === 'daily') {
    if (config.get('widgetVisibility', {}).daily !== true) return false;
    if (dailyBriefWindow && !dailyBriefWindow.isDestroyed() && dailyBriefWindow.isVisible() && !dailyBriefWindow.isMinimized()) dailyBriefPopout.close();
    else openDailyBriefWindow();
    pushDockState();
    return true;
  }
  if (!ALL_WIDGET_IDS.includes(id) || config.get('widgetVisibility', {})[id] !== true) return false;
  if (id === 'minimap' && dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed()) closeDungeonOverlay();
  const open = { ...config.get('widgetOpen', {}) };
  open[id] = open[id] !== true;
  config.set('widgetOpen', open);
  setDockAutoHidden(false);
  lastDockHover = Date.now();
  syncWidgetWindows();
  broadcastDockConfig();
  if (open[id]) requestWidgetTutorial(id);
  return true;
}

ipcMain.handle('dock-toggle-widget', (event, id) => {
  if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return false;
  return toggleDockWidget(id);
});
ipcMain.on('dock-keyboard-active', (event, active) => {
  if (BrowserWindow.fromWebContents(event.sender) === mainWindow) dockKeyboardActive = !!active;
});

function destroyLayoutGrid() {
  for (const win of layoutGridWindows.values()) if (!win.isDestroyed()) win.destroy();
  layoutGridWindows.clear();
}

function raiseLayoutWindows() {
  // Show the scrim first and then all overlay content above it on Windows.
  for (const win of layoutGridWindows.values()) if (!win.isDestroyed()) win.moveTop();
  for (const win of [...widgetWindows.values(), mainWindow]) {
    if (win && !win.isDestroyed() && win.isVisible()) win.moveTop();
  }
  raiseAlertWindows();
}

function showLayoutGrid() {
  const effective = appearanceSession.effectiveConfig();
  const { locale, labels } = windowMessages(effective.language, ['dockDropHint']);
  const font = Appearance.fontStack(Appearance.resolve(effective).fontFamily, locale);
  for (const display of screen.getAllDisplays()) {
    const win = new BrowserWindow({ ...display.bounds, frame: false, transparent: true,
      show: false, focusable: false, skipTaskbar: true, resizable: false, movable: false,
      hasShadow: false, enableLargerThanScreen: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false } });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    layoutGridWindows.set(display.id, win);
    win.loadFile(path.join(__dirname, 'renderer', 'layout-grid.html'), { query: { locale, hint: labels.dockDropHint, font } });
    win.once('ready-to-show', () => {
      if (!layoutEditing || win.isDestroyed()) return;
      win.showInactive();
      win.setBounds(display.bounds);
      raiseLayoutWindows();
    });
  }
}

function finishWidgetDrag(win, cancelled = false) {
  if (!win || win.isDestroyed()) return;
  const id = win._widgetId;
  if (!id || !win._isDragging) { windowDrag.end(win, !cancelled); return; }
  const origin = win._layoutDragOrigin;
  const finalBounds = windowDrag.end(win, !cancelled) || getWindowBounds(win);
  const moved = origin && (origin.x !== finalBounds.x || origin.y !== finalBounds.y);
  win._layoutDragOrigin = null;
  if (!moved || cancelled) return;
  const docked = { ...config.get('widgetDocked', {}) };
  const drop = pointInBounds(screen.getCursorScreenPoint(), railBounds(dockDisplay().bounds, config.get('dockEdge', 'bottom')), 24);
  docked[id] = drop;
  config.set('widgetDocked', docked);
  win._layoutDragBounds = drop ? null : finalBounds;
  if (!drop) layoutMovedWidgets.add(id);
  redockTarget = false;
  broadcastDockConfig();
  if (!layoutEditing) layoutDockedPanels();
}

function setLayoutEditing(editing) {
  if (editing === layoutEditing) return;
  if (editing && (overlayHiddenByUser || !isAnyOverlayWindowFocused() || (!mainWindow?.isVisible() && !dockAutoHidden) || shortcutCapture || settingsWindow?.isFocused() || tutorialWindow?.isFocused()
    || (gameHiddenActive && appStatus !== 'waiting'))) return;
  if (!editing) {
    // Finish the gesture before aligning. Delayed renderer moves are rejected below.
    for (const win of widgetWindows.values()) {
      finishWidgetDrag(win);
      if (win._manualResizePreview) commitWidgetResize(win);
    }
  }
  layoutEditing = editing;
  redockTarget = false;
  if (editing) {
    layoutMovedWidgets.clear();
    setDockAutoHidden(false);
    showLayoutGrid();
  } else {
    destroyLayoutGrid();
    const docked = config.get('widgetDocked', {});
    for (const id of layoutMovedWidgets) {
      const win = widgetWindows.get(id);
      if (!win || win.isDestroyed()) continue;
      const liveBounds = getWindowBounds(win);
      // Content fitting or a later resize can legitimately change dimensions
      // while Shift remains held; only the final requested origin is deferred.
      const placement = win._layoutDragBounds
        ? { ...liveBounds, x: win._layoutDragBounds.x, y: win._layoutDragBounds.y } : liveBounds;
      win._layoutDragBounds = null;
      if (docked[id] !== false) continue;
      const display = screen.getDisplayMatching(placement);
      const bounds = snapWidgetToGrid(placement, display, config.get('dockEdge', 'bottom'), display.id === dockDisplay().id);
      setWindowBounds(win, bounds);
      config.set('widgetBounds_' + id, bounds);
    }
    layoutMovedWidgets.clear();
    layoutDockedPanels();
  }
  for (const win of [mainWindow, ...widgetWindows.values()]) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send('layout-editing', editing);
  }
  applyOverlayMousePolicy();
  if (editing) raiseLayoutWindows();
  lastDockHover = Date.now();
  pushDockState();
}

function onGlobalShift(held) {
  clearTimeout(shiftStartTimer);
  if (!held) setLayoutEditing(false);
  else if (isAnyOverlayWindowFocused()) shiftStartTimer = setTimeout(() => setLayoutEditing(true), 120);
}

function onNativeForeground(pid) {
  const changed = nativeOverlayForeground !== (pid === process.pid);
  nativeOverlayForeground = pid === process.pid;
  if (!nativeOverlayForeground && Date.now() - overlayFocusRequestedAt >= 200) {
    clearTimeout(shiftStartTimer);
    setLayoutEditing(false);
    if (overlayInteractive) toggleOverlayInteraction(true);
  }
  if (changed) applyOverlayMousePolicy();
}

function startDockRuntime() {
  layoutKeyMonitor = startLayoutKeyMonitor({ onShift: onGlobalShift,
    onForeground: pid => onNativeForeground(pid),
    onButtonUp: () => { for (const win of widgetWindows.values()) finishWidgetDrag(win); },
    onError: error => {
      nativeLayoutTracking = false;
      nativeOverlayForeground = null;
      clearTimeout(shiftStartTimer);
      setLayoutEditing(false);
      for (const win of [mainWindow, ...widgetWindows.values()]) {
        if (win && !win.isDestroyed()) win.webContents.send('layout-key-monitor-status', false);
      }
      log('LAYOUT', `Global Shift tracking unavailable; using renderer events: ${error.message}`);
    } });
  dockPollTimer = setInterval(() => {
    // Reconcile even while the rail is auto-hidden: native blur events can be
    // missed when windows close or the fullscreen game regains focus.
    if ((overlayInteractive || layoutEditing) && Date.now() - overlayFocusRequestedAt >= 200 && !isAnyOverlayWindowFocused()) {
      setLayoutEditing(false);
      if (overlayInteractive) toggleOverlayInteraction(true);
    }
    if (!mainWindow || mainWindow.isDestroyed() || (!mainWindow.isVisible() && !dockAutoHidden) || overlayHiddenByUser || mainHiddenForFocus) return;
    const overlayFocused = isAnyOverlayWindowFocused();
    const pointerInteraction = overlayFocused && (overlayInteractive || layoutEditing);
    const point = screen.getCursorScreenPoint();
    const rail = railBounds(dockDisplay().bounds, config.get('dockEdge', 'bottom'));
    // Cursor polling sees game mouse movement and drags even through ignored
    // windows. Only an active, focused overlay may use it to reveal the rail.
    const hovered = pointerInteraction && pointInBounds(point, dockAutoHidden ? railBounds(dockDisplay().bounds, config.get('dockEdge', 'bottom'), true) : rail);
    const target = pointerInteraction && layoutEditing && [...widgetWindows.values()].some(win => win._isDragging) && pointInBounds(point, rail, 24);
    if (target !== redockTarget) { redockTarget = target; pushDockState(); }
    const overPanel = pointerInteraction && [...widgetWindows.values()].some(win => !win.isDestroyed() && win.isVisible() && pointInBounds(point, getWindowBounds(win)));
    const popoutFocused = [settingsWindow, tutorialWindow, widgetsWindow, changelogWindow, marketWindow, dailyBriefWindow, wikiWindow, groupFinderWindow, mapWindow, dungeonOverlayWindow, calendarSettingsWindow, updateWindow]
      .some(win => win && !win.isDestroyed() && win.isFocused());
    // Keep an open rail stable while input is in a widget or its native menu,
    // including keyboard navigation with the pointer outside the widget.
    const panelInteraction = overlayInteractive && !dockAutoHidden && !mainWindow.isFocused();
    const focusedActivity = overlayFocused && (layoutEditing || popoutFocused || panelInteraction || (dockKeyboardActive && mainWindow.isFocused()));
    if (hovered || (overPanel && !dockAutoHidden) || focusedActivity) { lastDockHover = Date.now(); setDockAutoHidden(false); }
    else if (config.get('dockAutoHide', false) && Date.now() - lastDockHover > 850) setDockAutoHidden(true);
    else if (!config.get('dockAutoHide', false)) setDockAutoHidden(false);
  }, 60);
  const displayChanged = () => { setLayoutEditing(false); applyDockGeometry(); broadcastOverlayDisplays(); };
  screen.on('display-metrics-changed', displayChanged);
  screen.on('display-added', displayChanged);
  screen.on('display-removed', displayChanged);
}

function setOverlayHidden(hidden) {
  if (overlayHiddenByUser === hidden) return;
  overlayHiddenByUser = hidden;
  if (hidden) {
    gameFocusRequest?.abort();
    clearTimeout(shiftStartTimer);
    setLayoutEditing(false);
    if (overlayInteractive) toggleOverlayInteraction(true);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (alertWindows.has(win) || win._moonsteelAlert) continue;
      win._visibleBeforeOverlayHide = win.isVisible();
      win.hide();
    }
    createTray();
  } else {
    setDockAutoHidden(false);
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.showInactive();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !alertWindows.has(win) && !win._moonsteelAlert && win._visibleBeforeOverlayHide && !win._widgetId) {
        if (win === dailyBriefWindow && win.isMinimized()) continue;
        if (win.isMinimized()) win.restore();
        win.showInactive();
      }
      win._visibleBeforeOverlayHide = false;
    }
    syncWidgetWindows();
    applyGameHiddenState();
    destroyTray();
  }
  syncAlertVisibility();
}

function registerVisibilityShortcut() {
  if (registeredVisibilityShortcut) globalShortcut.unregister(registeredVisibilityShortcut);
  registeredVisibilityShortcut = null;
  visibilityShortcutWarning = '';
  if (shortcutCapture) return;
  const hotkey = config.get('overlayVisibilityHotkey', 'Shift+F2');
  try {
    if (globalShortcut.register(hotkey, () => setOverlayHidden(!overlayHiddenByUser))) registeredVisibilityShortcut = hotkey;
    else visibilityShortcutWarning = `${hotkey.replaceAll('+', ' + ')} is unavailable. Choose another overlay visibility shortcut in Settings.`;
  } catch { visibilityShortcutWarning = 'The overlay visibility shortcut is invalid. Choose another shortcut in Settings.'; }
  pushDockState();
  pushStateToRenderer();
}

function endShortcutCapture() {
  if (!shortcutCapture) return;
  shortcutCapture = false;
  registerOverlayShortcut();
  registerVisibilityShortcut();
}

ipcMain.on('shortcut-capture', (event, active) => {
  if (BrowserWindow.fromWebContents(event.sender) !== settingsWindow) return;
  if (!active) { endShortcutCapture(); return; }
  shortcutCapture = true;
  setLayoutEditing(false);
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  if (registeredVisibilityShortcut) globalShortcut.unregister(registeredVisibilityShortcut);
  registeredShortcut = registeredVisibilityShortcut = null;
});

ipcMain.on('layout-editing-request', (event, editing) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== mainWindow && !win?._widgetId) return;
  // On Windows the native monitor owns key-up across all apps. Renderer events
  // give immediate feedback on key-down while interacting with a panel.
  if (!nativeLayoutTracking) setLayoutEditing(!!editing);
  else if (editing) setLayoutEditing(true);
  // A renderer may optimistically start a fast Shift gesture. Reject it back
  // to that surface when focus or shortcut capture prevents entering layout.
  if (editing && !layoutEditing) win.webContents?.send('layout-editing', false);
});

function resetWidgetPositions() {
  config.set('widgetDocked', {});
  layoutMovedWidgets.clear();
  layoutDockedPanels();
  broadcastDockConfig();
}

function resetWidgetSizes() {
  if (config.set('widgetSizes', {}) === false) return false;
  for (const widgetId of ALL_WIDGET_IDS) applyWidgetSize(widgetId, null);
  broadcastDockConfig();
  return true;
}

/** Apply size intent without moving a panel unless it would leave the screen. */
function clampWidgetSize(widgetId, value) {
  const dimensions = widgetWindowDimensions(widgetId), size = WidgetSizing.normalizeSize(widgetId, value);
  const win = widgetWindows.get(widgetId);
  const saved = win && !win.isDestroyed() ? getWindowBounds(win) : config.get(`widgetBounds_${widgetId}`);
  const area = saved ? screen.getDisplayMatching(saved).workArea : dockDisplay().workArea;
  const bounds = restoreBounds({ ...saved, width: size.width ?? dimensions.width,
    height: size.height ?? dimensions.height }, dimensions, area,
  { width: dimensions.minWidth, height: dimensions.minHeight });
  return { width: size.width === null ? null : bounds.width, height: size.height === null ? null : bounds.height };
}

function applyWidgetSize(widgetId, value) {
  const win = widgetWindows.get(widgetId);
  const dimensions = widgetWindowDimensions(widgetId);
  const size = WidgetSizing.normalizeSize(widgetId, value);
  const saved = win && !win.isDestroyed() ? getWindowBounds(win) : config.get(`widgetBounds_${widgetId}`);
  const area = saved ? screen.getDisplayMatching(saved).workArea : dockDisplay().workArea;
  const next = restoreBounds({ ...saved, width: size.width ?? dimensions.width,
    height: size.height ?? dimensions.height }, dimensions, area,
  { width: dimensions.minWidth, height: dimensions.minHeight });
  if (win && !win.isDestroyed()) {
    win._manualResizePreview = null;
    win._cancelPendingBounds?.();
    win._layoutApplying = true;
    try { setWindowBounds(win, next); }
    finally { win._layoutApplying = false; }
    // The config broadcast owns manual-vs-Auto intent. The renderer restores
    // content fitting only after receiving those updated choices.
    win.webContents.send('config-changed', appearanceSession.effectiveConfig());
    win.webContents.send('layout-widget-bounds', next);
    if (size.width === null && size.height === null) win.webContents.send('reset-widget-sizes');
  }
  config.set(`widgetBounds_${widgetId}`, next);
}

function commitWidgetResize(win) {
  const id = win?._widgetId, preview = win?._manualResizePreview;
  if (!id || !preview || win.isDestroyed()) return false;
  const size = WidgetSizing.normalizeSize(id, preview);
  const next = { ...WidgetSizing.normalizeSizes(config.get('widgetSizes', {})), [id]: size };
  if (config.setMany({ widgetSizes: next, [`widgetBounds_${id}`]: getWindowBounds(win) }) === false) return false;
  win._manualResizePreview = null;
  broadcastDockConfig();
  return true;
}

// ─── Group Finder window ──────────────────────────────────
const GF_DEFAULT_WIDTH = 520;
const GF_DEFAULT_HEIGHT = 680;
const GF_MIN_WIDTH = 400;
const GF_MIN_HEIGHT = 400;

function createGroupFinderWindow() {
  if (groupFinderWindow && !groupFinderWindow.isDestroyed()) {
    groupFinderWindow.focus();
    return;
  }

  groupFinderWindow = new BrowserWindow({
    ...restoredWindowBounds('groupFinderBounds',
      { width: GF_DEFAULT_WIDTH, height: GF_DEFAULT_HEIGHT },
      { width: GF_DEFAULT_WIDTH, height: GF_DEFAULT_HEIGHT }),
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    minWidth: GF_MIN_WIDTH,
    minHeight: GF_MIN_HEIGHT,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  groupFinderWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  groupFinderWindow.loadFile(path.join(__dirname, 'renderer', 'group-finder.html'));
  trackWindowBounds(groupFinderWindow, 'groupFinderBounds');
  attachOverlayBlurHandler(groupFinderWindow);

  // Start real-time listeners when the window opens
  groupFinderWindow.webContents.on('did-finish-load', () => {
    groupFinder.startListeners(groupFinderWindow);
  });

  groupFinderWindow.on('closed', () => {
    groupFinder.stopListeners();
    groupFinderWindow = null;
  });
}

function createMarketWindow() {
  // Use verified cached artwork while the optional network refresh is running.
  applyTemperCatalog(localizedCatalog(dataManager, 'tempers', config.get('language', 'en'), loadLanguageData));
  void refreshModuleData('temper-tracker');
  void market.refresh();
  if (marketWindow && !marketWindow.isDestroyed()) { marketWindow.show(); marketWindow.focus(); return; }
  const win = new BrowserWindow({
    ...marketWindowBounds(config.get('marketBounds'), screen),
    frame: false, transparent: false, resizable: true, alwaysOnTop: true, skipTaskbar: true,
    minWidth: 620, minHeight: 460, backgroundColor: '#121619',
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: { preload: path.join(__dirname, 'market-preload.js'), partition: 'persist:overkot-market',
      contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  marketWindow = win;
  pushDockState();
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  const marketSession = win.webContents.session;
  if (!marketSession.protocol.isProtocolHandled(MARKET_SCHEME)) {
    marketSession.protocol.registerFileProtocol(MAP_TILE_SCHEME, serveTemperIcon);
    marketSession.protocol.handle(GAME_DATA_SCHEME, request => gameDataAccess.imageResponse(request));
    marketSession.protocol.handle(MARKET_SCHEME, createMarketProtocolHandler({
      uiRoot: path.join(app.getAppPath(), app.isPackaged ? 'market-ui' : '.build/market-ui'),
      rendererRoot: path.join(__dirname, 'renderer'), assetsRoot: path.join(__dirname, '..', 'assets'),
    }));
    marketSession.setPermissionRequestHandler((contents, permission, callback) => callback(
      permission === 'clipboard-sanitized-write' && contents === marketWindow?.webContents
        && contents.getURL().startsWith(`${MARKET_ORIGIN}/`)));
    marketSession.setPermissionCheckHandler((contents, permission) =>
      permission === 'clipboard-sanitized-write' && contents === marketWindow?.webContents
        && contents.getURL().startsWith(`${MARKET_ORIGIN}/`));
  }
  configureMarketNavigation(win, url => require('electron').shell.openExternal(url));
  win.loadURL(`${MARKET_ORIGIN}/`);
  trackWindowBounds(win, 'marketBounds');
  attachOverlayBlurHandler(win);
  win.on('focus', () => requestWidgetTutorial('market'));
  win.once('ready-to-show', () => requestWidgetTutorial('market'));
  win.on('closed', () => { marketWindow = null; pushDockState(); });
}

const dailyBriefPopout = createDailyBriefWindow({ BrowserWindow, screen, config,
  rendererRoot: path.join(__dirname, 'renderer'), preloadPath: path.join(__dirname, 'preload.js'),
  iconPath: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
  canShow: () => !overlayHiddenByUser && !gameHiddenActive,
  trackBounds: win => trackWindowBounds(win, 'dailyBriefBounds'),
  onCreated: win => {
    dailyBriefWindow = win;
    win.setAlwaysOnTop(true, 'screen-saver', dungeonOverlayWindow ? 4 : 1);
    attachOverlayBlurHandler(win);
    for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, pushDockState);
    applyOverlayMousePolicy();
  },
  onClosed: () => { dailyBriefWindow = null; pushDockState(); },
  onError: error => log('DAILY', `Daily Brief could not open: ${error.message}`),
});

function openDailyBriefWindow({ focus = true } = {}) {
  if (overlayHiddenByUser || gameHiddenActive) return null;
  if (focus) {
    gameFocusRequest?.abort(); gameFocusRequest = null;
    overlayInteractive = true; overlayFocusRequestedAt = Date.now();
  }
  void refreshDailyBrief();
  const win = dailyBriefPopout.open({ focus });
  applyOverlayMousePolicy();
  pushDockState();
  return win;
}

registerMarketIpc({ ipcMain, market, rendererRoot: path.join(__dirname, 'renderer'), openWindow: createMarketWindow,
  retryConnection: async () => { await marketAccount.retry(); return { ok: true, state: market.snapshot() }; } });
registerMarketFrontendIpc({ ipcMain, market, getWindow: () => marketWindow,
  getConnectionState: () => avakotAccount.snapshot(), openAccountSettings: () => { createSettingsWindow('connections'); return { ok: true }; },
  getAppearance: () => ({ ...Appearance.appearanceConfig(appearanceSession.effectiveConfig()), language: config.get('language', 'en'), marketRememberSession: config.get('marketRememberSession', true) }) });
registerAppearanceIpc({ ipcMain, dialog: require('electron').dialog, BrowserWindow,
  rendererRoot: path.join(__dirname, 'renderer'), session: appearanceSession });
const layoutRuntime = createLayoutRuntime({ config, screen, getDockDisplay: dockDisplay, widgetWindows,
  widgetIds: ALL_WIDGET_IDS, widgetDimensions: widgetWindowDimensions, getBounds: getWindowBounds, setBounds: setWindowBounds,
  onApplied: () => {
    closeDungeonOverlay();
    market.setEnabled(config.get('widgetVisibility', {}).market === true);
    if (config.get('widgetVisibility', {}).daily !== true) closeWithoutChangingFocus(dailyBriefWindow);
    setDockAutoHidden(false);
    applyDockGeometry();
    syncWidgetWindows();
    broadcastDockConfig();
    for (const win of widgetWindows.values()) {
      if (!win.isDestroyed()) win.webContents.send('layout-widget-bounds', getWindowBounds(win));
    }
  },
});
registerLayoutIpc({ ipcMain, dialog: require('electron').dialog, BrowserWindow,
  rendererRoot: path.join(__dirname, 'renderer'), config, captureCurrent: layoutRuntime.capture,
  onApply: layout => { setLayoutEditing(false); return layoutRuntime.apply(layout); }, onChanged: broadcastDockConfig });
registerWidgetSizingIpc({ ipcMain, rendererRoot: path.join(__dirname, 'renderer'), config,
  widgetIds: ALL_WIDGET_IDS,
  getCurrentSize: id => {
    const win = widgetWindows.get(id);
    return win && !win.isDestroyed() ? getWindowBounds(win) : config.get(`widgetBounds_${id}`);
  },
  onApply: applyWidgetSize,
  constrainSize: clampWidgetSize,
  onChanged: () => { layoutDockedPanels(); broadcastDockConfig(); },
});
registerAvakotAccountIpc({ ipcMain, account: avakotAccount, rendererRoot: path.join(__dirname, 'renderer') });
registerGamePathsIpc({ ipcMain, dialog: require('electron').dialog, BrowserWindow,
  rendererRoot: path.join(__dirname, 'renderer'), getResolver: () => gamePaths, config,
  onChanged: changed => {
    if (Object.hasOwn(changed, 'screenshotDir')) screenshotWatcher.configureScreenshotPaths(gamePaths);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('config-changed', appearanceSession.effectiveConfig());
  },
});

// ─── Wiki search window ──────────────────────────────────
let wikiWindow = null;

function createWikiWindow(query) {
  if (!services.wikiWebsite || overlayHiddenByUser) return;
  // Submitting a search is an intentional input request, including from a
  // clickable desktop widget. Keep that session active as game detection
  // starts, and unlock an existing passive wiki before showing/focusing it.
  gameFocusRequest?.abort();
  gameFocusRequest = null;
  overlayInteractive = true;
  overlayFocusRequestedAt = Date.now();
  if (!wikiWindow || wikiWindow.isDestroyed()) {
    wikiWindow = createWikiBrowser({
      rendererRoot: path.join(__dirname, 'renderer'), getConfig: () => appearanceSession.effectiveConfig(),
      bounds: restoredWindowBounds('wikiBounds', { width: 900, height: 700 }, { width: 500, height: 400 }),
      icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    });
    trackWindowBounds(wikiWindow, 'wikiBounds');
    attachOverlayBlurHandler(wikiWindow);
    wikiWindow.on('closed', () => { wikiWindow = null; });
  }
  overlayFocusRequestedAt = Date.now();
  applyOverlayMousePolicy();
  loadWikiSearch(wikiWindow, query);
}

// ─── Map window (expanded mini-map) ─────────────────────
let mapWindow = null;
let dungeonOverlayWindow = null;

function closeDungeonOverlay() {
  closeWithoutChangingFocus(dungeonOverlayWindow);
}

async function exitDungeonOverlayInteraction() {
  // Release capture before restoring game focus; keep the current map view.
  toggleOverlayInteraction(true);
  gameFocusRequest?.abort();
  const request = new AbortController();
  gameFocusRequest = request;
  try {
    await detector?.focusGameWindow({ signal: request.signal });
  } catch (error) {
    if (!request.signal.aborted) log('FOCUS', `Unable to return focus to Soulframe: ${error.message}`);
  } finally {
    if (gameFocusRequest === request) gameFocusRequest = null;
  }
}

function createDungeonOverlay() {
  if (overlayHiddenByUser || !dungeonWatcher?.getState().active) return;
  if (dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed()) {
    if (!overlayInteractive) toggleOverlayInteraction();
    dungeonOverlayWindow.show();
    dungeonOverlayWindow.focus();
    refreshOverlayWindowStack();
    return;
  }
  const activatedInteraction = !overlayInteractive;
  setLayoutEditing(false);
  if (!overlayInteractive) toggleOverlayInteraction();
  const display = dockDisplay();
  const win = new BrowserWindow({ ...display.bounds, frame: false, transparent: true,
    ...(platformSupport.platform === 'linux' ? { type: 'dock' } : {}),
    backgroundColor: '#00000000', show: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, movable: false, resizable: false,
    enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  dungeonOverlayWindow = win;
  configureOverlayWorkspace(win, platformSupport);
  win.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 3);
  for (const panel of widgetWindows.values()) if (!panel.isDestroyed()) panel.setAlwaysOnTop(true, 'screen-saver', 2);
  for (const popup of [settingsWindow, tutorialWindow, widgetsWindow, changelogWindow, updateWindow, marketWindow, dailyBriefWindow, wikiWindow, groupFinderWindow, mapWindow, calendarSettingsWindow]) {
    if (popup && !popup.isDestroyed()) popup.setAlwaysOnTop(true, 'screen-saver', 4);
  }
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.loadFile(path.join(__dirname, 'renderer', 'dungeon-overlay.html'));
  attachOverlayBlurHandler(win);
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    if (overlayHiddenByUser || gameHiddenActive) { win._visibleBeforeOverlayHide = true; return; }
    if (overlayInteractive && !isAnyOverlayWindowFocused()) toggleOverlayInteraction(true);
    win.setBounds(dockDisplay().bounds);
    applyOverlayMousePolicy();
    if (overlayInteractive) win.show();
    else win.showInactive();
    win.setBounds(dockDisplay().bounds);
    if (overlayInteractive) win.focus();
    refreshOverlayWindowStack();
  });
  win.on('closed', () => {
    dungeonOverlayWindow = null;
    if (activatedInteraction && overlayInteractive) toggleOverlayInteraction(true);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(true, 'screen-saver');
    for (const panel of widgetWindows.values()) if (!panel.isDestroyed()) panel.setAlwaysOnTop(true, 'screen-saver');
    for (const popup of [settingsWindow, tutorialWindow, widgetsWindow, changelogWindow, updateWindow, marketWindow, dailyBriefWindow, wikiWindow, groupFinderWindow, mapWindow, calendarSettingsWindow]) {
      if (popup && !popup.isDestroyed()) popup.setAlwaysOnTop(true, 'screen-saver', 1);
    }
    syncWidgetWindows();
  });
  syncWidgetWindows();
}

function createMapWindow() {
  if (mapWindow && !mapWindow.isDestroyed()) {
    mapWindow.focus();
    return;
  }

  mapWindow = new BrowserWindow({
    ...restoredWindowBounds('mapBounds', { width: 900, height: 900 }, { width: 400, height: 400 }),
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    minWidth: 400,
    minHeight: 400,
    icon: path.join(__dirname, '..', 'assets', platformSupport.platform === 'win32' ? 'overkot.ico' : 'overkot.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mapWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mapWindow.loadFile(path.join(__dirname, 'renderer', 'map-window.html'));
  trackWindowBounds(mapWindow, 'mapBounds');
  attachOverlayBlurHandler(mapWindow);

  mapWindow.on('closed', () => {
    mapWindow = null;
  });
}

// ─── System tray ─────────────────────────────────────────
function createTray() {
  if (tray) return;
  // Use .ico on Windows for reliable tray icon rendering
  const iconPath = path.join(__dirname, '..', 'assets', 'overkot.ico');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    log('TRAY', `Failed to load tray icon from ${iconPath}, falling back to PNG`);
    const pngIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'overkot.png'));
    tray = new Tray(pngIcon.resize({ width: 16, height: 16 }));
  } else {
    tray = new Tray(icon);
  }
  tray.setToolTip('Overkot');
  updateTrayLanguage();
  tray.on('click', () => {
    setOverlayHidden(false);
  });
}

function updateTrayLanguage() {
  if (!tray) return;
  const labels = i18nTranslations[config.get('language', 'en')] || i18nTranslations.en;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: labels.trayShow || 'Show overlay', click: () => setOverlayHidden(false) },
    { type: 'separator' },
    { label: labels.trayQuit || 'Quit', click: () => app.quit() },
  ]));
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

// ─── IPC handlers (renderer ↔ main) ──────────────────────

// i18n: load translations from langs/ JSON files (synchronous for preload)
const { TRANSLATIONS: i18nTranslations, LANGUAGES: i18nLanguages } = require('./modules/localization');
ipcMain.on('get-i18n', (event) => {
  event.returnValue = { translations: i18nTranslations, languages: i18nLanguages, titleTrackerEnabled: TITLE_TRACKER_ENABLED,
    wikiAvailable: !!services.wikiWebsite, buildWebsiteHost: services.buildWebsite ? new URL(services.buildWebsite).host : '' };
});

ipcMain.on('updates:open', () => { createUpdateWindow(); void updater?.check(); });
ipcMain.handle('updates:state', () => updater?.snapshot() || { phase: 'unsupported', currentVersion: CURRENT_VERSION });
ipcMain.handle('updates:check', () => updater?.check());
ipcMain.handle('updates:download', () => updater?.download(true));
ipcMain.handle('updates:install', () => updater?.installNow() || false);
ipcMain.handle('overlay-displays:get', () => overlayDisplaysSnapshot());
ipcMain.on('updates:installer', () => {
  if (!services.releases || IS_BETA || platformSupport.platform !== 'win32') return;
  require('electron').shell.openExternal(`${services.releases}/overkot.exe`).catch(error => log('UPDATE', error.message));
});

ipcMain.handle('get-state', () => ({
  status: appStatus,
  overlayShortcutWarning,
  visibilityShortcutWarning,
  overlayInteractive,
  layoutEditing,
  nativeLayoutTracking,
  dockState: dockState(),
  platformSupport,
  timers: timerState.timers,
  dailyAffiliation: timerState.dailyAffiliation,
  dailyAffiliationOde: timerState.dailyAffiliationOde,
  factions: timerState.factions,
  config: appearanceSession.effectiveConfig(),
  namesMap,
  timerDurations: getTimerDurations(),
  arenaStatus,
  arenaDetectionSource,
  arenaWave,
  ancestors: ancestorMarkers,
  mapTiles: mapTileManager.getInfo(),
}));

ipcMain.handle('get-map-tiles', async () => { await dataManager.checkForUpdates(); return mapTileManager.getInfo(); });
ipcMain.handle('check-data-updates', () => checkGameDataNow());
ipcMain.handle('get-map-data', async (_event, name) => {
  if (!POI_FILES.includes(name)) throw new Error('Unknown map layer');
  await dataManager.checkForUpdates();
  const key = `map-json/${name}.json`;
  await dataManager.ensureAsset(key);
  return dataManager.readJSON(key);
});
ipcMain.handle('get-ancestors', () => ancestorMarkers);

ipcMain.handle('data-snapshot:get', (_event, kind) => dataSnapshots.read(kind));
ipcMain.handle('data-snapshot:refresh', (_event, kind) => dataSnapshots.refresh(kind));

ipcMain.handle('build-export:status', async () => { await refreshModuleData('build-exporter'); return buildExporter.getStatus(); });
ipcMain.handle('build-export:current', async () => {
  await refreshModuleData('build-exporter');
  const result = await buildExporter.exportCurrent();
  if (result.ok) usage.track('feature_use', { action: 'export_build' });
  return result;
});

ipcMain.handle('daily-brief:get', () => { void refreshDailyBrief(); return dailyBrief.getSnapshot(); });
ipcMain.handle('daily-brief:refresh', () => refreshDailyBrief({ force: true }));
ipcMain.handle('daily-brief:dismiss', event => {
  const win = dailyBriefWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
  dailyBriefPopout.close();
  return true;
});
ipcMain.handle('inventory-widget:get', (_event, id) => {
  if (!inventoryWidgets.has(id)) throw new Error('Unknown inventory widget');
  if (COLLECTION_WIDGET_IDS.includes(id)) void refreshCollectionLanguage();
  return inventoryWidgets.get(id).getSnapshot();
});
ipcMain.handle('inventory-widget:action', (_event, id, action) => {
  if (!inventoryWidgets.has(id)) throw new Error('Unknown inventory widget');
  return inventoryWidgets.get(id).action(action);
});
ipcMain.handle('temper-tracker:get', async () => { await refreshModuleData('temper-tracker'); return temperTracker.getSnapshot(); });
ipcMain.handle('title-tracker:get', () => {
  if (!TITLE_TRACKER_ENABLED) return { status: 'disabled', rows: [], unreadableChallenges: 0 };
  void refreshTitleData(); return titleTracker.getSnapshot();
});
ipcMain.handle('wolf-training:get', async () => { await refreshModuleData('wolf-training'); return wolfTraining.getSnapshot(); });
ipcMain.handle('dungeon:state', () => dungeonWatcher?.getState() || { active: false });
ipcMain.handle('dungeon:map', () => dungeonMap.getSnapshot(dungeonWatcher?.getState() || { active: false }));

ipcMain.handle('clock:get', () => {
  worldClock.refresh().catch(error => log('CLOCK', error.message));
  return worldClock.snapshot();
});

ipcMain.handle('weather:get', () => {
  weather.refresh().catch(error => log('WEATHER', error.message));
  return weather.snapshot();
});

ipcMain.handle('calendar:get-day', async (_event, date) => {
  await calendar.refresh();
  return calendar.getDay(date);
});
ipcMain.handle('calendar:get-settings', () => calendar.getSettings());
ipcMain.handle('calendar:set-ancestor', (_event, name, unlocked) => calendar.setAncestor(name, unlocked));
ipcMain.handle('calendar:reset', () => calendar.reset());
ipcMain.on('calendar:open-settings', event => createCalendarSettingsWindow(event.sender));

ipcMain.handle('moonsteel-alert:preview', (event, settings) => {
  if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents
      || event.senderFrame !== event.sender.mainFrame || marketShutdownStarted || !MoonsteelAlertSettings.validate(settings)) return false;
  const preview = { ...MoonsteelAlertSettings.normalize(settings), enabled: true };
  if (!preview.flashEnabled && !preview.soundEnabled) return false;
  try { return moonsteelAlertWindow.show({ settings: preview, preview: true, items: [] }) !== false; }
  catch (error) { log('MOONSTEEL', error.message); return false; }
});

ipcMain.handle('save-config', (_e, newConfig) => {
  // File overrides go through the validated Settings endpoint.
  if (!newConfig || typeof newConfig !== 'object' || Object.hasOwn(newConfig, 'eeLogPath') || Object.hasOwn(newConfig, 'screenshotDir')
    || Object.hasOwn(newConfig, 'appearance') || Object.hasOwn(newConfig, 'appearancePresets') || Object.hasOwn(newConfig, 'savedLayouts') || Object.hasOwn(newConfig, 'startupLayoutId')
    || Object.hasOwn(newConfig, 'widgetSizes') || Object.hasOwn(newConfig, 'widgetResizeMode')) return false;
  newConfig = { ...newConfig };
  if (Object.hasOwn(newConfig, 'windowCloseFocus') && !isWindowCloseFocus(newConfig.windowCloseFocus)) return false;
  // Older renderers and profiles cannot re-enable unattended app updates.
  delete newConfig.automaticUpdates;
  if (Object.hasOwn(newConfig, 'dockDisplayId')) {
    const displayId = normalizeDisplayId(newConfig.dockDisplayId);
    if (displayId === null || !screen.getAllDisplays().some(display => display.id === displayId)) return false;
    newConfig.dockDisplayId = displayId;
  }
  if (Object.hasOwn(newConfig, 'moonsteelAlert')) {
    const next = MoonsteelAlertSettings.merge(config.get('moonsteelAlert'), newConfig.moonsteelAlert);
    if (!next) return false;
    newConfig.moonsteelAlert = next;
  }
  // Tutorial completion is merged by its dedicated endpoint, never replaced
  // by an older Settings snapshot.
  delete newConfig.tutorialCompleted;
  delete newConfig.tutorialsEnabled;
  if (Object.hasOwn(newConfig, 'temperTrackerPreferences')) newConfig.temperTrackerPreferences = normalizeTemperTrackerPreferences(newConfig.temperTrackerPreferences);
  if (Object.hasOwn(newConfig, 'titleTrackerPreferences')) newConfig.titleTrackerPreferences = normalizeTitleTrackerPreferences(newConfig.titleTrackerPreferences);
  if (!TITLE_TRACKER_ENABLED) {
    // A shared profile can retain beta selections. They must not block edits
    // to ordinary widgets or turn the beta widget on in a stable installer.
    for (const key of ['widgetVisibility', 'moduleVisibility', 'widgetOpen']) {
      if (!newConfig[key] || !Object.hasOwn(newConfig[key], 'title-tracker')) continue;
      newConfig[key] = { ...newConfig[key] }; delete newConfig[key]['title-tracker'];
    }
  }
  for (const key of ['dailyAutoLogin', 'dailyAutoReset']) if (Object.hasOwn(newConfig, key) && typeof newConfig[key] !== 'boolean') return false;
  if (Object.hasOwn(newConfig, 'dockEdge') && !EDGES.includes(newConfig.dockEdge)) return false;
  if (Object.hasOwn(newConfig, 'dockAutoHide') && typeof newConfig.dockAutoHide !== 'boolean') return false;
  if (Object.hasOwn(newConfig, 'dockWidgetOrder') && (!Array.isArray(newConfig.dockWidgetOrder)
    || newConfig.dockWidgetOrder.some(id => ![...ALL_WIDGET_IDS, 'market', 'daily'].includes(id))
    || new Set(newConfig.dockWidgetOrder).size !== newConfig.dockWidgetOrder.length)) return false;
  if (Object.hasOwn(newConfig, 'widgetOutlineOpacity') && (!Number.isFinite(newConfig.widgetOutlineOpacity)
    || newConfig.widgetOutlineOpacity < 0 || newConfig.widgetOutlineOpacity > 100)) return false;
  const shortcutIdentity = value => String(value).toLowerCase().split('+')
    .map(part => ({ control: 'ctrl', command: 'super', cmd: 'super', meta: 'super' }[part] || part)).sort().join('+');
  const visibilityChord = newConfig.overlayVisibilityHotkey ?? config.get('overlayVisibilityHotkey', 'Shift+F2');
  const interactionChord = newConfig.interactionHotkey ?? config.get('interactionHotkey', 'Shift+F1');
  if (shortcutIdentity(visibilityChord) === shortcutIdentity(interactionChord)) return false;
  if (Object.hasOwn(newConfig, 'overlayVisibilityHotkey')) {
    if (typeof visibilityChord !== 'string' || !/^(?:(?:Ctrl|Control|Alt|Shift|Super|Meta|Command|CommandOrControl)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/i.test(visibilityChord)) return false;
    if (!shortcutCapture && visibilityChord !== registeredVisibilityShortcut) {
      // Check availability before persisting a shortcut that could leave no way back.
      try {
        if (!globalShortcut.register(visibilityChord, () => {})) return false;
        globalShortcut.unregister(visibilityChord);
      } catch { return false; }
    }
  }
  if (['dungeonMapAutoSwitch', 'dungeonMapProgressiveReveal', 'dungeonMapSeeThrough', 'livePlayerTracking', 'showWorldDrops', 'showAlertsWhenHidden'].some(key => Object.hasOwn(newConfig, key) && typeof newConfig[key] !== 'boolean')) return false;
  if (Object.hasOwn(newConfig, 'dungeonMapBackgroundOpacity') && (!Number.isFinite(newConfig.dungeonMapBackgroundOpacity)
      || newConfig.dungeonMapBackgroundOpacity < 0 || newConfig.dungeonMapBackgroundOpacity > 100)) return false;
  if (['playerMarkerColor', 'playerMarkerOutlineColor', 'dungeonMapOutlineColor'].some(key => Object.hasOwn(newConfig, key)
    && (typeof newConfig[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(newConfig[key])))) return false;
  if (typeof newConfig.marketRememberSession === 'boolean'
    && !market.setRememberSession(newConfig.marketRememberSession)) return false;
  const prevLang = config.get('language', 'en');
  const previousVisibility = config.get('widgetVisibility', {});
  for (const [widget, enabled] of Object.entries(newConfig.widgetVisibility || {})) {
    if (enabled === true && previousVisibility[widget] !== true) usage.track('widget_enabled', { widget });
  }
  if (config.setMany(newConfig) === false) return false;
  if (Object.hasOwn(newConfig, 'moonsteelAlert')) moonsteelAlertWindow.close();
  if (typeof newConfig.livePlayerTracking === 'boolean') playerTracking.setEnabled(newConfig.livePlayerTracking);
  if (newConfig.widgetVisibility !== undefined) {
    const open = { ...config.get('widgetOpen', {}) };
    for (const [id, enabled] of Object.entries(newConfig.widgetVisibility)) {
      if (enabled !== true || previousVisibility[id] !== true) open[id] = false;
    }
    config.set('widgetOpen', open);
    if (newConfig.widgetVisibility.daily === false) closeWithoutChangingFocus(dailyBriefWindow);
  }

  if (Object.hasOwn(newConfig, 'dockDisplayId')) {
    setLayoutEditing(false);
    applyDockGeometry();
    broadcastOverlayDisplays();
  }

  // If language actually changed, reload names map
  if (newConfig.language !== undefined && newConfig.language !== prevLang) {
    updateTrayLanguage();
    if (COLLECTION_WIDGET_IDS.some(id => config.get('widgetVisibility', {})[id])) void refreshCollectionLanguage();
    ensureNamesForLanguage(newConfig.language)
      .then(names => {
        if (config.get('language', 'en') !== newConfig.language) return;
        namesMap = names;
        const visible = config.get('widgetVisibility', {});
        if (visible['temper-tracker'] || visible.daily || visible.market) refreshModuleData('temper-tracker');
        if (config.get('widgetVisibility', {})['wolf-training']) refreshModuleData('wolf-training');
        log('LANG', `Switched to ${newConfig.language}: ${Object.keys(names).length} names`);
        if (mapWindow && !mapWindow.isDestroyed()) mapWindow.webContents.send('map-language-updated', newConfig.language);
        pushStateToRenderer();
      })
      .catch(e => log('LANG', `Failed to switch language: ${e.message}`));
  }
  // If click-through or hotkey changed, re-register shortcut
  if (newConfig.clickThrough !== undefined || newConfig.interactionHotkey !== undefined) {
    registerOverlayShortcut();
    toggleOverlayInteraction(true);
  }
  if (newConfig.overlayVisibilityHotkey !== undefined) registerVisibilityShortcut();

  // Push config update to main window and all widget windows
  const allConfig = appearanceSession.effectiveConfig();
  broadcastTheme(allConfig);
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('config-changed', allConfig);
  if (tutorialWindow && !tutorialWindow.isDestroyed()) tutorialWindow.webContents.send('config-changed', allConfig);
  if (calendarSettingsWindow && !calendarSettingsWindow.isDestroyed()) calendarSettingsWindow.webContents.send('config-changed', allConfig);
  if (widgetsWindow && !widgetsWindow.isDestroyed()) widgetsWindow.webContents.send('config-changed', allConfig);
  if (mapWindow && !mapWindow.isDestroyed()) mapWindow.webContents.send('config-changed', allConfig);
  if (dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed()) dungeonOverlayWindow.webContents.send('config-changed', allConfig);
  if (marketWindow && !marketWindow.isDestroyed()) marketWindow.webContents.send('config-changed', allConfig);
  if (dailyBriefWindow && !dailyBriefWindow.isDestroyed()) dailyBriefWindow.webContents.send('config-changed', allConfig);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-changed', allConfig);
  }
  for (const [, wWin] of widgetWindows) {
    if (!wWin.isDestroyed()) wWin.webContents.send('config-changed', allConfig);
  }
  if (dockWindow && !dockWindow.isDestroyed()) {
    for (const frame of dockWindow.webContents.mainFrame.framesInSubtree) {
      try { frame.send('config-changed', allConfig); } catch { /* Cell closed during update. */ }
    }
  }

  // Sync widget windows if visibility changed
  if (newConfig.widgetVisibility !== undefined) {
    market.setEnabled(config.get('widgetVisibility', {}).market === true);
    syncWidgetWindows();
  }

  if (newConfig.widgetOpen !== undefined || newConfig.widgetDocked !== undefined || newConfig.dockWidgetOrder !== undefined) syncWidgetWindows();
  if (newConfig.dockEdge !== undefined || newConfig.dockAutoHide !== undefined) {
    setLayoutEditing(false);
    setDockAutoHidden(false);
    lastDockHover = Date.now();
    applyDockGeometry();
  }

  // Re-evaluate auto-hide state if related settings changed
  if (newConfig.hideWhenGameClosed !== undefined || newConfig.showOnlyWhenGameFocused !== undefined) {
    // Start or stop the persistent foreground monitor based on the toggle.
    if (newConfig.showOnlyWhenGameFocused === true) {
      detector?.startForegroundMonitor();
    } else if (newConfig.showOnlyWhenGameFocused === false) {
      detector?.stopForegroundMonitor();
    }
    applyGameHiddenState();
  }
  if (newConfig.showAlertsWhenHidden !== undefined || newConfig.enableAlertPopup !== undefined) syncAlertVisibility();

  return true;
});

ipcMain.handle('get-changelog', async () => {
  // Always start with the local bundled changelog (matches installed version)
  let changelog = { versions: [] };
  try {
    const changelogPath = path.join(__dirname, '..', 'changelog.json');
    delete require.cache[changelogPath];
    changelog = mergeChangelog(require(changelogPath));
    log('IPC', `Loaded local changelog (${changelog.versions.length} versions)`);
  } catch (e) {
    log('IPC', `Failed to load local changelog: ${e.message}`);
  }

  if (services.releases) {
    try {
      const { data } = await require('axios').get(`${services.releases}/changelog.json`, {
        timeout: 5000, responseType: 'json', maxContentLength: 512 * 1024, maxRedirects: 0,
      });
      if (Array.isArray(data?.versions)) changelog = mergeChangelog(changelog, data);
    } catch (error) {
      log('IPC', `Changelog fetch failed: ${error.message}`);
    }
  }

  return changelog;
});

ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win === dailyBriefWindow) win.minimize();
  else if (win) setOverlayHidden(true);
});
ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  // If a sub-window sends window-close, only destroy that sub-window.
  // Only the main window close should trigger the app exit cascade.
  if (win === mainWindow || platformSupport.platform === 'win32') {
    win.close();
  } else {
    // Let resizable settings windows save their final size before closing.
    if (win === widgetsWindow || win === settingsWindow || win === dailyBriefWindow) win.close();
    else win.destroy();
    // Re-assert main window and popout visibility after sub-window closes (Windows z-order fix)
    if (mainWindow && !mainWindow.isDestroyed() && !overlayHiddenByUser && !dockAutoHidden) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver', dungeonOverlayWindow ? 3 : 0);
      mainWindow.show();
      // Keep popout windows above widgets
      for (const w of [settingsWindow, tutorialWindow, changelogWindow, widgetsWindow, groupFinderWindow, marketWindow, dailyBriefWindow, wikiWindow, mapWindow, dungeonOverlayWindow, calendarSettingsWindow, updateWindow]) {
        if (w && !w.isDestroyed()) w.setAlwaysOnTop(true, 'screen-saver', dungeonOverlayWindow && w !== dungeonOverlayWindow ? 4 : 1);
      }
      refreshOverlayWindowStack();
    }
  }
});
// [DEAD CODE] No renderer sends 'window-drag' — drag handled via JS-based IPC now
// ipcMain.on('window-drag', () => {
//   // Not needed – handled via CSS -webkit-app-region: drag
// });

// Popout windows
ipcMain.on('open-settings', () => createSettingsWindow());
ipcMain.on('open-changelog', () => createChangelogWindow());
ipcMain.on('open-modules', () => createWidgetsWindow());
ipcMain.on('open-widgets', () => createWidgetsWindow());
ipcMain.on('open-group-finder', () => createGroupFinderWindow());
ipcMain.on('open-wiki-search', (_e, query) => createWikiWindow(query));
ipcMain.on('open-map-window', () => createMapWindow());
ipcMain.on('open-dungeon-overlay', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win === mainWindow || win?._widgetId === 'minimap') createDungeonOverlay();
});
ipcMain.on('close-dungeon-overlay', (event) => {
  if (dungeonOverlayWindow && BrowserWindow.fromWebContents(event.sender) === dungeonOverlayWindow) dungeonOverlayWindow.close();
});
ipcMain.on('exit-dungeon-overlay-interaction', (event) => {
  if (dungeonOverlayWindow && !dungeonOverlayWindow.isDestroyed() && overlayInteractive
      && BrowserWindow.fromWebContents(event.sender) === dungeonOverlayWindow) {
    void exitDungeonOverlayInteraction();
  }
});

// Only explicit feature actions are tracked, never arbitrary renderer payloads.
for (const [channel, feature] of Object.entries({
  'open-settings': 'settings', 'open-changelog': 'changelog', 'open-widgets': 'widgets',
  'open-modules': 'widgets', 'open-group-finder': 'group_finder', 'open-wiki-search': 'wiki',
  'open-map-window': 'map', 'calendar:open-settings': 'calendar',
})) ipcMain.on(channel, () => usage.track('feature_open', { feature }));

// ─── Timer alert floating windows ─────────────────────────
ipcMain.on('show-alert', (_e, data) => createAlertWindow(data));
ipcMain.on('alert-dismiss', dismissAlertWindow);

// ─── Player location and dungeon discovery ────────────────
const screenshotWatcher = require('./modules/screenshotWatcher');

ipcMain.handle('locate-player', async () => {
  usage.track('feature_use', { action: 'locate_player' });
  playerTracking.beginCapture();
  return screenshotWatcher.startWatching();
});

ipcMain.on('cancel-locate-player', () => {
  screenshotWatcher.stopWatching();
});

ipcMain.handle('get-player-location', () => {
  return playerTracking.getLocation();
});
ipcMain.handle('get-player-tracking', () => playerTracking.getStatus());
ipcMain.handle('dungeon-discovery:get', (_e, data) => playerTracking.discovery.load(data));
ipcMain.handle('dungeon-discovery:save', (_e, data) => playerTracking.discovery.save(data));
ipcMain.handle('dungeon-discovery:align', (_e, data) => playerTracking.discovery.addPoint(data));
ipcMain.handle('dungeon-discovery:reset', (_e, data) => playerTracking.discovery.reset(data));

// ─── Resolve loc_tags to localized display names ──────────
ipcMain.handle('resolve-location-names', (_e, locTags) => {
  const locale = config.get('language', 'en');
  const langData = loadLanguageData(locale);
  const result = {};
  for (const tag of locTags) {
    result[tag] = langData[tag] || '';
  }
  return result;
});

screenshotWatcher.onResult((data) => {
  playerTracking.acceptCapture(data);
});

// Minimize to system tray
ipcMain.on('minimize-to-tray', () => {
  if (!mainWindow) return;
  setOverlayHidden(true);
});

ipcMain.on('exit-interactive-mode', () => {
  if (overlayInteractive) toggleOverlayInteraction(true);
});

const windowDrag = createWindowDragController({
  screen,
  nativeCursor: platformSupport.platform === 'win32' || (platformSupport.platform === 'linux' && ['x11', 'xwayland'].includes(platformSupport.displayBackend)),
  getOtherWindows: () => [...widgetWindows.values(), mainWindow],
});
app.on('will-quit', () => windowDrag.dispose());

ipcMain.on('window-move-by', (event, dx, dy, snap) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win === mainWindow || (win?._widgetId && !layoutEditing)) return;
  windowDrag.moveBy(win, dx, dy, win?._widgetId ? false : snap);
});
ipcMain.on('window-drag-start', (event, threshold, snap) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win === mainWindow || (win?._widgetId && !layoutEditing)) return;
  if (win?._widgetId) win._layoutDragOrigin = getWindowBounds(win);
  windowDrag.start(win, { threshold, snap: win?._widgetId ? false : snap });
});
ipcMain.on('window-drag-end', (event, cancelled) => {
  finishWidgetDrag(BrowserWindow.fromWebContents(event.sender), !!cancelled);
});

// Auto-fit window size to content (preserve position)
ipcMain.on('fit-window-size', (event, contentWidth, contentHeight) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !Number.isFinite(contentWidth) || !Number.isFinite(contentHeight)) return;
  if (win === mainWindow) return;
  const bounds = getWindowBounds(win);
  const workArea = screen.getDisplayMatching(bounds).workArea;
  // Hard suppression while the user is actively dragging the window.
  // We accept either the explicit drag flag (set on mousedown / cleared on
  // mouseup) or the short time-based fallback that bumps with each move event.
  const isDragMoving = !!win._isDragging
    || (!!win._dragMoveActiveUntil && Date.now() < win._dragMoveActiveUntil);
  // A drag uses the app's requested dimensions. Content measurements from
  // intermediate native resize/configure events must not change that intent.
  if (isDragMoving || win._manualResizePreview || win === dailyBriefWindow) return;
  const [minWidth, expandedMinHeight] = win._widgetMinimumSize || [200, 40];
  const minHeight = expandedMinHeight;
  const size = win._widgetId ? config.get('widgetSizes', {})[win._widgetId] : null;
  const newWidth = Math.min(workArea.width, Math.max(Math.round(size?.width ?? contentWidth), minWidth, 1));
  const newHeight = Math.min(workArea.height, Math.max(Math.round(size?.height ?? contentHeight), minHeight, 1));
  const wChanged = Math.abs(bounds.width - newWidth) > 2;
  const hChanged = Math.abs(bounds.height - newHeight) > 2;
  if (wChanged || hChanged) {
    setWindowBounds(win, constrainBounds({
      x: bounds.x, y: bounds.y,
      width: wChanged ? newWidth : bounds.width,
      height: hChanged ? newHeight : bounds.height,
    }, workArea));
    if (win._widgetId) layoutDockedPanels();
  }
});

// Reset all widget positions to center of screen
ipcMain.on('reset-widget-positions', () => {
  resetWidgetPositions();
});

// Resize a widget window to an absolute target size
ipcMain.on('window-resize-to', (event, width, height, options = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !Number.isFinite(width) || !Number.isFinite(height)) return;
  if (win === mainWindow || win === dailyBriefWindow
    || (win._widgetId && !layoutEditing && !(options?.commit !== false && win._manualResizePreview))) return;
  const liveBounds = getWindowBounds(win);
  const bounds = win._layoutDragBounds
    ? { ...liveBounds, x: win._layoutDragBounds.x, y: win._layoutDragBounds.y } : liveBounds;
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const [minWidth, minHeight] = win._widgetMinimumSize || [200, 40];
  const requested = win._widgetId ? WidgetSizing.resizeSize({ id: win._widgetId,
    startWidth: bounds.width, startHeight: bounds.height, dx: width - bounds.width, dy: height > 0 ? height - bounds.height : 0,
    mode: options?.precise === true || config.get('widgetResizeMode', 'grid') === 'free' ? 'free' : 'grid', workArea })
    : { width: Math.min(workArea.width, Math.max(Math.round(width), minWidth, 150)),
      height: height > 0 ? Math.min(workArea.height, Math.max(Math.round(height), minHeight, 150)) : bounds.height };
  const resized = constrainBounds({ ...bounds, ...requested }, workArea);
  setWindowBounds(win, resized);
  if (win._widgetId) {
    win._layoutDragBounds = resized;
    layoutMovedWidgets.add(win._widgetId);
    win._manualResizePreview = { width: resized.width, height: resized.height };
    if (options?.commit !== false) commitWidgetResize(win);
  }
});

// Reset all widget sizes to defaults
ipcMain.on('reset-widget-sizes', () => {
  resetWidgetSizes();
});

// ─── Group Finder IPC handlers ────────────────────────────
ipcMain.handle('gf:get-state', () => {
  return groupFinder.getState();
});

ipcMain.handle('gf:get-profile', async () => {
  return await groupFinder.getPlayerProfile();
});

ipcMain.handle('gf:save-preferences', async (_e, prefs) => {
  await groupFinder.savePlayerPreferences(prefs);
  return true;
});

ipcMain.handle('gf:create-listing', async (_e, data) => {
  const result = await groupFinder.createListing(data);
  if (result) usage.track('feature_use', { action: 'create_listing' });
  return result;
});

ipcMain.handle('gf:update-listing', async (_e, updates) => {
  return await groupFinder.updateListing(updates);
});

ipcMain.handle('gf:close-listing', async () => {
  await groupFinder.closeListing();
  return true;
});

ipcMain.handle('gf:request-join', async (_e, listingId) => {
  const result = await groupFinder.requestJoin(listingId);
  if (result) usage.track('feature_use', { action: 'request_join' });
  return result;
});

ipcMain.handle('gf:cancel-request', async (_e, listingId) => {
  await groupFinder.cancelRequest(listingId);
  return true;
});

ipcMain.handle('gf:accept-request', async (_e, listingId, playerId) => {
  return await groupFinder.acceptRequest(listingId, playerId);
});

ipcMain.handle('gf:decline-request', async (_e, listingId, playerId) => {
  return await groupFinder.declineRequest(listingId, playerId);
});

ipcMain.handle('gf:mark-invited', async (_e, listingId, playerId) => {
  return await groupFinder.markInvited(listingId, playerId);
});

ipcMain.handle('gf:mark-joined', async (_e, listingId, playerId) => {
  return await groupFinder.markJoined(listingId, playerId);
});

ipcMain.handle('gf:get-suggestions', async () => {
  return await groupFinder.getSuggestions();
});

// ─── Background loop (mirrors Rust background thread) ─────
async function startBackgroundLoop() {
  if (!platformSupport.gameConnection) {
    setStatus('companion');
    return;
  }
  detector = new ProcessDetector(DEBUG);
  const logWatcher = new LogWatcher(DEBUG);
  const scanner = new MemoryScanner(DEBUG);
  const api = new ApiClient();
  const groupIdentity = new GroupFinderIdentity({ service: groupFinder, log: message => log('GF', message) });
  app.once('will-quit', () => groupIdentity.stopWatching());

  log('LOOP', 'Starting log watcher...');
  logWatcher.start();

  // The dungeon decoder is primary; the log tail also supplies fallback and waves.
  arenaWatcher = new ArenaWatcher({
    debug: DEBUG,
    getDungeonIndex: () => dataManager.readJSON('dungeons/index.json'),
    onChange: (next, detection) => {
      arenaStatus = next;
      arenaDetectionSource = detection?.source || 'log';
      // Keep a buffered wave hidden during same-instance metadata refresh,
      // then restore it immediately when current tile confirmation returns.
      arenaWave = next === 'arena' ? arenaWatcher?.getWave() || null : null;
      broadcastArenaStatus();
      broadcastArenaWave();
    },
    onWaveChange: (wave) => {
      arenaWave = wave;
      broadcastArenaWave();
    },
  });
  arenaWatcher.start();

  ancestorWatcher = new AncestorWatcher({
    debug: DEBUG,
    onChange: (markers) => {
      ancestorMarkers = Array.isArray(markers) ? markers : [];
      broadcastAncestors();
    },
  });
  dungeonWatcher = new DungeonWatcher({
    debug: DEBUG,
    getIndex: () => dataManager.readJSON('dungeons/index.json'),
    onChange: state => {
      void playerTracking.refresh(state);
      void arenaPresence?.update(state);
      if (!state.active) closeDungeonOverlay();
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        for (const frame of win.webContents.mainFrame.framesInSubtree) {
          try { frame.send('dungeon-state-changed', state); } catch { /* Frame closed during notification. */ }
        }
      }
    },
  });
  arenaPresence = new ArenaPresence({ arenaWatcher, dungeonMap, getState: () => dungeonWatcher.getState(),
    getVersion: () => dataManager.getInfo().version });
  arenaPresence.start();
  app.on('will-quit', () => { arenaPresence?.stop(); arenaWatcher?.stop(); dungeonWatcher?.stop(); });
  // Outer loop: wait for game, scan, poll – restart on disconnect
  while (true) {
    // A previous process may have crashed without writing a logout line.
    ancestorWatcher.stop();
    dungeonWatcher.stop();
    playerTracking.stop();
    // 1. Wait for Soulframe.x64.exe
    log('LOOP', 'Status -> waiting (looking for Soulframe.x64.exe)');
    setStatus('waiting');
    const pid = await detector.waitForProcess();
    log('LOOP', `Found Soulframe.x64.exe (PID: ${pid})`);

    // Give the game time to initialize
    log('LOOP', 'Waiting 2s for game to initialize...');
    await sleep(2000);
    if (!detector.isProcessRunning(pid)) continue;
    if (firebaseConfig.isConfigured()) {
      void groupIdentity.watchGame(() => logWatcher.currentLogin(), () => detector.isProcessRunning(pid));
    }
    ancestorWatcher.start();
    dungeonWatcher.start();
    playerTracking.start(pid);

    // Start foreground monitor early so focus-hide works during connecting.
    let lastForegroundCheck = 0;
    gameFocusedActive = true;
    if (config.get('showOnlyWhenGameFocused', false)) {
      detector.startForegroundMonitor();
    }

    // 2. Scan for account ID and nonce (memory-first, EE.log fallback)
    log('LOOP', 'Status -> connecting (scanning memory for credentials)');
    setStatus('connecting');
    let accountId = '';
    let nonce = '';
    let scanAttempts = 0;
    while (true) {
      if (!detector.isProcessRunning(pid)) {
        log('LOOP', 'Game process gone during credential scan. Restarting wait...');
        break;
      }

      if (logWatcher.consumeLoginSignal()) {
        log('LOOP', 'Login signal detected in EE.log -- rescanning...');
      }

      scanAttempts++;
      if (scanAttempts % 10 === 1) {
        log('SCAN', `Credential scan attempt #${scanAttempts}...`);
      }

      // EE.log fallback for accountId (checked each pass in case it becomes available)
      if (!accountId) {
        const logAcct = logWatcher.extractAccountId();
        if (logAcct) {
          accountId = logAcct;
          log('LOOP', `Account ID from EE.log: ${accountId}`);
        }
      }

      // Single memory scan — finds both accountId and nonce, uses EE.log accountId as fallback
      const result = await scanner.scanForAccountAndNonce(pid, accountId);
      if (!applyCredentialScanStatus(result)) break;
      if (result.accountId && !accountId) {
        accountId = result.accountId;
        log('LOOP', `Account ID from memory: ${accountId}`);
      } else if (result.accountId) {
        accountId = result.accountId;
      }
      if (result.nonce) {
        nonce = result.nonce;
        break;
      }

      // Poll foreground focus during credential scan so overlay hides immediately.
      if (config.get('showOnlyWhenGameFocused', false)) {
        if (!detector._fgProc) detector.startForegroundMonitor();
        const now = Date.now();
        if (now - lastForegroundCheck >= 400) {
          lastForegroundCheck = now;
          updateGameFocus(await detector.isProcessForeground(pid));
        }
      }

      await sleep(credentialScanRetryDelay());
    }
    if (!accountId || !nonce) { log('LOOP', 'No credentials obtained, restarting outer loop.'); continue; }

    log('LOOP', 'Game session credentials found.');

    // 3. Start polling
    log('LOOP', 'Status -> connected! Starting inventory polling...');
    setStatus('connected');

    calendarAccountId = accountId;
    calendarInventoryCached = false;
    timerState.rawInventory = null;
    let poller = new InventoryPoller(accountId, nonce, DEBUG);
    activeInventoryPoller = poller;
    void playerTracking.refresh();
    poller.start();

    // Resolve the account-matched public profile before publishing an invite name.

    // Monitor loop
    let needsFullRestart = false;
    while (true) {
      // If enabled, hide overlay when Soulframe is not the active foreground app.
      if (config.get('showOnlyWhenGameFocused', false)) {
        if (!detector._fgProc) detector.startForegroundMonitor();
        const now = Date.now();
        if (now - lastForegroundCheck >= 400) {
          lastForegroundCheck = now;
          updateGameFocus(await detector.isProcessForeground(pid));
        }
      } else if (!gameFocusedActive) {
        // If the feature is disabled while unfocused, unhide immediately.
        detector.stopForegroundMonitor();
        gameFocusedActive = true;
        applyGameHiddenState();
      }

      // Check if the game process has exited → full restart
      if (!detector.isProcessRunning(pid)) {
        log('LOOP', 'Game closed. Stopping poller, restarting wait...');
        poller.stop();
        activeInventoryPoller = null;
        void playerTracking.refresh();
        updateInventoryWidgets();
        avakotAccount.update();
        buildExporter.update();
        if (marketWindow || config.get('widgetVisibility', {}).market) market.update();
        if (config.get('widgetVisibility', {})['temper-tracker']) temperTracker.update();
        if (config.get('widgetVisibility', {})['wolf-training']) wolfTraining.update();
        if (TITLE_TRACKER_ENABLED && config.get('widgetVisibility', {})['title-tracker']) titleTracker.update();
        detector.stopForegroundMonitor();
        // Reset focus-hide state so the main window reappears in waiting mode.
        gameFocusedActive = true;
        mainHiddenForFocus = false;
        needsFullRestart = true;
        break;
      }

      // Check for logout event in EE.log
      const loggedOut = logWatcher.consumeLogoutSignal();

      // Check if the nonce expired (API returned INVALID_NONCE / Log-in expired)
      const nonceExpired = poller.isNonceExpired();

      if (loggedOut || nonceExpired) {
        const reason = loggedOut ? 'Logout detected in EE.log' : 'Nonce expired (API rejection)';
        log('LOOP', `${reason} -- stopping poller, waiting for re-login to rescan nonce...`);
        poller.stop();
        activeInventoryPoller = null;
        void playerTracking.refresh();
        updateInventoryWidgets();
        avakotAccount.update();
        buildExporter.update();
        if (marketWindow || config.get('widgetVisibility', {}).market) market.update();
        if (config.get('widgetVisibility', {})['temper-tracker']) temperTracker.update();
        if (config.get('widgetVisibility', {})['wolf-training']) wolfTraining.update();
        if (TITLE_TRACKER_ENABLED && config.get('widgetVisibility', {})['title-tracker']) titleTracker.update();
        setStatus('connecting');

        // Wait for a new login event before rescanning
        log('LOOP', 'Waiting for login event in EE.log...');
        let relogged = false;
        while (true) {
          if (!detector.isProcessRunning(pid)) {
            log('LOOP', 'Game closed while waiting for re-login.');
            needsFullRestart = true;
            break;
          }
          if (logWatcher.consumeLoginSignal()) {
            log('LOOP', 'Login event detected -- rescanning for new nonce...');
            relogged = true;
            break;
          }
          await sleep(500);
        }

        if (!relogged) break; // game closed, full restart

        // Re-scan for credentials (memory-first, EE.log fallback)
        log('LOOP', 'Rescanning for new credentials...');
        nonce = '';
        let rescanAttempts = 0;
        while (true) {
          if (!detector.isProcessRunning(pid)) {
            log('LOOP', 'Game closed during credential rescan.');
            needsFullRestart = true;
            break;
          }
          rescanAttempts++;
          if (rescanAttempts % 10 === 1) {
            log('SCAN', `Credential rescan attempt #${rescanAttempts}...`);
          }
          // EE.log fallback for accountId
          const logAcct = logWatcher.extractAccountId();
          if (logAcct) accountId = logAcct;
          // Combined memory scan (gets both accountId and nonce)
          const result = await scanner.scanForAccountAndNonce(pid, accountId);
          if (!applyCredentialScanStatus(result)) { needsFullRestart = true; break; }
          if (result.accountId) accountId = result.accountId;
          if (result.nonce) { nonce = result.nonce; break; }
          await sleep(credentialScanRetryDelay());
        }

        if (!nonce) break; // game closed, full restart

        log('LOOP', `Account ID for session: ${accountId}`);
        log('LOOP', 'New game session found. Resuming polling...');
        setStatus('connected');
        calendarAccountId = accountId;
        calendarInventoryCached = false;
        timerState.rawInventory = null;
        poller = new InventoryPoller(accountId, nonce, DEBUG);
        activeInventoryPoller = poller;
        void playerTracking.refresh();
        poller.start();
        continue; // back to top of monitor loop
      }

      // Copy data from poller to shared state
      avakotAccount.update();
      timerState.timers = poller.getTimers();
      timerState.dailyAffiliation = poller.getDailyAffiliation();
      timerState.dailyAffiliationOde = poller.getDailyAffiliationOde();
      timerState.factions = poller.getFactions();
      timerState.rawInventory = poller.getRawInventory();
      calendarInventoryCached = poller.isInventoryCached();
      pushStateToRenderer();

      await sleep(500);
    }

    if (needsFullRestart) continue; // restart outer loop (wait for game)
  }
}

// ─── Helpers ──────────────────────────────────────────────
function applyCredentialScanStatus(result) {
  if (result.scanError === 'process-gone') return false;
  const status = result.scanError === 'permission-denied' ? 'permission-denied'
    : result.scanError ? 'scan-failed' : 'connecting';
  if (status !== appStatus) setStatus(status);
  return true;
}

function credentialScanRetryDelay() {
  if (appStatus === 'permission-denied' || appStatus === 'scan-failed') return 10000;
  return platformSupport.platform === 'linux' ? 2000 : 100;
}

function setStatus(status) {
  log('STATUS', `${appStatus} -> ${status}`);
  appStatus = status;
  applyOverlayMousePolicy();
  pushStateToRenderer();
  applyGameHiddenState();
}

/**
 * Hide or show sub-windows and widgets based on game running state
 * and focus state settings.
 */
function applyGameHiddenState() {
  if (overlayHiddenByUser) return;
  const overlayFocused = isAnyOverlayWindowFocused();
  const hideWhenGameClosed = platformSupport.gameConnection && config.get('hideWhenGameClosed', true) && appStatus === 'waiting';
  const hideWhenNotFocused = platformSupport.gameFocusTracking && config.get('showOnlyWhenGameFocused', false)
    && (appStatus === 'connected' || appStatus === 'connecting')
    && !gameFocusedActive
    && !overlayFocused;
  const shouldHide = hideWhenGameClosed || hideWhenNotFocused;

  // When the game is not running, ensure the main overlay can stay visible
  // (unless intentionally hidden to system tray via hideWhenGameClosed).
  if (appStatus === 'waiting' && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !dockAutoHidden) {
    if (!tray) {
      mainWindow.showInactive();
    }
  }

  // Focus-only mode hides the main overlay while Soulframe is not the foreground window.
  if (hideWhenNotFocused) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
    mainHiddenForFocus = true;
  } else if (!hideWhenNotFocused && mainHiddenForFocus) {
    if (mainWindow && !mainWindow.isDestroyed() && !dockAutoHidden) mainWindow.showInactive();
    mainHiddenForFocus = false;
  }

  if (shouldHide && !gameHiddenActive) {
    gameHiddenActive = true;
    setLayoutEditing(false);
    const reason = hideWhenGameClosed ? 'game not running' : 'game not focused';
    log('AUTO-HIDE', `Auto-hide active (${reason}) -- hiding sub-windows and widgets`);
    // Hide widget windows
    if (dockWindow && !dockWindow.isDestroyed()) dockWindow.hide();
    for (const [, wWin] of widgetWindows) {
      if (!wWin.isDestroyed()) wWin.hide();
    }
    // Hide popout sub-windows
    for (const w of [settingsWindow, tutorialWindow, changelogWindow, widgetsWindow, groupFinderWindow, marketWindow, dailyBriefWindow, wikiWindow, mapWindow, dungeonOverlayWindow, calendarSettingsWindow, updateWindow]) {
      if (w && !w.isDestroyed()) w.hide();
    }
  } else if (!shouldHide && gameHiddenActive) {
    gameHiddenActive = false;
    log('AUTO-HIDE', 'Auto-hide cleared -- showing sub-windows and widgets');
    // Only show widgets if not collapsed
    if (!isCollapsed) {
      if (dockWindow && !dockWindow.isDestroyed()) dockWindow.showInactive();
      syncWidgetWindows();
    }
    // Show popout sub-windows
    for (const w of [settingsWindow, tutorialWindow, changelogWindow, widgetsWindow, groupFinderWindow, marketWindow, dailyBriefWindow, wikiWindow, mapWindow, dungeonOverlayWindow, calendarSettingsWindow, updateWindow]) {
      if (w && !w.isDestroyed() && !(w === dailyBriefWindow && w.isMinimized())) w.showInactive();
    }
  }
  syncAlertVisibility();
}

function pushStateToRenderer() {
  updateInventoryWidgets();
  calendar.updateInventory(timerState.rawInventory, calendarAccountId, calendarInventoryCached);
  dailyBrief.update();
  buildExporter.update();
  if (marketWindow || config.get('widgetVisibility', {}).market) market.update();
  if (config.get('widgetVisibility', {})['temper-tracker']) temperTracker.update();
  if (config.get('widgetVisibility', {})['wolf-training']) wolfTraining.update();
  if (TITLE_TRACKER_ENABLED && config.get('widgetVisibility', {})['title-tracker']) titleTracker.update();
  const payload = {
    status: appStatus,
    overlayShortcutWarning,
    visibilityShortcutWarning,
    timers: timerState.timers,
    dailyAffiliation: timerState.dailyAffiliation,
    dailyAffiliationOde: timerState.dailyAffiliationOde,
    factions: timerState.factions,
    namesMap,
    timerDurations: getTimerDurations(),
    arenaStatus,
    arenaDetectionSource,
    arenaWave,
    ancestors: ancestorMarkers,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-update', payload);
  }
  for (const [, wWin] of widgetWindows) {
    if (!wWin.isDestroyed()) wWin.webContents.send('state-update', payload);
  }
  if (dockWindow && !dockWindow.isDestroyed()) {
    for (const frame of dockWindow.webContents.mainFrame.framesInSubtree) {
      try { frame.send('state-update', payload); } catch { /* Cell closed during update. */ }
    }
  }
}

function broadcastArenaStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('arena-status', arenaStatus, arenaDetectionSource);
  }
  for (const [, wWin] of widgetWindows) {
    if (!wWin.isDestroyed()) wWin.webContents.send('arena-status', arenaStatus, arenaDetectionSource);
  }
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.webContents.send('arena-status', arenaStatus, arenaDetectionSource);
  }
}

function broadcastArenaWave() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('arena-wave', arenaWave);
  }
  for (const [, wWin] of widgetWindows) {
    if (!wWin.isDestroyed()) wWin.webContents.send('arena-wave', arenaWave);
  }
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.webContents.send('arena-wave', arenaWave);
  }
}

function broadcastAncestors() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // Docked minimaps have their own preload/IPC listener in a child frame.
    for (const frame of win.webContents.mainFrame.framesInSubtree) {
      try { frame.send('ancestor-markers', ancestorMarkers); } catch { /* Frame detached during layout. */ }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
