'use strict';
process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { MANIFEST_URL } = require('../src/modules/gameDataAccess');

test('signing in during a startup check queues an authorized refresh after auth backoff is set', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const access = new EventEmitter(), checks = [], tileNotifications = [], artworkNotifications = [];
  let finishStartup, signedIn = false, titleRefreshes = 0, imageWarmups = 0;
  const startup = new Promise(resolve => { finishStartup = resolve; });
  let finishImages;
  const images = new Promise(resolve => { finishImages = resolve; });
  let finishCatalogues;
  const catalogues = new Promise(resolve => { finishCatalogues = resolve; });
  const context = vm.createContext({
    normalizeLocale: require('../src/modules/gameLocales').normalizeLocale,
    MANIFEST_URL, gameDataAccess: access, app: { isReady: () => true },
    avakotAccount: { snapshot: () => ({ signedIn }) },
    TITLE_TRACKER_ENABLED: false, COLLECTION_WIDGET_IDS: [], POI_FILES: [], mapWindow: null,
    config: { get: (key, fallback) => key === 'widgetVisibility' ? {} : fallback },
    dataManager: { manifestUrl: MANIFEST_URL,
      checkForUpdates: async options => { checks.push(options); return checks.length === 1 ? startup : { updated: false }; },
      refreshCachedAssets: () => catalogues, ensureAsset: async () => {},
      readJSON: () => ({}), getInfo: () => ({}),
    },
    refreshTitleData: async () => { titleRefreshes++; }, setTimerDurations() {},
    mapTileManager: { warmCache: () => { imageWarmups++; return images; }, getInfo: () => ({ version: 'new-images' }) },
    services: { accountApi: 'https://issuer.test', accountPortal: 'https://account.test', dataOrigin: 'https://data.test' }, widgetsWindow: null,
    applicationFrames: () => [{ send: (...args) => artworkNotifications.push(args) }],
    ensureNamesForLanguage: async () => ({}), pushStateToRenderer() {},
    broadcastMapTilesUpdated(info) { tileNotifications.push(info); }, log() {},
  });
  vm.runInContext('let dataRefreshPromise = null; let namesMap = {};', context);
  vm.runInContext(main.slice(main.indexOf('function mapTilesRequireSignIn('), main.indexOf('function broadcastMapTilesUpdated(')), context);
  vm.runInContext(main.slice(main.indexOf('function refreshGameData('), main.indexOf('function startMapTileUpdateCheck(')), context);
  vm.runInContext(main.slice(main.indexOf("gameDataAccess.on('changed'"), main.indexOf('const dungeonMap =')), context);
  const first = vm.runInContext('refreshGameData()', context);
  assert.equal(checks.length, 1);
  assert.equal(vm.runInContext('mapTilesRequireSignIn()', context), true);
  signedIn = true; access.emit('changed', { signedIn: true });
  assert.deepEqual(artworkNotifications, [['game-artwork-available']], 'open widgets can retry images before any manifest check finishes');
  assert.equal(vm.runInContext('mapTilesRequireSignIn()', context), false);
  assert.equal(checks.length, 1, 'the authorized refresh waits for the current check');
  finishStartup({ updated: false, error: 'Sign in required; retry later' });
  await first; await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks.length, 2, 'a completed unauthorized check cannot swallow sign-in refresh');
  assert.equal(checks[1].force, true, 'the authorized refresh bypasses the startup retry interval');
  assert.equal(tileNotifications.length, 1, 'the map retries before unrelated catalogue downloads complete');
  assert.equal(tileNotifications[0].reload, true);
  finishCatalogues({ failed: [], updated: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(titleRefreshes, 1);
  assert.equal(imageWarmups, 1, 'sign-in starts the shared image cache before the next periodic check');
  const concurrent = vm.runInContext('warmMapTiles()', context);
  assert.equal(imageWarmups, 1);
  assert.equal(tileNotifications.filter(info => info.version === 'new-images').length, 0);
  finishImages({ updated: true });
  await concurrent;
  const imageNotifications = tileNotifications.filter(info => info.version === 'new-images');
  assert.equal(imageNotifications.length, 1, 'open maps reload once when the new images have reached disk');
  assert.equal(imageNotifications[0].reload, true);
});
