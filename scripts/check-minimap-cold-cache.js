// node scripts/check-minimap-cold-cache.js [--source]
// Source main process + real IPC and protected data client. By default the
// selected Windows package supplies Electron, the preload and the renderer.
if (process.platform !== 'win32') {
  console.error('This check requires a packaged Windows runtime and an isolated LOCALAPPDATA profile.');
  process.exit(1);
}
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 45000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, globalShortcut, session } = require('electron');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { brotliCompressSync } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { tile, marker } = require('../test/fixtures/map-assets');
const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(root, 'output', 'minimap-cold-cache-'));
const unpacked = process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist', 'win-unpacked');
const appRoot = process.argv.includes('--source') ? root : path.resolve(unpacked, 'resources', 'app.asar');
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith('OVERKOT_')) delete process.env[key];
}
process.env.LOCALAPPDATA = out;
process.env.APPDATA = out;
app.setPath('userData', path.join(out, 'profile'));
const dataOrigin = 'https://minimap-fixture.invalid';
const manifestUrl = dataOrigin + '/protected/overlay/v2/manifest.json';
process.env.OVERKOT_SERVICES_FILE = path.join(out, 'fixture-services.json');
fs.writeFileSync(process.env.OVERKOT_SERVICES_FILE, JSON.stringify({
  dataOrigin, accountApi: 'https://account-api.invalid', accountPortal: 'https://account.invalid',
}));
for (const operation of ['register', 'unregister', 'unregisterAll']) globalShortcut[operation] = () => true;

const grant = 'synthetic.map.fixture';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const responses = new Map();
const artworkRequests = new Set();
const itemArtwork = {
  'collection-log': '/SF/Interface/Graphics/Fixture/Collection.png',
  cosmetics: '/SF/Interface/Graphics/Fixture/Cosmetic.png',
};
let account, manifest, timersUrl;
let timersWaiting = false, manifestRequests = 0, tileRequests = 0;
const timersGate = Promise.withResolvers();
const offline = async () => { throw new Error('Network disabled in cold-cache fixture'); };
globalThis.fetch = offline;
const transport = { get: async (url, options) => {
  const item = Object.values(itemArtwork).find(path => dataOrigin + '/protected/images' + path === url);
  if (!item && url !== manifestUrl && !responses.has(url)) return offline();
  assert.equal(options.headers.Authorization, 'Bearer ' + grant, 'Every feed request requires the fixture grant');
  if (item) {
    artworkRequests.add(item);
    return { status: 200, data: marker, headers: { 'content-type': 'image/png' } };
  }
  if (url === manifestUrl) {
    manifestRequests++;
    return { status: 200, data: manifest, headers: {} };
  }
  if (url === timersUrl) {
    timersWaiting = true;
    await timersGate.promise;
  } else tileRequests++;
  return { status: 200, data: responses.get(url), headers: {} };
}, create: () => ({ get: offline, post: offline }) };

const original = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'axios') return transport;
  const actual = original.call(this, request, parent, isMain);
  if (request === './modules/platformSupport') return { ...actual, getPlatformSupport: () => ({ ...actual.getPlatformSupport(), gameConnection: false }) };
  if (request === './modules/avakotAccount') return { ...actual, AvakotAccountService: class extends actual.AvakotAccountService {
    constructor(options) { super(options); account = this; }
    async request(route) {
      assert.equal(route, 'data-authorization');
      return { tokenType: 'Bearer', accessToken: grant, scope: 'overlay:read', expiresAt: new Date(Date.now() + 300000).toISOString(), expiresIn: 300 };
    }
  } };
  return actual;
};

async function until(check, message) {
  const deadline = Date.now() + 10000;
  do {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + message);
}

async function openWidget(renderer, widget) {
  const win = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: {
    preload: path.join(appRoot, 'src', 'preload.js'), sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false,
  } });
  await win.loadFile(path.join(renderer, 'widget-host.html'), { query: { widget } });
  return win;
}

async function openSignedOutCollection(renderer, id, icon) {
  const win = await openWidget(renderer, id);
  const contents = win.webContents;
  await until(() => contents.executeJavaScript("!!document.querySelector('.inventory-widget-status[data-status=connect]')"), id + ' ready');
  // Simulate a saved inventory arriving over the normal widget channel. The
  // account and image requests still go through the real protected protocol.
  const category = id === 'cosmetics' ? 'Cosmetic' : 'Weapon';
  contents.send('inventory-widget-changed', id, { status: 'cached',
    summary: { [category]: { owned: 1, total: 1, unknown: 0 } },
    rows: [{ id, itemType: id, category, name: 'Fixture item', copies: [{}], owned: true, icon }],
  });
  await until(() => contents.executeJavaScript(`(() => {
    const img = document.querySelector('.collection-image img');
    if (img) img.loading = 'eager';
    return img?.parentElement.classList.contains('is-missing') && img.naturalWidth === 0;
  })()`), id + ' displays its signed-out image fallback');
  return contents;
}

async function run() {
  const files = {};
  function add(key, bytes) {
    const json = key.endsWith('.json');
    const wire = json ? brotliCompressSync(bytes) : bytes;
    const url = 'objects/' + digest(wire) + (json ? '.json.br' : '.webp');
    files[key] = { sha256: digest(bytes), bytes: bytes.length, downloadBytes: wire.length, encoding: json ? 'br' : 'identity', url };
    const fullUrl = new URL(url, manifestUrl).href;
    responses.set(fullUrl, wire);
    return fullUrl;
  }
  // Distinct RIFF padding chunks give each fixture tile its own content hash.
  // The cache must fetch all four visible images instead of reusing one blob.
  for (let index = 0; index < 196; index++) {
    const bytes = Buffer.concat([tile, Buffer.alloc(12)]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('JUNK', tile.length);
    bytes.writeUInt32LE(4, tile.length + 4);
    bytes.writeUInt32LE(index, tile.length + 8);
    add('map-tiles/' + index + '.webp', bytes);
  }
  timersUrl = add('timers/durations.json', Buffer.from('{}'));
  manifest = { schema: 2, version: digest(JSON.stringify(files)), files };

  const { ConfigStore } = require('../src/modules/config');
  const config = new ConfigStore();
  config.setMany({ startupLayoutChoice: 'custom', hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
    widgetVisibility: {}, layoutMode: 'free', launchToTray: false });
  require('../src/main');
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
  const renderer = path.join(appRoot, 'src', 'renderer');
  session.defaultSession.webRequest.onHeadersReceived(require('../src/modules/guard').createHeadersHandler(renderer));
  await until(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().endsWith('/index.html')), 'app startup');
  const mini = await openWidget(renderer, 'minimap');
  const execute = code => mini.webContents.executeJavaScript(code);
  await until(() => execute("typeof Minimap !== 'undefined' && Minimap.inited"), 'Mini-Map startup');
  const dimensions = await execute(`new Promise(resolve => {
    const img = new Image();
    img.onload = img.onerror = () => resolve([img.naturalWidth, img.naturalHeight]);
    img.src = 'overkot-map-tiles://tile/90.webp';
  })`);
  assert.deepEqual(dimensions, [0, 0], 'A signed-out cold profile has no tile to decode');
  assert.equal(manifestRequests, 0);
  await until(() => execute(`(() => {
    const status = document.querySelector('#minimap-loading');
    return !status.classList.contains('loaded') && status.textContent.includes('avakot.dev')
      && document.querySelector('#minimap-connect')?.getClientRects().length > 0;
  })()`), 'visible Mini-Map sign-in button');
  const findWindow = name => BrowserWindow.getAllWindows().find(win => {
    const url = win.webContents.getURL();
    return url && new URL(url).pathname.endsWith('/' + name + '.html');
  });
  const onConnections = `document.querySelector('#tab-connections')?.getAttribute('aria-selected') === 'true'
    && document.querySelector('#btn-avakot-account-login')?.getClientRects().length > 0`;
  const center = await execute(`(() => {
    const rect = document.querySelector('#minimap-viewport').getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    return { x, y, target: document.elementFromPoint(x, y)?.id };
  })()`);
  assert.equal(center.target, 'minimap-connect', 'The signed-out button receives pointer input at the center of the map');
  for (const type of ['mouseDown', 'mouseUp']) {
    mini.webContents.sendInputEvent({ type, button: 'left', x: center.x, y: center.y, clickCount: 1 });
  }
  const settings = await until(() => findWindow('settings'), 'Settings to open from Mini-Map');
  await until(() => settings.webContents.executeJavaScript(onConnections), 'account sign-in in Settings');
  await settings.webContents.executeJavaScript("document.querySelector('#tab-overlay').click()");
  await execute('window.api.openWidgets()');
  const picker = await until(() => findWindow('widgets-window'), 'Widgets menu');
  const cardButton = "document.querySelector('[data-widget=\"minimap\"] .widget-card-connect')";
  await until(() => picker.webContents.executeJavaScript(cardButton + '?.getClientRects().length > 0'), 'Mini-Map card sign-in button');
  const selection = "document.querySelector('#widget-toggle-minimap').checked";
  const selected = await picker.webContents.executeJavaScript(selection);
  await picker.webContents.executeJavaScript(cardButton + '.click()');
  await until(() => settings.webContents.executeJavaScript(onConnections), 'widget card to reopen the Connections tab');
  assert.equal(await picker.webContents.executeJavaScript(selection), selected, 'Sign-in leaves widget selection intact');
  const collections = [];
  for (const [id, icon] of Object.entries(itemArtwork)) {
    const button = `document.querySelector('.widget-card[data-widget="${id}"] .widget-card-connect')`;
    await until(() => picker.webContents.executeJavaScript(button + '?.getClientRects().length > 0'), id + ' connection button');
    await settings.webContents.executeJavaScript("document.querySelector('#tab-overlay').click()");
    await picker.webContents.executeJavaScript(button + '.click()');
    await until(() => settings.webContents.executeJavaScript(onConnections), id + ' opens Connections');
    collections.push({ id, contents: await openSignedOutCollection(renderer, id, icon), button });
  }
  assert.equal(artworkRequests.size, 0, 'A signed-out widget never downloads protected images');
  await execute(`(() => {
    const ctx = document.querySelector('#minimap-canvas').getContext('2d');
    const draw = ctx.drawImage;
    window.paintedTiles = new Set();
    ctx.drawImage = function(image, ...args) {
      const result = draw.call(this, image, ...args);
      if (image instanceof HTMLImageElement && image.naturalWidth === 512 && image.naturalHeight === 512
          && image.src.startsWith('overkot-map-tiles://tile/')) paintedTiles.add(new URL(image.src).pathname);
      return result;
    };
  })()`);
  account.token = 'synthetic-account-session';
  account.account = { displayName: 'Fixture' };
  account.publish();
  await until(() => timersWaiting, 'foreground catalogue refresh to request timer durations');
  const painted = await until(async () => {
    const paths = await execute('[...paintedTiles].sort()');
    return paths.length >= 4 && paths;
  }, 'open Mini-Map to draw its four central tiles while timer data is blocked');
  for (const id of [90, 91, 104, 105]) assert.ok(painted.includes('/' + id + '.webp'), 'Missing central tile ' + id);
  assert.ok(manifestRequests > 0 && tileRequests >= 4 && tileRequests < 196,
    'The protected feed supplied the viewport before background download finished');
  assert.equal(await execute("document.querySelector('#minimap-loading').classList.contains('loaded')"), true,
    'The visible sign-in notice clears when the viewport is painted');
  assert.equal(await execute("document.querySelector('#minimap-connect').hidden"), true);
  await until(() => picker.webContents.executeJavaScript(cardButton + '.hidden'), 'widget card sign-in button to clear');
  for (const { id, contents, button } of collections) {
    await until(() => contents.executeJavaScript(`(() => {
      const img = document.querySelector('.collection-image img');
      return img?.naturalWidth === 8 && img.naturalHeight === 8 && !img.hidden && img.parentElement.classList.contains('is-loaded');
    })()`), id + ' decodes its missing image after sign-in');
    assert.equal(await picker.webContents.executeJavaScript(button + '.hidden'), true);
  }
  assert.deepEqual([...artworkRequests].sort(), Object.values(itemArtwork).sort());
  timersGate.resolve();
  console.log(JSON.stringify({ ok: true, main: 'source', rendererRoot: renderer, painted, manifestRequests, tileRequests,
    recoveredArtwork: collections.map(widget => widget.id) }));
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
