// Run with node scripts/check-app.js after npm run data:build, with Soulframe open.
// Launches the real app against an isolated profile and local feed. Credential
// scanning, inventory login, and group service writes are disabled for this test.
if (process.platform !== 'win32') {
  console.error('This integration check requires Windows to isolate LOCALAPPDATA.');
  process.exit(1);
}
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 60000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

// Integration smoke for the real source app using a local feed and isolated data.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', `source-smoke-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
app.setPath('userData', path.join(out, 'electron-profile'));
const port = 32000 + process.pid % 10000;
process.env.OVERKOT_DATA_MANIFEST_URL = `http://127.0.0.1:${port}/manifest.json`;
const requests = [];
const feedRoot = path.join(root, 'output', 'data-feed');
const manifest = JSON.parse(fs.readFileSync(path.join(feedRoot, 'manifest.json'), 'utf8'));
const byUrl = Object.fromEntries(Object.entries(manifest.files).map(([key, value]) => ['/' + value.url, key]));
const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  if (url !== '/manifest.json' && !/^\/objects\/[a-f0-9]{64}\.(?:webp|json\.br)$/.test(url)) { response.writeHead(404); response.end(); return; }
  const file = path.join(feedRoot, ...url.split('/').filter(Boolean));
  fs.readFile(file, (error, bytes) => {
    if (error) { response.writeHead(404); response.end(); return; }
    requests.push({ key: byUrl[url] || 'manifest', bytes: bytes.length });
    response.writeHead(200, { 'Content-Type': url.endsWith('.json') ? 'application/json' : 'application/octet-stream', ETag: manifest.version });
    response.end(bytes);
  });
});
server.on('error', error => { console.error(error.message); app.exit(1); });
server.listen(port, '127.0.0.1');
const metrics = { foregroundStarts: 0, foregroundStops: 0, gameFound: false };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class { async scanForAccountAndNonce() { return new Promise(() => {}); } }, scannerAvailableSync: () => false };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class { start() {} consumeLoginSignal() { return false; } extractAccountId() { return ''; } } };
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, { get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false) });
  if (request.endsWith('/modules/processDetector')) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return { ProcessDetector: class extends actual.ProcessDetector {
      async findProcess() { const pid = await super.findProcess(); metrics.gameFound = pid > 0; return pid; }
      startForegroundMonitor() { metrics.foregroundStarts++; }
      stopForegroundMonitor() { metrics.foregroundStops++; }
      async isProcessForeground() { return true; }
    } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
for (const [key, value] of Object.entries({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false, layoutMode: 'free', widgetVisibility: { boss: true, crafting: true, minimap: false }, enableAlertSound: false })) config.set(key, value);
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const find = file => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().split('?')[0].endsWith('/' + file));
async function until(fn, label, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
async function ready(file) {
  const win = await until(() => find(file), file);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), file + ' preload');
  return win;
}
async function capture(win, name) {
  await pause(150);
  const file = path.join(out, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  return file;
}
app.whenReady().then(async () => {
  const main = await ready('index.html');
  await until(async () => (await main.webContents.executeJavaScript('window.api.getState()')).mapTiles.source === 'remote', 'manifest');
  const state = await until(async () => {
    const value = await main.webContents.executeJavaScript('window.api.getState()');
    return Object.keys(value.namesMap).length ? value : false;
  }, 'remote names');
  assert.ok(Object.keys(state.timerDurations).length > 0);
  await until(() => metrics.gameFound, 'running Soulframe detection');
  const screenshots = [await capture(main, 'main')];
  const startupRequests = requests.slice();
  const startupKeys = new Set(['manifest', 'timers/durations.json', 'names/en.json', 'locations/en.json']);
  assert.ok(startupRequests.every(request => startupKeys.has(request.key)), 'Startup should request only the selected language and timer data');
  await main.webContents.executeJavaScript('window.api.openSettings()');
  const settings = await ready('settings.html');
  await settings.webContents.executeJavaScript('window.api.saveConfig({ showOnlyWhenGameFocused: true })');
  await settings.webContents.executeJavaScript('window.api.saveConfig({ showOnlyWhenGameFocused: false })');
  assert.ok(metrics.foregroundStarts > 0 && metrics.foregroundStops > 0);
  screenshots.push(await capture(settings, 'settings'));
  await settings.webContents.executeJavaScript('window.api.windowClose()');
  await main.webContents.executeJavaScript('window.api.openMapWindow()');
  const map = await ready('map-window.html');
  const mapStats = await until(async () => {
    const value = await map.webContents.executeJavaScript('({ loaded: tilesLoaded, pois: mapPOIs.length, version: mapTilesVersion, poiReady: mapPOIsLoaded })');
    return value.loaded === 196 && value.poiReady && value.pois > 0 ? value : false;
  }, 'visible map tiles and POIs');
  screenshots.push(await capture(map, 'map'));
  const englishLabels = await map.webContents.executeJavaScript('mapPOIs.map(point => point.label).filter(Boolean).sort().join("|")');
  const french = JSON.parse(fs.readFileSync(path.join(root, 'langs', 'fr.json'), 'utf8'));
  await main.webContents.executeJavaScript("window.api.saveConfig({ language: 'fr' })");
  await until(async () => await map.webContents.executeJavaScript(`mapLanguage === 'fr' && document.querySelector('.map-legend-label').textContent === ${JSON.stringify(french.legendEnclaves)}`), 'open map legend language switch');
  await until(() => requests.some(item => item.key === 'locations/fr.json') && requests.some(item => item.key === 'names/fr.json'), 'French data downloads');
  await until(async () => {
    const labels = await map.webContents.executeJavaScript('mapPOIsLoaded && mapPOIs.map(point => point.label).filter(Boolean).sort().join("|")');
    return labels && labels !== englishLabels;
  }, 'open map POI label refresh');
  screenshots.push(await capture(map, 'map-fr'));
  await main.webContents.executeJavaScript("window.api.saveConfig({ language: 'en' })");
  const widget = await until(() => BrowserWindow.getAllWindows().find(win => /widget-host.html\?widget=boss/.test(win.webContents.getURL())), 'boss widget');
  await until(() => !widget.webContents.isLoading(), 'boss load');
  const area = screen.getDisplayMatching(widget.getBounds()).workArea;
  widget.setBounds({ x: area.x + 5, y: area.y + 200, width: 300, height: 200 });
  await widget.webContents.executeJavaScript('window.api.windowDragStart(); for(let i=0;i<20;i++) window.api.windowMoveBy(1,0,true); window.api.windowDragEnd();');
  await pause(150);
  assert.equal(widget.getBounds().x, area.x + 25);
  const dragBounds = widget.getBounds();
  await widget.webContents.executeJavaScript("window.api.widgetSetCollapsed('boss', true)");
  await pause(50);
  await widget.webContents.executeJavaScript("window.api.windowDragStart(); window.api.windowMoveBy(120, 50, false); window.api.windowDragEnd(); window.api.widgetSetCollapsed('boss', false);");
  await pause(150);
  assert.equal(widget.getBounds().x, dragBounds.x + 120);
  await main.webContents.executeJavaScript("window.api.saveConfig({ layoutMode: 'grid' })");
  const dock = await ready('dock-window.html');
  await until(async () => await dock.webContents.executeJavaScript("document.querySelectorAll('.dock-cell').length === 2"), 'dock cells');
  await pause(350);
  const dockMetrics = await dock.webContents.executeJavaScript(`({ viewport: [innerWidth,innerHeight], root: [document.documentElement.clientWidth,document.documentElement.clientHeight,document.documentElement.scrollWidth,document.documentElement.scrollHeight], body:[document.body.clientWidth,document.body.clientHeight,document.body.scrollWidth,document.body.scrollHeight], container: [document.querySelector('#dock-columns').offsetWidth,document.querySelector('#dock-columns').offsetHeight], cells: [...document.querySelectorAll('.dock-cell')].map(c=>[c.style.width,c.style.height,c.offsetWidth,c.offsetHeight]) })`);
  assert.deepEqual(dockMetrics.root.slice(0, 2), dockMetrics.root.slice(2, 4), 'Content-sized dock must not have scrollbars');
  screenshots.push(await capture(dock, 'dock'));
  await main.webContents.executeJavaScript('window.api.windowCollapse(true)');
  await pause(100);
  assert.equal(dock.isVisible(), false);
  assert.equal(main.getBounds().width, 40);
  await main.webContents.executeJavaScript('window.api.windowCollapse(false)');
  await pause(100);
  assert.equal(dock.isVisible(), true);
  await main.webContents.executeJavaScript("window.api.saveConfig({ layoutMode: 'free' })");
  await until(() => !find('dock-window.html'), 'free-mode dock teardown');
  await main.webContents.executeJavaScript("window.api.showAlert({ name: 'Integration test timer', readyLabel: 'Ready' })");
  const alert = await ready('alert-window.html');
  await pause(100);
  assert.equal(await alert.webContents.executeJavaScript("document.getElementById('alert-name').textContent"), 'Integration test timer');
  screenshots.push(await capture(alert, 'alert'));
  await alert.webContents.executeJavaScript("document.getElementById('alert-close').click()");
  await until(() => !find('alert-window.html'), 'alert close');
  assert.deepEqual(errors, []);
  const summary = { ok: true, metrics, state: { status: state.status, nameCount: Object.keys(state.namesMap).length, durationKeys: Object.keys(state.timerDurations).length }, mapStats, dockMetrics, startupRequests, requestCount: requests.length, requestBytes: requests.reduce((sum, entry) => sum + entry.bytes, 0), requestedKeys: requests.map(entry => entry.key), screenshots };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ok:summary.ok, screenshots:summary.screenshots}));
  server.close();
  app.exit(0);
}).catch(error => {
  console.error(error.stack);
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, errors, requests }, null, 2));
  server.close();
  app.exit(1);
});
setTimeout(() => { console.error('Source smoke timed out'); app.exit(1); }, 55000).unref();
