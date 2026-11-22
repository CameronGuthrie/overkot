// Packaged Electron + real preload/protocol + remote feed, isolated from game IO.
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 120000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session, globalShortcut } = require('electron');
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
const out = path.join(root, 'output', `overlay-map-check-${Date.now()}`);
fs.mkdirSync(out, { recursive: true }); process.env.LOCALAPPDATA = out;
app.setPath('userData', path.join(out, 'profile'));
const feedNetwork = require('./overlay-feed/check-network');
const original = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [] }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, scannerAvailableSync: () => false };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class { async waitForProcess() { return new Promise(() => {}); } startForegroundMonitor() {} stopForegroundMonitor() {} } };
  for (const name of ['LogWatcher', 'ArenaWatcher', 'AncestorWatcher']) {
    if (request.endsWith('/modules/' + name[0].toLowerCase() + name.slice(1))) return { [name]: class { start() {} stop() {} } };
  }
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, { get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false) });
  if (request === 'axios') return feedNetwork.http;
  return original.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
for (const [key, value] of Object.entries({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  layoutMode: 'free', widgetVisibility: {}, backgroundOpacity: 95, language: 'en' })) config.set(key, value);
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  contents.on('render-process-gone', (_event, details) => errors.push(details.reason));
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 1000; i++) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
async function ready(name) {
  const win = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes(name)), name);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), 'preload');
  return win;
}
const stats = win => win.webContents.executeJavaScript(`({ tiles:tileImages.filter(Boolean).length,
  painted:tileImages.filter(x=>x?.complete&&x.naturalWidth>0).length, pois:mapPOIs.length,
  categories:mapPOIs.reduce((counts,poi)=>(counts[poi.category]=(counts[poi.category]||0)+1,counts),{}),
  icons:mapPOIs.filter(x=>x.img?.complete&&x.img.naturalWidth>0).length, ready:mapPOIsLoaded })`);
const minimapView = win => win.webContents.executeJavaScript(`(() => {
  const viewport = document.querySelector('#minimap-viewport');
  const context = document.querySelector('#minimap-canvas').getContext('2d');
  const scale = context.scale, translate = context.translate;
  const view = { width: viewport.clientWidth, height: viewport.clientHeight };
  context.scale = function(x, y) { view.zoom ??= x; return scale.call(this, x, y); };
  context.translate = function(x, y) { view.pan ??= [x, y]; return translate.call(this, x, y); };
  try { Minimap.render(); } finally { context.scale = scale; context.translate = translate; }
  return view;
})()`);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html');
  await until(async () => Object.keys((await main.webContents.executeJavaScript('window.api.getState()')).namesMap).length, 'timer names');
  const cacheFile = path.join(out, 'Overkot/data/state.json');
  const cacheState = () => { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return null; } };
  const cachedKeys = () => Object.keys(cacheState()?.files || {});
  const initialCache = await until(() => { const value = cacheState(); return value?.manifest ? value : false; }, 'startup map manifest');
  const manifest = initialCache.manifest;
  const mapAssets = Object.keys(manifest.files).filter(key => /^map-(tiles|icons|json)\//.test(key));
  const temperIcons = Object.keys(manifest.files).filter(key => key.startsWith('temper-icons/'));
  assert.equal(mapAssets.filter(key => key.startsWith('map-tiles/')).length, 196);
  assert.ok(mapAssets.some(key => key.startsWith('map-icons/')), 'Use a complete feed fixture with map marker icons');
  await until(() => {
    const state = cacheState();
    return [...mapAssets, ...temperIcons].every(key => state?.files[key]?.sha256 === manifest.files[key].sha256);
  }, 'background map and temper cache before opening a map');
  const startupState = await main.webContents.executeJavaScript('window.api.getState()');
  assert.ok(['waiting', 'companion'].includes(startupState.status), 'Warmup does not require a game connection');
  assert.ok(!BrowserWindow.getAllWindows().some(win => /map-window\.html|widget-host\.html/.test(win.webContents.getURL())), 'Warmup completes without a map or minimap window');
  const allowedStartupKeys = new Set([...mapAssets, ...temperIcons, 'names/en.json', 'locations/en.json', 'timers/durations.json']);
  assert.ok(cachedKeys().every(key => allowedStartupKeys.has(key)), 'Warmup excludes unrelated catalogues, images and languages');
  for (const key of mapAssets) {
    const entry = manifest.files[key];
    assert.equal(fs.statSync(path.join(path.dirname(cacheFile), 'objects', entry.sha256)).size, entry.bytes, `Cached map asset is complete: ${key}`);
  }
  const startupCachedFiles = cachedKeys().length;
  await main.webContents.executeJavaScript('window.api.openMapWindow()');
  const map = await ready('map-window.html');
  await until(async () => { const s = await stats(map); return s.tiles > 0 && s.painted === s.tiles && s.ready && s.pois > 0 && s.icons === s.pois; }, 'source map paints');
  const sourceStats = await stats(map);
  if (process.env.OVERKOT_MAP_EXPECTATIONS) {
    const expected = JSON.parse(fs.readFileSync(process.env.OVERKOT_MAP_EXPECTATIONS, 'utf8')).local;
    assert.equal(sourceStats.pois, expected.count);
    assert.deepEqual(sourceStats.categories, expected.categories);
    if (expected.namedLocations) {
      assert.deepEqual(await map.webContents.executeJavaScript("mapPOIs.filter(row => row.category === 'locations').map(({px,py,label}) => ({px,py,label}))"), expected.namedLocations);
    }
  }
  const { createHeadersHandler } = require('../src/modules/guard');
  session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
  const before = feedNetwork.requests.length;
  await map.loadFile(path.join(archive, 'src/renderer/map-window.html'));
  await until(async () => { const s = await stats(map); return s.tiles > 0 && s.painted === s.tiles && s.ready && s.pois > 0 && s.icons === s.pois; }, 'ASAR map paints');
  assert.deepEqual((await stats(map)).categories, sourceStats.categories);
  if (process.env.OVERKOT_MAP_EXPECTATIONS) {
    const expected = JSON.parse(fs.readFileSync(process.env.OVERKOT_MAP_EXPECTATIONS, 'utf8')).local;
    if (expected.namedLocations) assert.deepEqual(await map.webContents.executeJavaScript("mapPOIs.filter(row => row.category === 'locations').map(({px,py,label}) => ({px,py,label}))"), expected.namedLocations);
  }
  assert.equal(feedNetwork.requests.length, before, 'Reload reuses verified assets without network');
  map.showInactive(); await pause(300);
  fs.writeFileSync(path.join(out, 'map-packaged.png'), (await map.webContents.capturePage()).toPNG());
  await map.webContents.executeJavaScript('zoom=1;panX=100;panY=100;render()');
  await until(async () => (await stats(map)).tiles <= 64, 'off-screen tiles released');
  await main.webContents.executeJavaScript("window.api.saveConfig({widgetVisibility:{minimap:true}})");
  const mini = await ready('widget-host.html?widget=minimap');
  await mini.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'minimap' } });
  await until(() => mini.webContents.executeJavaScript("Minimap.inited && document.querySelector('#minimap-loading')?.classList.contains('loaded')"), 'packaged minimap');
  mini.showInactive(); await pause(300);
  const initialMinimapView = await minimapView(mini);
  const defaultZoom = .65;
  assert.ok(Math.abs(initialMinimapView.zoom - defaultZoom) < 1e-9, 'Packaged minimap starts at the closer overworld zoom without a test reset');
  fs.writeFileSync(path.join(out, 'minimap-packaged.png'), (await mini.webContents.capturePage()).toPNG());
  await mini.webContents.executeJavaScript("(() => { const viewport = document.querySelector('#minimap-viewport'); Minimap.zoomAt(1.2, viewport.clientWidth / 2, viewport.clientHeight / 2); })()");
  const chosenMinimapView = await minimapView(mini);
  // Exercise the packaged Settings button through the real preload and main
  // process, including a forced check inside the automatic refresh interval.
  await main.webContents.executeJavaScript('window.api.openSettings()');
  const settings = await ready('settings.html');
  await settings.loadFile(path.join(archive, 'src/renderer/settings.html'));
  await until(() => settings.webContents.executeJavaScript("document.querySelectorAll('#theme-select option').length === 5"), 'packaged settings');
  const manifestRequests = () => feedNetwork.requests.filter(key => key === 'manifest.json').length;
  const checksBefore = manifestRequests();
  const checkData = async expected => {
    assert.equal(await settings.webContents.executeJavaScript("(() => { const button = document.querySelector('#btn-check-data'); button.click(); button.click(); return button.disabled && button.getAttribute('aria-busy') === 'true'; })()"), true);
    await until(() => settings.webContents.executeJavaScript("!document.querySelector('#btn-check-data').disabled"), 'manual data check');
    assert.match(await settings.webContents.executeJavaScript("document.querySelector('#data-check-status').textContent"), expected);
  };
  await checkData(/up to date/);
  assert.equal(manifestRequests(), checksBefore + 1, 'The button bypasses the cooldown and ignores double clicks');
  const get = feedNetwork.http.get;
  feedNetwork.http.get = async (url, options) => {
    if (new URL(url).pathname.endsWith('/manifest.json')) throw new Error('Simulated offline feed');
    return get(url, options);
  };
  await checkData(/Could not check/);
  feedNetwork.http.get = get;
  await checkData(/up to date/);
  await until(async () => { const s = await stats(map); return s.painted === s.tiles && s.ready && s.icons === s.pois; }, 'map after manual retry');
  assert.deepEqual((await stats(map)).categories, sourceStats.categories);
  await until(() => mini.webContents.executeJavaScript("document.querySelector('#minimap-loading')?.classList.contains('loaded')"), 'minimap after manual retry');
  assert.deepEqual(await minimapView(mini), chosenMinimapView, 'Data refreshes retain the chosen minimap zoom and pan');
  settings.showInactive();
  await settings.webContents.executeJavaScript("document.querySelector('#btn-check-data').scrollIntoView({block:'center'})");
  await pause(300);
  fs.writeFileSync(path.join(out, 'settings-data-current.png'), (await settings.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, map: await stats(map), startupCachedFiles, warmedMapAssets: mapAssets.length,
    initialMinimapView, requests: feedNetwork.requests.length, cachedFiles: cachedKeys().length, screenshots: out }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error); console.error({ errors, out }); app.exit(1); });
