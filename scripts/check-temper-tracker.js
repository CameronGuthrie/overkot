// npm run pack -- --skip-scanner, then node scripts/check-temper-tracker.js
// Real IPC, inventory events, window lifecycle and packaged assets; no game requests.
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 60000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', `temper-tracker-check-${Date.now()}`);
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(out, 'profile'));
const { TemperTracker, setTemperCatalog } = require('../src/modules/temperTracker');
const feedNetwork = require('./overlay-feed/check-network');
const { temperInventory, weapon } = require('../test/fixtures/temper-inventory');
let inventory = temperInventory(), liveSession = null, tracker, cached = false;
const fakeSession = { isNonceExpired: () => false, isInventoryCached: () => cached, getRawInventory: () => inventory };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/temperTracker')) return { setTemperCatalog, TemperTracker: class extends TemperTracker {
    constructor() { super({ getSession: () => liveSession }); tracker = this; }
  } };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [] }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, scannerAvailableSync: () => false };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class { async waitForProcess() { return new Promise(() => {}); } startForegroundMonitor() {} stopForegroundMonitor() {} } };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class { start() {} } };
  if (request.endsWith('/modules/arenaWatcher')) return { ArenaWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/ancestorWatcher')) return { AncestorWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, { get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false) });
  if (request === 'axios') return feedNetwork.http;
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
for (const [key, value] of Object.entries({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  layoutMode: 'free', widgetVisibility: { 'temper-tracker': true }, backgroundOpacity: 95, language: 'en' })) config.set(key, value);
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
const find = text => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes(text));
async function ready(text) {
  const win = await until(() => find(text), text);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), text + ' preload');
  return win;
}
async function capture(win, name) {
  win.showInactive(); win.webContents.invalidate(); await pause(300);
  const image = await until(async () => { const result = await win.webContents.capturePage(); return result.isEmpty() ? null : result; }, 'paint ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
}
const read = target => target.executeJavaScript(`({ summary:document.querySelector('.temper-summary')?.textContent,
  names:[...document.querySelectorAll('.temper-card .temper-name')].map(x=>x.textContent),
  filters:[...document.querySelectorAll('.temper-filter')].filter(x=>!x.parentElement.hidden).map(x=>x.textContent),
  progress:[...document.querySelectorAll('.temper-card')].map(x=>({name:x.querySelector('.temper-name').textContent,count:x.querySelector('.temper-count').textContent,unlocked:x.dataset.unlocked})),
  view:document.querySelector('.temper-view-select')?.value,
  detail:document.querySelector('.temper-detail-title')?.textContent,
  sources:[...document.querySelectorAll('.temper-weapon')].map(x=>x.textContent),
  icons:[...document.querySelectorAll('.temper-icon img')].map(x=>x.complete && x.naturalWidth>0),
  groups:[...document.querySelectorAll('.temper-group-head')].map(x=>x.textContent),
  search:document.querySelector('.temper-search')?.value,
  width:innerWidth, height:innerHeight, scrollWidth:document.body?.scrollWidth, scrollHeight:document.body?.scrollHeight })`);
const click = (target, selector) => target.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
const input = (target, selector, value, event = 'input') => target.executeJavaScript(`(() => {
  const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('${event}'));
})()`);
async function fits(target) {
  await until(async () => { const m = await read(target); return m.scrollWidth <= m.width + 1 && m.scrollHeight <= m.height + 2; }, 'card fits viewport');
}
async function resize(target, width) {
  await target.executeJavaScript(`(() => {
    const delta=${width}-outerWidth;
    document.querySelector('#resize-handle').dispatchEvent(new MouseEvent('mousedown',{button:0,screenX:0}));
    document.dispatchEvent(new MouseEvent('mousemove',{screenX:delta}));
    document.dispatchEvent(new MouseEvent('mouseup',{screenX:delta}));
  })()`);
  await until(async () => (await read(target)).width === width, 'manual resize');
  await fits(target);
}
async function checkDropdownLayering(win, target, selector) {
  win.show(); win.focus();
  await until(() => win.isFocused(), 'dropdown host focus');
  const raised = [], originals = new Map();
  for (const window of BrowserWindow.getAllWindows()) {
    const original = window.setAlwaysOnTop;
    originals.set(window, original);
    window.setAlwaysOnTop = function(...args) { raised.push(this.id); return original.apply(this, args); };
  }
  try {
    await target.executeJavaScript(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.focus(); select.showPicker(); })()`, true);
    await pause(2200); // Cross a complete always-on-top refresh while the native menu is open.
    assert.equal(win.isFocused(), true, 'An open native dropdown retains overlay focus');
    assert.deepEqual(raised, [], 'No overlay windows are raised over the focused native dropdown');
  } finally {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    for (const [window, original] of originals) if (!window.isDestroyed()) window.setAlwaysOnTop = original;
  }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html');
  const widget = await ready('widget-host.html?widget=temper-tracker');
  const ui = widget.webContents;
  await until(async () => (await read(ui)).summary?.includes('Connect to Soulframe'), 'disconnected tracker');
  liveSession = fakeSession; tracker.update();
  await until(async () => (await read(ui)).names.length > 0, 'blacksmith catalogue loaded');
  const total = tracker.getSnapshot().rows.length;
  assert.equal((await read(ui)).names.length, total, 'all blacksmith tempers shown by default');
  assert.equal((await read(ui)).view, 'blacksmith');
  assert.deepEqual((await read(ui)).filters, ['Hide unlocked', 'Hide incomplete']);
  assert.deepEqual((await read(ui)).groups, ['⌄ Fully unlocked (1)', `⌄ Incomplete (${total - 1})`]);
  assert.equal((await read(ui)).summary, `1/${total} tempers fully unlocked at the blacksmith`);
  assert.deepEqual((await read(ui)).progress.find(row => row.name === 'Fortified'), { name: 'Fortified', count: '10/10', unlocked: 'true' });
  assert.deepEqual((await read(ui)).progress.find(row => row.name === 'Swift Strike'), { name: 'Swift Strike', count: '9/10', unlocked: 'false' });
  await until(async () => (await read(ui)).icons.every(Boolean), 'blacksmith icons');
  await checkDropdownLayering(widget, ui, '.temper-view-select');
  await checkDropdownLayering(widget, ui, '.temper-group-select');
  await fits(ui); await capture(widget, 'tempers-blacksmith');
  await resize(ui, 240); await capture(widget, 'tempers-blacksmith-narrow'); await resize(ui, 300);
  await click(ui, '[data-hide=unlocked]');
  assert.equal((await read(ui)).names.length, total - 1);
  assert(!(await read(ui)).names.includes('Fortified'));
  inventory = structuredClone(inventory); inventory.RawUpgrades[2].ItemCount = 10; tracker.update();
  await until(async () => (await read(ui)).names.length === total - 2, 'newly unlocked temper respects hide filter');
  assert(!(await read(ui)).names.includes('Swift Strike'));
  await click(ui, '[data-hide=incomplete]');
  assert.equal((await read(ui)).names.length, 0, 'both groups can be hidden');
  await click(ui, '[data-hide=unlocked]');
  assert.deepEqual((await read(ui)).names, ['Fortified', 'Swift Strike']);
  await input(ui, '.temper-search', 'swift');
  await click(ui, '.temper-card');
  assert.equal((await read(ui)).detail, 'Swift Strike10/10');
  inventory = structuredClone(inventory); inventory.RawUpgrades[2].ItemCount = 9; tracker.update();
  await until(async () => (await read(ui)).detail === 'Swift Strike9/10', 'selected blacksmith progress updates');
  await click(ui, '.temper-back');
  assert.equal((await read(ui)).names.length, 0, 'search and hide filter survive detail updates');
  await click(ui, '[data-hide=incomplete]');
  assert.deepEqual((await read(ui)).names, ['Swift Strike']);
  await input(ui, '.temper-search', '');
  await input(ui, '.temper-view-select', 'weapons', 'change');
  await until(async () => (await read(ui)).names.length === 3, 'inventory holdings');
  assert.deepEqual((await read(ui)).filters, [`All ${total}`, 'Held 3', `Missing ${total - 3}`]);
  await until(async () => (await read(ui)).icons.every(Boolean), 'verified downloaded icons');
  await fits(ui); await capture(widget, 'tempers-held');
  await input(ui, '.temper-search', 'fortified');
  assert.deepEqual((await read(ui)).names, ['Fortified']);
  await click(ui, '.temper-card');
  assert.equal((await read(ui)).detail, 'Fortified×2');
  assert.match((await read(ui)).sources[0], /Vetch.*Legendary.*equipped.*×2/);
  inventory = structuredClone(inventory); inventory.Melee.push(weapon(4, 'Vetch', ['BlockingLessStaggerMod'])); tracker.update();
  await until(async () => (await read(ui)).detail === 'Fortified×3', 'new weapon increases holdings');
  assert.equal(await ui.executeJavaScript("document.activeElement.classList.contains('temper-back')"), true, 'Inventory updates preserve keyboard focus');
  inventory = structuredClone(inventory); inventory.Melee = inventory.Melee.filter(item => item.ItemId.$oid.endsWith('4')); tracker.update();
  await until(async () => (await read(ui)).detail === 'Fortified×1', 'sold double-stack removed');
  await capture(widget, 'temper-detail');
  inventory = { Melee: [], LongGuns: [] }; tracker.update();
  await until(async () => (await read(ui)).detail === 'Fortified×0', 'deleting final weapon clears counts');
  await click(ui, '.temper-back');
  assert.equal((await read(ui)).search, 'fortified');
  assert.equal((await read(ui)).names.length, 0);
  inventory = temperInventory(); tracker.update();
  await input(ui, '.temper-search', '');
  await click(ui, '[data-filter=missing]');
  assert.equal((await read(ui)).names.length, total - 3);
  await click(ui, '[data-filter=all]');
  assert.equal((await read(ui)).names.length, total);
  await until(async () => { const state = await read(ui); return state.icons.length === total && state.icons.every(Boolean); }, 'all catalogue icons');
  await fits(ui); await capture(widget, 'tempers-all');
  await resize(ui, 500);
  await resize(ui, 240);
  await capture(widget, 'tempers-narrow');
  await resize(ui, 300);
  await click(ui, '[data-filter=held]');
  await input(ui, '.temper-group-select', 'weapon', 'change');
  assert.deepEqual((await read(ui)).groups, ['⌄ Seathorn', '⌄ Vetch']);
  await ui.executeJavaScript("document.querySelector('.temper-group-head').focus()");
  await click(ui, '.temper-group-head');
  assert.equal((await read(ui)).names.length, 2);
  assert.equal(await ui.executeJavaScript("document.activeElement.classList.contains('temper-group-head')"), true);
  cached = true; tracker.update();
  await until(async () => /cached/i.test((await read(ui)).summary), 'cached holdings label');
  cached = false; tracker.update();
  // Reload the exact minified scripts and assets from the packaged ASAR, under CSP.
  const { createHeadersHandler } = require('../src/modules/guard');
  session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
  await widget.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'temper-tracker' } });
  await until(async () => { const s = await read(ui); return s.names.length === total && s.icons.length === total && s.icons.every(Boolean); }, 'packaged blacksmith tracker');
  assert.equal((await read(ui)).view, 'blacksmith');
  await fits(ui); await capture(widget, 'tempers-packaged');
  await click(ui, '.timer-widget[data-widget=temper-tracker] .widget-collapse-btn');
  await until(async () => (await read(ui)).height < 40, 'collapse');
  await click(ui, '.timer-widget[data-widget=temper-tracker] .widget-collapse-btn');
  await until(async () => (await read(ui)).height > 100, 'expand');
  const workArea = screen.getPrimaryDisplay().workArea;
  main.setPosition(workArea.x + 80, workArea.y + 80);
  await main.webContents.executeJavaScript("window.api.saveConfig({layoutMode:'grid'})");
  const dock = await ready('dock-window.html');
  const frame = await until(() => dock.webContents.mainFrame.framesInSubtree.find(item => /widget=temper-tracker/.test(item.url)), 'tracker dock frame');
  await until(async () => (await read(frame)).names.length === total, 'docked blacksmith unlocks');
  assert.equal((await read(frame)).view, 'blacksmith');
  await checkDropdownLayering(dock, frame, '.temper-view-select');
  await checkDropdownLayering(dock, frame, '.temper-group-select');
  await input(frame, '.temper-view-select', 'weapons', 'change');
  await until(async () => (await read(frame)).names.length === 3, 'docked holdings');
  liveSession = null; tracker.update();
  await until(async () => (await read(frame)).summary.includes('Connect to Soulframe'), 'dock logout notification');
  assert.equal((await read(frame)).names.length, 0);
  liveSession = fakeSession; tracker.update();
  await until(async () => (await read(frame)).names.length === 3, 'dock reconnect');
  inventory = { Melee: [weapon(5, 'Vetch', ['StaggerCritMod'])], LongGuns: [] }; tracker.update();
  await until(async () => (await read(frame)).names.length === 1, 'docked inventory update');
  assert.deepEqual((await read(frame)).names, ['Cowp']);
  await main.webContents.executeJavaScript("window.api.saveConfig({theme:'ember'})");
  await until(() => frame.executeJavaScript("document.documentElement.dataset.theme === 'ember'"), 'live theme');
  await main.webContents.executeJavaScript("window.api.saveConfig({theme:'dark-mint'})");
  inventory = temperInventory(); tracker.update();
  await until(async () => (await read(frame)).names.length === 3, 'restored dock holdings');
  await fits(frame); await capture(dock, 'tempers-docked');
  await main.webContents.executeJavaScript('window.api.openWidgets()');
  const modules = await ready('widgets-window.html');
  await until(() => modules.webContents.executeJavaScript("!!document.querySelector('input[data-widget=temper-tracker]')"), 'module toggle');
  await click(modules.webContents, 'input[data-widget=temper-tracker]');
  await until(async () => !find('dock-window.html') || !(await dock.webContents.executeJavaScript("!!document.querySelector('iframe[data-widget=temper-tracker]')")), 'disable tracker');
  await click(modules.webContents, 'input[data-widget=temper-tracker]');
  const reenabled = await ready('dock-window.html');
  const restored = await until(() => reenabled.webContents.mainFrame.framesInSubtree.find(item => /widget=temper-tracker/.test(item.url)), 're-enabled frame');
  await until(async () => (await read(restored)).names.length === total, 're-enabled blacksmith unlocks');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: out }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error.stack); console.error({ errors, output: out }); app.exit(1); });
