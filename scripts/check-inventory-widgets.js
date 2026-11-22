// Offline native QA for consolidated Player/Daily panels and real main/preload IPC.
// Run: node scripts/check-inventory-widgets.js
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
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
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', 'inventory-widgets');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-inventory-qa-'));
fs.mkdirSync(out, { recursive: true });
// Both Chromium and application-specific storage are isolated from normal runs.
process.env.LOCALAPPDATA = profile;
process.env.XDG_DATA_HOME = profile;
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(profile, 'chromium'));
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

const ids = ['storage-capacity', 'account-wallet', 'active-boons', 'equipment-progress', 'session-gains'];
const services = new Map();
const { InventoryWidgetService } = require('../src/modules/inventoryWidgetService');
const dataModule = require('../src/modules/dataUpdates');
const fixtureImage = fs.readFileSync(path.join(root, 'assets/overkot.png'));
const imageHash = createHash('sha256').update(fixtureImage).digest('hex');
const temperIcon = `temper-icons/${imageHash}.png`;
const temperEntry = { sha256: imageHash, bytes: fixtureImage.length, downloadBytes: fixtureImage.length,
  encoding: 'identity', url: `objects/${imageHash}.png` };
const temperCatalog = require('../src/data/tempers.json');
const vendorTags = ['cassidpoisonmod', 'feykinarcanicdamagemod'];
const vendorTemperIds = vendorTags.map(tag => temperCatalog.aliases[tag]);
const fixtureTempers = { ...temperCatalog, tempers: temperCatalog.tempers
  .filter(row => vendorTemperIds.includes(row.id)).map(row => ({ ...row, icon: temperIcon })) };
assert.equal(fixtureTempers.tempers.length, vendorTags.length, 'both vendor tempers have fixture catalogue entries');
// Use the real content-addressed cache and protocol. Only the image download is local.
const iconCache = new dataModule.DataUpdateManager({
  rootDir: path.join(profile, 'fixture-icons'), manifestUrl: 'http://127.0.0.1:1/manifest.json',
  http: { async get(url) {
    assert.equal(url, 'http://127.0.0.1:1/' + temperEntry.url);
    return { data: fixtureImage };
  } },
});
const { DailyBrief } = require('../src/modules/dailyBrief');
const { DailyVendors, AVAKOT_VENDOR, CATALOG_URL, STOCK_URL } = require('../src/modules/dailyVendors');
let dailyService, vendorService; const openReasons = [], vendorRequests = [];
const { TUTORIAL_IDS } = require('../src/modules/tutorials');
const itemId = value => ({ $oid: value.toString(16).padStart(24, '0') });
const catalog = require('../src/data/collection-catalog.json');
const sword = catalog.mastery.items.find(row => row.kind === 'weapon' && /^\/SF\/Weapons\/Melee\//.test(row.itemType))?.itemType;
const bow = catalog.mastery.items.find(row => row.kind === 'weapon' && /^\/SF\/Weapons\/(?:Bows|Ranged)\//.test(row.itemType))?.itemType;
const pact = catalog.mastery.items.find(row => row.kind === 'pact')?.itemType;
assert(sword && bow && pact, 'Equipment fixtures come from the approved collection catalogue');
const resource = '/SF/Types/Items/MiscItems/FixtureOre';
const fixtureArtwork = catalog.items.find(row => row.icon)?.icon;
const consumable = '/SF/Types/Items/Consumables/FixturePotion';
const boon = '/SF/Types/Items/Boosters/FixtureBoon';
const names = { [sword]: 'Fixture sword', [bow]: 'Fixture bow', [pact]: 'Fixture Pact',
  [resource]: 'Fixture ore', [consumable]: 'Fixture potion', [boon]: 'Fixture boon' };
let fakeNow = Date.now(), updatedAt = fakeNow, activeSession = null, cached = false;
let inventory = {
  AccountId: 'qa-account', Nonce: 'qa-private-session', UniversalBin: { Slots: 12 },
  RegularCredits: 10000, PremiumCredits: 100, TradesRemaining: 4, DailyAffiliation: 12000, DailyAffiliationOde: 15000,
  Affiliations: [{ Tag: 'ChampionSyndicate', Title: 4, Standing: 50000 }],
  Melee: [{ ItemId: itemId(1), ItemType: sword, XP: 100 }],
  LongGuns: [{ ItemId: itemId(2), ItemType: bow, XP: 45000 }],
  Suits: [{ ItemId: itemId(3), ItemType: pact, XP: 1000 }],
  WeaponSkins: [{ ItemId: itemId(4), ItemType: '/SF/Upgrades/Skins/Body/FixtureArmour' }],
  XPInfo: [{ ItemType: sword, XP: 222000 }],
  MiscItems: [{ ItemType: resource, ItemCount: 10 }],
  Consumables: [{ ItemType: consumable, ItemCount: 2 }],
  Boosters: [{ ItemType: boon, ExpiryDate: Math.floor(updatedAt / 1000) + 7200 },
    { ItemType: '/SF/Types/Items/Boosters/FixtureEndedBoon', ExpiryDate: Math.floor(updatedAt / 1000) - 3600 }],
};
const fakeSession = { accountId: '000000000000000000000abc', nonce: 'fixture-private-nonce', isNonceExpired: () => false, isInventoryCached: () => cached,
  api: { fetchProfile: async accountId => ({ Results: [{ AccountId: accountId }], Stats: { TimePlayedSec: 123456 } }) },
  getRawInventory: () => inventory, getInventorySavedAt: () => updatedAt, getLastSuccessfulPollAt: () => updatedAt };
const offline = async () => { throw new Error('Native QA blocks all network requests'); };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/inventoryWidgetService')) return { InventoryWidgetService: class extends InventoryWidgetService {
    constructor(options) {
      super({ ...options, getSession: () => activeSession, getNames: () => names }); services.set(options.id, this);
    }
  } };
  if (request.endsWith('/modules/dailyBrief')) return { DailyBrief: class extends DailyBrief {
    constructor(options) { super({ ...options, getSession: () => activeSession, now: () => fakeNow }); dailyService = this;
      this.on('open', reason => openReasons.push(reason)); }
  } };
  if (request.endsWith('/modules/dailyVendors')) return { DailyVendors: class extends DailyVendors {
    constructor(options) { super({ ...options, getSession: () => activeSession, getNames: () => names, now: () => fakeNow,
      http: { async get(url, options) {
        vendorRequests.push(url);
        if (url === CATALOG_URL) return { status: 200, data: { avakot: { vendor: AVAKOT_VENDOR, pool: [
          { storeItem: '/SF/StoreItems/Upgrades/Skins/Body/FixtureArmour', typeName: '/SF/Upgrades/Skins/Body/FixtureArmour', value: 'Fixture armour', icon: fixtureArtwork },
          { storeItem: '/SF/StoreItems/Types/Items/MiscItems/FixtureOre', typeName: resource, value: 'Fixture ore', icon: fixtureArtwork },
        ] }, factions: [{ syndicate: 'ChampionSyndicate', favors: [
          { storeItem: '/SF/StoreItems/Weapons/Melee/FixtureSword', typeName: sword, value: 'Fixture sword', standingCost: 15000, requiredLevel: 3,
            aspects: [{ tag: 'CassidPoisonMod', rarity: 0, canBeBuff: true, canRollTwice: true }, { tag: 'FeykinArcanicDamageMod', rarity: 1, canBeBuff: true, canRollTwice: false }] },
          { storeItem: '/SF/StoreItems/Types/Items/MiscItems/FixtureOre', typeName: resource, value: 'Fixture ore', standingCost: 300, requiredLevel: 1 },
        ] }] } };
        assert.equal(url, STOCK_URL); assert.equal(options.params.nonce, fakeSession.nonce);
        return { status: 200, data: { VendorInfo: { TypeName: AVAKOT_VENDOR, ItemManifest: [
          { StoreItem: '/SF/StoreItems/Upgrades/Skins/Body/FixtureArmour', RegularPrice: [2500], PremiumPrice: [0], PurchaseQuantityLimit: 1, Expiry: { $date: { $numberLong: String(fakeNow + 10800000) } } },
          { StoreItem: '/SF/StoreItems/Types/Items/MiscItems/FixtureOre', RegularPrice: [0], PremiumPrice: [8], PurchaseQuantityLimit: 3, Expiry: { $date: { $numberLong: String(fakeNow + 10800000) } } },
        ] } } };
      } } }); vendorService = this; }
  } };
  if (request.endsWith('/modules/calendar')) return { CalendarService: class extends EventEmitter {
    getDay(date) { const offset = Math.round((Date.parse(date + 'T00:00:00Z') - Math.floor(fakeNow / 86400000) * 86400000) / 86400000);
      return { date, today: new Date(fakeNow).toISOString().slice(0, 10), firstDate: '2026-01-01', lastDate: '2027-12-31',
      ancestor: offset === 1 ? 'Tuvalkane' : offset === 3 ? 'Zenith' : 'Fixture ancestor', encounterAvailable: true, inventoryReady: true, source: 'live', customized: false,
      offers: [{ name: 'Fixture Zenith sword', price: 25 }, { name: 'Fixture Zenith bow', price: 30 }] }; }
    updateInventory() {} getSettings() { return { source: 'live', ancestors: [] }; } async refresh() { return false; }
  } };
  if (request.endsWith('/modules/dataUpdates')) return { ...dataModule, DataUpdateManager: class {
    constructor() { this.manifest = null; this.state = { files: {} }; }
    getInfo() { return { version: 'offline-qa', source: 'fixture', tileCount: 0 }; }
    async initialize() {
      await iconCache.initialize();
      iconCache.manifest = { files: { [temperIcon]: temperEntry } };
      return this.getInfo();
    }
    async checkForUpdates() { return { updated: false }; }
    cachedPath(key) { return key === temperIcon ? iconCache.cachedPath(key) : null; }
    async ensureAsset(key) { return key === temperIcon ? iconCache.ensureAsset(key) : null; }
    async refreshCachedAssets() { return { updated: false, failed: [] }; }
    readJSON(key) { return key === 'tempers/en.json' ? fixtureTempers : null; }
  } };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [] }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, scannerAvailableSync: () => false };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class {
    async waitForProcess() { return new Promise(() => {}); } startForegroundMonitor() {} stopForegroundMonitor() {}
  } };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/arenaWatcher')) return { ArenaWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/ancestorWatcher')) return { AncestorWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/dungeonWatcher')) return { DungeonWatcher: class { start() {} stop() {} getState() { return { active: false }; } } };
  if (request.endsWith('/modules/screenshotWatcher')) return {
    configureScreenshotPaths() {}, startWatching() {}, stopWatching() {}, getLastLocation: () => null, onResult() {},
  };
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, {
    get: (_target, key) => key === 'getState' ? () => ({ configured: false, listings: [], requests: [] }) : () => Promise.resolve(false),
  });
  if (request === 'axios') return { get: offline, post: offline, create: () => ({ get: offline, post: offline }) };
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
config.setMany({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  automaticUpdates: false, layoutMode: 'free', backgroundOpacity: 95, language: 'en', theme: 'dark-mint',
  widgetVisibility: { player: true, daily: true }, widgetOpen: { player: true, daily: false }, dailyAutoLogin: true, dailyAutoReset: true,
  widgetDocked: { player: false, daily: false }, tutorialCompleted: Object.fromEntries(TUTORIAL_IDS.map(id => [id, true])),
});
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await check(); if (result) return result; await pause(50);
  }
  throw new Error('Timed out: ' + label);
}
const execute = (target, source) => (target.webContents || target).executeJavaScript(source);
const find = fragment => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(fragment));
const dailyFragment = 'daily-brief-window.html';
const panelFragment = id => id === 'daily' ? dailyFragment : 'widget-host.html?widget=' + id;
async function ready(fragment) {
  const window = await until(() => find(fragment), fragment);
  await until(async () => !window.webContents.isLoading() && await execute(window, '!!window.api'), fragment + ' preload');
  return window;
}
const click = (target, selector) => execute(target, 'document.querySelector(' + JSON.stringify(selector) + ').click()');
const snapshot = (target, id) => execute(target, 'window.api.getInventoryWidget(' + JSON.stringify(id) + ')');
const playerTab = (target, tab) => click(target, `.player-tab[aria-controls$="-${tab}-panel"]`);
const dailyTab = (target, tab) => click(target, `.daily-tab[aria-controls$="-${tab}"]`);
const read = target => execute(target, `(() => {
  const visible=node=>node.getClientRects().length&&node.clientWidth>0;
  const active=document.querySelector('.player-panel:not([hidden]),.daily-panel:not([hidden])');
  const scroll=active?.querySelector('.player-overview,.daily-scroll,.inventory-widget-body,.calendar-day');
  return {status:active?.querySelector('.inventory-widget-status')?.dataset.status,text:active?.textContent||'',
    rows:active?.querySelectorAll('.equipment-row').length||0,gains:[...document.querySelectorAll('.session-gains-net')].map(node=>node.textContent),
    height:active?.clientHeight||0,scrollHeight:scroll?.scrollHeight||0,usable:scroll?.clientHeight||0,width:innerWidth,scrollWidth:document.body.scrollWidth,
    clipping:[...document.querySelectorAll('.inventory-widget-body,.inventory-widget-toolbar,.daily-scroll,.player-tabs,.daily-tabs')]
      .filter(visible).filter(node=>node.scrollWidth>node.clientWidth+2).map(node=>node.className),
    narrowSearch:[...document.querySelectorAll('.equipment-search,.session-gains-search,.daily-search')].filter(visible)
      .filter(node=>node.getBoundingClientRect().width<node.parentElement.clientWidth-2).length};
})()`);
async function fits(target, label) {
  await until(async () => { const value = await read(target); return value.scrollWidth <= value.width + 1
    && value.clipping.length === 0 && value.narrowSearch === 0 && value.usable >= Math.min(250, value.scrollHeight) - 2; }, label + ' usable content and no clipping');
}
async function capture(window, filename) {
  window.showInactive(); window.webContents.invalidate(); await pause(180);
  const image = await window.webContents.capturePage(); assert(!image.isEmpty(), filename + ' paints');
  fs.writeFileSync(path.join(out, filename + '.png'), image.toPNG());
}
function publish() { for (const service of services.values()) service.update(); dailyService.update(); }

app.whenReady().then(async () => {
  // Serve fixture item artwork from the local app icon; QA stays offline while
  // exercising actual image loading, dimensions and fallback visibility.
  const isFixtureArtwork = url => url.startsWith('overkot-game-data://images/SF/Interface/Graphics/');
  session.defaultSession.protocol.unhandle('overkot-game-data');
  session.defaultSession.protocol.handle('overkot-game-data', request => isFixtureArtwork(request.url)
    ? new Response(fixtureImage, { headers: { 'content-type': 'image/png' } }) : new Response('', { status: 503 }));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) =>
    done({ cancel: true }));
  const main = await ready('index.html'), player = await ready('widget-host.html?widget=player');
  for (const id of ['player']) assert.equal(await execute(player,
    `!!document.querySelector('.timer-widget[data-widget="${id}"] .${id}-content')`), true, id + ' has a real widget host template');
  // main also registers the separate collection/resource/mastery services.
  // This check owns the five Player modules, each exercised through real IPC
  // below; their availability must not depend on the count of other services.
  for (const id of ids) assert.ok(services.has(id), id + ' domain module remains available inside Player');
  assert.equal(find(dailyFragment), undefined, 'Daily pop-out starts closed');
  await until(async () => (await read(player)).status === 'connect', 'Player disconnected'); await capture(player, 'player-connect');
  for (const id of ids) assert.equal((await snapshot(main, id)).status, 'connect', id + ' real IPC');
  activeSession = fakeSession; cached = true; publish();
  await until(async () => (await read(player)).status === 'cached', 'Player saved inventory');
  assert.deepEqual(openReasons, [], 'saved inventory cannot open Daily');
  assert.equal((await snapshot(main, 'session-gains')).baselineAt, null);
  cached = false; publish();
  let daily = await ready(dailyFragment);
  await until(() => daily.isVisible(), 'first live login opens Daily'); assert.deepEqual(openReasons, ['login']);
  assert.equal(daily.isResizable(), true, 'Daily Brief is a normal native resizable pop-out');
  assert.equal(daily._widgetId, undefined, 'Daily Brief does not join the docked widget collection');
  assert.equal(find('widget-host.html?widget=daily'), undefined, 'Daily Brief has no docked widget host');
  await until(async () => (await read(player)).status === 'live', 'Player live inventory');
  await until(async () => (await execute(daily, 'window.api.getDailyBrief()')).vendors.avakot.items.length === 2, 'real vendor catalogue and stock projection');
  assert.equal((await snapshot(main, 'storage-capacity')).total, 16);
  assert.equal((await snapshot(main, 'account-wallet')).rows.find(row => row.key === 'TradesRemaining').value, 4);
  await fits(player, 'Player overview'); await capture(player, 'player-overview');
  await fits(daily, 'Daily Today'); await capture(daily, 'daily-today');
  daily.setBounds({ x: 100, y: 100, width: 620, height: 700 });
  await until(async () => {
    const bounds = (await execute(main, 'window.api.getState()')).config.dailyBriefBounds;
    return bounds?.width === 620 && bounds?.height === 700;
  }, 'independent Daily Brief size is persisted');
  await click(daily, '#daily-minimize');
  await until(() => daily.isMinimized(), 'Daily titlebar minimizes its own pop-out');
  assert.equal(main.isVisible(), true, 'minimizing Daily Brief does not hide Overkot');
  assert.equal(player.isVisible(), true, 'minimizing Daily Brief keeps the Player widget visible');
  await click(main, '.dock-widget-button[data-widget="daily"]');
  await until(() => daily.isVisible() && !daily.isMinimized(), 'Daily dock launcher restores its existing minimized pop-out');
  assert.equal(BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().includes(dailyFragment)).length, 1, 'restoring Daily Brief does not create a duplicate');
  assert.equal(await execute(daily, 'document.querySelector(".daily-today-content").textContent.includes("12,000")'), true, 'exact remaining affiliation');
  await until(() => execute(daily, 'document.querySelector(".daily-today-content").textContent.includes("34h 17m")'), 'public profile total played time');
  assert.equal(await execute(daily, 'document.querySelector(".daily-today-content").textContent.includes("Ode infamy")'), false);
  assert.equal(await execute(daily, 'document.querySelector(".daily-today-content").textContent.includes("Avakot")'), false);
  assert.equal(await execute(daily, 'parseFloat(getComputedStyle(document.querySelector(".daily-ancestor")).fontSize) >= 24'), true, 'ancestor is prominent');
  assert.equal(await execute(daily, 'document.querySelector(".daily-upcoming").textContent.includes("Tomorrow")'), true);
  assert.equal(await execute(daily, 'document.querySelector(".daily-upcoming").textContent.includes("3 days")'), true);
  await playerTab(player, 'equipment'); await until(async () => (await read(player)).rows === 3, 'Equipment tab');
  await execute(player, `(() => {const input=document.querySelector('.equipment-search');input.focus();input.value='Fixture sword';input.dispatchEvent(new Event('input'));window.qaEquipmentSearch=input;})()`);
  assert.equal((await read(player)).rows, 1); await playerTab(player, 'session');
  inventory = structuredClone(inventory); updatedAt += 60000;
  inventory.MiscItems[0].ItemCount += 5; inventory.Consumables[0].ItemCount -= 1; inventory.RegularCredits += 250; inventory.PremiumCredits -= 5; publish();
  await until(async () => (await read(player)).gains.length === 4, 'net gains and spending inside Player');
  await fits(player, 'Player Session'); await capture(player, 'player-session');
  await click(player, '.session-gains-reset'); await until(async () => (await snapshot(main, 'session-gains')).rows.every(row => row.net === 0), 'Session Restart IPC');
  await playerTab(player, 'equipment');
  assert.equal(await execute(player, 'document.querySelector(".equipment-search")===window.qaEquipmentSearch'), true, 'tab switches retain controls');
  assert.equal((await read(player)).rows, 1, 'tab switches retain filters');
  await execute(player, `(() => {const input=document.querySelector('.equipment-search');input.value='';input.dispatchEvent(new Event('input'));input.focus();})()`);
  inventory = structuredClone(inventory); updatedAt += 1000; publish();
  await until(() => execute(player, 'document.activeElement===window.qaEquipmentSearch'), 'live updates retain focus');
  await fits(player, 'Player Equipment'); await capture(player, 'player-equipment');
  await playerTab(player, 'boons'); await until(() => execute(player, 'document.querySelectorAll(".boons-card").length===1'), 'Boons tab');
  await click(player, '.boons-ended-toggle'); await fits(player, 'Player Boons'); await capture(player, 'player-boons');
  await dailyTab(daily, 'vendors');
  await until(() => execute(daily, 'document.querySelectorAll(".daily-vendor-item").length===3'), 'Avakot stock and faction weapons');
  await execute(daily, 'document.querySelectorAll(".daily-vendor-group")[1].open=true');
  assert.equal(await execute(daily, 'document.querySelector(".daily-vendor-list").textContent.includes("Officer")'), true);
  assert.equal(await execute(daily, 'document.querySelectorAll(".daily-tempers li").length>0'), true, 'calculated daily faction tempers');
  assert.equal(await execute(daily, '/Afflicted Lurgy|Aftershock/.test(document.querySelector(".daily-tempers").textContent)'), true, 'canonical temper names');
  await until(() => execute(daily, '[...document.querySelectorAll(".daily-temper-icon img")].length > 0 && [...document.querySelectorAll(".daily-temper-icon img")].every(image => image.complete && image.naturalWidth > 0)'), 'temper logos loaded');
  await until(() => execute(daily, '[...document.querySelector(".daily-vendor-group").querySelectorAll(".daily-item-icon img")].length === 2 && [...document.querySelector(".daily-vendor-group").querySelectorAll(".daily-item-icon img")].every(image => image.complete && image.naturalWidth > 0)'), 'Avakot item icons loaded');
  await fits(daily, 'Daily Vendors'); await capture(daily, 'daily-vendors');
  await dailyTab(daily, 'calendar'); await until(() => execute(daily, 'document.querySelector(".calendar-ancestor")?.textContent==="Fixture ancestor"'), 'Calendar inside Daily');
  await fits(daily, 'Daily Calendar'); await capture(daily, 'daily-calendar');
  await execute(main, 'window.api.openWidgets()'); const picker = await ready('widgets-window.html');
  const icons = await execute(picker, '[...document.querySelectorAll(".widget-card")].map(card=>({id:card.dataset.widget,icon:card.querySelector("svg")?.innerHTML}))');
  assert.equal(icons.length, new Set(icons.map(row => row.icon)).size, 'every picker widget has a distinct icon');
  for (const id of [...ids, 'calendar']) assert.equal(icons.some(row => row.id === id), false, id + ' has no separate picker icon');
  assert(icons.some(row => row.id === 'player') && icons.some(row => row.id === 'daily'));
  assert.deepEqual(await execute(main, '[...document.querySelectorAll(".dock-widget-button")].map(node=>node.dataset.widget).sort()'), ['daily', 'player']);
  await capture(picker, 'widget-picker'); await capture(main, 'dock-icons');
  assert.equal(daily.getBounds().width, 620, 'live Daily updates and tab changes preserve the chosen width');
  assert.equal(daily.getBounds().height, 700, 'live Daily updates and tab changes preserve the chosen height');
  await click(daily, '.daily-done'); await until(() => daily.isDestroyed(), 'Done closes the Daily pop-out');
  await execute(main, 'window.api.getDailyBrief()'); publish(); await pause(100); assert.equal(find(dailyFragment), undefined, 'ordinary reads and polls do not reopen');
  await click(main, '.dock-widget-button[data-widget="daily"]'); daily = await ready(dailyFragment);
  await until(() => daily.isVisible(), 'Daily opens manually'); await dailyTab(daily, 'today');
  assert.equal(daily.getBounds().width, 620, 'manually reopened Daily restores its own width');
  assert.equal(daily.getBounds().height, 700, 'manually reopened Daily restores its own height');
  await click(daily, '.daily-preferences input');
  await until(async () => (await execute(main, 'window.api.getState()')).config.dailyAutoLogin === false, 'login preference saves through IPC');
  await click(daily, '.daily-done'); await until(() => daily.isDestroyed(), 'Daily dismissed');
  activeSession = null; publish(); activeSession = fakeSession; publish(); await pause(100); assert.equal(find(dailyFragment), undefined, 'login opt-out');
  await execute(main, 'window.api.saveConfig({dailyAutoReset:false})');
  fakeNow = (Math.floor(fakeNow / 86400000) + 1) * 86400000; updatedAt = fakeNow; publish(); await pause(100); assert.equal(find(dailyFragment), undefined, 'reset opt-out');
  await execute(main, 'window.api.saveConfig({dailyAutoReset:true})'); fakeNow += 86400000; updatedAt = fakeNow; publish();
  daily = await ready(dailyFragment);
  await until(() => daily.isVisible(), 'forward UTC reset opens Daily'); assert.deepEqual(openReasons, ['login', 'reset']);
  await click(daily, '.daily-done'); await until(() => daily.isDestroyed(), 'reset pop-out dismissed'); publish(); await pause(100); assert.equal(find(dailyFragment), undefined, 'same reset never replays');
  for (const id of ['player', 'daily']) {
    const checkbox = `input[data-widget="${id}"]`, dock = `.dock-widget-button[data-widget="${id}"]`;
    if (id === 'daily' && !find(dailyFragment)) {
      await click(main, dock); daily = await ready(dailyFragment);
      await until(() => daily.isVisible(), 'Daily opens before disabling its launcher');
    }
    await click(picker, checkbox); await until(() => !find(panelFragment(id)), id + ' disable destroys panel');
    await until(() => execute(main, `!document.querySelector(${JSON.stringify(dock)})`), id + ' disabled icon removed');
    await click(picker, checkbox); await until(() => execute(main, `!!document.querySelector(${JSON.stringify(dock)})`), id + ' re-enabled icon');
    await click(main, dock); const restored = await ready(panelFragment(id)); await until(() => restored.isVisible(), id + ' re-enabled panel');
    if (id === 'daily') daily = restored;
  }
  daily.setSize(360, 400);
  for (const tab of ['today', 'vendors', 'calendar']) {
    await dailyTab(daily, tab);
    const metrics = await execute(daily, `(()=>{const footer=document.querySelector('.daily-footer').getBoundingClientRect(),panel=document.querySelector('.daily-panel:not([hidden])').getBoundingClientRect();return{width:innerWidth,height:innerHeight,bodyWidth:document.body.scrollWidth,footerBottom:footer.bottom,panelHeight:panel.height}})()`);
    assert.ok(metrics.bodyWidth <= metrics.width + 1 && metrics.footerBottom <= metrics.height && metrics.panelHeight > 0, 'Daily ' + tab + ' remains usable at its narrow pop-out size');
    await capture(daily, 'daily-popout-narrow-' + tab);
  }
  await click(daily, '#daily-close'); await until(() => daily.isDestroyed(), 'Daily titlebar closes its pop-out');
  assert.equal(main.isVisible(), true, 'closing Daily does not exit Overkot');
  assert(vendorRequests.includes(CATALOG_URL) && vendorRequests.includes(STOCK_URL), 'real vendor service exercised both synthetic endpoint responses');
  assert.deepEqual(errors, [], 'renderers complete without JavaScript failures');
  const report = { ok: true, widgets: ['player', 'daily'], domainModules: ids, openReasons, screenshots: out, isolatedProfile: profile };
  fs.writeFileSync(path.join(out, 'consolidated-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); app.exit(0);
}).catch(error => { console.error(error.stack); console.error(JSON.stringify({ errors, screenshots: out, isolatedProfile: profile }, null, 2)); app.exit(1); });
