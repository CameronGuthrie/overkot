// Isolated smoke check for the built moving-branch frontend, real protocol,
// dedicated preload and inventory composer. Every market operation is a fixture.
'use strict';

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 80000 });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const appRoot = path.resolve(process.env.OVERKOT_SMOKE_APP_ROOT || root);
const { MARKET_SCHEME, MARKET_ORIGIN, createMarketProtocolHandler, registerMarketFrontendIpc, configureMarketNavigation } = require('../src/modules/marketFrontend');
const { MarketService } = require('../src/modules/marketService');
const { SCHEME: GAME_IMAGE_SCHEME, IMAGE_BASE: GAME_IMAGE_BASE } = require('../src/modules/gameDataImages');
const uiRoot = process.env.OVERKOT_SMOKE_APP_ROOT ? path.join(appRoot, 'market-ui') : path.join(root, '.build', 'market-ui');
if (!fs.existsSync(path.join(uiRoot, 'index.html'))) throw new Error('Build the preview UI first with npm run market:build.');
const output = path.join(root, 'output', `market-redesign-check-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const directory = path.join(output, name);
  fs.mkdirSync(directory);
  app.setPath(name, directory);
}
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([MARKET_SCHEME, GAME_IMAGE_SCHEME].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } })));

const clone = value => JSON.parse(JSON.stringify(value));
const item = { id: 'smoke-thread', slug: 'smoke-moonsteel-thread', name: 'Smoke Moonsteel Thread', category: 'resource',
  maxQuantity: 999, acceptedQuantityMax: 999, tradeable: true, imageUrl: GAME_IMAGE_BASE + '/SF/Interface/Graphics/Smoke/Thread.png' };
const account = { id: 'smoke-envoy', displayHandle: 'SmokeEnvoy', handleSlug: 'smoke-envoy', platform: 'PC',
  inGameVerified: true, restrictionState: 'NONE', roles: [], emailVerified: true, createdAt: '2026-01-01T00:00:00Z' };
const row = { key: 'smoke-thread-row', itemId: item.id, name: item.name, category: item.category,
  quantity: 12, availableQuantity: 12, maxQuantity: 999, canList: true, warnings: [], attributes: {}, imageUrl: item.imageUrl };
const blade = { id: 'smoke-blade', name: 'Smoke Moonsteel Threadblade', category: 'weapon',
  imageUrl: GAME_IMAGE_BASE + '/SF/Interface/Graphics/Smoke/Blade.png', possibleTempers: [
    { id: 'smoke-temper', name: 'Smoke Temper', icon: GAME_IMAGE_BASE + '/SF/Interface/Graphics/Smoke/Temper.png' },
    { id: 'no-art', name: 'Temper without artwork' },
  ] };
const bladeRow = { ...row, key: 'smoke-blade-row', itemId: blade.id, name: blade.name, category: blade.category,
  imageUrl: blade.imageUrl, attributes: { weapon: { tempers: ['smoke-temper', 'no-art'] } } };
const inventoryRows = [row, bladeRow, ...Array.from({ length: 79 }, (_, index) => ({ ...row,
  key: `smoke-thread-row-${index + 1}`, name: `${row.name} ${String(index + 1).padStart(2, '0')}` }))];
let state = { authenticated: false, canTrade: false, user: null, sessionPersistent: false, catalogue: [item, blade], listings: [], trading: { arcsTradeDisabled: true },
  inventory: { available: false, rows: [], summary: { inventoryAvailable: false } } };
let connection = { signedIn: false, authorizing: false, busy: false, error: '', account: null };
const publicState = () => clone({ ...state, accountConnection: connection });
const listing = { id: 'smoke-public-listing', attributes: { type: 'OFFER', status: 'ACTIVE', quantity: 2, platform: 'PC',
  item: { id: item.id, slug: item.slug, displayName: item.name, imageUrl: '/api/v1/data-assets/SF/Interface/Graphics/Smoke/Thread.png', category: item.category, uniqueName: item.id },
  terms: { priceAmount: null, priceUnit: null, acceptedItems: [] }, createdAt: '2026-10-01T00:00:00Z',
  seller: { userId: 'smoke-seller', handle: 'FixtureSeller', handleSlug: 'fixture-seller', platform: 'PC', avatar: 'acorn', inGame: true } } };
const calls = [], errors = [], blockedRequests = [], localFailures = [], unexpectedRoutes = [], externalNavigations = [], screenshots = [], checks = [];
const imageRequests = [];
let win, finishing = false, heldRefresh = null, heldInitialState = null;
const push = () => win?.webContents.send('market:changed', clone({ ...state, accountConnection: connection }));
const market = {
  generation: 0, enabled: true, token: null, mutating: false,
  get user() { return state.user; },
  set user(value) { state = { ...state, user: value, authenticated: !!value }; },
  checkGeneration: MarketService.prototype.checkGeneration,
  acceptAccountResponse: MarketService.prototype.acceptAccountResponse,
  startPresence: async () => {},
  initialize: async () => {}, snapshot: publicState, update: () => {},
  refresh: async () => {
    const snapshot = publicState();
    if (heldRefresh) {
      const held = heldRefresh;
      calls.push({ action: 'held-refresh' });
      await held.promise;
    }
    return { ok: true, state: snapshot };
  },
  async request(route, options = {}) {
    calls.push({ action: 'request', route, method: options.method || 'GET' });
    const pathname = route.split('?')[0];
    if (pathname === 'me') {
      if (!state.authenticated) throw Object.assign(new Error('Sign in required'), { code: 'UNAUTHENTICATED', status: 401 });
      return { data: { id: account.id, attributes: account } };
    }
    if (pathname === 'public/config') return { data: { motd: 'Fixture Market announcement', tradingDisabled: false, arcsTradeDisabled: true, catalogueOverrides: [] } };
    if (pathname === 'catalogue/feed') return { metadata: { generated_at: '2026-10-01T00:00:00Z' }, items: [
      { id: item.id, unique_name: item.id, path: '/Smoke/Thread', name: item.name, category: item.category, tradeable: true,
        image_path: 'https://dap1x6lmnonv6.cloudfront.net/SF/Interface/Graphics/Smoke/Thread.png', icon: null },
    ] };
    if (pathname.startsWith('catalogue/languages/')) return {};
    if (['listings/search', 'listings/recent'].includes(pathname)) {
      const old = clone(listing); old.id += '-legacy'; old.attributes.item.imageUrl = 'https://dap1x6lmnonv6.cloudfront.net/SF/Interface/Graphics/Smoke/ThreadLegacy.png';
      return { data: [clone(listing), old], meta: { hasMore: false, nextCursor: null } };
    }
    if (pathname === `items/${item.slug}/arc-values`) return { data: { item: { slug: item.slug }, variantKind: 'standard', series: [] } };
    if (pathname === 'me/availability') return { data: { attributes: { status: 'ONLINE', inGame: true, inGameSource: 'overlay' } } };
    if (pathname === 'me/offers/summary') return { data: { pendingReceivedCount: 0, unreadDecisionCount: 0, alertCount: 0 } };
    if (pathname === 'me/settings' && options.method === 'PATCH') return { data: { attributes: account } };
    unexpectedRoutes.push(route);
    throw new Error('Unimplemented fixture route: ' + route);
  },
  async createListing(draft) {
    assert.equal(state.authenticated, true);
    assert.equal(draft.rowKey, row.key);
    assert.equal(draft.quantity, 2);
    assert.deepEqual(draft.acceptedItems, []);
    calls.push({ action: 'create', draft: clone(draft) });
    state.inventory.rows[0].availableQuantity -= draft.quantity;
    push();
    return { ok: true, state: publicState() };
  },
  async logout() {
    calls.push({ action: 'logout' });
    this.generation++;
    this.token = null;
    state = { ...state, authenticated: false, canTrade: false, user: null, listings: [] };
    push();
    return { ok: true, state: publicState() };
  },
  login: async () => { throw new Error('Embedded Market must use Overkot Connections, never its own credential form.'); },
  browse: async () => ({ ok: true, listings: [], meta: {} }),
  openWebsite: async value => { calls.push({ action: 'website', value }); return { ok: true }; },
};

// The harness never uses a real MarketService or a network-backed API.
globalThis.fetch = async url => { throw new Error('Main-process network disabled: ' + String(url)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = source => win.webContents.executeJavaScript(source, true);
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
async function capture(name) {
  await pause(150);
  const filename = path.join(output, name + '.png');
  const picture = await win.webContents.capturePage();
  assert.equal(picture.isEmpty(), false);
  fs.writeFileSync(filename, picture.toPNG());
  screenshots.push(filename);
}
const inventoryLink = 'a[href="/overkot-inventory"]';
const frameEvaluate = source => evaluate(`(() => { const document = window.document.querySelector('iframe.inventory').contentDocument; return (${source}); })()`);
const inventoryPalette = () => evaluate(`(() => {
  const sample = document.createElement('span'); sample.style.backgroundColor = 'var(--bg-secondary)'; document.body.append(sample);
  const expected = getComputedStyle(sample).backgroundColor; sample.remove();
  const frame = document.querySelector('iframe.inventory');
  const actual = frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('.inventory-card'));
  return { expected, actual: actual.backgroundColor, radius: actual.borderRadius };
})()`);
function finish(error) {
  if (finishing) return;
  finishing = true;
  const summary = { ok: !error, checks, errors, blockedRequests, localFailures, unexpectedRoutes, externalNavigations, calls, imageRequests, screenshots,
    source: JSON.parse(fs.readFileSync(path.join(uiRoot, 'market-source.json'), 'utf8')),
    ...(error ? { failure: error.stack || String(error) } : {}) };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, checks, errors, localFailures, blockedRequests: blockedRequests.length, output,
    ...(error ? { failure: summary.failure } : {}) }));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(error ? 1 : 0);
}
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
setTimeout(() => finish(new Error('Redesign smoke timed out after 70 seconds')), 70000).unref();

app.whenReady().then(async () => {
  protocol.handle(GAME_IMAGE_SCHEME, request => {
    imageRequests.push(request.url);
    assert.match(request.url, /^overkot-game-data:\/\/images\/SF\/Interface\/Graphics\/(?:Smoke\/(?:Thread(?:Legacy)?|Blade|Temper)|StoreItems\/Currency\/ArcsBundleSmall)\.png$/);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aazsAAAAASUVORK5CYII=', 'base64');
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    blockedRequests.push(details.url);
    callback({ cancel: true });
  });
  const handler = createMarketProtocolHandler({ uiRoot, rendererRoot: path.join(appRoot, 'src', 'renderer'), assetsRoot: path.join(appRoot, 'assets') });
  protocol.handle(MARKET_SCHEME, async request => {
    const response = await handler(request);
    if (response.status >= 400) localFailures.push({ url: request.url, status: response.status });
    return response;
  });
  win = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: {
    preload: path.join(appRoot, 'src', 'market-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    backgroundThrottling: false, offscreen: true,
  } });
  win.webContents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer stopped: ' + details.reason));
  configureMarketNavigation(win, url => { externalNavigations.push(url); });
  const delayedStateIpc = { handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
      const result = listener(event, ...args);
      if (channel === 'market-frontend:action' && args[0] === 'state' && heldInitialState) {
        const held = heldInitialState;
        calls.push({ action: 'held-initial-state' });
        return held.promise.then(() => result);
      }
      return result;
    });
  } };
  registerMarketFrontendIpc({ ipcMain: delayedStateIpc, market, getWindow: () => win, getAppearance: () => ({ theme: 'dark-mint' }),
    getConnectionState: () => clone(connection),
    openAccountSettings: () => { calls.push({ action: 'settings', section: 'connections' }); return { ok: true }; },
  });
  ipcMain.on('get-i18n', event => {
    event.returnValue = { languages: [{ code: 'en' }], translations: { en: require('../langs/en.json') } };
  });
  await win.loadURL(MARKET_ORIGIN + '/');
  await until(() => evaluate('!!window.overkotMarket && !!document.querySelector(".sidebar-primary") && document.querySelector(".search-results")?.textContent.includes("Smoke Moonsteel Thread")'), 'guest public search and fixture listing');
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(inventoryLink)}).length`), 1);
  assert.equal(await evaluate('typeof require'), 'undefined');
  checks.push('guest browse renders real redesign and fixture listing; inventory selling remains discoverable; Node unavailable');
  await until(() => evaluate('Array.from(document.images).filter(image => image.src.startsWith("overkot-game-data://images/SF/Interface/Graphics/Smoke/") && image.complete && image.naturalWidth > 0).length >= 2'), 'legacy CDN and website-proxy game artwork load through the main-process scheme');
  assert.ok(imageRequests.some(url => url.endsWith('/Thread.png')));
  assert.ok(imageRequests.some(url => url.endsWith('/ThreadLegacy.png')));
  checks.push('old CDN and future website-proxy artwork render through the protected game-image protocol without duplicated prefixes or local 404s');
  await capture('guest-browse');

  await until(() => evaluate('document.querySelectorAll(".account-area .desktop-account-action").length === 2'), 'guest account actions');
  for (const primary of [false, true]) {
    const before = calls.filter(call => call.action === 'settings').length;
    await evaluate(`document.querySelector(${JSON.stringify(primary ? '.account-area .desktop-account-action.primary' : '.account-area .desktop-account-action:not(.primary)')}).click()`);
    await until(() => calls.filter(call => call.action === 'settings').length === before + 1, 'top account action opens Overkot Connections');
    assert.equal(await evaluate('location.pathname'), '/');
  }
  for (const route of ['/login?other=1', '/signup', '/avakot-login']) {
    await win.loadURL(MARKET_ORIGIN + route);
    await until(() => evaluate('!!document.querySelector(".signin-card")'), 'Connections-only account route');
    assert.equal(await evaluate('!!document.querySelector("input[type=password], #market-email-form, .code")'), false);
    assert.match(await evaluate('document.querySelector(".signin-card").textContent'), /Open Overkot Connections/);
    const before = calls.filter(call => call.action === 'settings').length;
    await evaluate('document.querySelector(".signin-card button").click()');
    await until(() => calls.filter(call => call.action === 'settings').length === before + 1, 'fallback account action opens Overkot Connections');
  }
  checks.push('Login, Sign up and account fallback routes open Overkot Connections without any Market credential or device-code UI');

  connection = { ...connection, signedIn: true, account: { displayName: 'ConnectedFixture' } };
  state = { ...state, inventory: { available: true, rows: clone(inventoryRows), summary: { inventoryAvailable: true }, playerName: 'SmokeEnvoy' } };
  push();
  await until(() => evaluate('document.querySelector(".account-area .desktop-account-action")?.textContent.includes("ConnectedFixture")'), 'central connection status appears in Market');
  assert.equal(await evaluate('window.overkotMarket.getState().then(state => state.authenticated)'), false, 'Central avakot.dev connection alone is not a Market session');
  assert.equal(market.token, null);
  await evaluate(`document.querySelector(${JSON.stringify(inventoryLink)}).click()`);
  await until(() => evaluate('location.pathname === "/overkot-inventory" && !!document.querySelector("iframe.inventory")?.contentDocument?.querySelector(".inventory-list-item")'), 'inventory iframe and real composer renderer');
  const bladeCard = '.inventory-card[data-row-key="smoke-blade-row"]';
  await frameEvaluate(`document.querySelector('${bladeCard}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await until(() => frameEvaluate(`(() => {
    const card = document.querySelector('${bladeCard}');
    const thumbnail = card.querySelector('img.item-image');
    const temper = card.querySelector('summary .market-temper-icon img');
    return thumbnail?.src === ${JSON.stringify(blade.imageUrl)} && thumbnail.complete && thumbnail.naturalWidth > 0
      && temper?.src === ${JSON.stringify(blade.possibleTempers[0].icon)} && temper.complete && temper.naturalWidth > 0;
  })()`), 'Sell from inventory decodes the protected weapon thumbnail and temper icon');
  assert.equal(await frameEvaluate(`document.querySelectorAll('${bladeCard} summary .temper-icon-fallback').length`), 1);
  await evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  checks.push('Sell from inventory displays decoded protected item and temper artwork, with a placeholder for a temper without art');
  await capture('many-items-and-market-notice');
  assert.equal(await evaluate('document.querySelectorAll(".motd-banner").length'), 1, 'The shared shell renders one Market announcement');
  assert.equal(await frameEvaluate('document.defaultView.getComputedStyle(document.querySelector("#market-notice")).display'), 'none',
    'Embedded inventory does not repeat the legacy whole-page Market notice');
  await until(() => frameEvaluate('document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1'),
    'long inventory expands within the Market page without a second document scrollbar');
  assert.equal(await frameEvaluate('document.querySelector("#panel-inventory").scrollHeight <= document.querySelector("#panel-inventory").clientHeight + 1'), true,
    'Inventory panel does not introduce another scroll surface');
  const inventoryStyle = await inventoryPalette();
  assert.equal(inventoryStyle.actual, inventoryStyle.expected, 'Inventory cards use the shared Market theme');
  assert.equal(inventoryStyle.radius, '0px', 'Inventory uses the shared Market square corners');
  checks.push('long inventory uses the shared page scroll; shared Market announcement appears once without legacy page notice');
  assert.equal(await frameEvaluate('document.querySelector(".inventory-list-item").disabled'), true, 'A connected central account cannot publish without an authenticated Market session');
  assert.match(await frameEvaluate('document.querySelector("#inventory-gate").textContent'), /Connecting Market|Open Connections/);
  const beforeInventoryCta = calls.filter(call => call.action === 'settings').length;
  await frameEvaluate('document.querySelector("#inventory-gate button").click()');
  await until(() => calls.filter(call => call.action === 'settings').length === beforeInventoryCta + 1, 'inventory account CTA opens Overkot Connections');
  assert.equal(await frameEvaluate('document.querySelector("#account-dialog").open'), false);
  checks.push('central avakot.dev connection is visible; inventory opens, but publishing requires a real Market session; inventory CTA opens Overkot Connections');
  await capture('connected-without-market-session');

  market.generation++;
  market.token = 'inert-fixture-token';
  state = { ...state, authenticated: true, canTrade: true, user: clone(account) };
  push();
  await until(() => evaluate('document.querySelector(".account-name")?.textContent.includes("SmokeEnvoy")'), 'authenticated redesign account after confirmed Market session');
  await until(() => frameEvaluate('!document.querySelector(".inventory-list-item").disabled'), 'verified Market session enables inventory listing');
  await evaluate('document.querySelector(".logo-link").click()');
  await until(() => evaluate('location.pathname === "/" && !document.querySelector("iframe.inventory")'), 'leave inventory after sign-in');
  await evaluate(`document.querySelector(${JSON.stringify(inventoryLink)}).click()`);
  await until(() => evaluate('!!document.querySelector("iframe.inventory")?.contentDocument?.querySelector(".inventory-list-item")'), 'mount inventory after sign-in is already complete');
  await until(() => frameEvaluate('!document.querySelector(".inventory-list-item").disabled'), 'existing Market session reaches newly mounted inventory without a new state event');
  checks.push('opening and remounting inventory after sign-in retains the existing verified Market account');
  assert.match(await frameEvaluate('document.querySelector("#inventory-results").textContent'), /Smoke Moonsteel Thread/);
  assert.equal(await frameEvaluate('document.querySelector("#panel-inventory").hidden'), false);
  assert.equal(await evaluate('typeof document.querySelector("iframe.inventory").contentWindow.require'), 'undefined');
  checks.push('confirmed and verified Market session enables actual inventory composer through parent preload');
  await capture('connected-inventory');
  await evaluate('document.documentElement.dataset.theme = "light"');
  await until(async () => { const palette = await inventoryPalette(); return palette.actual === palette.expected && palette.actual !== inventoryStyle.actual; },
    'shared light theme updates inventory cards');
  await capture('light-inventory');
  await evaluate('document.documentElement.dataset.theme = "dark"');
  await until(async () => { const palette = await inventoryPalette(); return palette.actual === palette.expected && palette.actual === inventoryStyle.actual; },
    'shared dark theme updates inventory cards');
  win.setSize(960, 960);
  await until(() => frameEvaluate('document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1'),
    'default-width long inventory resizes without an inner document scrollbar');
  await capture('default-width-inventory');
  win.setSize(1280, 960);
  await until(() => frameEvaluate('document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1'), 'wide inventory resize settles');
  checks.push('inventory follows shared light/dark themes and resizes at the default 960-pixel window width');

  for (const width of [960, 1280]) {
    win.setSize(width, 960);
    await pause(100);
    const priorOverflow = await evaluate('document.documentElement.style.overflow');
    await frameEvaluate('(() => { const button = [...document.querySelectorAll(".inventory-list-item")].at(-1); button.scrollIntoView({ block: "center", behavior: "instant" }); return true; })()');
    await pause(100);
    await frameEvaluate('[...document.querySelectorAll(".inventory-list-item")].at(-1).click()');
    await until(() => frameEvaluate('document.querySelector("#composer-dialog").open'), 'composer opens from a lower inventory row');
    await pause(300);
    await capture(width === 1280 ? 'lower-row-composer' : 'lower-row-composer-960');
    const lowerDialogGeometry = await evaluate(`(() => {
      const frame = document.querySelector('iframe.inventory');
      const dialog = frame.contentDocument.querySelector('#composer-dialog').getBoundingClientRect();
      const frameTop = frame.getBoundingClientRect().top;
      const titlebarBottom = Math.max(document.querySelector('.desktop-titlebar').getBoundingClientRect().bottom,
        document.querySelector('.top-bar').getBoundingClientRect().bottom);
      return { top: frameTop + dialog.top, bottom: frameTop + dialog.bottom, frameTop,
        titlebarBottom, viewport: innerHeight, parentScroll: scrollY, childScroll: frame.contentWindow.scrollY,
        childDialogTop: dialog.top, configuredTop: frame.contentDocument.documentElement.style.getPropertyValue('--inventory-dialog-top') };
    })()`);
    calls.push({ action: 'lower-dialog-geometry', width, ...lowerDialogGeometry });
    assert.equal(lowerDialogGeometry.top >= lowerDialogGeometry.titlebarBottom && lowerDialogGeometry.bottom <= lowerDialogGeometry.viewport, true,
      'Lower-row composer remains within the visible Market viewport after native focus scrolling settles');
    await frameEvaluate('document.querySelector("#composer-dialog [data-close-dialog]").click()');
    await until(() => evaluate(`document.documentElement.style.overflow === ${JSON.stringify(priorOverflow)}`), 'closing composer restores Market page scrolling');
    await evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
    await pause(100);
  }
  checks.push('lower-row composer stays visible at default and wide widths and restores page scrolling after closing');

  await evaluate(`(() => { const frame = document.querySelector('iframe.inventory'); const field = frame.contentDocument.querySelector('#inventory-search'); field.value = 'Thread 79'; field.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true })); window.scrollTo({ top: 0, behavior: 'instant' }); })()`);
  await until(() => frameEvaluate('document.querySelectorAll(".inventory-list-item").length === 1'), 'filter inventory to a single item');
  await frameEvaluate('document.querySelector(".inventory-list-item").click()');
  await until(() => frameEvaluate('document.querySelector("#composer-dialog").open'), 'composer opens for a filtered item');
  await pause(300);
  const filteredComposer = await evaluate(`(() => {
    const frame = document.querySelector('iframe.inventory');
    const child = frame.contentDocument;
    const dialog = child.querySelector('#composer-dialog').getBoundingClientRect();
    const button = child.querySelector('#composer-submit');
    const submit = button.getBoundingClientRect();
    const rect = frame.getBoundingClientRect();
    const x = submit.left + submit.width / 2, y = submit.top + submit.height / 2;
    return { height: frame.clientHeight, dialogBottom: dialog.bottom, submitBottom: submit.bottom,
      clickable: document.elementFromPoint(rect.left + x, rect.top + y) === frame && child.elementFromPoint(x, y) === button };
  })()`);
  assert.ok(filteredComposer.dialogBottom <= filteredComposer.height + 1, 'Filtered inventory frame contains the entire composer instead of clipping its controls');
  assert.ok(filteredComposer.submitBottom <= filteredComposer.height + 1, 'Publish listing remains inside the clickable inventory frame');
  assert.equal(filteredComposer.clickable, true, 'Pointer hit testing reaches Publish listing from the Market window');
  await capture('filtered-inventory-composer');
  await frameEvaluate('document.querySelector("#composer-dialog [data-close-dialog]").click()');
  await evaluate(`(() => { const frame = document.querySelector('iframe.inventory'); const field = frame.contentDocument.querySelector('#inventory-search'); field.value = ''; field.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true })); })()`);
  checks.push('filtered inventory keeps the entire composer and Publish listing control inside the iframe');

  await frameEvaluate('document.querySelector(".inventory-list-item").click()');
  await until(() => frameEvaluate('document.querySelector("#composer-dialog").open'), 'inventory composer dialog');
  await evaluate(`(() => { const frame = document.querySelector('iframe.inventory'); const field = frame.contentDocument.querySelector('#composer-quantity'); field.value = '2'; field.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true })); })()`);
  assert.equal(await frameEvaluate('document.querySelector("#composer-submit").disabled'), false);
  await capture('inventory-composer');
  await frameEvaluate('document.querySelector("#composer-submit").click()');
  await until(() => calls.some(call => call.action === 'create'), 'fixture create call via real preload');
  await until(() => frameEvaluate('!document.querySelector("#composer-dialog").open'), 'composer confirmation');
  assert.equal(calls.filter(call => call.action === 'create').length, 1);
  checks.push('inventory composer publishes exactly once to fake createListing, with no live mutation');

  state = { ...state, authenticated: false, canTrade: false, user: null };
  market.token = null;
  push();
  await evaluate('document.querySelector(".logo-link").click()');
  await until(() => evaluate('!document.querySelector("iframe.inventory")'), 'leave inventory before pending initial state');
  let releaseInitialState;
  heldInitialState = { promise: new Promise(resolve => { releaseInitialState = resolve; }) };
  await evaluate(`document.querySelector(${JSON.stringify(inventoryLink)}).click()`);
  await until(() => calls.some(call => call.action === 'held-initial-state'), 'new inventory initial state reply is pending');
  assert.match(await frameEvaluate('document.querySelector("#inventory-gate").textContent'), /Loading your account/);
  assert.doesNotMatch(await frameEvaluate('document.querySelector("#inventory-gate").textContent'), /Sign in/,
    'A pending initial state never claims the connected account is signed out');
  market.token = 'inert-fixture-token';
  state = { ...state, authenticated: true, canTrade: true, user: clone(account) };
  push();
  await until(() => frameEvaluate('!!document.querySelector(".inventory-list-item") && !document.querySelector(".inventory-list-item").disabled'), 'new authenticated event reaches inventory while initial state is pending');
  releaseInitialState(); heldInitialState = null;
  await pause(100);
  assert.equal(await frameEvaluate('document.querySelector(".inventory-list-item").disabled'), false,
    'An older initial guest snapshot cannot overwrite the authenticated event');
  checks.push('pending initial state shows loading; a late initial guest snapshot cannot replace a newer authenticated event');

  state = { ...state, authenticated: false, canTrade: false, user: null };
  market.token = null;
  push();
  await until(() => frameEvaluate('document.querySelector(".inventory-list-item").disabled'), 'fixture signs out before delayed refresh');
  let releaseRefresh;
  heldRefresh = { promise: new Promise(resolve => { releaseRefresh = resolve; }) };
  await frameEvaluate('document.querySelector("#market-refresh").click()');
  await until(() => calls.some(call => call.action === 'held-refresh'), 'guest refresh is in flight');
  market.token = 'inert-fixture-token';
  state = { ...state, authenticated: true, canTrade: true, user: clone(account) };
  push();
  await until(() => frameEvaluate('!document.querySelector(".inventory-list-item").disabled'), 'new authenticated event arrives before old refresh response');
  releaseRefresh(); heldRefresh = null;
  await until(() => frameEvaluate('!document.querySelector("#market-refresh").disabled'), 'older guest refresh response returns');
  await capture('after-delayed-guest-refresh');
  assert.equal(await frameEvaluate('document.querySelector(".inventory-list-item").disabled'), false,
    'An older guest refresh must not overwrite the newly authenticated inventory state');
  assert.equal(await evaluate('window.overkotMarket.getState().then(value => value.authenticated)'), true);
  checks.push('delayed guest refresh response cannot overwrite a newer authenticated inventory event');

  await evaluate('document.querySelector(".account-trigger").click()');
  await until(() => evaluate('document.querySelector(".dropdown-signout")?.textContent.includes("Account connection")'), 'redesign central account connection menu');
  const beforeAccountMenu = calls.filter(call => call.action === 'settings').length;
  await evaluate('document.querySelector(".dropdown-signout").click()');
  await until(() => calls.filter(call => call.action === 'settings').length === beforeAccountMenu + 1, 'account menu opens Overkot Connections');
  assert.equal(calls.filter(call => call.action === 'logout').length, 0, 'Widget never signs out independently of its central account');
  assert.equal(state.authenticated, true);
  checks.push('authenticated account menu opens Overkot Connections instead of signing out separately');

  connection = { ...connection, signedIn: false, account: null };
  market.generation++; market.token = null;
  state = { ...state, authenticated: false, canTrade: false, user: null, listings: [] };
  push();
  await until(() => frameEvaluate('document.querySelector(".inventory-list-item").disabled && !document.querySelector("#inventory-gate").hidden'), 'central sign-out disables listing while retaining inventory access');
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(inventoryLink)}).length`), 1);
  assert.equal(await evaluate('!!document.querySelector("iframe.inventory")'), true);
  assert.match(await frameEvaluate('document.querySelector("#inventory-gate").textContent'), /Sign in/);
  checks.push('central account sign-out preserves inventory sidebar and items while removing permission to publish');
  await capture('signed-out-inventory');
  assert.deepEqual(errors, [], 'No renderer exceptions');
  assert.deepEqual(localFailures, [], 'Every local frontend/inventory asset loads');
  assert.deepEqual(unexpectedRoutes, [], 'All renderer API requests use explicit fixtures');
  assert.deepEqual(externalNavigations, [], 'No test opens an external browser');
  assert.equal(blockedRequests.some(url => /dap1x6lmnonv6|d2855gck1tg5bh/.test(url)), false, 'Game artwork never attempts a public CDN request');
  // External artwork/fonts may be requested by upstream, but every request was
  // synchronously cancelled by the isolated session before any network access.
  assert.equal(await evaluate('navigator.serviceWorker?.controller ?? null'), null);
  checks.push('all external requests blocked; no website service worker installed');
  finish();
}).catch(finish);
