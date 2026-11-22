// Run: node scripts/check-market-app.js
// Optional OVERKOT_SMOKE_APP_ROOT points at an extracted/staged App tree;
// OVERKOT_SMOKE_FEED_ROOT points at an existing output/data-feed directory.
// Loads real main/preload/renderers with inert game credentials and services.
'use strict';

if (process.platform !== 'win32') throw new Error('This check requires Windows LOCALAPPDATA isolation.');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 60000,
  });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow, session, globalShortcut, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const assert = require('node:assert/strict');
const harnessRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(process.env.OVERKOT_SMOKE_APP_ROOT || harnessRoot);
const feedRoot = path.resolve(process.env.OVERKOT_SMOKE_FEED_ROOT || path.join(harnessRoot, 'output', 'data-feed'));
// Electron was launched with this script as its entry. Resolve bundled market
// assets from the application tree, just as electron . does during normal use.
app.setAppPath(sourceRoot);
// Extracted staged trees intentionally omit dependencies; resolve them from
// the installed source checkout while running that tree's application code.
process.env.NODE_PATH = [path.join(harnessRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const output = path.join(harnessRoot, 'output', `market-main-smoke-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
process.env.LOCALAPPDATA = output;
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(output, key);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(key, directory);
}
app.disableHardwareAcceleration();

const errors = [], screenshots = [], feedRequests = [], blockedRequests = [];
const sharedAuth = { enabled: false, account: null, store: null, calls: [], exchanged: false, revoked: false,
  centralToken: 'c'.repeat(43), grant: 'g'.repeat(43), marketToken: 'm'.repeat(43) };
const fixtureResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
// These production-shaped origins are intercepted below; no remote fetch runs.
process.env.OVERKOT_SERVICES_FILE = path.join(harnessRoot, 'config', 'official-services.json');
process.env.OVERKOT_MARKET_API_KEY = 'retired-smoke-test-key';
function sharedAuthResponse(url, options = {}) {
  const parsed = new URL(String(url));
  const route = parsed.pathname;
  const method = options.method || 'GET';
  const authorization = options.headers?.Authorization;
  const body = options.body ? JSON.parse(options.body) : undefined;
  if (sharedAuth.enabled && parsed.origin === 'https://auth.avakot.dev' && route.startsWith('/v1/overlay/')) {
    const action = route.slice('/v1/overlay/'.length);
    sharedAuth.calls.push({ service: 'account', action, method });
    assert.equal(authorization, 'Bearer ' + sharedAuth.centralToken);
    if (action === 'me') return fixtureResponse({ account: { email: 'fixture@example.invalid', displayName: 'CentralFixture' }, overlay: { marketSignIn: true } });
    if (action === 'market-authorization') {
      assert.equal(method, 'POST'); assert.deepEqual(body, {}); assert.equal(sharedAuth.exchanged, false);
      return fixtureResponse({ grant: sharedAuth.grant });
    }
    if (action === 'presence' || (action === 'session' && method === 'DELETE')) return fixtureResponse({ ok: true });
    throw new Error('Unexpected isolated account fixture: ' + action);
  }
  const publicGateway = parsed.origin === 'https://avakot.market' && route.startsWith('/api/v1/');
  if (!publicGateway && (parsed.origin !== 'https://api.avakot.market' || !route.startsWith('/v1/'))) return null;
  const action = route.slice(publicGateway ? '/api/v1/'.length : '/v1/'.length);
  assert.equal(options.headers?.['X-API-Key'], undefined);
  if (publicGateway) { assert.equal(method, 'GET'); assert.equal(authorization, undefined); assert.equal(options.headers?.['X-API-Key'], undefined); }
  sharedAuth.calls.push({ service: 'market', action, method });
  if (action === 'auth/desktop/avakot') {
    assert.equal(sharedAuth.enabled, true); assert.equal(sharedAuth.exchanged, false);
    assert.equal(authorization, undefined); assert.deepEqual(body, { grant: sharedAuth.grant });
    sharedAuth.exchanged = true;
    return fixtureResponse({ data: { attributes: { sessionToken: sharedAuth.marketToken, expiresAt: new Date(Date.now() + 900_000).toISOString() } } });
  }
  if (action === 'auth/sign-out') {
    assert.equal(authorization, 'Bearer ' + sharedAuth.marketToken); sharedAuth.revoked = true;
    return fixtureResponse({ data: {} });
  }
  if (action === 'me' || action.startsWith('me/')) {
    if (authorization !== 'Bearer ' + sharedAuth.marketToken || sharedAuth.revoked) {
      return fixtureResponse({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required.' } }, 401);
    }
    if (action === 'me') return fixtureResponse({ data: { id: 'confirmed-market-user', attributes: {
      displayHandle: 'MarketFixtureEnvoy', handleSlug: 'market-fixture-envoy', platform: 'PC',
      inGameVerified: true, restrictionState: 'NONE', emailVerified: true,
    } } });
    if (action.startsWith('me/listings')) return fixtureResponse({ data: [] });
    if (action === 'me/availability') return fixtureResponse({ data: { attributes: { status: 'ONLINE', inGame: true, inGameSource: 'overlay' } } });
    if (action === 'me/offers/summary') return fixtureResponse({ data: { pendingReceivedCount: 0, unreadDecisionCount: 0, alertCount: 0 } });
    throw new Error('Unexpected protected Market fixture: ' + action);
  }
  if (action === 'public/config') return fixtureResponse({ data: { tradingDisabled: false, arcsTradeDisabled: false, catalogueOverrides: [] } });
  if (action === 'catalogue/feed') return fixtureResponse({ items: [] });
  if (action.startsWith('catalogue/languages/')) return fixtureResponse({});
  if (action.startsWith('listings/search') || action.startsWith('listings/recent')) return fixtureResponse({ data: [], meta: { hasMore: false, nextCursor: null } });
  throw new Error('Unexpected public Market fixture: ' + action);
}
const metrics = { scans: 0, foregroundChecks: 0, foregroundStarts: 0, foregroundStops: 0, gameForeground: true };
const shortcuts = new Map();
globalShortcut.register = (key, callback) => { shortcuts.set(key, callback); return true; };
globalShortcut.unregister = key => shortcuts.delete(key);

// No request to a remote host can leave this isolated test process.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const fixture = sharedAuthResponse(url, options);
  if (fixture) return Promise.resolve(fixture);
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(String(url))) {
    blockedRequests.push({ transport: 'fetch', url: String(url) });
    return Promise.reject(new Error('External network disabled by market smoke harness'));
  }
  return nativeFetch(url, options);
};
const axios = require('axios');
axios.interceptors.request.use(config => {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(config.url || '')) {
    blockedRequests.push({ transport: 'axios', url: config.url });
    throw new Error('External network disabled by market smoke harness');
  }
  return config;
});
app.once('ready', () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    blockedRequests.push({ transport: 'renderer', url: details.url });
    callback({ cancel: true });
  });
});

const originalLoad = Module._load;
class InertWatcher { start() {} stop() {} consumeLoginSignal() { return false; } consumeLogoutSignal() { return false; } extractAccountId() { return ''; } extractDisplayName() { return ''; } }
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/avakotAccount')) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return { ...actual,
      AvakotTokenStore: class {
        constructor() { this.value = null; sharedAuth.store = this; }
        load() { return this.value; }
        save(value) { this.value = value; return true; }
        clear() { this.value = null; }
      },
      AvakotAccountService: class extends actual.AvakotAccountService {
        constructor(options) { super(options); sharedAuth.account = this; }
      },
    };
  }
  if (request.endsWith('/modules/layoutKeyMonitor')) return {
    // This check controls Electron focus explicitly. Never read the user's
    // real keyboard or foreground window while exercising the fixture.
    startLayoutKeyMonitor: () => ({ stop() {} }),
  };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class {
    async waitForProcess() { return 424242; }
    isProcessRunning() { return true; }
    startForegroundMonitor() { this._fgProc = {}; metrics.foregroundStarts++; }
    stopForegroundMonitor() { this._fgProc = null; metrics.foregroundStops++; }
    async isProcessForeground() { metrics.foregroundChecks++; return metrics.gameForeground; }
  } };
  if (request.endsWith('/modules/memoryScanner')) return {
    MemoryScanner: class { async scanForAccountAndNonce() { metrics.scans++; return {}; } },
    scannerAvailableSync: () => false,
  };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: InertWatcher };
  if (request.endsWith('/modules/arenaWatcher')) return { ArenaWatcher: InertWatcher };
  if (request.endsWith('/modules/ancestorWatcher')) return { AncestorWatcher: InertWatcher };
  if (request.endsWith('/modules/apiClient')) return { ApiClient: class {} };
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, {
    get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false),
  });
  return originalLoad.call(this, request, parent, isMain);
};

app.on('web-contents-created', (_event, contents) => {
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    blockedRequests.push({ transport: 'renderer', url: details.url });
    callback({ cancel: true });
  });
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push(`Renderer stopped: ${details.reason}`));
});

const manifest = JSON.parse(fs.readFileSync(path.join(feedRoot, 'manifest.json'), 'utf8'));
const files = new Map(Object.entries(manifest.files).map(([key, entry]) => [`/${entry.url}`, key]));
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1').pathname;
  if (url !== '/manifest.json' && !files.has(url)) { response.writeHead(404); response.end(); return; }
  const filename = path.join(feedRoot, ...url.split('/').filter(Boolean));
  fs.readFile(filename, (error, bytes) => {
    if (error) { response.writeHead(404); response.end(); return; }
    feedRequests.push(files.get(url) || 'manifest');
    response.writeHead(200, { 'Content-Type': url.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    response.end(bytes);
  });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await test(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
const findWindow = (file, query = '') => BrowserWindow.getAllWindows().find(win => {
  const url = win.webContents.getURL();
  return (file === 'market.html' ? url.startsWith('overkot-market://app/') : url.split('?')[0].endsWith('/' + file)) && (!query || url.includes(query));
});
async function ready(file, query) {
  const win = await until(() => findWindow(file, query), file + (query || ''));
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), file + ' preload');
  return win;
}
async function capture(win, name) {
  await pause(200);
  const filename = path.join(output, name + '.png');
  fs.writeFileSync(filename, (await win.webContents.capturePage()).toPNG());
  screenshots.push(filename);
}
let finishing = false;
function finish(error) {
  if (finishing) return;
  finishing = true;
  const summary = { ok: !error, sourceRoot, metrics, errors, feedRequests, blockedRequests, screenshots,
    sharedAccount: { calls: sharedAuth.calls, exchanged: sharedAuth.exchanged, revoked: sharedAuth.revoked },
    ...(error ? { failure: error.stack || String(error) } : {}) };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  server.closeAllConnections(); server.close();
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  app.exit(error ? 1 : 0);
}
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
setTimeout(() => finish(new Error('Market main smoke timed out after 55 seconds')), 55000).unref();

server.listen(0, '127.0.0.1', () => {
  process.env.OVERKOT_DATA_MANIFEST_URL = `http://127.0.0.1:${server.address().port}/manifest.json`;
  // A fresh profile has neither an account identifier nor a market session.
  const { ConfigStore } = require(path.join(sourceRoot, 'src', 'modules', 'config'));
  const config = new ConfigStore();
  const { TUTORIAL_IDS } = require(path.join(sourceRoot, 'src', 'modules', 'tutorials'));
  const settings = { clickThrough: true, interactionHotkey: 'Shift+F1', automaticUpdates: false,
    hideWhenGameClosed: false, showOnlyWhenGameFocused: false, dockEdge: 'bottom', dockAutoHide: false,
    widgetVisibility: { market: true, boss: true }, widgetOpen: { boss: true }, widgetDocked: { boss: false },
    dockParadigmVersion: 1, startupLayoutPending: false,
    tutorialCompleted: Object.fromEntries(TUTORIAL_IDS.map(id => [id, true])),
    enableAlertSound: false, backgroundOpacity: 92 };
  for (const [key, value] of Object.entries(settings)) config.set(key, value);
  require(path.join(sourceRoot, 'src', 'main'));

  app.whenReady().then(async () => {
    const main = await ready('index.html');
    const widget = await ready('widget-host.html', 'widget=boss');
    assert.equal(findWindow('widget-host.html', 'widget=market'), undefined, 'Market does not create a floating widget');
    await until(async () => await main.webContents.executeJavaScript("!!document.querySelector('.dock-widget-button[data-widget=market]')"), 'enabled Market launcher');
    await capture(main, 'market-launcher-free');
    await main.webContents.executeJavaScript("document.querySelector('.dock-widget-button[data-widget=market]').click()");
    let market = await ready('market.html');
    await until(async () => await market.webContents.executeJavaScript("!!document.querySelector('.sidebar-primary')"), 'shared market frontend');
    await until(async () => await main.webContents.executeJavaScript("document.querySelector('.dock-widget-button[data-widget=market]').classList.contains('is-open') && document.querySelector('.dock-widget-button[data-widget=market]').getAttribute('aria-pressed') === 'true'"), 'Market launcher stays active while its window is open');
    assert.equal((await market.webContents.executeJavaScript('window.api.marketGetState()')).authenticated, false);
    assert.equal(await market.webContents.executeJavaScript("!!document.querySelector('a[href=\"/overkot-inventory\"]')"), true);
    assert.equal((await market.webContents.executeJavaScript('window.overkotMarket.getState()')).accountConnection.signedIn, false);
    await capture(market, 'market-login');

    await market.webContents.executeJavaScript("document.querySelector('.account-area .desktop-account-action:not(.primary)').click()");
    const accountSettings = await ready('settings.html');
    await until(async () => await accountSettings.webContents.executeJavaScript("document.querySelector('#tab-connections')?.getAttribute('aria-selected') === 'true'"), 'Market login opens Settings Connections');
    assert.equal((await accountSettings.webContents.executeJavaScript('window.api.avakotAccountState()')).signedIn, false);
    assert.equal(await market.webContents.executeJavaScript('location.pathname'), '/');
    assert.equal(await market.webContents.executeJavaScript('!!document.querySelector("input[type=password], #market-email-form")'), false);
    await capture(accountSettings, 'market-overkot-connections');
    await accountSettings.webContents.executeJavaScript("document.querySelector('#tab-appearance').click()");
    await market.webContents.executeJavaScript("document.querySelector('.account-area .desktop-account-action.primary').click()");
    await until(async () => await accountSettings.webContents.executeJavaScript("document.querySelector('#tab-connections')?.getAttribute('aria-selected') === 'true'"), 'Market signup returns existing Settings window to Connections');
    assert.equal(findWindow('settings.html').id, accountSettings.id);
    await accountSettings.webContents.executeJavaScript('window.api.windowClose()');
    await until(() => !findWindow('settings.html'), 'Settings close before focus checks');

    await market.webContents.executeJavaScript("document.querySelector('a[href=\"/overkot-inventory\"]').click()");
    await until(async () => await market.webContents.executeJavaScript("!!document.querySelector('iframe.inventory')?.contentDocument?.querySelector('#inventory-gate')"), 'guest inventory page remains accessible');
    assert.equal((await market.webContents.executeJavaScript('window.api.marketGetState()')).authenticated, false);
    assert.match(await market.webContents.executeJavaScript("document.querySelector('iframe.inventory').contentDocument.querySelector('#inventory-gate').textContent"), /Sign in/);
    assert.equal(await market.webContents.executeJavaScript("innerWidth > 1024 || document.querySelector('iframe.inventory').getBoundingClientRect().top >= document.querySelector('.sidebar').getBoundingClientRect().bottom - 1"), true,
      'Responsive sidebar stays above inventory controls in the default Market window');
    await capture(market, 'market-inventory-without-connections');

    // Restore an inert central token through the real account service. Its
    // main-only grant must be exchanged and /me validated by MarketService.
    assert.ok(sharedAuth.account && sharedAuth.store);
    sharedAuth.enabled = true; sharedAuth.store.value = sharedAuth.centralToken;
    clearInterval(sharedAuth.account.heartbeat); sharedAuth.account.initialized = false;
    await sharedAuth.account.initialize();
    await until(async () => {
      const state = await market.webContents.executeJavaScript('window.overkotMarket.getState()');
      return state.authenticated && state.accountConnection.connected;
    }, 'real central restore, grant exchange and Market session validation');
    const sharedState = await market.webContents.executeJavaScript('window.overkotMarket.getState()');
    assert.equal(sharedState.user.displayHandle, 'MarketFixtureEnvoy');
    assert.equal(sharedState.accountConnection.account.displayName, 'CentralFixture');
    assert.equal(sharedState.sessionPersistent, false);
    for (const secret of [sharedAuth.centralToken, sharedAuth.grant, sharedAuth.marketToken]) {
      assert.equal(JSON.stringify(sharedState).includes(secret), false, 'Credentials stay out of renderer state');
    }
    assert.equal(sharedAuth.exchanged, true);
    assert.equal(sharedAuth.calls.filter(call => call.service === 'account' && call.action === 'market-authorization').length, 1);
    await until(async () => await market.webContents.executeJavaScript("document.querySelector('.account-name')?.textContent.includes('MarketFixtureEnvoy')"), 'redesign sees real Market identity from shared sign-in');
    await capture(market, 'market-shared-account-connected');
    await market.webContents.executeJavaScript('window.overkotMarket.openAccountSettings()');
    const sharedSettings = await ready('settings.html');
    await until(async () => (await sharedSettings.webContents.executeJavaScript('window.api.avakotAccountState()')).signedIn, 'Settings reflects central account restoration');
    await sharedSettings.webContents.executeJavaScript('window.api.avakotAccountLogout()');
    await until(async () => {
      const state = await market.webContents.executeJavaScript('window.overkotMarket.getState()');
      return !state.authenticated && !state.accountConnection.signedIn;
    }, 'central Settings sign-out clears the Market session');
    await until(() => sharedAuth.revoked, 'derived Market token revoked after central sign-out');
    await sharedSettings.webContents.executeJavaScript('window.api.windowClose()');
    await until(() => !findWindow('settings.html'), 'shared account Settings close before focus checks');

    // Moving focus from the click-through overlay to Market must preserve
    // interactive mode, even while the synthetic game is in the background.
    await main.webContents.executeJavaScript('(async () => { window.__marketSmokeInteractive = (await window.api.getState()).overlayInteractive; window.api.onOverlayInteraction(value => window.__marketSmokeInteractive = value); })()');
    const toggle = shortcuts.get('Shift+F1');
    assert.equal(typeof toggle, 'function');
    if (!await main.webContents.executeJavaScript('window.__marketSmokeInteractive')) toggle();
    market.show(); market.focus();
    await until(() => market.isFocused(), 'market focus');
    await until(() => metrics.scans > 0, 'inert scanner loop');
    await main.webContents.executeJavaScript('window.api.saveConfig({ showOnlyWhenGameFocused: true })');
    metrics.gameForeground = false;
    await until(() => metrics.foregroundChecks > 0, 'synthetic background game check');
    await pause(700);
    assert.equal(BrowserWindow.getFocusedWindow()?.id, market.id, 'Market is the focused overlay window');
    assert.equal(main.isVisible(), true, 'Market focus keeps the main overlay visible');
    assert.equal(widget.isVisible(), true, 'Market focus keeps free widgets visible');
    assert.equal(market.isVisible(), true, 'Market does not auto-hide itself');
    assert.equal(await main.webContents.executeJavaScript('window.__marketSmokeInteractive'), true, 'Market focus retains interactive mode');

    metrics.gameForeground = true;
    await main.webContents.executeJavaScript('window.api.saveConfig({ showOnlyWhenGameFocused: false })');
    const firstMarketId = market.id;
    await market.webContents.executeJavaScript('window.overkotMarket.close()');
    await until(() => !findWindow('market.html'), 'market close');
    await until(async () => await main.webContents.executeJavaScript("!document.querySelector('.dock-widget-button[data-widget=market]').classList.contains('is-open') && document.querySelector('.dock-widget-button[data-widget=market]').getAttribute('aria-pressed') === 'false'"), 'closing Market clears its launcher indicator');
    await main.webContents.executeJavaScript("document.querySelector('.dock-widget-button[data-widget=market]').click()");
    market = await ready('market.html');
    assert.notEqual(market.id, firstMarketId, 'App bar launcher recreates a closed Market window');
    await market.webContents.executeJavaScript('window.api.windowClose()');
    await until(() => !findWindow('market.html'), 'second market close');

    // The current edge dock keeps each ordinary panel in its native window.
    // Attaching Boss changes its geometry; Market remains a dedicated window.
    const { railBounds, layoutDockedWidgets } = require(path.join(sourceRoot, 'src', 'modules', 'edgeDockGeometry'));
    const { getWindowBounds } = require(path.join(sourceRoot, 'src', 'modules', 'windowDrag'));
    await main.webContents.executeJavaScript("window.api.saveConfig({ dockEdge: 'left', widgetDocked: { boss: true } })");
    const display = screen.getDisplayMatching(main.getBounds());
    await until(() => JSON.stringify(main.getBounds()) === JSON.stringify(railBounds(display.bounds, 'left')), 'left edge dock geometry');
    await until(() => {
      const bounds = getWindowBounds(widget);
      const { id, ...expected } = layoutDockedWidgets([{ id: 'boss', ...bounds }], display.workArea, 'left', display.bounds)[0];
      return ['x', 'y', 'width', 'height'].every(key => bounds[key] === expected[key]);
    }, 'Boss panel attached to edge dock');
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('.dock-widget-button[data-widget=boss]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('.dock-widget-button[data-widget=market]').getAttribute('aria-pressed')"), 'false', 'Closed Market remains inactive while the Boss panel is open');
    assert.equal(findWindow('widget-host.html', 'widget=market'), undefined, 'Attaching a panel never creates a Market widget');
    assert.equal(findWindow('dock-window.html'), undefined, 'The edge dock does not create a legacy grid window');
    await capture(main, 'market-launcher-dock');
    await main.webContents.executeJavaScript("document.querySelector('.dock-widget-button[data-widget=market]').click()");
    market = await ready('market.html');
    assert.equal(market.isVisible(), true, 'App bar opens Market while widgets are docked');
    await main.webContents.executeJavaScript("window.api.saveConfig({ widgetVisibility: { market: false, boss: true } })");
    await until(async () => await main.webContents.executeJavaScript("!document.querySelector('.dock-widget-button[data-widget=market]')"), 'disabled Market launcher');
    assert.equal(findWindow('widget-host.html', 'widget=market'), undefined, 'Disabling Market leaves no widget panel');
    assert.equal(widget.isVisible(), true, 'Disabling Market preserves the attached Boss panel');
    await main.webContents.executeJavaScript("window.api.saveConfig({ widgetVisibility: { market: true, boss: true } })");
    await until(async () => await main.webContents.executeJavaScript("!!document.querySelector('.dock-widget-button[data-widget=market]')"), 're-enabled Market launcher');
    await main.webContents.executeJavaScript("window.api.saveConfig({ dockEdge: 'bottom', widgetDocked: { boss: false } })");
    assert.equal((await ready('widget-host.html', 'widget=boss')).id, widget.id, 'Detaching Boss preserves its native panel');
    assert.equal(findWindow('widget-host.html', 'widget=market'), undefined, 'A floating Boss panel keeps Market in the dock');
    assert.deepEqual(errors, []);
    assert.equal(fs.existsSync(path.join(output, 'Overkot', 'market-session.bin')), false, 'No market token was written');

    // An unreachable server cannot block exiting, and repeated quit requests
    // must not send duplicate presence cleanup writes.
    const { MarketService } = require(path.join(sourceRoot, 'src', 'modules', 'marketService'));
    const originalDispose = MarketService.prototype.dispose;
    const originalQuit = app.quit;
    let disposals = 0, quitRetries = 0, preventedQuits = 0;
    MarketService.prototype.dispose = function() {
      disposals++;
      void originalDispose.call(this);
      return new Promise(() => {});
    };
    app.quit = () => { quitRetries++; };
    const quitEvent = { preventDefault: () => { preventedQuits++; } };
    app.emit('before-quit', quitEvent);
    app.emit('before-quit', quitEvent);
    assert.equal(disposals, 1, 'Repeated quit requests dispose Market once');
    assert.equal(quitRetries, 0, 'Exit waits briefly for presence cleanup');
    await until(() => quitRetries === 1, 'bounded Market shutdown', 6000);
    app.emit('before-quit', quitEvent);
    assert.equal(preventedQuits, 2, 'The final quit proceeds after the shutdown timeout');
    MarketService.prototype.dispose = originalDispose;
    app.quit = originalQuit;
    finish();
  }).catch(finish);
});
