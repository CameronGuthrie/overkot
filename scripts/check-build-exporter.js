// npm run pack -- --skip-scanner, then node scripts/check-build-exporter.js
// Real window/module lifecycle, offline fixture, packaged renderer files.
if (!process.versions.electron) {
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
const out = path.join(root, 'output', `build-export-check-${Date.now()}`);
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_SERVICES_FILE = path.join(out, 'services.json');
fs.writeFileSync(process.env.OVERKOT_SERVICES_FILE, JSON.stringify({ buildWebsite: 'https://build.example.org' }));
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(out, 'profile'));
const { BuildExporter, currentPreset, setBuildExportCatalog } = require('../src/modules/buildExporter');
// Keep the native fixture offline and independent of a local overlay-feed
// server. Production still obtains this same catalogue through its data feed.
setBuildExportCatalog(require('../src/data/build-export.json'));
const feedNetwork = require('./overlay-feed/check-network');
const { buildInventory } = require('../test/fixtures/build-inventory');
const { inflateRawSync } = require('node:zlib');
let inventory = buildInventory(), liveSession = null, exporter, pendingRead, failOpen = false;
const opened = [];
const fakeSession = { accountId: 'fixture-account', nonce: 'fixture-nonce', isNonceExpired: () => false,
  isInventoryCached: () => false, getRawInventory: () => inventory,
  api: { fetchInventory: () => new Promise(resolve => { pendingRead = resolve; }) },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/buildExporter')) return { currentPreset, setBuildExportCatalog, BuildExporter: class extends BuildExporter {
    constructor() { super({ getSession: () => liveSession, openDraft: async url => {
      if (failOpen) throw new Error('Browser fixture failure'); opened.push(url);
    } }); exporter = this; }
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
for (const [key, value] of Object.entries({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false, layoutMode: 'free', widgetVisibility: { 'build-exporter': true }, widgetOpen: { 'build-exporter': true }, backgroundOpacity: 95, language: 'en' })) config.set(key, value);
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
  win.showInactive(); win.webContents.invalidate();
  await pause(300); // Let native resize and dock FLIP animations settle.
  const image = await until(async () => { const result = await win.webContents.capturePage(); return result.isEmpty() ? null : result; }, 'paint ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
}
const read = target => target.executeJavaScript(`({ children:document.querySelector('.build-exporter-content')?.children.length,
  text:document.querySelector('.build-exporter-content')?.textContent,
  disabled:document.querySelector('.build-exporter-button')?.disabled, status:document.querySelector('.build-exporter-button')?.title,
  busy:document.querySelector('.build-exporter-content')?.getAttribute('aria-busy'), width:innerWidth,height:innerHeight,
  scrollWidth:document.body.scrollWidth, scrollHeight:document.body.scrollHeight })`);
const clickExport = target => target.executeJavaScript("document.querySelector('.build-exporter-button').click()");

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html');
  const widget = await ready('widget-host.html?widget=build-exporter');
  await until(async () => (await read(widget.webContents)).status?.includes('Connect to Soulframe'), 'disconnected exporter');
  assert.equal((await read(widget.webContents)).disabled, true);
  await capture(widget, 'exporter-disconnected');
  liveSession = fakeSession; exporter.update();
  await until(async () => !(await read(widget.webContents)).disabled, 'equipped build');
  assert.equal((await read(widget.webContents)).children, 1);
  assert.equal((await read(widget.webContents)).text, 'Open on build.example.org ↗');
  await capture(widget, 'exporter-ready');
  const readyMetrics = await read(widget.webContents);
  await clickExport(widget.webContents);
  await until(() => pendingRead, 'fresh inventory request');
  assert.equal((await read(widget.webContents)).busy, 'true');
  assert.equal((await read(widget.webContents)).disabled, true);
  const fresh = buildInventory(); fresh.LoadOutPresets.NORMAL[1].n = 'Fresh selected build';
  fresh.PlayerLevel = 21; fresh.Stats = { PlayerLevel: 40 };
  pendingRead({ data: fresh }); pendingRead = null;
  await until(() => opened.length === 1, 'browser handoff');
  await until(async () => (await read(widget.webContents)).busy === 'false', 'export complete');
  assert.equal((await read(widget.webContents)).text, 'Open on build.example.org ↗', 'Success adds no extra text');
  assert.equal((await read(widget.webContents)).height, readyMetrics.height, 'Success does not resize the card');
  const payload = JSON.parse(inflateRawSync(Buffer.from(new URL(opened[0]).hash.slice(8), 'base64url')));
  assert.equal(payload.state.name, 'Fresh selected build');
  assert.equal(payload.state.rank, 18, 'exported rank comes from 408000 inventory mastery XP, not PlayerLevel or Stats');
  assert.equal(Object.values(payload.state.stats).reduce((sum, value) => sum + value, 0), 34, 'virtue pool uses the same inventory rank');
  assert.equal(payload.state.motes.weapon.bonus.virtue, 'spirit');
  assert.equal(JSON.stringify(payload).includes('fixture-account'), false);
  await capture(widget, 'exporter-success');
  failOpen = true;
  await clickExport(widget.webContents); await until(() => pendingRead, 'failed-browser request');
  pendingRead({ data: inventory }); pendingRead = null;
  await until(async () => (await read(widget.webContents)).status.includes('Could not open your browser'), 'recoverable browser error');
  assert.equal((await read(widget.webContents)).disabled, false);
  assert.equal((await read(widget.webContents)).text, 'Retry export ↗');
  assert.equal((await read(widget.webContents)).height, readyMetrics.height, 'Error stays within the button');
  failOpen = false;
  await clickExport(widget.webContents); await until(() => pendingRead, 'logout during export');
  liveSession = null; exporter.update(); pendingRead({ data: inventory }); pendingRead = null;
  await until(async () => (await read(widget.webContents)).status.includes('session changed'), 'session race');
  assert.equal(opened.length, 1);
  liveSession = fakeSession; exporter.update();
  await until(async () => !(await read(widget.webContents)).disabled, 'reconnect');
  assert.equal((await read(widget.webContents)).height, readyMetrics.height, 'Reconnect keeps the compact height');
  // Test the exact packaged scripts, CSS and bridge under CSP.
  const { createHeadersHandler } = require('../src/modules/guard');
  session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
  await widget.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'build-exporter' } });
  await until(async () => !(await read(widget.webContents)).disabled, 'packaged exporter');
  await capture(widget, 'exporter-packaged');
  assert.equal((await read(widget.webContents)).children, 1, 'the packaged exporter stays visible without obsolete collapse controls');
  // Docked panels now retain their native window and renderer; the legacy
  // iframe grid is no longer created. Exercise the current docking setting.
  await main.webContents.executeJavaScript("window.api.saveConfig({widgetDocked:{'build-exporter':true}})");
  await until(() => main.webContents.executeJavaScript("window.api.getState().then(state=>state.config.widgetDocked['build-exporter']===true)"), 'native exporter docking');
  const frame = widget.webContents;
  await until(async () => (await read(frame)).text === 'Open on build.example.org ↗', 'docked exporter');
  assert.equal((await read(frame)).children, 1);
  liveSession = null; exporter.update();
  await until(async () => (await read(frame)).disabled === true, 'dock session notification');
  liveSession = fakeSession; exporter.update();
  await until(async () => (await read(frame)).disabled === false, 'dock reconnect');
  await clickExport(frame); await until(() => pendingRead, 'docked export');
  pendingRead({ data: inventory }); pendingRead = null;
  await until(() => opened.length === 2, 'docked handoff');
  await main.webContents.executeJavaScript('window.api.openSettings()');
  const settings = await ready('settings.html');
  const applyTheme = base => settings.webContents.executeJavaScript(`window.api.getState().then(state=>{
    const appearance=structuredClone(state.config.appearance);appearance.base=${JSON.stringify(base)};
    return window.api.appearanceApply({appearance});
  })`);
  assert.equal((await applyTheme('ember')).ok, true);
  await until(() => frame.executeJavaScript("document.documentElement.dataset.theme === 'ember'"), 'live theme');
  assert.equal((await applyTheme('dark-mint')).ok, true);
  settings.close();
  await until(() => frame.executeJavaScript('document.body.scrollHeight <= innerHeight + 2'), 'dock auto-fit');
  await capture(widget, 'exporter-docked');
  await main.webContents.executeJavaScript('window.api.openWidgets()');
  const modules = await ready('widgets-window.html');
  await until(() => modules.webContents.executeJavaScript("!!document.querySelector('input[data-widget=build-exporter]')"), 'module toggle');
  await modules.webContents.executeJavaScript("document.querySelector('input[data-widget=build-exporter]').click()");
  await until(() => !find('widget-host.html?widget=build-exporter'), 'disable exporter');
  await modules.webContents.executeJavaScript("document.querySelector('input[data-widget=build-exporter]').click()");
  await until(() => main.webContents.executeJavaScript("window.api.getState().then(state=>state.config.widgetVisibility['build-exporter']===true)"), 're-enable exporter');
  await main.webContents.executeJavaScript("window.api.getState().then(state=>state.config.widgetOpen['build-exporter']?null:window.api.toggleDockWidget('build-exporter'))");
  await ready('widget-host.html?widget=build-exporter');
  assert.ok(readyMetrics.scrollWidth <= readyMetrics.width + 1 && readyMetrics.scrollHeight <= readyMetrics.height + 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, readyMetrics, screenshots: out }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error.stack); console.error({ errors, output: out }); app.exit(1); });
