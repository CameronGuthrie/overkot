// Run: node scripts/check-platform-app.js
// Requires output/data-feed/manifest.json. Prepare it with
// npm run data:build -- --source <pipeline-output> (the extracted pipeline data
// must be available; see docs/data-updates.md), or set OVERKOT_SMOKE_FEED_ROOT
// to an existing feed directory. No running game or market account is needed.
// Exercises macOS companion behavior with real main/preload/renderers on the
// host Electron runtime. This does not replace testing a native macOS package.
'use strict';

if (process.platform !== 'win32') throw new Error('This simulated-platform check uses Windows LOCALAPPDATA isolation.');
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 60000,
  });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow, session, globalShortcut, shell } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const Module = require('node:module'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', `platform-main-smoke-${Date.now()}`);
const feedRoot = path.resolve(process.env.OVERKOT_SMOKE_FEED_ROOT || path.join(root, 'output', 'data-feed'));
fs.mkdirSync(output, { recursive: true });
process.env.LOCALAPPDATA = output;
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps', 'pictures']) {
  const directory = path.join(output, key);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(key, directory);
}
app.disableHardwareAcceleration();

const metrics = { detectors: 0, scanners: 0, watchers: 0, gameCalls: 0, externalOpens: [] };
const errors = [], blockedRequests = [], screenshots = [], hiddenWindows = [];
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
shell.openExternal = async url => { metrics.externalOpens.push(url); };
const nativeFetch = globalThis.fetch;
const localUrl = url => /^http:\/\/127\.0\.0\.1:\d+\//.test(String(url));
globalThis.fetch = (url, options) => {
  if (localUrl(url)) return nativeFetch(url, options);
  blockedRequests.push(String(url));
  return Promise.reject(new Error('Remote network disabled by platform smoke harness'));
};
require('axios').interceptors.request.use(config => {
  if (localUrl(config.url)) return config;
  blockedRequests.push(config.url);
  throw new Error('Remote network disabled by platform smoke harness');
});
app.once('ready', () => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  (details, callback) => { blockedRequests.push(details.url); callback({ cancel: true }); }));

const originalLoad = Module._load;
const { getPlatformSupport } = require('../src/modules/platformSupport');
const support = getPlatformSupport('darwin');
class InertWatcher {
  constructor() { metrics.watchers++; }
  start() { metrics.gameCalls++; }
  stop() {}
}
Module._load = function(request, parent, isMain) {
  const name = request.replaceAll('\\', '/');
  if (name.endsWith('/platformSupport')) return { getPlatformSupport: () => support };
  if (name.endsWith('/modules/processDetector')) return { ProcessDetector: class {
    constructor() { metrics.detectors++; }
    async waitForProcess() { metrics.gameCalls++; return 0; }
    startForegroundMonitor() { metrics.gameCalls++; }
    stopForegroundMonitor() {}
  } };
  if (name.endsWith('/modules/memoryScanner')) return {
    scannerAvailableSync: () => false,
    MemoryScanner: class {
      constructor() { metrics.scanners++; }
      async scanForAccountAndNonce() { metrics.gameCalls++; return {}; }
    },
  };
  for (const [filename, exported] of [['logWatcher', 'LogWatcher'], ['arenaWatcher', 'ArenaWatcher'], ['ancestorWatcher', 'AncestorWatcher']]) {
    if (name.endsWith('/modules/' + filename)) return { [exported]: InertWatcher };
  }
  if (name.endsWith('/modules/apiClient')) return { ApiClient: class {} };
  if (name.endsWith('/modules/groupFinderService')) return new Proxy({}, {
    get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false),
  });
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const defaults = ConfigStore.defaults.bind(ConfigStore);
ConfigStore.defaults = () => defaults('darwin');
const config = new ConfigStore();
const { TUTORIAL_IDS } = require('../src/modules/tutorials');
assert.equal(config.get('clickThrough'), false);
assert.equal(config.get('hideWhenGameClosed'), false);
assert.equal(config.get('automaticUpdates'), false);
config.setMany({ hideWhenGameClosed: true, showOnlyWhenGameFocused: true,
  widgetVisibility: { market: true, boss: true }, widgetOpen: { boss: true }, widgetDocked: { boss: false },
  dockParadigmVersion: 1, startupLayoutPending: false,
  tutorialCompleted: Object.fromEntries(TUTORIAL_IDS.map(id => [id, true])), enableAlertSound: false });

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push(`Renderer stopped: ${details.reason}`));
});
app.on('browser-window-created', (_event, win) => {
  win.on('hide', () => { const url = win.webContents.getURL(); if (url) hiddenWindows.push(url); });
});
const manifest = JSON.parse(fs.readFileSync(path.join(feedRoot, 'manifest.json'), 'utf8'));
const allowed = new Set(['/manifest.json', ...Object.values(manifest.files).map(entry => '/' + entry.url)]);
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1').pathname;
  if (!allowed.has(url)) { response.writeHead(404); response.end(); return; }
  fs.readFile(path.join(feedRoot, ...url.split('/').filter(Boolean)), (error, bytes) => {
    response.writeHead(error ? 404 : 200); response.end(error ? '' : bytes);
  });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const start = Date.now();
  while (Date.now() - start < 12000) { const value = await predicate(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
async function ready(file, query = '') {
  const win = await until(() => BrowserWindow.getAllWindows().find(candidate => {
    const url = candidate.webContents.getURL();
    return (file === 'market.html' ? url.startsWith('overkot-market://app/') : url.split('?')[0].endsWith('/' + file)) && url.includes(query);
  }), file);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), file + ' preload');
  return win;
}
async function capture(win, name) {
  // Allow the compositor to present DOM changes before capturing the frame.
  await pause(200);
  const filename = path.join(output, name + '.png');
  fs.writeFileSync(filename, (await win.webContents.capturePage()).toPNG());
  screenshots.push(filename);
}
let finishing = false;
function finish(error) {
  if (finishing) return;
  finishing = true;
  const summary = { ok: !error, simulatedPlatform: 'darwin', hostPlatform: process.platform, metrics, errors,
    blockedRequests, hiddenWindows, screenshots, ...(error ? { failure: error.stack || String(error) } : {}) };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  server.closeAllConnections(); server.close();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  app.exit(error ? 1 : 0);
}
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
setTimeout(() => finish(new Error('Platform smoke timed out after 55 seconds')), 55000).unref();
server.listen(0, '127.0.0.1', () => {
  process.env.OVERKOT_DATA_MANIFEST_URL = `http://127.0.0.1:${server.address().port}/manifest.json`;
  require('../src/main');
  app.whenReady().then(async () => {
    const main = await ready('index.html');
    const widget = await ready('widget-host.html', 'widget=boss');
    await until(async () => (await main.webContents.executeJavaScript('window.api.getState()')).status === 'companion', 'companion status');
    const state = await main.webContents.executeJavaScript('window.api.getState()');
    assert.deepEqual(state.platformSupport, support);
    assert.equal(state.config.hideWhenGameClosed, true, 'Stale saved visibility setting is retained');
    assert.equal(main.isVisible(), true, 'Companion main remains visible without a running game');
    assert.equal(widget.isVisible(), true, 'Companion widgets remain visible without a running game');
    assert.match(await main.webContents.executeJavaScript("document.getElementById('dock-status-text').textContent"), /companion/i);
    await capture(main, 'companion-main');
    await main.webContents.executeJavaScript('window.api.openMarket()');
    const market = await ready('market.html');
    // The hidden Windows test process can suppress native initial popup show.
    // Present it explicitly, then exercise the real app visibility handlers.
    market.show(); market.focus();
    await main.webContents.executeJavaScript('window.api.saveConfig({ hideWhenGameClosed: true, showOnlyWhenGameFocused: true })');
    await pause(300);
    assert.equal(market.isVisible(), true);
    assert.equal(main.isVisible(), true);
    assert.equal(widget.isVisible(), true);
    const marketState = await market.webContents.executeJavaScript('window.api.marketGetState()');
    assert.equal(marketState.authenticated, false);
    assert.equal(marketState.inventory.available, false);
    assert.equal(marketState.inventory.reason, support.inventoryUnavailableReason);
    // Public catalogue requests stay blocked in this companion-mode check.
    // Market's dedicated smoke owns catalogue rendering and account navigation.
    assert.equal(await market.webContents.executeJavaScript('!!document.body'), true);
    await capture(market, 'companion-market');
    await main.webContents.executeJavaScript('window.api.openSettings()');
    const settings = await ready('settings.html');
    await until(async () => !await settings.webContents.executeJavaScript("document.getElementById('settings-content').inert"), 'settings loaded');
    for (const id of ['chk-hide-when-game-closed', 'chk-show-only-when-game-focused']) {
      assert.equal(await settings.webContents.executeJavaScript(`document.getElementById('${id}').disabled`), true, id + ' unsupported');
    }
    await settings.webContents.executeJavaScript("document.getElementById('tab-overlay').click()");
    await until(async () => await settings.webContents.executeJavaScript(
      "!document.getElementById('panel-overlay').hidden && !document.getElementById('platform-support-note').hidden"), 'companion overlay settings visible');
    assert.match(await settings.webContents.executeJavaScript("document.getElementById('platform-support-note').textContent"), /macOS/);
    assert.equal(await settings.webContents.executeJavaScript("document.getElementById('chk-live-player-tracking').checked"), true);
    assert.match(await settings.webContents.executeJavaScript("document.getElementById('player-tracking-hint').textContent"), /Center on player/);
    await settings.webContents.executeJavaScript("document.getElementById('chk-live-player-tracking').checked = false; document.getElementById('chk-live-player-tracking').dispatchEvent(new Event('change', {bubbles:true}))");
    await until(async () => (await settings.webContents.executeJavaScript('window.api.getState()')).config.livePlayerTracking === false, 'tracking preference saved off');
    assert.equal((await settings.webContents.executeJavaScript('window.api.getPlayerTracking()')).status, 'disabled');
    await until(async () => await settings.webContents.executeJavaScript("document.getElementById('player-tracking-status').dataset.status === 'disabled'"), 'tracking status disabled');
    await settings.webContents.executeJavaScript("document.getElementById('chk-live-player-tracking').checked = true; document.getElementById('chk-live-player-tracking').dispatchEvent(new Event('change', {bubbles:true}))");
    await until(async () => (await settings.webContents.executeJavaScript('window.api.getState()')).config.livePlayerTracking === true, 'tracking preference saved on');
    assert.ok(['stopped', 'unsupported-platform'].includes((await settings.webContents.executeJavaScript('window.api.getPlayerTracking()')).status));
    assert.equal(await settings.webContents.executeJavaScript("!!document.querySelector('#panel-overlay input[type=color]')"), false,
      'Widget map colours are absent from global Overlay settings');
    await settings.webContents.executeJavaScript("document.getElementById('tab-widgets').click()");
    await until(async () => await settings.webContents.executeJavaScript("!document.getElementById('panel-widgets').hidden"), 'Widget settings tab visible');
    for (const id of ['color-player-marker', 'color-player-marker-outline', 'color-dungeon-outline', 'chk-dungeon-auto-switch', 'chk-dungeon-see-through', 'slider-dungeon-opacity']) {
      assert.equal(await settings.webContents.executeJavaScript(`!!document.querySelector('#panel-widgets #${id}')`), true,
        id + ' belongs to widget settings');
    }
    const mapColorControls = () => settings.webContents.executeJavaScript(`(() => ({
      player: document.getElementById('color-player-marker').value,
      border: document.getElementById('color-player-marker-outline').value,
      outline: document.getElementById('color-dungeon-outline').value,
      playerHex: document.getElementById('player-marker-color-value').textContent,
      borderHex: document.getElementById('player-marker-outline-color-value').textContent,
      outlineHex: document.getElementById('dungeon-outline-color-value').textContent,
      playerType: document.getElementById('color-player-marker').type,
      borderType: document.getElementById('color-player-marker-outline').type,
      outlineType: document.getElementById('color-dungeon-outline').type,
    }))()`);
    assert.deepEqual(await mapColorControls(), { player: '#f4b642', border: '#241708', outline: '#d8d8d8',
      playerHex: '#F4B642', borderHex: '#241708', outlineHex: '#D8D8D8', playerType: 'color', borderType: 'color', outlineType: 'color' });
    const pickColor = (id, value) => settings.webContents.executeJavaScript(`(() => {
      const input = document.getElementById(${JSON.stringify(id)}); input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await pickColor('color-player-marker', '#b96432');
    await until(async () => (await settings.webContents.executeJavaScript('window.api.getState()')).config.playerMarkerColor === '#b96432', 'marker colour saved through native Settings control');
    await pickColor('color-player-marker-outline', '#12080a');
    await until(async () => (await settings.webContents.executeJavaScript('window.api.getState()')).config.playerMarkerOutlineColor === '#12080a', 'marker outline colour saved through native Settings control');
    await pickColor('color-dungeon-outline', '#aaccee');
    await until(async () => (await settings.webContents.executeJavaScript('window.api.getState()')).config.dungeonMapOutlineColor === '#aaccee', 'outline colour saved through native Settings control');
    await until(async () => { const colors = await mapColorControls(); return colors.playerHex === '#B96432' && colors.borderHex === '#12080A' && colors.outlineHex === '#AACCEE'; }, 'colour hex labels reflect saved selections');
    assert.equal(new ConfigStore().get('playerMarkerColor'), '#b96432', 'Marker colour survives a config-store reload');
    assert.equal(new ConfigStore().get('playerMarkerOutlineColor'), '#12080a', 'Marker outline colour survives a config-store reload');
    assert.equal(new ConfigStore().get('dungeonMapOutlineColor'), '#aaccee', 'Outline colour survives a config-store reload');
    for (const key of ['playerMarkerColor', 'playerMarkerOutlineColor', 'dungeonMapOutlineColor']) {
      for (const value of [null, false, 123, {}, [], '', 'cyan', '#fff', '#ffffff00', '#12345g', ' #112233']) {
        assert.equal(await settings.webContents.executeJavaScript(`window.api.saveConfig(${JSON.stringify({ [key]: value })})`), false,
          key + ': malformed colour rejected by actual config IPC');
      }
    }
    assert.equal(await settings.webContents.executeJavaScript("window.api.saveConfig({playerMarkerColor:'#112233', dungeonMapOutlineColor:'invalid'})"), false,
      'A mixed valid/invalid colour patch is rejected before either selection changes');
    const unchangedColors = (await settings.webContents.executeJavaScript('window.api.getState()')).config;
    assert.equal(unchangedColors.playerMarkerColor, '#b96432'); assert.equal(unchangedColors.dungeonMapOutlineColor, '#aaccee');
    assert.equal(unchangedColors.playerMarkerOutlineColor, '#12080a');
    assert.equal(await main.webContents.executeJavaScript("window.api.saveConfig({playerMarkerColor:'#DeAd12', playerMarkerOutlineColor:'#1E0D04', dungeonMapOutlineColor:'#87AbCD'})"), true);
    await until(async () => { const colors = await mapColorControls(); return colors.player === '#dead12' && colors.outline === '#87abcd'
      && colors.border === '#1e0d04' && colors.playerHex === '#DEAD12' && colors.borderHex === '#1E0D04' && colors.outlineHex === '#87ABCD'; }, 'external colour edits update open Settings controls');
    assert.equal(new ConfigStore().get('playerMarkerColor'), '#dead12');
    assert.equal(new ConfigStore().get('playerMarkerOutlineColor'), '#1e0d04');
    assert.equal(new ConfigStore().get('dungeonMapOutlineColor'), '#87abcd');
    await settings.webContents.executeJavaScript("document.getElementById('reset-player-marker-color').click()");
    await until(async () => (await settings.webContents.executeJavaScript('window.api.getState()')).config.playerMarkerColor === '#f4b642', 'marker reset saved');
    assert.equal((await mapColorControls()).outline, '#87abcd', 'Marker reset preserves custom room outlines');
    assert.equal((await mapColorControls()).border, '#1e0d04', 'Marker reset preserves custom marker outlines');
    await settings.webContents.executeJavaScript("document.getElementById('reset-player-marker-outline-color').click()");
    await until(async () => (await settings.webContents.executeJavaScript('window.api.getState()')).config.playerMarkerOutlineColor === '#241708', 'marker outline reset saved');
    assert.equal((await mapColorControls()).outline, '#87abcd', 'Marker outline reset preserves custom room outlines');
    await settings.webContents.executeJavaScript("document.getElementById('reset-dungeon-outline-color').click()");
    await until(async () => { const colors = await mapColorControls(); return colors.player === '#f4b642' && colors.border === '#241708' && colors.outline === '#d8d8d8'; }, 'outline reset saved and controls restored');
    assert.equal(new ConfigStore().get('playerMarkerColor'), '#f4b642');
    assert.equal(new ConfigStore().get('playerMarkerOutlineColor'), '#241708');
    assert.equal(new ConfigStore().get('dungeonMapOutlineColor'), '#d8d8d8');
    await capture(settings, 'companion-settings');
    await main.webContents.executeJavaScript('window.api.openUpdates()');
    const updates = await ready('update-window.html');
    await until(async () => await updates.webContents.executeJavaScript("document.getElementById('update-installer').hidden"), 'Windows installer hidden');
    await updates.webContents.executeJavaScript('window.api.downloadInstaller()');
    await pause(300);
    assert.deepEqual(metrics, { detectors: 0, scanners: 0, watchers: 0, gameCalls: 0, externalOpens: [] });
    assert.deepEqual(hiddenWindows, [], 'Unsupported visibility preferences never hide companion windows');
    assert.deepEqual(errors, []);
    assert.equal(fs.existsSync(path.join(output, 'Overkot', 'market-session.bin')), false);
    finish();
  }).catch(finish);
});
