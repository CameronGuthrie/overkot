'use strict';

process.env.OVERKOT_SERVICES_FILE = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readServiceConfig } = require('../src/modules/serviceConfig');

test('local official source runs and packaging share the configured service profile', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-local-services-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, '.env.local');
  fs.copyFileSync(path.resolve(__dirname, '../config/official-services.json'), path.join(directory, 'services.json'));
  fs.writeFileSync(envFile, 'OVERKOT_SERVICES_FILE=services.json\n');
  const configured = readServiceConfig({}, { envFile });
  assert.ok(configured.accountApi && configured.releases && configured.groupFirebase);
  assert.equal(readServiceConfig({ OVERKOT_SERVICES_FILE: '' }, { envFile }).accountApi, '');
  assert.equal(readServiceConfig({}).accountApi, '');
  assert.equal(readServiceConfig({}, { envFile: path.join(directory, 'missing.env') }).accountApi, '');
});

test('community packages and their service entry points stay offline by default', async t => {
  const settings = readServiceConfig({});
  for (const key of ['releases', 'marketApi', 'marketPublicApi', 'marketWebsite', 'accountApi', 'accountPortal', 'dataOrigin',
    'dataManifest', 'calendarManifest', 'epithets', 'vendorCatalog']) assert.equal(settings[key], '');
  assert.equal(settings.groupFirebase, null);
  assert.equal(settings.usageFirebase, null);
  assert.equal(settings.imageBase, undefined);
  assert.equal(settings.wikiWebsite, undefined);
  assert.equal(settings.buildWebsite, undefined);
  let attempts = 0;
  const unavailable = () => { attempts++; throw new Error('Unexpected service call'); };
  const { Updater } = require('../src/modules/updater');
  const updater = new Updater({ supported: true, backend: { on: unavailable }, fetch: unavailable });
  assert.equal((await updater.check()).phase, 'unsupported');
  assert.equal(updater.snapshot().installerAvailable, false);
  const { AvakotAccountService } = require('../src/modules/avakotAccount');
  const account = new AvakotAccountService({ tokenStore: { load: unavailable }, openExternal: unavailable, fetchImpl: unavailable });
  await account.initialize();
  assert.equal((await account.signIn()).ok, false);
  assert.equal((await account.openAccount()).ok, false);
  const { MarketService } = require('../src/modules/marketService');
  const market = new MarketService({ fetchImpl: unavailable, openExternal: unavailable });
  await assert.rejects(market.request('catalogue/feed'), { code: 'NOT_CONFIGURED' });
  assert.equal((await market.openWebsite()).ok, false);
  const { DataUpdateManager } = require('../src/modules/dataUpdates');
  const { EpithetsData } = require('../src/modules/epithetsData');
  const { CalendarFeed } = require('../src/modules/calendarFeed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-offline-services-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const http = { get: unavailable };
  assert.equal((await new DataUpdateManager({ rootDir: dir, http }).checkForUpdates()).updated, false);
  assert.equal(await new EpithetsData({ cacheDir: dir, http }).refresh(), false);
  assert.equal(await new CalendarFeed({ cacheDir: dir, http }).refresh(), false);
  assert.equal(require('../src/modules/firebaseConfig').isConfigured(), false);
  await require('../src/modules/usageTransport').sendUsage({});
  const { UsageAnalytics } = require('../src/modules/usageAnalytics');
  const usage = new UsageAnalytics({ directory: dir, enabled: !!settings.usageFirebase, send: unavailable });
  usage.start();
  assert.equal(usage.track('app_launch'), false);
  await usage.flush();
  usage.stop();
  assert.equal(usage.clientId, undefined);
  assert.deepEqual(usage.queue, []);
  assert.equal(fs.existsSync(usage.file), false);
  assert.equal(attempts, 0);
});

test('explicit profiles pin HTTPS origins and isolate custom services from saved official credentials', t => {
  const official = path.resolve(__dirname, '../config/official-services.json');
  const configured = readServiceConfig({ OVERKOT_SERVICES_FILE: official });
  assert.equal(configured.storageScope, '');
  assert.equal(configured.releases, 'https://releases.overkot.com/releases');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-custom-services-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'services.json');
  fs.writeFileSync(filename, JSON.stringify({ accountApi: 'https://account.example/', marketWebsite: 'https://market.example',
    releases: 'https://releases.example/path/', usageFirebase: { projectId: 'example', appId: 'client', apiKey: 'public-id',
      extraSetting: 'excluded' }, unknownField: true }));
  const custom = readServiceConfig({ OVERKOT_SERVICES_FILE: filename });
  assert.throws(() => readServiceConfig({ OVERKOT_SERVICES_FILE: official, OVERKOT_MARKET_API_URL: 'https://different-market.example/v1' }), /registered marketApi/);
  assert.equal(custom.accountApi, 'https://account.example');
  assert.equal(custom.releases, 'https://releases.example/path');
  assert.equal(custom.unknownField, undefined);
  assert.equal(custom.usageFirebase.extraSetting, undefined);
  assert.ok(custom.storageScope);
  const host = { imageBase: 'https://assets.example.org/images/' };
  fs.writeFileSync(filename, JSON.stringify(host));
  const icons = readServiceConfig({ OVERKOT_SERVICES_FILE: filename });
  assert.equal(icons.imageBase, 'https://assets.example.org/images');
  assert.notEqual(icons.storageScope, readServiceConfig({}).storageScope);
  fs.writeFileSync(filename, JSON.stringify({ ...host, dataOrigin: configured.dataOrigin }));
  assert.throws(() => readServiceConfig({ OVERKOT_SERVICES_FILE: filename }), /production data service/);
  assert.notEqual(readServiceConfig({ OVERKOT_SERVICES_FILE: official, OVERKOT_ACCOUNT_API_URL: custom.accountApi }).storageScope, '');
  for (const accountApi of ['ftp://example.org', 'http://example.org', 'https://user:pass@example.org',
    'https://example.org/path', 'https://example.org/#login']) {
    assert.throws(() => readServiceConfig({ OVERKOT_ACCOUNT_API_URL: accountApi }), /Invalid service URL/);
  }
});

test('editing the official profile in place isolates every changed destination', t => {
  const filename = path.resolve(__dirname, '../config/official-services.json');
  const original = JSON.parse(fs.readFileSync(filename, 'utf8'));
  let profile;
  t.mock.method(fs, 'readFileSync', () => JSON.stringify(profile));
  for (const field of ['dataManifest', 'calendarManifest', 'epithets', 'vendorCatalog', 'releases']) {
    profile = { ...original, [field]: 'https://different.example/path' };
    assert.ok(readServiceConfig({ OVERKOT_SERVICES_FILE: filename }).storageScope, field);
  }
  for (const field of ['wikiWebsite', 'buildWebsite']) {
    for (const alternate of ['https://example.org', undefined]) {
      profile = { ...original, [field]: alternate };
      assert.ok(readServiceConfig({ OVERKOT_SERVICES_FILE: filename }).storageScope, field);
    }
    profile = { ...original, [field]: 'https://example.org/path' };
    assert.throws(() => readServiceConfig({ OVERKOT_SERVICES_FILE: filename }), /Invalid service URL/);
  }
  for (const project of ['usageFirebase', 'groupFirebase']) {
    for (const field of ['appId', 'authDomain', 'apiKey', 'projectId', 'storageBucket', 'messagingSenderId', 'databaseURL']) {
      profile = { ...original, [project]: { ...original[project], [field]: 'changed' } };
      assert.ok(readServiceConfig({ OVERKOT_SERVICES_FILE: filename }).storageScope, `${project}.${field}`);
    }
  }
});
