// Offline native integration: real widget registration, main/preload IPC and dock frames.
// node scripts/check-wolf-training.js --source
// node scripts/check-wolf-training.js --packaged (after a portable/unpacked build)
if (!process.versions.electron) {
  const args = process.argv.slice(2);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = args.includes('--packaged')
    ? require('./run-packaged-check').runPackagedCheck(__filename, args, 120000)
    : require('node:child_process').spawnSync(require('electron'), [__filename, ...args], {
      env, stdio: 'inherit', windowsHide: true, timeout: 120000,
    });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, session, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const out = path.join(root, 'output', `wolf-training-check-${Date.now()}`);
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(out, 'profile'));
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

const { WolfTraining, setWolfTrainingCatalog } = require('../src/modules/wolfTraining');
const dataModule = require('../src/modules/dataUpdates');
const { wolfInventory, wolfCatalog, id } = require('../test/fixtures/wolf-inventory');
let inventory = wolfInventory(), activeSession = null, tracker, cached = false, polledAt = 1789781861000;
const fakeSession = { isNonceExpired: () => false, isInventoryCached: () => cached,
  getRawInventory: () => inventory, getLastSuccessfulPollAt: () => polledAt };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (packaged && request.endsWith('/modules/appearanceIpc')) {
    const appearanceIpc = originalLoad.call(this, request, parent, isMain);
    // The fixture main lives in source while Settings is loaded from ASAR.
    // Match production's packaged renderer root without relaxing sender checks.
    return { ...appearanceIpc, registerAppearanceIpc(options) {
      return appearanceIpc.registerAppearanceIpc({ ...options, rendererRoot: path.join(archive, 'src', 'renderer') });
    } };
  }
  if (request.endsWith('/modules/wolfTraining')) return { setWolfTrainingCatalog, WolfTraining: class extends WolfTraining {
    constructor(options) { super({ ...options, getSession: () => activeSession }); tracker = this; }
  } };
  if (request.endsWith('/modules/dataUpdates')) return { ...dataModule, DataUpdateManager: class {
    constructor() { this.manifest = null; this.state = { files: {} }; }
    getInfo() { return { version: 'fixture', source: 'remote', tileCount: 196 }; }
    async initialize() { return this.getInfo(); }
    async checkForUpdates() { return { updated: false }; }
    async ensureAsset() { return null; }
    async refreshCachedAssets() { return { updated: false, failed: [] }; }
    readJSON(key) { const language = /^wolf-training\/(en|fr)\.json$/.exec(key)?.[1]; return language ? wolfCatalog(language) : null; }
  } };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [] }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, scannerAvailableSync: () => false };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class {
    async waitForProcess() { return new Promise(() => {}); } startForegroundMonitor() {} stopForegroundMonitor() {}
  } };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class { start() {} } };
  if (request.endsWith('/modules/arenaWatcher')) return { ArenaWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/ancestorWatcher')) return { AncestorWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/dungeonWatcher')) return { DungeonWatcher: class { start() {} stop() {} getState() { return { active: false }; } } };
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, {
    get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false),
  });
  if (request === 'axios') return { get: async () => { throw new Error('Offline fixture'); },
    create: () => ({ get: async () => { throw new Error('Offline fixture'); }, post: async () => { throw new Error('Offline fixture'); } }) };
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
config.setMany({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false, automaticUpdates: false,
  layoutMode: 'free', widgetVisibility: { 'wolf-training': true }, widgetOpen: { 'wolf-training': true },
  widgetDocked: { 'wolf-training': false }, tutorialsEnabled: false, dailyAutoLogin: false, dailyAutoReset: false,
  backgroundOpacity: 95, language: 'en', theme: 'dark-mint' });
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
const execute = (target, source) => (target.webContents || target).executeJavaScript(source);
const find = fragment => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes(fragment));
async function ready(fragment) {
  const win = await until(() => find(fragment), fragment);
  await until(async () => !win.webContents.isLoading() && await execute(win, '!!window.api'), fragment + ' preload'); return win;
}
async function capture(win, name) {
  win.showInactive(); win.webContents.invalidate(); await pause(250);
  const picture = await until(async () => { const image = await win.webContents.capturePage(); return image.isEmpty() ? null : image; }, 'paint ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), picture.toPNG());
}
const read = target => execute(target, `(() => {
  const root=document.querySelector('.wolf-training-content');
  if(!root) return {status:'',names:[],labels:[],rests:[],details:[]};
  return {status:root?.querySelector('.wolf-status')?.textContent,
    names:[...root.querySelectorAll('.wolf-name')].map(el=>el.textContent),
    labels:[...root.querySelectorAll('.wolf-stat-label')].map(el=>el.textContent),
    allocated:root.querySelectorAll('.wolf-stats .wolf-paw-allocated').length,
    trained:root.querySelectorAll('.wolf-stats .wolf-paw-trained').length,
    progress:root.querySelectorAll('.wolf-stats .wolf-paw-fill').length,
    details:[...root.querySelectorAll('.wolf-stat-details')].map(el=>el.textContent),
    rests:[...root.querySelectorAll('.wolf-rest')].map(el=>el.textContent),
    empty:root.querySelector('.wolf-empty')?.textContent,
    bond:root.querySelector('.wolf-bond strong')?.textContent,
    bondKnown:root.querySelector('.wolf-bond')?.dataset.rankKnown,
    bondHint:root.querySelector('.wolf-bond')?.title,
    bondPoints:root.querySelector('.wolf-bond-points')?.textContent,
    energy:root.querySelector('.wolf-energy-head strong')?.textContent,
    energyMax:root.querySelector('.wolf-energy-track')?.getAttribute('aria-valuemax'),
    energyWidth:parseFloat(root.querySelector('.wolf-energy-fill')?.style.width),
    selectionControls:root.querySelectorAll('.wolf-selection,.wolf-filter,.wolf-equipped,.wolf-card-toggle').length,
    companionPaws:root.querySelectorAll('.wolf-card-head svg.wolf-companion-paw[viewBox="0 0 24 24"]').length,
    approximate:root.querySelector('.wolf-curve-note')?.textContent,
    clippedCards:[...root.querySelectorAll('.wolf-card')].filter(el=>el.scrollHeight>el.clientHeight+2).length,
    width:innerWidth,height:innerHeight,scrollWidth:document.body.scrollWidth,scrollHeight:document.body.scrollHeight};
})()`);
const click = (target, selector) => execute(target, `document.querySelector(${JSON.stringify(selector)}).click()`);
async function fits(target) {
  await until(async () => { const value = await read(target); return value.scrollWidth <= value.width + 1 && value.scrollHeight <= value.height + 2; }, 'widget fits viewport');
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html');
  const widget = await ready('widget-host.html?widget=wolf-training');
  const ui = widget.webContents;
  await until(async () => (await read(ui)).status?.includes('Connect to Soulframe'), 'connect state');
  await fits(ui); await capture(widget, 'wolf-connect');
  activeSession = fakeSession; tracker.update();
  await until(async () => (await read(ui)).names.length === 1, 'current companion card');
  assert.deepEqual((await read(ui)).names, ['Ciar']);
  assert.equal((await execute(ui, 'window.api.getWolfTraining()')).rows.length, 2, 'real preload/main bridge');
  assert.equal((await read(ui)).selectionControls, 0, 'one companion needs no selection sections');
  assert.equal((await read(ui)).companionPaws, 1, 'the companion header uses the existing paw motif');
  assert.equal((await read(ui)).bond, 'Wild'); assert.equal((await read(ui)).bondKnown, 'true');
  assert.equal((await read(ui)).bondHint, '3,481 bond points', 'exact bond points remain available beside the resolved type');
  assert.equal((await read(ui)).bondPoints, '3,481', 'bond points are visible without opening Details');
  assert.equal((await read(ui)).energy, '95 / 150', 'energy uses the current extracted game maximum');
  assert.equal((await read(ui)).energyMax, '150', 'accessible energy scale follows the same maximum');
  assert(Math.abs((await read(ui)).energyWidth - 95 / 150 * 100) < .01, 'energy bar uses the actual cap');
  assert.equal((await read(ui)).allocated, 2); assert.equal((await read(ui)).trained, 2);
  assert((await read(ui)).progress > 0, 'partial training paws are visible');
  assert.equal((await read(ui)).approximate, undefined, 'all native skill thresholds are verified');
  await fits(ui); await capture(widget, 'wolf-ready');
  inventory = structuredClone(inventory); inventory.KubrowPets[0].Details.Energy = 120; tracker.update();
  await until(async () => (await read(ui)).energy === '120 / 150', 'energy above the retired 100 cap remains visible');
  assert.equal((await read(ui)).energyWidth, 80);
  const legacyEnergy = wolfCatalog(); legacyEnergy.progression.maxEnergy = 100;
  setWolfTrainingCatalog(legacyEnergy, 'en'); tracker.update();
  assert.equal((await execute(ui, 'window.api.getWolfTraining()')).rows[0].maxEnergy, 150, 'an old cached feed cannot restore the retired cap');
  await capture(widget, 'wolf-current-energy');
  inventory = structuredClone(inventory); inventory.KubrowPets[0].Details.Bond = 125000; tracker.update();
  await until(async () => (await read(ui)).bond === 'Tame', 'native bond rank 2 transition');
  assert.equal((await read(ui)).bondPoints, '125,000');
  inventory = structuredClone(inventory); inventory.KubrowPets[0].Details.Bond = 3481; tracker.update();
  await until(async () => (await read(ui)).bond === 'Wild', 'initial bond type restored');
  const unknownCurve = wolfCatalog(); unknownCurve.progression.bondThresholds = [];
  setWolfTrainingCatalog(unknownCurve, 'en'); tracker.update();
  await until(async () => (await read(ui)).bondKnown === 'false', 'unknown bond catalogue');
  assert.equal((await read(ui)).bond, '3,481');
  assert((await read(ui)).bondHint.includes('cannot be confirmed'), 'unknown bond catalogues remain explicit');
  setWolfTrainingCatalog(wolfCatalog(), 'en'); tracker.update();
  await until(async () => (await read(ui)).bond === 'Wild', 'verified bond catalogue restored');
  await click(ui, '.wolf-details-toggle');
  assert.equal((await read(ui)).details.length, 5); assert((await read(ui)).details.some(text => text.includes('3,900')));
  assert((await read(ui)).details.every(text => !text.includes('≈')), 'verified XP targets have no estimated marker');
  await fits(ui); await capture(widget, 'wolf-details');
  inventory = structuredClone(inventory); inventory.CurrentLoadOutIds = [id('loadout-1')]; tracker.update();
  await until(async () => (await read(ui)).names[0] === 'Cathal', 'loadout companion changed');
  assert.equal((await read(ui)).rests.length, 1); assert.equal((await read(ui)).details.length, 5);
  assert.equal((await read(ui)).clippedCards, 0, 'the current card fits completely');
  await fits(ui);
  await capture(widget, 'wolf-resting');
  inventory = structuredClone(inventory); inventory.CurrentLoadOutIds = [id('loadout-2')]; tracker.update();
  await until(async () => (await read(ui)).names[0] === 'Ciar', 'original companion restored');
  await execute(ui, 'document.querySelector(".wolf-details-toggle").focus()');
  inventory = structuredClone(inventory); inventory.KubrowPets[0].Details.Search = 2000; polledAt++;
  tracker.update();
  await until(async () => (await read(ui)).trained === 3, 'training update');
  assert.equal(await execute(ui, 'document.activeElement.className'), 'wolf-details-toggle', 'inventory update preserves details keyboard focus');
  cached = true; tracker.update();
  await until(async () => (await read(ui)).status === 'Saved inventory', 'cached label');
  await capture(widget, 'wolf-cached'); cached = false; tracker.update();
  await execute(main, "window.api.saveConfig({language:'fr'})");
  await until(async () => (await read(ui)).labels.includes('Curiosité'), 'localized catalogue from live config');
  assert.equal((await read(ui)).bond, 'Sauvage', 'bond type follows game localization');
  await fits(ui); await capture(widget, 'wolf-french');
  await execute(main, "window.api.saveConfig({language:'en'})");
  await until(async () => (await read(ui)).labels.includes('Curiosity'), 'English catalogue restored');
  inventory = { KubrowPets: [] }; tracker.update();
  await until(async () => (await read(ui)).names.length === 0, 'no companions');
  assert((await read(ui)).empty.includes('will appear here')); await capture(widget, 'wolf-empty');
  inventory = wolfInventory(); tracker.update();
  await until(async () => (await read(ui)).names.length === 1, 'companion restored');
  if (packaged) {
    assert(fs.existsSync(archive), 'current app.asar exists');
    const { createHeadersHandler } = require('../src/modules/guard');
    session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
    await widget.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'wolf-training' } });
    await until(async () => (await read(ui)).names.length === 1, 'packaged widget renderer');
    assert.equal((await read(ui)).allocated, 2);
    await fits(ui); await capture(widget, 'wolf-packaged');
  }
  await execute(main, "window.api.toggleDockWidget('wolf-training')");
  await until(() => !widget.isVisible(), 'dock icon hides companion');
  await execute(main, "window.api.toggleDockWidget('wolf-training')");
  await until(() => widget.isVisible(), 'dock icon restores companion');
  await execute(main, "window.api.saveConfig({widgetDocked:{'wolf-training':true}})");
  assert.equal((await execute(main, 'window.api.getState()')).config.widgetDocked['wolf-training'], true,
    'companion participates in the current native dock arrangement');
  activeSession = null; tracker.update();
  await until(async () => (await read(ui)).status.includes('Connect to Soulframe'), 'dock logout');
  assert.equal((await read(ui)).names.length, 0);
  activeSession = fakeSession; tracker.update();
  await until(async () => (await read(ui)).names.length === 1, 'dock reconnect');
  await fits(ui); await capture(widget, 'wolf-docked');
  await execute(main, 'window.api.openWidgets()');
  const picker = await ready('widgets-window.html');
  await until(() => execute(picker, '!!document.querySelector("input[data-widget=wolf-training]")'), 'picker registration');
  await click(picker, 'input[data-widget="wolf-training"]');
  await until(() => widget.isDestroyed(), 'disable widget');
  await click(picker, 'input[data-widget="wolf-training"]');
  const restoredState = await execute(main, 'window.api.getState()');
  if (restoredState.config.widgetOpen['wolf-training'] !== true) await execute(main, "window.api.toggleDockWidget('wolf-training')");
  const restoredWidget = await ready('widget-host.html?widget=wolf-training');
  await until(async () => (await read(restoredWidget)).names.length === 1, 're-enabled companion');
  await execute(main, 'window.api.openSettings()');
  const settings = await ready('settings.html');
  if (packaged) await settings.loadFile(path.join(archive, 'src/renderer/settings.html'));
  await until(() => execute(settings, '!document.querySelector("#settings-content").inert'), 'settings initialized');
  await click(settings, '#tab-overlay');
  const settingsValues = () => execute(settings, `({
    auto:document.querySelector('#chk-dungeon-auto-switch').checked,
    glass:document.querySelector('#chk-dungeon-see-through').checked,
    opacity:document.querySelector('#slider-dungeon-opacity').value,
    label:document.querySelector('#dungeon-opacity-value').textContent
  })`);
  assert.deepEqual(await settingsValues(), { auto: true, glass: false, opacity: '45', label: '45%' });
  await click(settings, '#chk-dungeon-auto-switch');
  await until(async () => (await execute(main, 'window.api.getState()')).config.dungeonMapAutoSwitch === false, 'automatic dungeon switching saved');
  await click(settings, '#chk-dungeon-see-through');
  await until(async () => (await execute(main, 'window.api.getState()')).config.dungeonMapSeeThrough === true, 'see-through saved');
  await execute(settings, `(() => { const slider=document.querySelector('#slider-dungeon-opacity'); slider.value='34'; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change')); })()`);
  await until(async () => (await execute(main, 'window.api.getState()')).config.dungeonMapBackgroundOpacity === 34, 'dungeon opacity saved');
  assert.deepEqual(await settingsValues(), { auto: false, glass: true, opacity: '34', label: '34%' });
  for (const invalid of [{ dungeonMapAutoSwitch: 'false' }, { dungeonMapSeeThrough: 1 },
    { dungeonMapBackgroundOpacity: -1 }, { dungeonMapBackgroundOpacity: 101 }]) {
    assert.equal(await execute(main, `window.api.saveConfig(${JSON.stringify(invalid)})`), false, 'malformed dungeon preference rejected');
  }
  assert.equal((await execute(settings, "window.api.appearanceApply({appearance:window.OverkotAppearance.builtins['high-contrast'].appearance})")).ok, true);
  await until(() => execute(settings, 'document.documentElement.dataset.theme === "high-contrast"'), 'high-contrast settings');
  assert.equal(await execute(settings, 'document.querySelector("#slider-dungeon-opacity").disabled'), false, 'dungeon opacity stays user configurable in high contrast');
  assert.equal((await settingsValues()).opacity, '34', 'dungeon opacity remains accurate in high contrast');
  assert.equal((await settingsValues()).label, '34%');
  assert.equal((await execute(settings, "window.api.appearanceApply({appearance:window.OverkotAppearance.builtins.grove.appearance})")).ok, true);
  await until(() => execute(settings, 'document.documentElement.dataset.theme === "dark-mint"'), 'normal theme restored');
  await capture(settings, packaged ? 'dungeon-settings-packaged' : 'dungeon-settings');
  await click(settings, '#close-btn');
  await until(() => !find('settings.html'), 'settings closed');
  await execute(main, 'window.api.openSettings()');
  const reopened = await ready('settings.html');
  await until(() => execute(reopened, '!document.querySelector("#settings-content").inert'), 'reopened settings');
  assert.equal(await execute(reopened, 'document.querySelector("#chk-dungeon-auto-switch").checked'), false, 'automatic dungeon preference retained');
  assert.equal(await execute(reopened, 'document.querySelector("#chk-dungeon-see-through").checked'), true, 'see-through preference retained');
  assert.equal(await execute(reopened, 'document.querySelector("#slider-dungeon-opacity").value'), '34', 'dungeon opacity retained');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, packaged, screenshots: out }, null, 2)); app.exit(0);
}).catch(error => { console.error(error.stack); console.error({ errors, output: out }); app.exit(1); });
