// npm run pack, then node scripts/check-packaged-content.js
// Add --live-wiki to check the public wiki instead of the offline fixture.
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 50000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const electron = require('electron');
const { app, BrowserWindow, session, protocol, ipcMain } = electron;
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const out = path.join(root, 'output', 'packaged-content-' + Date.now());
const liveWiki = process.argv.includes('--live-wiki');
fs.mkdirSync(out, { recursive: true });
const wikiWebsite = require('./wiki-test-profile').configureWikiTestProfile(out, liveWiki);
app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'overkot-map-tiles', privileges: {
  standard: true, secure: true, supportFetchAPI: true,
} }]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fn()) return;
    await pause(50);
  }
  throw new Error('Timed out: ' + message);
}
async function capture(win, name) {
  win.webContents.invalidate();
  await pause(150);
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

// Exercise the released renderer against the normal verified cache. All tiles
// are generated here and the transport never opens a network connection.
async function createFixtureMap() {
  const renderer = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let images;
  try {
    await renderer.loadURL('about:blank');
    images = await renderer.webContents.executeJavaScript(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 512;
      const ctx = canvas.getContext('2d');
      return Array.from({ length: 196 }, (_, index) => {
        ctx.fillStyle = 'hsl(' + (index * 37 % 360) + ', 55%, 42%)';
        ctx.fillRect(0, 0, 512, 512);
        return canvas.toDataURL('image/webp').split(',')[1];
      });
    })()`);
  } finally { renderer.destroy(); }

  const digest = data => createHash('sha256').update(data).digest('hex');
  const manifestUrl = 'https://tiles.invalid/fixture/manifest.json';
  const responses = new Map();
  const files = {};
  for (const [index, image] of images.entries()) {
    const bytes = Buffer.from(image, 'base64');
    const sha256 = digest(bytes), url = `objects/${sha256}.webp`;
    files[`map-tiles/${index}.webp`] = { sha256, bytes: bytes.length, downloadBytes: bytes.length, encoding: 'identity', url };
    responses.set(new URL(url, manifestUrl).href, bytes);
  }
  responses.set(manifestUrl, { schema: 2, version: digest(JSON.stringify(files)), files });
  const { DataUpdateManager } = require('../src/modules/dataUpdates');
  const dataManager = new DataUpdateManager({ rootDir: path.join(out, 'game-data'), bundledRoot: path.join(archive, 'assets'),
    manifestUrl, http: { get: async url => {
      assert.ok(responses.has(url), 'Unexpected fixture request: ' + url);
      return { status: 200, data: responses.get(url), headers: {} };
    } },
  });
  await dataManager.initialize();
  await dataManager.checkForUpdates();
  const { MapTileManager } = require('../src/modules/mapTiles');
  const tiles = new MapTileManager({ app, dataManager });
  assert.equal((await tiles.initialize()).source, 'remote');
  return tiles;
}

app.whenReady().then(async () => {
  assert.ok(fs.existsSync(archive), 'Build the unpacked app before this check');
  // Run the same document restriction handler used in production, against
  // the actual ASAR paths. Earlier renderer checks omitted this packaged rule.
  const { createHeadersHandler } = require('../src/modules/guard');
  session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const tiles = await createFixtureMap();
  assert.ok(!fs.existsSync(path.join(archive, 'assets/map-tiles/0.webp')), 'Map imagery belongs in the data cache');
  protocol.registerFileProtocol('overkot-map-tiles', (request, callback) => {
    const url = new URL(request.url);
    if (url.hostname !== 'tile') return callback({ error: -6 });
    tiles.getTilePath(url.pathname.slice(1)).then(file => callback(file ? { path: file } : { error: -6 }),
      () => callback({ error: -6 }));
  });
  const translations = { en: JSON.parse(fs.readFileSync(path.join(archive, 'langs/en.json'), 'utf8')) };
  ipcMain.on('get-i18n', event => { event.returnValue = { translations, languages: [] }; });
  ipcMain.handle('get-state', () => ({ config: { language: 'en' }, timers: [], namesMap: {} }));
  ipcMain.handle('get-map-tiles', () => tiles.getInfo());
  ipcMain.handle('dungeon:map', () => ({ mode: 'inactive', state: { active: false }, rooms: [] }));
  ipcMain.handle('dungeon:state', () => ({ active: false }));
  ipcMain.handle('get-map-data', (_event, name) => name === 'world_trees'
    ? { positions: [{ position: { x: 0, z: 0 } }] } : {});
  ipcMain.handle('get-ancestors', () => [{
    id: 'check-bromius', ancestorName: 'Bromius', x: 248.954, z: -391.512, startedAt: 1,
  }]);
  ipcMain.handle('get-player-location', () => null);
  ipcMain.handle('resolve-location-names', () => ({}));
  ipcMain.handle('save-config', () => true);

  const maps = [];
  for (const mini of [true, false]) {
    const win = new BrowserWindow({ show: false, width: 650, height: 650, webPreferences: {
      preload: path.join(archive, 'src/preload.js'), contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    await win.loadFile(path.join(archive, 'src/renderer', mini ? 'widget-host.html' : 'map-window.html'), mini ? { query: { widget: 'minimap' } } : {});
    const render = mini ? 'Minimap.render()' : 'render()';
    await until(() => win.webContents.executeJavaScript(mini ? 'typeof Minimap !== "undefined" && Minimap.inited' : 'mapPOIsLoaded'), 'packaged map initialization');
    await win.webContents.executeJavaScript(`(() => {
      const ctx = document.getElementById('${mini ? 'minimap-canvas' : 'map-canvas'}').getContext('2d');
      const draw = ctx.drawImage;
      ctx.drawImage = function(image, ...args) {
        if (image.tagName === 'IMG' && image.naturalWidth === 512 && image.src.startsWith('overkot-map-tiles://tile/')) {
          window.__tilesDrawn.add(new URL(image.src).pathname);
        }
        return draw.call(this, image, ...args);
      };
      window.__tilesDrawn = new Set();
      window.__countTiles = () => { window.__tilesDrawn.clear(); ${render}; return window.__tilesDrawn.size; };
      ${mini ? 'Minimap.fitToView()' : 'fitToView()'};
    })()`);
    await until(() => win.webContents.executeJavaScript('__countTiles() === 196'), 'all 196 cached tiles drawn by the packaged renderer');
    // Check the custom scheme explicitly: a bundled file fallback could hide
    // a protocol CSP regression while making a screenshot look healthy.
    const probe = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const image = new Image(); image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
      image.onerror = () => resolve([]); image.src = 'overkot-map-tiles://tile/0.webp';
    })`);
    assert.deepEqual(probe, [512, 512]);
    await capture(win, mini ? 'minimap' : 'expanded-map');
    await win.webContents.executeJavaScript(`(() => {
      const canvas = document.getElementById('${mini ? 'minimap-canvas' : 'map-canvas'}');
      const ctx = canvas.getContext('2d');
      const radial = ctx.createRadialGradient;
      ctx.createRadialGradient = function(...args) {
        window.__searchGradients.push(args);
        return radial.apply(this, args);
      };
      window.__searchGradients = [];
      window.__searchGeometry = () => { window.__searchGradients = []; ${render}; return window.__searchGradients; };
      window.__zoomToAncestor = value => {
        ${mini ? 'Minimap.animateTo(4081.908, 4367.024, value, 1)' : 'zoom = value; panX = canvas.width / 2 - 4081.908 * zoom; panY = canvas.height / 2 - 4367.024 * zoom; render()'};
      };
    })()`);
    for (const scale of [0.5, 1]) {
      await win.webContents.executeJavaScript(`__zoomToAncestor(${scale})`);
      await until(() => win.webContents.executeJavaScript(`(() => {
        const areas = __searchGeometry();
        return areas.length === 1 && Math.abs(areas[0][5] - ${100 * scale}) < 0.01;
      })()`), 'packaged ancestor search radius follows world zoom');
    }
    await capture(win, mini ? 'minimap-ancestor-area' : 'expanded-map-ancestor-area');
    maps.push({ view: mini ? 'minimap' : 'expanded-map', tilesDrawn: 196, customScheme: 'decoded', ancestorRadiusWorld: 50 });
    win.destroy();
  }

  const { storageScope } = require('../src/modules/serviceConfig').services;
  const wikiSession = session.fromPartition(`persist:wiki-${storageScope}`);
  if (!liveWiki) {
    wikiSession.protocol.handle('https', request => {
      if (request.url.includes('/failing-frame')) return Response.error();
      return new Response('<!doctype html><title>Wiki fixture</title><style>body{background:#18231c;color:#fff;font:24px sans-serif;padding:40px}</style><h1>Orlick</h1><p id="status">Loading</p><script>document.getElementById("status").textContent="Wiki scripts loaded"</script><iframe src="/failing-frame"></iframe>', { headers: { 'Content-Type': 'text/html' } });
    });
  }
  // Keep verification hidden; all navigation/session logic is the real module.
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron' && parent.filename === path.join(root, 'src/modules/wikiWindow.js')) {
      return { ...electron, BrowserWindow: class extends BrowserWindow {
        constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } }); }
        show() {}
        focus() {}
      } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const { createWikiBrowser, loadWikiSearch, getWikiWebContents } = require('../src/modules/wikiWindow');
  Module._load = originalLoad;
  const wiki = createWikiBrowser({ bounds: { width: 900, height: 700 }, icon: '' });
  const article = getWikiWebContents(wiki);
  loadWikiSearch(wiki, 'Orlick');
  await until(() => article.executeJavaScript(liveWiki
    ? 'document.body && document.body.innerText.includes("Orlick the Bicameral")'
    : 'document.body && document.body.innerText.includes("Wiki scripts loaded")'), 'wiki article content');
  await pause(1000);
  const page = await article.executeJavaScript('({ url: location.href, title: document.title, textLength: document.body.innerText.length })');
  assert.ok(page.url.startsWith(wikiWebsite + '/'), 'An iframe failure must not replace the wiki with a data error page');
  await capture(wiki, 'wiki');
  wiki.destroy();
  const result = { ok: true, archive, maps, wiki: { ...page, live: liveWiki }, output: out };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
setTimeout(() => app.exit(2), 45000).unref();
