'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MapTileManager } = require('../src/modules/mapTiles');
const { widgetConnections } = require('../src/modules/widgetConnections');
const temperIcon = `temper-icons/${'a'.repeat(64)}.png`;
const itemArtwork = {
  'collection-log': 'artwork', cosmetics: 'artwork', 'mastery-tracker': 'artwork', resources: 'artwork',
  enhancements: 'artwork', 'crafting-planner': 'artwork', activity: 'artwork', 'crafting-log': 'artwork',
  player: 'artwork', daily: 'artwork',
};

function fixture() {
  const services = {
    accountApi: 'https://account-api.example', accountPortal: 'https://account.example',
    dataOrigin: 'https://data.example', marketApi: 'https://market.example/api', buildWebsite: 'https://build.example',
  };
  const cache = new Set(), reads = [];
  const dataManager = {
    manifestUrl: `${services.dataOrigin}/protected/overlay/v2/manifest.json`,
    state: { files: {} }, manifest: null,
    cachedPath(key) { reads.push(key); return cache.has(key) ? key : null; },
    readJSON(key) {
      return this.cachedPath(key) ? { schema: 1, tempers: [{ id: '/SF/Language/Upgrades/AspectATestName',
        name: 'A', description: '', origin: '', icon: temperIcon }], weapons: {}, aliases: {}, weaponAliases: {} } : null;
    },
  };
  const mapTileManager = new MapTileManager({ dataManager });
  return { services, dataManager, mapTileManager, cache, reads,
    actions: (overrides = {}) => widgetConnections({ signedIn: false, services, dataManager, mapTileManager, language: 'en', ...overrides }) };
}

test('fresh protected profiles offer Connections only for account-backed widget features', () => {
  const f = fixture();
  assert.deepEqual(f.actions(), { ...itemArtwork, market: 'market', minimap: 'account', 'temper-tracker': 'account', 'build-exporter': 'account' });
  f.services.buildWebsite = '';
  f.services.marketApi = '';
  assert.deepEqual(f.actions(), { ...itemArtwork, minimap: 'account', 'temper-tracker': 'account' });
  f.services.accountPortal = '';
  assert.deepEqual(f.actions(), {});
});

test('independent item-image and catalogue services drive only their own prompts', () => {
  const f = fixture();
  f.dataManager.manifestUrl = 'https://public.example/manifest.json';
  assert.deepEqual(f.actions(), { ...itemArtwork, market: 'market' });
  assert.equal(f.reads.length, 0);
  f.services.marketPublicApi = 'https://public-market.example';
  f.services.marketApi = '';
  assert.deepEqual(f.actions(), { ...itemArtwork, market: 'artwork' });
  f.services.imageBase = 'https://public-images.example';
  assert.deepEqual(f.actions(), {});
  f.services.marketApi = 'https://market.example';
  assert.deepEqual(f.actions(), { market: 'market' });
  f.services.imageBase = '';
  f.services.dataOrigin = '';
  assert.deepEqual(f.actions(), { market: 'market' });
  f.services.accountApi = '';
  assert.deepEqual(f.actions(), {});
});

test('after sign-in, only an explicit Market consent or link request needs Connections', () => {
  const f = fixture();
  for (const marketConnection of [{ connected: true }, { busy: true }, { error: 'Retrying' }]) {
    assert.deepEqual(f.actions({ signedIn: true, marketConnection }), {});
  }
  for (const marketConnection of [{ requiresLink: true }, { requiresReconnect: true }]) {
    assert.deepEqual(f.actions({ signedIn: true, marketConnection }), { market: 'market' });
  }
  assert.equal(f.reads.length, 0);
});

test('offline assets suppress their own actions using the same locale selection as the widget', () => {
  const f = fixture();
  const center = 'map-tiles/90.webp';
  f.cache.add('build-export/catalog.json');
  f.cache.add('tempers/en.json');
  f.cache.add(center);
  for (let n = 0; n < 196; n++) f.dataManager.state.files[`map-tiles/${n}.webp`] = {};
  f.dataManager.manifest = { files: { 'tempers/en.json': {} } };
  assert.deepEqual(f.actions({ language: 'uk' }), { ...itemArtwork, market: 'market', 'temper-tracker': 'artwork' });
  assert.deepEqual(f.reads.filter(key => key.startsWith('map-tiles/')), [center]);
  f.cache.add(temperIcon);
  assert.deepEqual(f.actions({ language: 'uk' }), { ...itemArtwork, market: 'market' });
  f.dataManager.manifest.files['tempers/de.json'] = {};
  assert.deepEqual(f.actions({ language: 'de' }), { ...itemArtwork, market: 'market', 'temper-tracker': 'account' });
  f.cache.add('tempers/de.json');
  f.cache.delete(center);
  assert.deepEqual(f.actions({ language: 'de' }), { ...itemArtwork, market: 'market', minimap: 'account' });
});

test('public item images leave only missing protected marker and temper icons eligible', () => {
  const f = fixture();
  f.services.imageBase = 'https://public-images.example';
  f.services.vendorCatalog = 'https://vendors.example';
  f.services.marketApi = '';
  f.services.marketPublicApi = 'https://read-only-market.example';
  f.cache.add('build-export/catalog.json');
  f.cache.add('tempers/en.json');
  const center = 'map-tiles/90.webp', marker = 'map-icons/Vendor.png';
  f.dataManager.state.files[center] = {};
  f.cache.add(center);
  f.dataManager.manifest = { files: { 'tempers/en.json': {}, [marker]: {}, [temperIcon]: {} } };
  assert.deepEqual(f.actions(), { market: 'artwork', minimap: 'artwork', daily: 'artwork', 'temper-tracker': 'artwork' });
  f.cache.add(marker);
  f.cache.add(temperIcon);
  assert.deepEqual(f.actions(), {});
});

test('only a usable legacy terrain file suppresses the map action, matching the tile loader', t => {
  const f = fixture();
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-widget-map-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(cache)), path.resolve(os.tmpdir()));
    fs.rmSync(cache, { recursive: true, force: true });
  });
  f.mapTileManager.legacyDir = path.join(cache, 'missing');
  assert.equal(f.actions().minimap, 'account');
  f.mapTileManager.legacyDir = cache;
  fs.mkdirSync(path.join(cache, '0.webp'));
  fs.writeFileSync(path.join(cache, '196.webp'), 'unrelated');
  assert.equal(f.actions().minimap, 'account');
  fs.writeFileSync(path.join(cache, '92.webp'), 'legacy fixture');
  assert.equal(f.actions().minimap, undefined);
  f.dataManager.manifest = { files: {} };
  assert.equal(f.actions().minimap, 'account');
});
