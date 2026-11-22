// Native renderer/IPC check with isolated preferences, local fixture logs and no game requests.
if (!process.versions.electron) {
  process.env.OVERKOT_BUILD_CHANNEL = 'title-tracker-beta';
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
const out = path.join(root, 'output', `data-viewers-check-${Date.now()}`);
const archive = path.join(root, 'dist-beta/title-tracker/win-unpacked/resources/app.asar');
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_BUILD_CHANNEL = 'title-tracker-beta';
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(out, 'profile'));
const logPath = path.join(out, 'EE.log');
fs.writeFileSync(logPath, '1.200 Sys [Info]: Starting Soulframe\n2.300 Net [Warning]: Connection delayed\n3.400 Script [Error]: Failed test event <img src=x onerror=alert(1)>\n4.500 Game [Info]: Inventory ready {"count":42}\n');
let inventory = {
  PlayerLevel: 18, Resources: [
    { ItemType: '/SF/Types/Items/Resources/Silver', ItemCount: 12345 },
    { ItemType: '/SF/Types/Items/Resources/Wood', ItemCount: 24 },
  ],
  Melee: [{ ItemId: { $oid: '001' }, ItemType: '/SF/Weapons/TestSword', XP: 222000, Quality: 'IQ_NOBLE', Configs: [{ Upgrades: [] }] },
    { ItemId: { $oid: '002' }, ItemType: '/SF/Weapons/TestSword', XP: 40, Quality: 'IQ_WORN' }],
  TestRecords: Array.from({ length: 115 }, (_, index) => ({ Name: `Record ${String(index + 1).padStart(3, '0')}`, Value: index })),
  EmptyList: [],
};
let requests = 0, cached = true;
const liveSession = {
  accountId: 'fixture-a',
  isNonceExpired: () => false, isInventoryCached: () => cached,
  getInventorySavedAt: () => 1791700000000, getLastSuccessfulPollAt: () => cached ? 0 : 1791700000000,
  getRawInventory: () => inventory,
  async refreshNow() { requests++; cached = false; inventory = { ...inventory, PlayerLevel: 19 }; return { ok: true, updated: true }; },
};
let currentSession = liveSession;
const { DataSnapshots } = require('../src/modules/dataSnapshots');
const originalLoad = Module._load;
const offline = async () => { throw new Error('Network disabled in native data viewer check'); };
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/dataSnapshots')) return { DataSnapshots: class extends DataSnapshots {
    constructor() { super({ getSession: () => currentSession, getLogPath: () => logPath,
      getNames: () => ({ '/SF/Types/Items/Resources/Silver': 'Silver', '/SF/Types/Items/Resources/Wood': 'Wood', '/SF/Weapons/TestSword': 'Test Sword' }) }); }
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
new ConfigStore().setMany({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  widgetVisibility: { 'data-inventory': true, 'data-ee-log': true },
  widgetOpen: { 'data-inventory': true, 'data-ee-log': true }, backgroundOpacity: 95, language: 'en', theme: 'dark-mint' });
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
async function ready(text) {
  const win = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes(text)), text);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), text + ' preload');
  return win;
}
const click = (ui, selector) => ui.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
const input = (ui, selector, value, event = 'input') => ui.executeJavaScript(`(() => { const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)})); })()`);
async function capture(win, name) {
  win.showInactive(); win.webContents.invalidate(); await pause(150);
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function verify(inventoryWindow, logWindow, label) {
  const inv = inventoryWindow.webContents, log = logWindow.webContents;
  await until(() => inv.executeJavaScript("document.querySelector('.data-count')?.textContent.includes('entries')"), label + ' inventory');
  await until(() => log.executeJavaScript("document.querySelectorAll('.data-log-entry').length===4"), label + ' log');
  assert.equal(await inv.executeJavaScript("document.querySelector('.data-freshness').textContent.includes('Saved inventory')"), true);
  await input(inv, '.data-search', 'Silver');
  await until(() => inv.executeJavaScript("document.querySelectorAll('.data-entry').length===1"), 'resolved name search');
  await click(inv, '.data-entry > summary');
  await until(() => inv.executeJavaScript("document.querySelector('.data-entry-detail')?.textContent.includes('12,345')"), 'expanded item detail');
  await capture(inventoryWindow, label + '-inventory-search');
  await input(inv, '.data-search', ''); await input(inv, '.data-filter', 'TestRecords', 'change');
  await until(() => inv.executeJavaScript("document.querySelectorAll('.data-entry').length===100"), 'paginated inventory');
  await click(inv, '.data-more');
  assert.equal(await inv.executeJavaScript("document.querySelectorAll('.data-entry').length"), 115);
  await input(inv, '.data-filter', '', 'change');
  await input(inv, '.data-filter', 'Melee', 'change');
  await click(inv, '.data-entry > summary');
  await until(() => inv.executeJavaScript("document.querySelectorAll('.data-entry[open]').length===1"), 'first duplicate item opened');
  await input(inv, '.data-filter', 'Resources', 'change');
  await input(inv, '.data-filter', 'Melee', 'change');
  assert.equal(await inv.executeJavaScript("document.querySelectorAll('.data-entry[open]').length"), 1, 'same-named items retain independent expansion');
  await input(inv, '.data-filter', '', 'change');
  const beforeRequests = requests;
  await click(inv, '.data-refresh');
  await until(() => inv.executeJavaScript("!document.querySelector('.data-refresh').disabled"), 'inventory refresh');
  assert.equal(requests, beforeRequests + 1);
  assert.equal(await inv.executeJavaScript("document.querySelector('.data-freshness').textContent.includes('Saved inventory')"), false);
  await input(log, '.data-filter', 'error', 'change');
  assert.equal(await log.executeJavaScript("document.querySelectorAll('.data-log-entry').length"), 1);
  assert.equal(await log.executeJavaScript("document.querySelector('.data-results img')===null"), true, 'log content is escaped');
  await input(log, '.data-search', 'Failed test');
  await until(() => log.executeJavaScript("document.querySelectorAll('.data-results mark').length===2"), 'highlighted log search');
  await capture(logWindow, label + '-log-search');
  await input(log, '.data-search', ''); await input(log, '.data-filter', '', 'change');
  await until(() => log.executeJavaScript("document.querySelectorAll('.data-log-entry').length===4"), 'clear filters');
  await click(log, '.data-order');
  assert.equal(await log.executeJavaScript("document.querySelector('.data-log-time').textContent"), '1.200');
  fs.appendFileSync(logPath, '5.600 Game [Info]: Fresh log entry\n');
  await pause(150);
  assert.equal(await log.executeJavaScript("document.querySelectorAll('.data-log-entry').length"), 4, 'log is a snapshot');
  await click(log, '.data-refresh');
  await until(() => log.executeJavaScript("document.querySelectorAll('.data-log-entry').length===5"), 'log reload');
  const savedLog = fs.readFileSync(logPath);
  fs.unlinkSync(logPath);
  await click(log, '.data-refresh');
  await until(() => log.executeJavaScript("!document.querySelector('.data-refresh').disabled && document.querySelector('.data-feedback').dataset.error==='true'"), 'missing log error');
  assert.equal(await log.executeJavaScript("document.querySelectorAll('.data-log-entry').length"), 5, 'failed refresh retains previous snapshot');
  fs.writeFileSync(logPath, savedLog);
  await click(log, '.data-refresh');
  await until(() => log.executeJavaScript("!document.querySelector('.data-refresh').disabled && document.querySelector('.data-feedback').dataset.error==='false'"), 'log recovered');
  await capture(inventoryWindow, label + '-inventory'); await capture(logWindow, label + '-log');
  for (const win of [inventoryWindow, logWindow]) {
    // Use the app's intended-bounds cache so dock alignment retains test sizes.
    win.setMinimumSize(360, 360);
    require('../src/modules/windowDrag').setWindowBounds(win, { ...win.getBounds(), width: 360, height: 360 });
    await until(() => win.webContents.executeJavaScript('innerWidth===360 && innerHeight===360'), 'narrow resize');
    const fits = await win.webContents.executeJavaScript(`({ width:innerWidth, body:document.body.scrollWidth, height:innerHeight, card:document.querySelector('.data-viewer').getBoundingClientRect().bottom, scroll:document.querySelector('.data-results').scrollHeight, visible:document.querySelector('.data-results').clientHeight })`);
    assert(fits.body <= fits.width + 1, JSON.stringify(fits));
    assert(fits.card <= fits.height + 1, JSON.stringify(fits));
    assert(fits.visible >= 80, 'small viewers retain a usable scrolling viewport: ' + JSON.stringify(fits));
    assert(fits.scroll > fits.visible, 'data scrolls within the viewer: ' + JSON.stringify(fits));
    await capture(win, label + '-narrow-' + (win === inventoryWindow ? 'inventory' : 'log'));
    require('../src/modules/windowDrag').setWindowBounds(win, { ...win.getBounds(), width: 620, height: 560 });
  }
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html'), inventoryWindow = await ready('widget-host.html?widget=data-inventory'), logWindow = await ready('widget-host.html?widget=data-ee-log');
  await verify(inventoryWindow, logWindow, 'source');
  currentSession = { ...liveSession, accountId: 'fixture-b', getRawInventory: () => null, refreshNow: async () => ({ ok: false }) };
  await click(inventoryWindow.webContents, '.data-refresh');
  await until(() => inventoryWindow.webContents.executeJavaScript("!document.querySelector('.data-refresh').disabled && document.querySelectorAll('.data-entry').length===0"), 'account transition clears previous inventory');
  currentSession = liveSession;
  await click(inventoryWindow.webContents, '.data-refresh');
  await until(() => inventoryWindow.webContents.executeJavaScript("document.querySelectorAll('.data-entry').length>0"), 'inventory restored');
  await main.webContents.executeJavaScript('window.api.openWidgets()');
  const picker = await ready('widgets-window.html');
  await until(() => picker.webContents.executeJavaScript("document.querySelectorAll('input[data-widget^=data-]').length===2"), 'picker cards');
  if (fs.existsSync(archive) && !process.argv.includes('--source-only')) {
    cached = true; fs.writeFileSync(logPath, '1.200 Sys [Info]: Starting Soulframe\n2.300 Net [Warning]: Connection delayed\n3.400 Script [Error]: Failed test event <img src=x onerror=alert(1)>\n4.500 Game [Info]: Inventory ready {"count":42}\n');
    const { createHeadersHandler } = require('../src/modules/guard');
    session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
    await inventoryWindow.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'data-inventory' } });
    await logWindow.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'data-ee-log' } });
    await verify(inventoryWindow, logWindow, 'packaged');
  }
  await main.webContents.executeJavaScript("window.api.saveConfig({theme:'high-contrast'})");
  await until(() => inventoryWindow.webContents.executeJavaScript("document.documentElement.dataset.theme==='high-contrast'"), 'theme');
  await capture(inventoryWindow, 'high-contrast-inventory');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, screenshots: out, requests, packagedRenderer: fs.existsSync(archive) && !process.argv.includes('--source-only') }, null, 2)); app.exit(0);
}).catch(error => { console.error(error.stack); console.error({ errors, output: out }); app.exit(1); });
