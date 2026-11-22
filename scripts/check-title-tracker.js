// Native Electron check: isolated preferences, synthetic inventories and no game requests.
if (!process.versions.electron) {
  process.env.OVERKOT_BUILD_CHANNEL = 'stable';
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 60000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', `title-tracker-check-${Date.now()}`);
const packagedDirectory = path.resolve(process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist',
  process.platform === 'linux' ? 'linux-unpacked' : 'win-unpacked'));
const archive = path.join(packagedDirectory, 'resources/app.asar');
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_BUILD_CHANNEL = 'stable';
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(out, 'profile'));
const { TitleTracker, setTitleCatalog } = require('../src/modules/titleTracker');
const { TemperTracker, setTemperCatalog } = require('../src/modules/temperTracker');
const { epithets, titleInventory } = require('../test/fixtures/title-inventory');
const { temperInventory } = require('../test/fixtures/temper-inventory');
const { projectEpithets } = require('../src/modules/epithetsData');
const temperCatalog = require('../src/data/tempers.json');
setTemperCatalog(temperCatalog);
setTitleCatalog(epithets());
let inventory = { ...titleInventory(), ...temperInventory() }, liveSession = null, titleTracker, temperTracker, cached = false;
const fakeSession = { isNonceExpired: () => false, isInventoryCached: () => cached, getRawInventory: () => inventory };
const originalLoad = Module._load;
const offline = async () => { throw new Error('Network disabled in native tracker check'); };
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/titleTracker')) return { setTitleCatalog, TitleTracker: class extends TitleTracker {
    constructor() { super({ getSession: () => liveSession }); titleTracker = this; }
  } };
  if (request.endsWith('/modules/temperTracker')) return { setTemperCatalog, TemperTracker: class extends TemperTracker {
    constructor() { super({ getSession: () => liveSession }); temperTracker = this; }
  } };
  if (request.endsWith('/modules/epithetsData')) return { getBundledTitleCatalog: () => null, EpithetsData: class {
    initialize() {} getCatalog() { return projectEpithets(epithets()); } async refresh() { return false; }
  } };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [] }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, scannerAvailableSync: () => false };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class { async waitForProcess() { return new Promise(() => {}); } startForegroundMonitor() {} stopForegroundMonitor() {} } };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class { start() {} } };
  if (request.endsWith('/modules/arenaWatcher')) return { ArenaWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/ancestorWatcher')) return { AncestorWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, { get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false) });
  if (request === 'axios') return { get: offline, post: offline, create: () => ({ get: offline, post: offline }) };
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const Appearance = require('../src/modules/appearance');
const config = new ConfigStore();
config.setMany({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  widgetVisibility: { 'title-tracker': true, 'temper-tracker': true },
  widgetOpen: { 'title-tracker': true, 'temper-tracker': true }, backgroundOpacity: 95, language: 'en', theme: 'dark-mint',
  appearance: Appearance.normalize({ base: 'dark-mint', global: { backgroundOpacity: 95 } }) });
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
const find = text => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes(text));
async function ready(text) {
  const win = await until(() => find(text), text);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), text + ' preload');
  return win;
}
const read = target => target.executeJavaScript(`({ summary:document.querySelector('.title-summary')?.textContent,
  rows:[...document.querySelectorAll('.title-row')].map(x=>({id:x.dataset.titleId,name:x.querySelector('.title-name').textContent,
    count:x.querySelector('.title-progress-count').textContent,completed:x.dataset.completed,pinned:x.dataset.pinned})),
  width:innerWidth,scrollWidth:document.body.scrollWidth,height:innerHeight,scrollHeight:document.body.scrollHeight })`);
const readChrome = target => target.executeJavaScript(`(() => {
  const widget=document.querySelector('.timer-widget[data-widget="title-tracker"]'), style=getComputedStyle(widget);
  const content=document.querySelector('.title-content'), body=widget.querySelector('.widget-body');
  const toggle=content.querySelector('.title-view-toggle-compact') || content.querySelector('.title-view-toggle');
  const eye=toggle.querySelector('.title-icon'), pin=content.querySelector('.title-icon-pin');
  return { background:style.backgroundColor,borderWidth:style.borderTopWidth,outlineStyle:style.outlineStyle,
    bodyPadding:getComputedStyle(body).padding,contentPadding:getComputedStyle(content).padding,
    summaryHidden:getComputedStyle(content.querySelector('.title-summary')).display==='none',
    eye:eye?.className,mask:eye ? getComputedStyle(eye).maskImage : 'none',
    pinMask:pin ? getComputedStyle(pin).maskImage : 'none' };
})()`);
const click = (target, selector) => target.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
const input = (target, selector, value, event = 'input') => target.executeJavaScript(`(() => {
  const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)}));
})()`);
async function capture(win, name) {
  win.showInactive(); win.webContents.invalidate(); await pause(250);
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html'), widget = await ready('widget-host.html?widget=title-tracker');
  assert.equal(await main.webContents.executeJavaScript('window.i18n.titleTrackerEnabled'), true,
    'Title Tracker is available without a beta channel switch');
  const temper = await ready('widget-host.html?widget=temper-tracker'), ui = widget.webContents;
  await until(async () => (await read(ui)).summary?.includes('Connect to Soulframe'), 'disconnected tracker');
  liveSession = fakeSession; titleTracker.update(); temperTracker.update();
  await until(async () => (await read(ui)).rows.length === 3, 'title rows');
  assert.deepEqual((await read(ui)).rows.map(row => row.count), ['75 / 500', '3 / 10', '100 / 100']);
  await click(ui, '.title-row[data-title-id="FlavourItems.CogahTitle"] .title-pin');
  await click(ui, '.title-row[data-title-id="FlavourItems.CastingSkillTreeKillsTitle"] .title-pin');
  assert.equal((await read(ui)).rows.filter(row => row.pinned === 'true').length, 2);
  assert.equal((await read(ui)).rows[2].pinned, 'false');
  await click(ui, '[data-hide=completed]');
  assert.equal((await read(ui)).rows.length, 2);
  await click(ui, '[data-hide=incomplete]'); assert.equal((await read(ui)).rows.length, 0);
  await click(ui, '[data-hide=incomplete]');
  inventory = structuredClone(inventory); inventory.ChallengeProgress[0].Progress = 10; titleTracker.update();
  await until(async () => (await read(ui)).rows.length === 1, 'completed pinned title respects filter');
  await click(ui, '[data-hide=completed]');
  await input(ui, '.title-search', 'Soul'); assert.equal((await read(ui)).rows.length, 1);
  await input(ui, '.title-search', '');
  inventory = { ...titleInventory(), ...temperInventory() }; titleTracker.update();
  await click(ui, '[data-hide=completed]');
  await until(async () => {
    const state = await ui.executeJavaScript('window.api.getState()'); return state.config.titleTrackerPreferences.pinned.length === 2 && !state.config.titleTrackerPreferences.showCompleted;
  }, 'preferences persisted through IPC');
  await capture(widget, 'titles-pinned');
  assert.match((await readChrome(ui)).eye, /title-icon-eye$/);
  assert.notEqual((await readChrome(ui)).pinMask, 'none');
  await click(ui, '.title-toolbar .title-view-toggle');
  await until(async () => (await read(ui)).rows.length === 2 && (await readChrome(ui)).borderWidth === '0px', 'frameless pinned view');
  const compact = await readChrome(ui);
  assert.equal(compact.background, 'rgba(0, 0, 0, 0)');
  assert.equal(compact.bodyPadding, '0px'); assert.equal(compact.contentPadding, '0px');
  assert.equal(compact.summaryHidden, true); assert.match(compact.eye, /title-icon-eye-off$/); assert.notEqual(compact.mask, 'none');
  await ui.executeJavaScript("document.body.classList.add('layout-editing')");
  assert.equal((await readChrome(ui)).outlineStyle, 'solid', 'Shift layout mode retains the widget boundary');
  await ui.executeJavaScript("document.body.classList.remove('layout-editing')");
  await capture(widget, 'titles-frameless-pinned');
  await click(ui, '.title-view-toggle-compact');
  await until(async () => (await readChrome(ui)).borderWidth !== '0px', 'full-view chrome restored');
  assert.equal((await readChrome(ui)).summaryHidden, false);
  await input(temper.webContents, '.temper-view-select', 'weapons', 'change');
  await input(temper.webContents, '.temper-group-select', 'weapon', 'change');
  await input(temper.webContents, '.temper-search', 'Swift');
  await until(() => temper.webContents.executeJavaScript("window.api.getState().then(s=>s.config.temperTrackerPreferences.search==='Swift'&&s.config.temperTrackerPreferences.groupings.weapons==='weapon')"), 'temper preferences persisted');
  const diskConfig = new ConfigStore();
  assert.equal(diskConfig.get('titleTrackerPreferences').pinned.length, 2);
  assert.equal(diskConfig.get('temperTrackerPreferences').view, 'weapons');
  assert.equal(diskConfig.get('temperTrackerPreferences').groupings.weapons, 'weapon');
  await widget.webContents.reload();
  await until(async () => (await read(ui)).rows.length === 2 && (await read(ui)).rows.every(row => row.pinned === 'true'), 'title remount restore');
  temper.webContents.reload();
  await until(() => temper.webContents.executeJavaScript("document.querySelector('.temper-view-select')?.value==='weapons'&&document.querySelector('.temper-group-select')?.value==='weapon'&&document.querySelector('.temper-search')?.value==='Swift'"), 'temper remount restore');
  cached = true; titleTracker.update(); await until(async () => (await read(ui)).summary.includes('Saved inventory'), 'cached label');
  liveSession = null; titleTracker.update();
  await until(async () => (await read(ui)).summary.includes('Connect to Soulframe') && (await read(ui)).rows.length === 0, 'logout clears rows');
  liveSession = fakeSession; cached = false; titleTracker.update();
  await until(async () => (await read(ui)).rows.length === 2, 'reconnect keeps prefs');
  if (fs.existsSync(archive)) {
    const { createHeadersHandler } = require('../src/modules/guard');
    session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
    await widget.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'title-tracker' } });
    await until(async () => (await read(ui)).rows.length === 2, 'packaged ASAR renderer');
    await capture(widget, 'titles-packaged');
  }
  await main.webContents.executeJavaScript('window.api.openSettings()');
  const settings = await ready('settings.html');
  const applyTheme = base => settings.webContents.executeJavaScript(`window.api.getState().then(state=>{
    const appearance=structuredClone(state.config.appearance);appearance.base=${JSON.stringify(base)};
    return window.api.appearanceApply({appearance});
  })`);
  assert.equal((await applyTheme('high-contrast')).ok, true);
  await ui.executeJavaScript("window.api.saveConfig({widgetDocked:{'title-tracker':false}})");
  await until(() => ui.executeJavaScript("document.documentElement.dataset.theme==='high-contrast'"), 'theme');
  await capture(widget, 'titles-high-contrast');
  await click(ui, '.title-toolbar .title-view-toggle');
  await until(async () => (await readChrome(ui)).borderWidth === '0px', 'high-contrast frameless pinned view');
  assert.equal((await readChrome(ui)).background, 'rgba(0, 0, 0, 0)');
  await capture(widget, 'titles-high-contrast-frameless-pinned');
  await click(ui, '.title-view-toggle-compact');
  assert.equal((await applyTheme('dark-mint')).ok, true);
  await ui.executeJavaScript("window.api.saveConfig({widgetDocked:{'title-tracker':true}})");
  await until(() => ui.executeJavaScript("document.documentElement.dataset.theme==='dark-mint'"), 'restored theme');
  settings.close();
  await main.webContents.executeJavaScript('window.api.openWidgets()');
  const picker = await ready('widgets-window.html');
  assert.equal(await picker.webContents.executeJavaScript("!!document.querySelector('input[data-widget=title-tracker]')"), true);
  const fits = await read(ui); assert(fits.scrollWidth <= fits.width + 1); assert(fits.scrollHeight <= fits.height + 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, channel: 'stable', screenshots: out,
    packagedRenderer: fs.existsSync(archive) }, null, 2)); app.exit(0);
}).catch(error => { console.error(error.stack); console.error({ errors, output: out }); app.exit(1); });
