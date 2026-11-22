// Offline native QA: real watcher/decoder/controller/main/preload with no Mini-Map.
// Run: node scripts/check-arena-finder.js
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 120000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, session, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', 'arena-finder');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-arena-qa-'));
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = profile;
process.env.APPDATA = path.join(profile, 'roaming');
process.env.XDG_DATA_HOME = profile;
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(profile, 'chromium'));
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

const { ArenaWatcher } = require('../src/modules/arenaWatcher');
const { DungeonWatcher } = require('../src/modules/dungeonWatcher');
const { ArenaPresence } = require('../src/modules/arenaPresence');
const { DungeonMap } = require('../src/modules/dungeonMap');
const dataModule = require('../src/modules/dataUpdates');
const { TUTORIAL_IDS } = require('../src/modules/tutorials');
const table = require('../test/fixtures/underCityGauntlet.json');
const glades = require('../test/fixtures/gladesProcLevel.json');
const gladesArena = require('../test/fixtures/gladesArenaEvidence.json');
const index = { sets: [{ key: 'underCityMidrath', set: 'UnderCityMidrath', level_paths: [table.level_path] },
  { key: 'gladesofAndurin', set: 'GladesofAndurin', level_paths: [glades.level_path] }] };
let arenaWatcher, dungeonWatcher, presence;
let tablesAvailable = true, version = 'arena-qa-1', fakeNow = Date.now();
let delayNext = false, delayStarted = false, releaseDelayed = null;
const assetRequests = [], errors = [];
const offline = async () => { throw new Error('Arena QA blocks all network requests'); };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/arenaWatcher')) return { ArenaWatcher: class extends ArenaWatcher {
    constructor(options) { super(options); arenaWatcher = this; }
    start() {} // Manual real-parser input keeps the user's EE.log untouched.
  } };
  if (request.endsWith('/modules/dungeonWatcher')) return { DungeonWatcher: class extends DungeonWatcher {
    constructor(options) { super({ ...options, candidates: () => [], getIndex: () => index }); dungeonWatcher = this; }
    start() {}
  } };
  if (request.endsWith('/modules/arenaPresence')) return { ArenaPresence: class extends ArenaPresence {
    constructor(options) { super({ ...options, retryMs: 10, now: () => fakeNow }); presence = this; }
  } };
  if (request.endsWith('/modules/dungeonMap')) return { DungeonMap: class extends DungeonMap {
    getLayoutSnapshot(state) {
      const result = super.getLayoutSnapshot(state);
      if (!delayNext) return result;
      delayNext = false; delayStarted = true;
      const gate = new Promise(resolve => { releaseDelayed = resolve; });
      return result.then(async value => { await gate; return value; });
    }
  } };
  if (request.endsWith('/modules/dataUpdates')) return { ...dataModule, DataUpdateManager: class {
    constructor() { this.manifest = null; this.state = { files: {} }; }
    getInfo() { return { version, source: 'fixture', tileCount: 0 }; }
    async initialize() { return this.getInfo(); }
    async checkForUpdates() { return { updated: false }; }
    async ensureAsset(key) {
      assetRequests.push(key);
      if (key.endsWith('/rooms.json')) throw new Error('Arena fixture intentionally has no room geometry');
    }
    async refreshCachedAssets() { return { updated: false, failed: [] }; }
    readJSON(key) {
      if (key === 'dungeons/index.json') return index;
      if (key === 'dungeons/underCityMidrath/layouts.json') return { layouts: tablesAvailable ? [table] : [] };
      if (key === 'dungeons/gladesofAndurin/layouts.json') return { layouts: tablesAvailable ? [glades] : [] };
      return null;
    }
  } };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [] }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, scannerAvailableSync: () => false };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class {
    async waitForProcess() { return new Promise(() => {}); } startForegroundMonitor() {} stopForegroundMonitor() {}
  } };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/ancestorWatcher')) return { AncestorWatcher: class { start() {} stop() {} } };
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
  automaticUpdates: false, dailyAutoLogin: false, dailyAutoReset: false, backgroundOpacity: 95,
  language: 'en', theme: 'dark-mint', widgetVisibility: { arena: true, minimap: false, daily: false },
  widgetOpen: { arena: true, daily: false }, widgetDocked: { arena: false },
  tutorialCompleted: Object.fromEntries(TUTORIAL_IDS.map(id => [id, true])),
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await check(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
const execute = (target, code) => target.webContents.executeJavaScript(code);
const find = fragment => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(fragment));
async function ready(fragment) {
  const window = await until(() => find(fragment), fragment);
  await until(async () => !window.webContents.isLoading() && await execute(window, '!!window.api'), fragment + ' preload');
  return window;
}
const read = window => execute(window, `({
  label: document.querySelector('#arena-status-text').textContent,
  source: document.querySelector('#arena-status-text').title,
  waveDisplay: getComputedStyle(document.querySelector('#arena-wave-row')).display,
  wave: document.querySelector('#arena-wave-value').textContent,
  width:innerWidth,height:innerHeight,scrollWidth:document.body.scrollWidth,scrollHeight:document.body.scrollHeight
})`);
function feed(line) { arenaWatcher._processLine(line); dungeonWatcher._processLine(line); }
const enter = code => feed(`STATS ENTER_LEVEL ${table.level_path}/${code}.lp`);
const exit = code => feed(`STATS EXIT_LEVEL ${table.level_path}/${code}.lp`);
const physics = () => arenaWatcher._processLine('Sys [Error]: Could not use physics behavior: /Layer8/Prefab7/Decoration');
function wave(number = 20) {
  for (const line of ['UnderCityArena.lua: New wave:', `Wave Number: ${number}`, 'Tier: 2']) arenaWatcher._processLine(line);
}
async function expect(window, status, source) {
  await until(async () => {
    const state = await execute(window, 'window.api.getState()');
    return state.arenaStatus === status && state.arenaDetectionSource === source;
  }, `${status} from ${source} through main/preload`);
  const view = await read(window);
  assert(!view.label.includes('Glades'), 'Arena labels no longer restrict detection to Glades');
  return view;
}
async function capture(window, filename) {
  await until(async () => { const value = await read(window); return value.scrollWidth <= value.width + 1 && value.scrollHeight <= value.height + 2; }, filename + ' fits viewport');
  window.showInactive(); window.webContents.invalidate(); await pause(180);
  const image = await window.webContents.capturePage(); assert(!image.isEmpty(), filename + ' paints');
  fs.writeFileSync(path.join(out, filename + '.png'), image.toPNG());
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html'), widget = await ready('widget-host.html?widget=arena');
  await until(() => arenaWatcher && dungeonWatcher && presence, 'real arena pipeline constructed');
  assert.equal((await execute(main, 'window.api.getState()')).config.widgetVisibility.minimap, false);
  assert.equal(find('widget-host.html?widget=minimap'), undefined, 'Mini-Map remains disabled');

  enter(table.test_vectors.arena);
  let view = await expect(widget, 'arena', 'tiles');
  assert.match(view.source, /dungeon tile/i); assert.equal(arenaWatcher.getWave(), null);
  wave(); await until(async () => (await read(widget)).wave === '20 / 20', 'wave progress after tile confirmation');
  await capture(widget, 'arena-tiles-wave-20');
  feed(`Game successfully connected to: ${table.level_path}/${table.test_vectors.arena}.lp ]===`);
  await expect(widget, 'arena', 'tiles'); assert.equal(arenaWatcher.getWave().wave, 20, 'same instance migration preserves progress');
  version = 'arena-qa-same-instance-refresh';
  await presence.update(); await expect(widget, 'arena', 'tiles');
  assert.equal(arenaWatcher.getWave().wave, 20, 'same instance metadata refresh preserves wave progress');
  await until(async () => { const value = await read(widget); return value.wave === '20 / 20' && value.waveDisplay !== 'none'; }, 'wave restored through main/preload after metadata refresh');

  // The independent raw tail can lag the canonical watcher. Old physics/waves
  // must not confirm the next trip while its complete room lookup is pending.
  delayNext = true;
  dungeonWatcher._processLine(`STATS EXIT_LEVEL ${table.level_path}/${table.test_vectors.arena}.lp`);
  dungeonWatcher._processLine(`STATS ENTER_LEVEL ${table.level_path}/${table.test_vectors.without_arena}.lp`);
  await until(() => delayStarted && releaseDelayed, 'next instance lookup while raw tail is behind');
  physics(); wave(9);
  assert.notEqual(arenaWatcher.getState(), 'arena', 'old raw confirmation cannot cross the canonical instance boundary');
  assert.equal(arenaWatcher.getWave(), null, 'old raw waves cannot cross the canonical instance boundary');
  arenaWatcher._processLine(`STATS EXIT_LEVEL ${table.level_path}/${table.test_vectors.arena}.lp`);
  arenaWatcher._processLine(`STATS ENTER_LEVEL ${table.level_path}/${table.test_vectors.without_arena}.lp`);
  releaseDelayed(); delayStarted = false; releaseDelayed = null;
  await expect(widget, 'no_arena', 'tiles'); physics(); wave(7);
  view = await expect(widget, 'no_arena', 'tiles'); assert.equal(view.waveDisplay, 'none'); assert.equal(arenaWatcher.getWave(), null);
  await capture(widget, 'arena-negative-overrides-log');

  exit(table.test_vectors.without_arena); enter('AA');
  await until(() => presence.lastResult?.status === 'unavailable', 'invalid fingerprint falls back');
  view = await expect(widget, 'unknown', 'none');
  assert.match(view.label, /waiting/i, 'Unavailable layouts must not report No arena found');
  physics(); view = await expect(widget, 'arena', 'log'); assert.match(view.source, /log fallback/i);
  wave(7); await until(async () => (await read(widget)).wave === '7 / 20', 'fallback still tracks waves');
  await capture(widget, 'arena-log-fallback');

  tablesAvailable = false; version = 'arena-qa-no-tables';
  exit('AA'); enter(table.test_vectors.arena);
  await until(() => presence.lastResult?.status === 'unavailable', 'missing layout tables fall back');
  await expect(widget, 'unknown', 'none');
  physics(); await expect(widget, 'arena', 'log');
  tablesAvailable = true; version = 'arena-qa-recovered'; fakeNow += 100;
  await presence.update(); await expect(widget, 'arena', 'tiles');

  exit(table.test_vectors.arena); enter(table.test_vectors.without_arena);
  await expect(widget, 'no_arena', 'tiles');
  delayNext = true; exit(table.test_vectors.without_arena); enter(table.test_vectors.arena);
  await until(() => delayStarted && releaseDelayed, 'delayed current layout lookup');
  exit(table.test_vectors.arena);
  await expect(widget, 'not_in_dungeon', 'tiles'); releaseDelayed(); await pause(100);
  view = await expect(widget, 'not_in_dungeon', 'tiles'); assert.equal(view.waveDisplay, 'none'); assert.equal(arenaWatcher.getWave(), null);
  await capture(widget, 'arena-outside-after-late-result');

  feed(`STATS ENTER_LEVEL ${glades.level_path}/${gladesArena.test_vectors.arena}.lp`);
  await expect(widget, 'arena', 'tiles');
  wave(7); await until(async () => (await read(widget)).wave === '7 / 20', 'Glades reused script tracks waves');
  await capture(widget, 'arena-glades-wave-room');
  feed(`STATS EXIT_LEVEL ${glades.level_path}/${gladesArena.test_vectors.arena}.lp`);
  feed(`STATS ENTER_LEVEL ${glades.level_path}/${gladesArena.test_vectors.without_arena}.lp`);
  view = await expect(widget, 'no_arena', 'tiles'); assert.equal(view.waveDisplay, 'none');

  assert.equal(assetRequests.some(key => key.endsWith('/rooms.json')), false, 'Arena never needs geometry or a rendered map');
  assert.deepEqual(errors, [], 'real renderers finish without JavaScript errors');
  const report = { ok: true, primary: 'decoded Glades and Undercity wave-arena rooms', fallback: 'physics diagnostic',
    minimapEnabled: false, geometryRequests: 0, screenshots: out, isolatedProfile: profile };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); app.exit(0);
}).catch(error => {
  console.error(error.stack); console.error(JSON.stringify({ errors, screenshots: out, isolatedProfile: profile }, null, 2)); app.exit(1);
});
