// Native QA: actual main/preload/widget-host with an isolated profile.
// Run: node scripts/check-collection-widgets.js [--packaged-renderers] [--fixture-images]
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, stdio: 'inherit', windowsHide: true, timeout: 150000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, session, globalShortcut } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packagedRenderers = process.argv.includes('--packaged-renderers');
const imagePreflight = process.argv.includes('--image-preflight');
// Retain the old option as an alias; native QA never uses production authorization.
const liveImages = process.argv.includes('--fixture-images') || process.argv.includes('--live-images') || imagePreflight;
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const out = path.join(root, 'output', (packagedRenderers ? 'collection-widgets-packaged' : 'collection-widgets') + (liveImages ? '-images' : ''));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-collection-qa-'));
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = profile;
process.env.XDG_DATA_HOME = profile;
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(profile, 'chromium'));
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

const ids = ['collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements', 'crafting-planner', 'activity', 'crafting-log', 'session-analysis'];
const services = new Map();
const requestedPreloads = new Map();
const ObservedBrowserWindow = new Proxy(BrowserWindow, { construct(target, args) {
  const window = Reflect.construct(target, args);
  requestedPreloads.set(window.id, args[0]?.webPreferences?.preload);
  return window;
} });
const { InventoryWidgetService } = require('../src/modules/inventoryWidgetService');
const { dailyAffiliationProgress } = require('../src/modules/affiliationProgress');
const dataModule = require('../src/modules/dataUpdates');
const languageModule = require('../src/modules/languageNames');
const { getCollectionCatalog } = require('../src/modules/collectionCatalog');
const { TUTORIAL_IDS } = require('../src/modules/tutorials');
const catalog = getCollectionCatalog();
if (packagedRenderers) {
  assert.ok(fs.existsSync(archive), 'build the local Windows package before checking its renderer assets');
  assert.ok(fs.readFileSync(path.join(archive, 'src', 'main.js'), 'utf8').includes(catalog.source.buildId), 'bundled main includes verified catalogue provenance');
  assert.equal(fs.existsSync(path.join(archive, 'src', 'data', 'collection-catalog.json')), false, 'the compact catalogue is inlined in bundled main');
  // Match the packaged content-security-policy root while source main retains
  // the backend fixture seams. No packaged backend or live game session runs.
  app.getAppPath = () => archive;
}
const sword = catalog.items.find(row => row.category === 'Weapon' && catalog.mastery.items.some(item => item.itemType === row.itemType));
const pact = catalog.items.find(row => row.category === 'Soul' && catalog.mastery.items.some(item => item.itemType === row.itemType));
const cosmetic = catalog.items.find(row => row.category === 'Cosmetic');
const armor = catalog.items.find(row => row.category === 'Armor');
const appliedHair = catalog.items.find(row => row.itemType === '/SF/Upgrades/Skins/Hair/FemaleLongHairB');
const defaultHair = catalog.items.find(row => row.itemType === '/SF/Upgrades/Skins/Hair/ForgetFireHair2A');
const transmogArmor = catalog.items.find(row => row.itemType === '/SF/Upgrades/Skins/Helmets/ForgetFireNeckMask');
const mote = catalog.items.find(row => row.category === 'Mote');
const craft = catalog.items.find(row => row.category === 'Armor' && row.recipe?.ingredients.length > 1
  && row.recipe.ingredients.every(item => catalog.items.some(entry => entry.itemType === item.itemType && entry.category === 'Resource')));
assert(sword && pact && cosmetic && armor && appliedHair && defaultHair && transmogArmor && mote && craft, 'published catalogue provides realistic fixtures');
const resource = craft.recipe.ingredients[0];
const names = Object.fromEntries(catalog.items.flatMap(row => [[row.itemType, row.name], [row.langKey, row.name]]));
const lore = catalog.discoveries.find(row => row.kind === 'location');
names[lore.itemType] = lore.name;
names['/SF/Types/Game/Ancestors/Tuvalkane'] = 'Tuvalkane';
const objectId = value => ({ $oid: value.toString(16).padStart(24, '0') });
let activeSession = null, cached = true, updatedAt = Date.now();
let inventory = {
  AccountId: 'qa-private-account', Nonce: 'qa-private-nonce', PlayerLevel: 5,
  RegularCredits: 10000, PremiumCredits: 25, FusionPoints: 400,
  Melee: [{ ItemId: objectId(1), ItemType: sword.itemType, XP: 45000, Quality: 'IQ_OFFICER',
    AspectFingerprint: JSON.stringify({ a: [{ t: 'DamageMod', v: 0.25 }] }) }], LongGuns: [], Pistols: [],
  Suits: [{ ItemId: objectId(2), ItemType: pact.itemType, XP: 500,
    Configs: [{ Skins: ['', appliedHair.itemType], Transmog: [transmogArmor.itemType] },
      { Skins: [appliedHair.itemType], Transmog: [transmogArmor.itemType] }] }],
  WeaponSkins: [{ ItemId: objectId(3), ItemType: armor.itemType }],
  FlavourItems: [{ ItemId: objectId(4), ItemType: cosmetic.itemType }],
  MiscItems: craft.recipe.ingredients.map(item => ({ ItemType: item.itemType, ItemCount: Math.max(0, item.count - 1) })),
  Consumables: [], RawUpgrades: [{ ItemType: mote.itemType, ItemCount: 3 }],
  Upgrades: [{ ItemId: objectId(5), ItemType: mote.itemType, UpgradeFingerprint: JSON.stringify({ lvl: 2, pol: 'AP_COURAGE' }) }],
  XPInfo: [{ ItemType: sword.itemType, XP: 50000 }, { ItemType: pact.itemType, XP: 500 }],
  LoreFragmentScans: [{ ItemType: lore.itemType, Progress: lore.required },
    { ItemType: '/SF/Types/Lore/MapTreeLoreFragmentMidrath', Progress: 1 }],
  PlayerSkills: [], Ancestors: [{ ItemType: '/SF/Types/Game/Ancestors/Tuvalkane', Rank: 3, XP: 2500,
    CompletedRecipes: [craft.recipe.itemType + '_IQ_OFFICER'] }],
};
const fakeSession = { accountId: 'qa-private-account', nonce: 'qa-private-nonce', isNonceExpired: () => false,
  getRawInventory: () => inventory, isInventoryCached: () => cached,
  getInventorySavedAt: () => updatedAt, getLastSuccessfulPollAt: () => updatedAt };
const offline = async () => { throw new Error('Native collection QA blocks all network requests'); };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (packagedRenderers && request === 'electron' && parent?.filename === path.join(root, 'src', 'main.js')) {
    return { ...originalLoad.call(this, request, parent, isMain), BrowserWindow: ObservedBrowserWindow };
  }
  if (packagedRenderers && request === 'path' && parent?.filename === path.join(root, 'src', 'main.js')) {
    return { ...path, join(...parts) {
      const filename = path.join(...parts);
      const relative = path.relative(path.join(root, 'src'), filename);
      if (relative === 'preload.js' || relative === path.join('renderer', 'widget-host.html')
          || relative === path.join('renderer', 'widgets-window.html')) return path.join(archive, 'src', relative);
      return filename;
    } };
  }
  if (request.endsWith('/modules/inventoryWidgetService')) return { InventoryWidgetService: class extends InventoryWidgetService {
    constructor(options) { super({ ...options, getSession: () => activeSession }); services.set(options.id, this); }
  } };
  if (request.endsWith('/modules/languageNames')) return { ...languageModule,
    ensureNamesForLanguage: async () => names, downloadLanguage: async () => true, loadLanguageData: () => names };
  if (request.endsWith('/modules/calendar')) return { CalendarService: class extends EventEmitter {
    getDay() { return { source: 'unavailable', ancestor: null, offers: [] }; }
    updateInventory() {} getSettings() { return { source: 'unavailable', ancestors: [] }; } async refresh() { return false; }
  } };
  if (request.endsWith('/modules/dataUpdates')) return { ...dataModule, DataUpdateManager: class {
    constructor() { this.manifest = null; this.state = { files: {} }; }
    getInfo() { return { version: 'offline-qa', source: 'fixture', tileCount: 0 }; }
    async initialize() { return this.getInfo(); } async checkForUpdates() { return { updated: false }; }
    async ensureAsset() { return null; } async refreshCachedAssets() { return { updated: false, failed: [] }; } readJSON() { return null; }
  } };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [],
    dailyAffiliation: dailyAffiliationProgress({ PlayerLevel: 21, DailyAffiliation: 25500 }),
    dailyAffiliationOde: dailyAffiliationProgress({ PlayerLevel: 21, DailyAffiliationOde: 51000 }, 'DailyAffiliationOde'),
    factions: [{ tag: 'OdeSyndicate', standing: 3000 }],
  }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, scannerAvailableSync: () => false };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class {
    async waitForProcess() { return new Promise(() => {}); } startForegroundMonitor() {} stopForegroundMonitor() {}
  } };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/arenaWatcher')) return { ArenaWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/ancestorWatcher')) return { AncestorWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/dungeonWatcher')) return { DungeonWatcher: class { start() {} stop() {} getState() { return { active: false }; } } };
  if (request.endsWith('/modules/screenshotWatcher')) return { configureScreenshotPaths() {}, startWatching() {}, stopWatching() {}, getLastLocation: () => null, onResult() {} };
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, { get: (_target, key) => key === 'getState'
    ? () => ({ configured: false, listings: [], requests: [] }) : () => Promise.resolve(false) });
  if (request === 'axios') return { get: offline, post: offline, create: () => ({ get: offline, post: offline }) };
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
const enabledIds = [...ids, 'player', 'affiliation', 'odeinfamy'];
config.setMany({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false, automaticUpdates: false,
  layoutMode: 'free', backgroundOpacity: 95, language: 'en', theme: 'dark-mint',
  widgetVisibility: Object.fromEntries(enabledIds.map(id => [id, true])), widgetOpen: Object.fromEntries(enabledIds.map(id => [id, true])),
  widgetDocked: Object.fromEntries(enabledIds.map(id => [id, false])), dailyAutoLogin: false, dailyAutoReset: false,
  tutorialCompleted: Object.fromEntries(TUTORIAL_IDS.map(id => [id, true])),
});
const errors = [], layout = [], images = [], imageRequests = [], imagePolicyErrors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if (/Content Security Policy|img-src/.test(message)) imagePolicyErrors.push(message);
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) { const result = await check(); if (result) return result; await pause(50); }
  throw new Error('Timed out: ' + label);
}
const execute = (target, source) => (target.webContents || target).executeJavaScript(source);
const find = fragment => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(fragment));
async function ready(fragment) {
  const window = await until(() => find(fragment), fragment);
  await until(async () => !window.webContents.isLoading() && await execute(window, '!!window.api'), fragment + ' preload');
  return window;
}
const snapshot = (target, id) => execute(target, `window.api.getInventoryWidget(${JSON.stringify(id)})`);
const click = (target, selector) => execute(target, `document.querySelector(${JSON.stringify(selector)}).click()`);
const control = (target, selector, value, event = 'change') => execute(target, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); node.value=${JSON.stringify(value)}; node.dispatchEvent(new Event(${JSON.stringify(event)})); })()`);
const status = target => execute(target, 'document.querySelector(".timer-widget[style*=block] .inventory-widget-status")?.dataset.status || [...document.querySelectorAll(".inventory-widget-status")].find(node=>node.getClientRects().length)?.dataset.status');
const visibleRows = target => execute(target, 'document.querySelectorAll(".collection-row,.collection-extras-row").length');
function publish() { for (const service of services.values()) service.update(); }
async function capture(window, filename) {
  window.showInactive(); window.webContents.invalidate(); await pause(120);
  const image = await window.webContents.capturePage(); assert(!image.isEmpty(), filename + ' paints');
  fs.writeFileSync(path.join(out, filename + '.png'), image.toPNG());
}
async function loadedImage(window, id, filename = id + '-images', selector = '.collection-image,.collection-extras-icon,.item-thumbnail-image') {
  await execute(window, `(() => {
    const image=[...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(node=>node.closest('.inventory-widget-body')&&node.parentElement?.getClientRects().length);
    if(image) { image.loading='eager'; image.scrollIntoView({block:'nearest'}); }
  })()`);
  try {
    const result = await until(() => execute(window, `(() => {
      const image=[...document.querySelectorAll(${JSON.stringify(selector)})]
        .find(node=>node.naturalWidth>0&&node.naturalHeight>0&&!node.hidden&&node.getClientRects().length);
      return image?{src:image.currentSrc,width:image.naturalWidth,height:image.naturalHeight}:null;
    })()`), id + ' fixture game artwork decodes');
    assert.equal(new URL(result.src).protocol, 'overkot-game-data:', id + ' image uses protected game artwork');
    images.push({ id, ...result }); await capture(window, filename); return result;
  } catch (error) {
    const state = await execute(window, `[...document.querySelectorAll('img')].map(image=>({src:image.currentSrc||image.src,width:image.naturalWidth,hidden:image.hidden,complete:image.complete}))`);
    await capture(window, id + '-image-failure');
    fs.writeFileSync(path.join(out, id + '-image-failure.json'), JSON.stringify({ state, imageRequests, imagePolicyErrors }, null, 2));
    throw error;
  }
}
async function fits(window, id, width) {
  await execute(window, `customWidth=${width}; document.body.style.maxWidth='${width}px';`);
  window.setBounds({ x: 80, y: 80, width, height: 700 });
  await execute(window, 'fitWindowToContent()'); await pause(200);
  const result = await execute(window, `(() => {
    const visible=node=>node.getClientRects().length&&node.clientWidth>0;
    const body=[...document.querySelectorAll('.inventory-widget-body')].find(visible);
    return {width:innerWidth,scrollWidth:document.body.scrollWidth,height:innerHeight,usable:body?.clientHeight||0,
      clipping:[...document.querySelectorAll('.inventory-widget-body,.inventory-widget-toolbar,.collection-grid,.collection-extras-goal')]
        .filter(visible).filter(node=>node.scrollWidth>node.clientWidth+2).map(node=>node.className)};
  })()`);
  layout.push({ id, requestedWidth: width, ...result });
  assert.equal(result.width, width, id + ' respects requested width');
  assert.ok(result.scrollWidth <= result.width + 1, id + ' no horizontal overflow');
  assert.deepEqual(result.clipping, [], id + ' no clipped controls or content');
  assert.ok(result.usable >= 40, id + ' has usable scroll area');
}

app.whenReady().then(async () => {
  if (liveImages) {
    const artwork = fs.readFileSync(path.join(root, 'assets/overkot.png'));
    const { imagePath } = require('../src/modules/gameDataImages');
    session.defaultSession.protocol.unhandle('overkot-game-data');
    session.defaultSession.protocol.handle('overkot-game-data', request => {
      if (!imagePath(request.url) || request.url.endsWith('/OverkotQaMissingImage.png')) return new Response('', { status: 404 });
      imageRequests.push(request.url);
      return new Response(artwork, { headers: { 'content-type': 'image/png' } });
    });
  }
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) => {
    done({ cancel: true });
  });
  const main = await ready('index.html'), windows = new Map();
  for (const [id, selector, expected] of [
    ['affiliation', '.affiliation-content', '25,500 / 51,000'],
    ['odeinfamy', '.odeinfamy-content', '0 / 51,000'],
  ]) {
    const window = await ready('widget-host.html?widget=' + id);
    await until(() => execute(window, `document.querySelector(${JSON.stringify(selector)}).textContent.includes(${JSON.stringify(expected)})`), id + ' uses the rank-derived daily cap over real IPC');
    assert.equal(await execute(window, `document.querySelector(${JSON.stringify(selector)}).textContent.includes('16,000')`), false,
      id + ' does not retain the old fixed daily cap');
    await capture(window, id + '-rank-derived-cap');
  }
  for (const id of ids) {
    const window = await ready('widget-host.html?widget=' + id); windows.set(id, window);
    if (packagedRenderers) {
      assert.match(window.webContents.getURL(), /app\.asar\/src\/renderer\/widget-host\.html/, id + ' loads the packaged renderer');
      assert.equal(requestedPreloads.get(window.id), path.join(archive, 'src', 'preload.js'), id + ' uses the packaged preload');
    }
    await until(async () => await status(window) === 'connect', id + ' disconnected mount');
    assert.equal((await snapshot(main, id)).status, 'connect', id + ' actual IPC');
  }
  const collection = windows.get('collection-log');
  await capture(collection, 'collection-disconnected');
  activeSession = fakeSession; publish();
  for (const [id, window] of windows) await until(async () => await status(window) === 'cached', id + ' cached state');
  for (const id of ['collection-log', 'cosmetics']) {
    const row = (await snapshot(main, id)).rows.find(row => row.itemType === appliedHair.itemType);
    assert.equal(row.owned, true, id + ' restores applied hair ownership from cached inventory');
    assert.equal(row.count, 1, id + ' repeated appearance configs do not invent extra copies');
    assert.equal((await snapshot(main, id)).rows.find(row => row.itemType === defaultHair.itemType).owned, true,
      id + ' includes default hair even when the game omits inventory and appearance entries');
  }
  assert.equal((await snapshot(main, 'collection-log')).rows.find(row => row.itemType === transmogArmor.itemType).owned, true,
    'collection restores transmog appearance ownership without a physical skin copy');
  assert.equal((await snapshot(main, 'activity')).tracking, false, 'saved inventory never fabricates activity');
  assert.equal((await snapshot(main, 'session-analysis')).tracking, false, 'saved inventory never fabricates mastery sessions');
  await capture(collection, 'collection-cached');
  if (imagePreflight) {
    await loadedImage(collection, 'collection-log');
    fs.writeFileSync(path.join(out, 'image-preflight.json'), JSON.stringify({ ok: true, images, imageRequests, imagePolicyErrors }, null, 2));
    app.exit(0); return;
  }
  cached = false; publish();
  for (const [id, window] of windows) await until(async () => await status(window) === 'live', id + ' live state');
  for (const id of ids) {
    const value = await snapshot(main, id), serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /qa-private|"AccountId"|"Nonce"|"ItemId"|000000000000000000000001/, id + ' private identity and instance IDs stay in main');
  }
  assert.equal((await snapshot(main, 'resources')).rows.find(row => row.itemType === resource.itemType).count, resource.count - 1);
  assert.equal((await snapshot(main, 'enhancements')).summary.copies, 4);
  assert.equal((await snapshot(main, 'crafting-log')).rows[0].quality, 'IQ_OFFICER');
  assert.equal((await snapshot(main, 'mastery-tracker')).currentRank, 2, 'inventory mastery determines rank, not fixture PlayerLevel 5');

  for (const id of ['collection-log', 'cosmetics']) {
    const window = windows.get(id);
    assert.equal((await snapshot(main, id)).rows.find(row => row.itemType === appliedHair.itemType).owned, true,
      id + ' live IPC retains applied hair ownership');
    await control(window, '.collection-search', appliedHair.itemType, 'input');
    await control(window, '.collection-select[aria-label="Progress filter"]', 'owned');
    assert.equal(await visibleRows(window), 1, id + ' owned filter includes applied hair');
    assert.equal(await execute(window, 'document.querySelector(".collection-state").textContent'), 'Owned',
      id + ' applied hair renders as Owned');
    await capture(window, id + '-applied-hair-owned');
    await control(window, '.collection-select[aria-label="Progress filter"]', 'missing');
    assert.equal(await visibleRows(window), 0, id + ' missing filter excludes applied hair');
    await control(window, '.collection-select[aria-label="Progress filter"]', 'all');
    await control(window, '.collection-search', '', 'input');
  }
  await control(collection, '.collection-search', transmogArmor.itemType, 'input');
  assert.equal(await execute(collection, 'document.querySelector(".collection-state").textContent'), 'Owned',
    'collection renders a transmog-only appearance as Owned');
  await control(collection, '.collection-select[aria-label="Progress filter"]', 'missing');
  assert.equal(await visibleRows(collection), 0, 'collection missing filter excludes transmog-only appearance');
  await control(collection, '.collection-select[aria-label="Progress filter"]', 'all');
  await control(collection, '.collection-search', '', 'input');

  const masteryWindow = windows.get('mastery-tracker');

  await control(collection, '.collection-select[aria-label="Category"]', 'discoveries');
  const discoverySnapshot = await snapshot(main, 'collection-log');
  assert.equal(discoverySnapshot.discoveries.find(row => row.itemType === lore.itemType).current, lore.required);
  assert.equal(discoverySnapshot.discoveries.find(row => row.kind === 'tree' && row.id.endsWith(':bit:0')).complete, true);
  assert.equal(await execute(collection, 'document.querySelector(".collection-total").textContent'), '2 / 58');
  await control(collection, '.collection-search', lore.name, 'input');
  assert.equal(await execute(collection, 'document.querySelector(".collection-row").textContent.includes(' + JSON.stringify(`${lore.required} / ${lore.required}`) + ')'), true, 'discovery count renders actual completed progress');
  await capture(collection, 'collection-discoveries');
  if (liveImages) await loadedImage(collection, 'discovery');
  await control(collection, '.collection-select[aria-label="Category"]', 'all');
  await control(collection, '.collection-select[aria-label="View"]', 'armory');
  await control(collection, '.collection-search', sword.itemType, 'input');
  assert.equal(await execute(collection, 'document.querySelector(".collection-copy").textContent.includes("Officer")'), true, 'Armory shows sanitized owned copy quality');
  await capture(collection, 'collection-armory');
  await control(collection, '.collection-select[aria-label="View"]', 'grid');

  await control(collection, '.collection-search', sword.itemType, 'input');
  await until(async () => await visibleRows(collection) === 1, 'collection search');
  await click(collection, '.collection-pin');
  assert.equal(await execute(collection, 'document.querySelector(".collection-pin").getAttribute("aria-pressed")'), 'true');
  await control(collection, '.collection-select[aria-label="Progress filter"]', 'pinned');
  assert.equal(await visibleRows(collection), 1, 'pin filter');
  await control(collection, '.collection-search', '', 'input');
  assert.equal(await visibleRows(collection), 1, 'only pinned goal remains');
  await execute(collection, 'document.querySelector(".collection-search").focus(); window.qaSearch=document.activeElement');
  inventory = structuredClone(inventory); updatedAt += 60000;
  inventory.MiscItems[0].ItemCount += 5; inventory.RegularCredits += 100; inventory.XPInfo[0].XP += 10000; publish();
  await until(() => execute(collection, 'document.activeElement===window.qaSearch'), 'live updates preserve focused search');
  await until(async () => (await snapshot(main, 'activity')).rows.some(row => row.delta === 5), 'activity observes real inventory delta');
  await until(async () => (await snapshot(main, 'session-analysis')).current?.gained > 0, 'session analysis records mastery gain across live snapshots');
  assert.equal(await execute(windows.get('session-analysis'), 'document.querySelectorAll(".mastery-session-bar").length'), 1, 'mastery timeline plots observed interval');
  await capture(windows.get('activity'), 'activity-live-deltas');
  if (liveImages) await loadedImage(windows.get('activity'), 'activity');
  await click(windows.get('activity'), '.collection-extras-button');
  await until(async () => (await snapshot(main, 'activity')).rows.length === 0, 'activity restart IPC');

  const planner = windows.get('crafting-planner');
  await control(planner, 'input[type=search]', craft.itemType, 'input');
  await click(planner, '.collection-extras-list .collection-extras-button');
  assert.equal(await execute(planner, 'document.querySelectorAll(".collection-extras-goal").length'), 1, 'planner adds selected craft');
  await control(planner, '.collection-extras-quantity', '2');
  assert.equal(await execute(planner, 'JSON.parse(localStorage.getItem("overkot.crafting-planner.goals.v1"))[0].quantity'), 2, 'planner goal quantity persists');
  assert.equal(await execute(planner, 'document.querySelector(".collection-extras-body").textContent.includes("more needed")'), true, 'planner displays combined deficits');
  if (liveImages) {
    await loadedImage(planner, 'crafting-goal', 'crafting-goal-images', '.collection-extras-goal .item-thumbnail-image');
    await loadedImage(planner, 'crafting-material', 'crafting-material-images', '.collection-extras-body > article .item-thumbnail-image');
  }

  const resources = windows.get('resources');
  await control(resources, 'select[aria-label="Resource category"]', 'Currency');
  assert.equal(await visibleRows(resources), 3, 'resource category filters currencies');
  if (liveImages) for (let index = 1; index <= 2; index++) {
    await loadedImage(resources, 'currency-' + index, 'currency-' + index + '-images', `.collection-extras-list > article:nth-child(${index}) .item-thumbnail-image`);
  }
  if (liveImages) assert.equal(await execute(resources, `(() => {
    const thumbnail=document.querySelector('.collection-extras-list > article:nth-child(3) .item-thumbnail');
    return thumbnail?.classList.contains('is-missing')&&!thumbnail.querySelector('img')&&thumbnail.clientWidth>0&&thumbnail.clientHeight>0;
  })()`), true, 'Harmony without published item art retains a visible category fallback');
  await control(resources, 'select[aria-label="Resource category"]', 'all');
  await control(resources, 'input[type=search]', resource.itemType, 'input');
  assert.equal(await visibleRows(resources), 1, 'resource search uses item type');
  const enhancements = windows.get('enhancements');
  assert.equal(await execute(enhancements, 'document.querySelector(' + JSON.stringify('select[aria-label="Enhancement rank"]') + ').value'), 'all', 'enhancements starts with every rank');
  await control(enhancements, 'select[aria-label="Enhancement rank"]', 'all');
  await control(enhancements, 'select[aria-label="Virtue"]', 'COURAGE');
  assert.equal(await visibleRows(enhancements), 1, 'enhancement virtue filter');
  await control(enhancements, 'select[aria-label="Virtue"]', 'all');
  await control(masteryWindow, '.collection-select[aria-label="View"]', 'planner');
  await control(masteryWindow, '.collection-search', sword.itemType, 'input');
  await click(masteryWindow, '.collection-pin');
  assert.equal(await visibleRows(masteryWindow), 1, 'mastery goal search and pin');

  if (liveImages) for (const id of ['collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements', 'crafting-planner', 'crafting-log']) {
    await loadedImage(windows.get(id), id);
  }

  if (liveImages) {
    const player = await ready('widget-host.html?widget=player');
    if (packagedRenderers) {
      assert.match(player.webContents.getURL(), /app\.asar\/src\/renderer\/widget-host\.html/, 'Player equipment loads packaged renderer assets');
      assert.equal(requestedPreloads.get(player.id), path.join(archive, 'src', 'preload.js'), 'Player equipment uses the packaged preload');
    }
    await execute(player, 'document.querySelectorAll(".player-tab")[1].click()');
    await until(async () => await status(player) === 'live', 'Player equipment receives live inventory');
    await loadedImage(player, 'player-equipment');
    await fits(player, 'player-equipment', 410); await capture(player, 'player-equipment-410');
    await fits(player, 'player-equipment', 300); await capture(player, 'player-equipment-300');
    await execute(collection, `(() => {
      const body=document.querySelector('.inventory-widget-body'), thumbnail=ItemImages.create('/SF/Interface/Graphics/OverkotQaMissingImage.png',{category:'Weapon'});
      thumbnail.dataset.qaMissing='true'; body.prepend(thumbnail); thumbnail.querySelector('img').loading='eager'; thumbnail.scrollIntoView({block:'nearest'});
    })()`);
    await until(() => execute(collection, `(() => {
      const thumbnail=document.querySelector('[data-qa-missing]');
      return thumbnail?.classList.contains('is-missing')&&thumbnail.querySelector('img').hidden
        &&thumbnail.clientWidth>0&&thumbnail.clientHeight>0&&getComputedStyle(thumbnail.querySelector('svg')).visibility!=='hidden';
    })()`), 'failed live image retains visible fallback and thumbnail geometry');
    await capture(collection, 'missing-image-fallback');
    await execute(collection, 'document.querySelector("[data-qa-missing]").remove()');
  }

  for (const [id, window] of windows) {
    await fits(window, id, 410); await capture(window, id + '-410');
    await fits(window, id, 300); await capture(window, id + '-300');
  }
  await execute(main, 'window.api.openWidgets()'); const picker = await ready('widgets-window.html');
  if (packagedRenderers) assert.match(picker.webContents.getURL(), /app\.asar\/src\/renderer\/widgets-window\.html/, 'picker loads its packaged renderer');
  const pickerIds = await execute(picker, '[...document.querySelectorAll(".widget-card")].map(row=>row.dataset.widget)');
  for (const id of ids) assert.ok(pickerIds.includes(id), id + ' is discoverable in picker');
  await capture(picker, 'widget-picker');
  activeSession = null; publish();
  for (const [id, window] of windows) await until(async () => await status(window) === 'connect', id + ' disconnect clears displayed inventory');
  activeSession = fakeSession; cached = true; publish();
  for (const [id, window] of windows) await until(async () => await status(window) === 'cached', id + ' reconnect saved state');
  assert.equal((await snapshot(main, 'activity')).tracking, false, 'reconnect clears old activity history');
  assert.equal((await snapshot(main, 'session-analysis')).tracking, false, 'cached reconnect cannot accrue mastery XP');
  cached = false; publish();
  await until(async () => await status(collection) === 'live', 'live reconnect');
  assert.equal(await visibleRows(collection), 1, 'pin preferences survive reconnect');
  assert.equal(await execute(collection, 'document.querySelector(".collection-pin").getAttribute("aria-pressed")'), 'true');
  const analysis = windows.get('session-analysis');
  await control(analysis, 'select[aria-label="Session date range"]', 'all');
  assert.equal(await execute(analysis, 'document.querySelectorAll(".mastery-session-history").length'), 2, 'date range retains prior live connection and new baseline');
  await capture(analysis, 'session-analysis-history');

  // Rank follows inventory mastery and its XP curve. Neither a raw level
  // refresh nor a release ceiling may replace the calculated result.
  await control(masteryWindow, '.collection-select[aria-label="View"]', 'rank');
  inventory = { ...inventory, PlayerLevel: 21, PlayerSkills: [],
    XPInfo: catalog.mastery.items.map(item => ({ ItemType: item.itemType, XP: catalog.mastery.itemRankXP[item.kind][item.maxRank] })),
    LoreFragmentScans: catalog.discoveries.filter(item => item.masteryEligible).map(item => ({ ItemType: item.itemType, Progress: item.required })),
  }; updatedAt += 1000; publish();
  await until(() => execute(masteryWindow, 'document.querySelector(".collection-total")?.textContent.includes("19")'), '453000 inventory mastery XP calculates Envoy Rank 19');
  const derived = await snapshot(main, 'mastery-tracker');
  assert.equal(derived.totalXP, 453000);
  assert.equal(derived.currentRank, 19);
  assert.equal(derived.rankSource, 'inventory-mastery');
  assert.equal(derived.maxAttainableRank, undefined, 'there is no release rank ceiling');
  assert.equal(await execute(masteryWindow, '/MAX/.test(document.querySelector(".collection-heading").textContent)'), false);
  assert.equal(await execute(masteryWindow, '/ER 20/.test(document.querySelector(".collection-heading").textContent)'), true, 'normal next-rank progress continues beyond 19');
  const unchangedXP = (await snapshot(main, 'session-analysis')).current;
  inventory = { ...inventory, PlayerLevel: 0, Stats: { PlayerLevel: 40 } }; updatedAt += 1000; publish();
  assert.equal((await snapshot(main, 'mastery-tracker')).currentRank, 19, 'raw level and playerstats cannot replace inventory rank');
  inventory = { ...inventory }; delete inventory.PlayerLevel; updatedAt += 1000; publish();
  assert.equal((await snapshot(main, 'mastery-tracker')).currentRank, 19, 'rank does not require a level field');
  assert.equal((await snapshot(main, 'session-analysis')).current.rankUps, unchangedXP.rankUps, 'raw level changes cannot create a session rank-up');
  assert.equal((await snapshot(main, 'session-analysis')).current.gained, unchangedXP.gained);
  await capture(masteryWindow, 'mastery-rank-19-inventory');
  inventory = { ...inventory, PlayerSkills: [32] }; updatedAt += 1000; publish();
  await until(() => execute(masteryWindow, 'document.querySelector(".collection-total")?.textContent.includes("20")'), '501000 inventory mastery XP calculates Envoy Rank 20');
  const advanced = await snapshot(main, 'mastery-tracker');
  assert.equal(advanced.totalXP, 501000);
  assert.equal(advanced.currentRank, 20, 'inventory XP can advance beyond rank 19');
  assert.equal((await snapshot(main, 'session-analysis')).current.rankTo, 20);
  await capture(masteryWindow, 'mastery-rank-20-inventory');
  assert.deepEqual(errors, [], 'all renderers complete without JavaScript failures');
  if (liveImages) assert.deepEqual(imagePolicyErrors, [], 'owned S3 images load without content security policy violations');
  const report = { ok: true, packagedRenderers, liveImages, ...(packagedRenderers ? { archive } : {}), widgets: ids,
    catalogBuild: catalog.source.buildId, layout, images, imageRequests, imagePolicyErrors, screenshots: out, isolatedProfile: profile };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); app.exit(0);
}).catch(error => { console.error(error.stack); console.error(JSON.stringify({ errors, layout, screenshots: out, isolatedProfile: profile }, null, 2)); app.exit(1); });
