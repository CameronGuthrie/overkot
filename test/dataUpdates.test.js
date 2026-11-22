process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { brotliCompressSync, constants } = require('node:zlib');
const { DataUpdateManager, MANIFEST_URL, CHECK_INTERVAL, validateManifest } = require('../src/modules/dataUpdates');
const { MapTileManager } = require('../src/modules/mapTiles');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  const base = path.resolve(__dirname, '..', '.build', 'data-tests');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'client-'));
  const files = {};
  const objects = new Map();
  const requests = [];
  const control = { now: 1_000_000, manifestStatus: 200, onAsset: null, active: 0, peak: 0 };
  function entry(key, bytes) {
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = digest(bytes);
    const encoding = /\.(webp|png)$/.test(key) ? 'identity' : 'br';
    const wire = encoding === 'br' ? brotliCompressSync(bytes) : bytes;
    const url = `objects/${digest(wire)}${encoding === 'br' ? '.json.br' : '.' + key.split('.').pop()}`;
    files[key] = { sha256, bytes: bytes.length, downloadBytes: wire.length, encoding, url };
    objects.set('/' + url, wire);
    return files[key];
  }
  function manifest() { return { schema: 1, version: digest(JSON.stringify(files)), files }; }
  for (let index = 0; index < 196; index++) entry(`map-tiles/${index}.webp`, `tile ${index}`);
  entry('names/en.json', JSON.stringify({ hello: 'Hello' }));
  entry('names/fr.json', JSON.stringify({ hello: 'Bonjour' }));
  entry('locations/fr.json', JSON.stringify({ location: 'Lieu' }));

  const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url === '/manifest.json') {
      if (control.manifestStatus !== 200) { res.writeHead(control.manifestStatus).end(); return; }
      const release = manifest();
      const etag = `"${release.version}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
      res.end(JSON.stringify(release));
      return;
    }
    const wire = objects.get(req.url);
    if (!wire) { res.writeHead(404).end(); return; }
    control.active++;
    control.peak = Math.max(control.peak, control.active);
    try {
      if (control.onAsset) await control.onAsset(req.url);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(wire);
    } finally { control.active--; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Each fixture owns only its mkdtemp child under the fixed build directory.
    assert.equal(path.dirname(directory), base);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const options = {
    rootDir: path.join(directory, 'cache'), bundledRoot: path.join(directory, 'bundled'), allowBundled: true,
    manifestUrl: `http://127.0.0.1:${server.address().port}/manifest.json`, now: () => control.now,
  };
  const manager = new DataUpdateManager(options);
  await manager.initialize();
  async function bundled(key, bytes) {
    const file = manager.bundledPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  }
  return { manager, options, control, entry, files, objects, requests, bundled, manifest,
    assets: () => requests.filter(request => request.url !== '/manifest.json') };
}

test('wolf and dungeon assets download on demand and survive an offline restart', async t => {
  const f = await fixture(t);
  const keys = ['wolf-training/en.json', 'dungeons/index.json', 'dungeons/fallenFortress/rooms.json', 'dungeons/fallenFortress/layouts.json'];
  for (const key of keys) f.entry(key, JSON.stringify({ schema: 1, asset: key }));
  await f.manager.checkForUpdates();
  assert.equal(f.assets().length, 0, 'the manifest does not prefetch every dungeon');
  for (const key of keys) {
    assert.ok(await f.manager.ensureAsset(key));
    assert.equal(f.manager.readJSON(key).asset, key);
  }
  f.control.manifestStatus = 503;
  const restarted = new DataUpdateManager(f.options);
  await restarted.initialize();
  for (const key of keys) assert.equal(restarted.readJSON(key).asset, key);
  await assert.rejects(restarted.ensureAsset('dungeons/../private/rooms.json'), /Unknown data asset/);
});

for (const previousUrl of [MANIFEST_URL.replace('/protected/', '/'), MANIFEST_URL.replace('/protected/', '/').replace('/v2/', '/v1/')]) test(`the protected feed preserves offline caches from ${new URL(previousUrl).pathname}`, async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const filename = await f.manager.ensureAsset('names/en.json');
  const stateFile = path.join(f.options.rootDir, 'state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  state.url = previousUrl;
  state.nextCheck = f.control.now + CHECK_INTERVAL;
  state.etag = 'old-v1-etag';
  await fs.writeFile(stateFile, JSON.stringify(state));
  let requests = 0;
  const restarted = new DataUpdateManager({ ...f.options, manifestUrl: MANIFEST_URL,
    http: { get: async () => { requests++; throw new Error('offline'); } } });
  await restarted.initialize();
  assert.equal(restarted.cachedPath('names/en.json'), filename);
  assert.deepEqual(restarted.readJSON('names/en.json'), { hello: 'Hello' });
  assert.equal(restarted.state.etag, undefined);
  assert.equal(restarted.state.nextCheck, undefined);
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).url, MANIFEST_URL);
  await restarted.checkForUpdates();
  assert.equal(requests, 1, 'v2 makes its first own manifest request');
  assert.deepEqual(restarted.readJSON('names/en.json'), { hello: 'Hello' });
});

test('production defaults never load a bundled snapshot; overlay modules download only requested hashes', async t => {
  const f = await fixture(t);
  await f.bundled('map-tiles/0.webp', 'packaged stale tile');
  const manager = new DataUpdateManager({ ...f.options, allowBundled: false });
  await manager.initialize();
  assert.equal(manager.cachedPath('map-tiles/0.webp'), null);
  assert.equal(await manager.ensureAsset('map-tiles/0.webp'), null);
  const key = 'temper-icons/' + 'f'.repeat(64) + '.png';
  f.entry(key, Buffer.from([137, 80, 78, 71]));
  f.entry('tempers/en.json', '{"schema":1}');
  f.entry('calendar/calendar.json', '{"schema":1}');
  f.entry('build-export/catalog.json', '{"schema":1}');
  await manager.checkForUpdates();
  assert.equal(f.assets().length, 0);
  await Promise.all([manager.ensureAsset(key), manager.ensureAsset(key)]);
  assert.equal(f.assets().length, 1);
  assert.deepEqual(await fs.readFile(manager.cachedPath(key)), Buffer.from([137, 80, 78, 71]));
  const restarted = new DataUpdateManager({ ...f.options, allowBundled: false });
  await restarted.initialize();
  await restarted.ensureAsset(key);
  assert.equal(f.assets().length, 1, 'verified downloads survive restart without another request');
});

// Self-contained 32px and 1px solid RGBA images.
const sourcePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMELQlxbUhRg3E/Or3rmkEhAQEBAQEBAQEBAQEBAQSAcezxigeZQxFIYAAAAASUVORK5CYII=', 'base64');
const smallPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQmVb/HwAEFAIpVE3NEAAAAABJRU5ErkJggg==', 'base64');
const otherPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4P63+PwAHwAMUPVoyPwAAAABJRU5ErkJggg==', 'base64');
const temperKey = bytes => `temper-icons/${digest(bytes)}.png`;

test('upgrading offline compacts an existing verified icon once and verifies the local representation on restart', async t => {
  const f = await fixture(t);
  const key = temperKey(sourcePng);
  f.entry(key, sourcePng);
  await f.manager.checkForUpdates();
  const original = await f.manager.ensureAsset(key);
  let transforms = 0, downloads = 0;
  const options = { ...f.options,
    compactTemperIcon: async bytes => { transforms++; assert.deepEqual(bytes, sourcePng); return smallPng; },
    http: { get: async () => { downloads++; throw new Error('offline'); } },
  };
  const upgraded = new DataUpdateManager(options);
  await upgraded.initialize();
  const filename = await upgraded.ensureAsset(key);
  assert.equal(upgraded.state.files[key].sha256, digest(sourcePng));
  assert.deepEqual(upgraded.state.files[key].local, { sha256: digest(smallPng), bytes: smallPng.length });
  assert.deepEqual(await fs.readFile(filename), smallPng);
  assert.equal(upgraded.isCurrentAsset(key, filename), true);
  await assert.rejects(fs.stat(original), { code: 'ENOENT' });
  const restarted = new DataUpdateManager(options);
  await restarted.initialize();
  assert.equal(await restarted.ensureAsset(key), filename);
  assert.equal(transforms, 1);
  assert.equal(downloads, 0);
  const damaged = Buffer.from(smallPng);
  damaged[30] ^= 1;
  await fs.writeFile(filename, damaged);
  const repaired = new DataUpdateManager({ ...f.options, compactTemperIcon: options.compactTemperIcon });
  await repaired.initialize();
  assert.equal(repaired.cachedPath(key), null);
  assert.equal(await repaired.ensureAsset(key), filename);
  assert.deepEqual(await fs.readFile(filename), smallPng);
  assert.equal(f.assets().length, 2, 'initial download and repair');
  // A downloaded manifest cannot supply trusted local cache metadata.
  const untrusted = structuredClone(f.manifest());
  untrusted.files[key].local = restarted.state.files[key].local;
  assert.throws(() => validateManifest(untrusted), /Invalid data entry/);
});

test('parallel icon aliases share source bytes but only temper icons receive thumbnails', async t => {
  const f = await fixture(t);
  const key = temperKey(sourcePng), marker = 'map-icons/Vendor.png';
  f.entry(key, sourcePng); f.entry(marker, sourcePng);
  const manager = new DataUpdateManager({ ...f.options, compactTemperIcon: () => smallPng });
  await manager.initialize();
  await manager.checkForUpdates();
  const [thumb, raw] = await Promise.all([manager.ensureAsset(key), manager.ensureAsset(marker)]);
  assert.equal(f.assets().length, 1);
  assert.deepEqual(await fs.readFile(raw), sourcePng);
  assert.deepEqual(await fs.readFile(thumb), smallPng);
  f.entry(marker, otherPng);
  await manager.checkForUpdates({ force: true });
  assert.deepEqual(await fs.readFile(await manager.ensureAsset(marker)), otherPng);
  await assert.rejects(fs.stat(raw), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(thumb), smallPng);
});

test('failed replacement keeps the old thumbnail and a failed encoder keeps the verified source', async t => {
  const f = await fixture(t);
  const key = temperKey(sourcePng);
  f.entry(key, sourcePng);
  let calls = 0;
  const manager = new DataUpdateManager({ ...f.options, compactTemperIcon: () => {
    if (++calls === 1) return smallPng;
    throw new Error('encoder unavailable');
  } });
  await manager.initialize();
  await manager.checkForUpdates();
  const lastGood = await manager.ensureAsset(key);
  const latest = f.entry(key, otherPng);
  f.objects.set('/' + latest.url, Buffer.alloc(otherPng.length));
  await manager.checkForUpdates({ force: true });
  assert.equal(await manager.ensureAsset(key), lastGood);
  assert.equal(calls, 1, 'unverified bytes never reach the encoder');
  assert.deepEqual(await fs.readFile(lastGood), smallPng);
  f.objects.set('/' + latest.url, otherPng);
  await manager.refreshCachedAssets();
  assert.deepEqual(await fs.readFile(await manager.ensureAsset(key)), otherPng);
  assert.equal(calls, 2, 'the original stays usable across repeated reads');
});

function savedTemperCatalog(icon) {
  return JSON.stringify({ schema: 1, tempers: [{ id: '/SF/Language/Tempers/One', name: 'One',
    origin: 'Test', description: '', icon }], weapons: {}, aliases: {}, weaponAliases: {} });
}

test('retired temper keys survive stale or unreadable catalogues and are collected after every cached locale moves on', async t => {
  const f = await fixture(t);
  const oldKey = temperKey(sourcePng), newKey = temperKey(otherPng);
  const options = { ...f.options, compactTemperIcon: bytes => bytes.equals(sourcePng) ? smallPng : null };
  const oldManager = new DataUpdateManager(options);
  await oldManager.initialize();
  f.entry(oldKey, sourcePng);
  f.entry('tempers/en.json', savedTemperCatalog(oldKey));
  f.entry('tempers/fr.json', savedTemperCatalog(oldKey));
  await oldManager.checkForUpdates();
  const [oldIcon,, french] = await Promise.all([oldKey, 'tempers/en.json', 'tempers/fr.json'].map(key => oldManager.ensureAsset(key)));
  delete f.files[oldKey];
  f.entry(newKey, otherPng);
  f.entry('tempers/en.json', savedTemperCatalog(newKey));
  f.entry('tempers/fr.json', savedTemperCatalog(newKey));
  await oldManager.checkForUpdates({ force: true });
  await Promise.all([newKey, 'tempers/en.json'].map(key => oldManager.ensureAsset(key)));

  const staleLocale = new DataUpdateManager(options);
  await staleLocale.initialize();
  assert.equal(staleLocale.cachedPath(oldKey), oldIcon, 'French still uses the old icon');
  await fs.writeFile(french, 'unreadable stale catalogue');
  const damagedLocale = new DataUpdateManager(options);
  await damagedLocale.initialize();
  assert.equal(damagedLocale.cachedPath(oldKey), oldIcon, 'unknown dependencies prevent collection');
  await damagedLocale.ensureAsset('tempers/fr.json');
  const fresh = new DataUpdateManager(options);
  await fresh.initialize();
  assert.equal(fresh.state.files[oldKey], undefined);
  await assert.rejects(fs.stat(oldIcon), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(fresh.cachedPath(newKey)), otherPng);
});

test('an expired hash triggers one manifest refresh and downloads its current replacement', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const retired = f.files['names/en.json'].url;
  f.entry('names/en.json', '{"hello":"Updated"}');
  f.objects.delete('/' + retired);
  await f.manager.ensureAsset('names/en.json');
  assert.equal(f.manager.readJSON('names/en.json').hello, 'Updated');
  assert.equal(f.requests.filter(row => row.url === '/manifest.json').length, 2);
  assert.equal(f.assets().length, 2, 'one retired hash and its replacement, no unrelated assets');
});

test('manifest is conditional, checks are throttled, and cached metadata survives restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.checkForUpdates()).updated, true);
  assert.equal(f.assets().length, 0);
  await f.manager.checkForUpdates();
  assert.equal(f.requests.length, 1);
  assert.equal((await f.manager.checkForUpdates({ force: true })).updated, false);
  assert.ok(f.requests[1].headers['if-none-match']);
  const restarted = new DataUpdateManager(f.options);
  await restarted.initialize();
  assert.equal(restarted.getInfo().version, f.manager.getInfo().version);
  await restarted.checkForUpdates();
  assert.equal(f.requests.length, 2);
  await restarted.checkForUpdates({ force: true });
  assert.equal(f.requests[2].headers['if-none-match'], f.requests[1].headers['if-none-match']);
});

test('bundled hashes are reused and only requested changed files download', async t => {
  const f = await fixture(t);
  const bundled = await f.bundled('map-tiles/0.webp', 'tile 0');
  await f.manager.checkForUpdates();
  assert.equal(await f.manager.ensureAsset('map-tiles/0.webp'), bundled);
  const original = await f.manager.ensureAsset('map-tiles/1.webp');
  assert.equal(f.assets().length, 1);
  f.entry('map-tiles/1.webp', 'changed tile 1');
  f.entry('map-tiles/2.webp', 'changed tile 2');
  await f.manager.checkForUpdates({ force: true });
  await f.manager.ensureAsset('map-tiles/0.webp');
  const replacement = await f.manager.ensureAsset('map-tiles/1.webp');
  assert.equal(await fs.readFile(replacement, 'utf8'), 'changed tile 1');
  assert.equal(f.assets().length, 2);
  assert.notEqual(replacement, original);
  await assert.rejects(fs.stat(original), { code: 'ENOENT' });
});

test('manual refresh updates used assets, retries failures immediately and leaves unseen tiles on demand', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  await f.manager.ensureAsset('map-tiles/0.webp');
  await f.manager.ensureAsset('names/en.json');
  f.entry('map-tiles/0.webp', 'updated tile');
  f.entry('map-tiles/1.webp', 'unseen tile');
  const french = f.files['names/fr.json'];
  const wire = f.objects.get('/' + french.url);
  f.objects.set('/' + french.url, Buffer.from('corrupt'));
  await f.manager.checkForUpdates({ force: true });
  assert.equal(await f.manager.ensureAsset('names/fr.json'), null);
  f.objects.set('/' + french.url, wire);
  const before = f.assets().length;
  assert.deepEqual(await f.manager.refreshCachedAssets(), { updated: true, failed: [] });
  assert.equal(f.assets().length, before + 2, 'Only the changed tile and failed locale download');
  assert.equal(await fs.readFile(f.manager.cachedPath('map-tiles/0.webp'), 'utf8'), 'updated tile');
  assert.equal(f.manager.readJSON('names/fr.json').hello, 'Bonjour');
  assert.equal(f.manager.cachedPath('map-tiles/1.webp'), null);
  assert.deepEqual(await f.manager.refreshCachedAssets(), { updated: false, failed: [] });
  assert.equal(f.assets().length, before + 2);
});

test('manual refresh reports incomplete data while preserving the last good copy', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const previous = await f.manager.ensureAsset('map-tiles/0.webp');
  const entry = f.entry('map-tiles/0.webp', 'new tile');
  f.objects.set('/' + entry.url, Buffer.from('corrupt'));
  await f.manager.checkForUpdates({ force: true });
  assert.deepEqual(await f.manager.refreshCachedAssets(['calendar/calendar.json']), {
    updated: false, failed: ['map-tiles/0.webp', 'calendar/calendar.json'],
  });
  assert.equal(f.manager.cachedPath('map-tiles/0.webp'), previous);
  assert.equal(await fs.readFile(previous, 'utf8'), 'tile 0');
});

test('manual refresh accepts a matching bundled asset without downloading', async t => {
  const f = await fixture(t);
  await f.bundled('map-tiles/0.webp', 'tile 0');
  await f.manager.checkForUpdates();
  assert.deepEqual(await f.manager.refreshCachedAssets(['map-tiles/0.webp']), { updated: false, failed: [] });
  assert.equal(f.assets().length, 0);
});

test('a release rollback reuses bundled tiles without downloading them or retaining newer cache mappings', async t => {
  const f = await fixture(t);
  const key = 'map-tiles/0.webp';
  const bundled = await f.bundled(key, 'tile 0');
  f.entry(key, 'newer remote tile');
  await f.manager.checkForUpdates();
  const installed = await f.manager.ensureAsset(key);
  assert.notEqual(installed, bundled);
  assert.equal(await fs.readFile(installed, 'utf8'), 'newer remote tile');
  assert.equal(f.manager.cachedPath(key), installed);
  assert.equal(f.assets().length, 1);

  f.entry(key, 'tile 0');
  await f.manager.checkForUpdates({ force: true });
  assert.equal(await f.manager.ensureAsset(key), bundled);
  assert.equal(f.manager.cachedPath(key), bundled);
  assert.equal(f.assets().length, 1);
  assert.equal(f.manager.state.files[key], undefined);

  const restarted = new DataUpdateManager(f.options);
  await restarted.initialize();
  assert.equal(restarted.cachedPath(key), bundled);
  assert.equal(await restarted.ensureAsset(key), bundled);
  assert.equal(f.assets().length, 1);
});

test('checking a multilingual release only fetches explicitly requested locale data', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  await Promise.all(['names/fr.json', 'locations/fr.json'].map(key => f.manager.ensureAsset(key)));
  assert.deepEqual(f.manager.readJSON('names/fr.json'), { hello: 'Bonjour' });
  assert.deepEqual(f.assets().map(request => request.url).sort(), [
    '/' + f.files['names/fr.json'].url, '/' + f.files['locations/fr.json'].url,
  ].sort());
  assert.equal(f.manager.readJSON('names/en.json'), null);
});

test('corrupt downloads retain bundled data and are backed off', async t => {
  const f = await fixture(t);
  const bundled = await f.bundled('map-tiles/0.webp', 'last known tile');
  f.objects.set('/' + f.files['map-tiles/0.webp'].url, Buffer.from('broken'));
  await f.manager.checkForUpdates();
  assert.equal(await f.manager.ensureAsset('map-tiles/0.webp'), bundled);
  assert.equal(await f.manager.ensureAsset('map-tiles/0.webp'), bundled);
  assert.equal(f.assets().length, 1);
  assert.equal(f.manager.state.files['map-tiles/0.webp'], undefined);
});

test('corrupt cached bytes fall back to bundled data and are repaired', async t => {
  const f = await fixture(t);
  const bundled = await f.bundled('map-tiles/0.webp', 'older tile');
  await f.manager.checkForUpdates();
  const downloaded = await f.manager.ensureAsset('map-tiles/0.webp');
  assert.equal(f.manager.cachedPath('map-tiles/0.webp'), downloaded);
  await fs.writeFile(downloaded, 'corrupt cached tile');
  assert.equal(f.manager.cachedPath('map-tiles/0.webp'), bundled);
  assert.equal(await f.manager.ensureAsset('map-tiles/0.webp'), downloaded);
  assert.equal(await fs.readFile(downloaded, 'utf8'), 'tile 0');
  assert.equal(f.assets().length, 2);
});

test('current cache metadata cannot make an older bundled fallback count as current after a failed repair', async t => {
  for (const damage of ['missing', 'corrupt']) await t.test(damage, async subtest => {
    const f = await fixture(subtest);
    const key = 'map-tiles/0.webp';
    const bundled = await f.bundled(key, 'older bundled tile');
    await f.manager.checkForUpdates();
    const downloaded = await f.manager.ensureAsset(key);
    assert.equal(f.manager.isCurrentAsset(key, downloaded), true);
    if (damage === 'missing') await fs.unlink(downloaded);
    else await fs.writeFile(downloaded, 'corrupt cached tile');
    f.objects.set('/' + f.files[key].url, Buffer.from('failed download'));
    const fallback = await f.manager.ensureAsset(key);
    assert.equal(fallback, bundled);
    assert.equal(f.manager.state.files[key].sha256, f.files[key].sha256, 'metadata still names the unavailable current object');
    assert.equal(f.manager.isCurrentAsset(key, fallback), false);
    assert.deepEqual(await f.manager.refreshCachedAssets(), { updated: false, failed: [key] });
  });
});

test('bundled freshness requires its current file signature after a failed repair', async t => {
  const f = await fixture(t);
  const key = 'map-tiles/0.webp';
  const bundled = await f.bundled(key, 'tile 0');
  await f.manager.checkForUpdates();
  assert.equal(await f.manager.ensureAsset(key), bundled);
  assert.equal(f.manager.isCurrentAsset(key, bundled), true);
  await fs.writeFile(bundled, 'a damaged bundled tile');
  f.objects.set('/' + f.files[key].url, Buffer.from('failed download'));
  assert.equal(await f.manager.ensureAsset(key), bundled);
  assert.equal(f.manager.isCurrentAsset(key, bundled), false, 'a stale matching signature is not proof of current content');
});

test('Brotli output and wire length are bounded by manifest sizes', async t => {
  const f = await fixture(t);
  const large = brotliCompressSync(Buffer.from(JSON.stringify({ text: 'x'.repeat(100_000) })));
  const names = f.files['names/fr.json'];
  names.downloadBytes = large.length;
  names.url = `objects/${digest(large)}.json.br`;
  f.objects.set('/' + names.url, large);
  const tile = f.files['map-tiles/0.webp'];
  f.objects.set('/' + tile.url, Buffer.alloc(tile.downloadBytes + 1));
  await f.manager.checkForUpdates();
  assert.equal(await f.manager.ensureAsset('names/fr.json'), null);
  assert.equal(await f.manager.ensureAsset('map-tiles/0.webp'), null);
  assert.deepEqual(f.manager.state.files, {});
});

test('same asset requests share work and downloads use at most three connections', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const opened = deferred();
  const release = deferred();
  let count = 0;
  f.control.onAsset = async () => { if (++count === 3) opened.resolve(); await release.promise; };
  const tasks = Array.from({ length: 8 }, (_, index) => f.manager.ensureAsset(`map-tiles/${index}.webp`));
  assert.equal(f.manager.ensureAsset('map-tiles/0.webp'), tasks[0]);
  await opened.promise;
  assert.equal(f.assets().length, 3);
  release.resolve();
  const results = await Promise.all(tasks);
  assert.equal(results.length, 8);
  assert.equal(f.assets().length, 8);
  assert.equal(f.control.peak, 3);
  assert.equal(f.manager.active, 0);
});

test('manifest outage keeps data and persists retry backoff across restart', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const version = f.manager.getInfo().version;
  f.control.now += CHECK_INTERVAL;
  f.control.manifestStatus = 503;
  assert.ok((await f.manager.checkForUpdates()).error);
  assert.equal(f.manager.getInfo().version, version);
  const restarted = new DataUpdateManager(f.options);
  await restarted.initialize();
  await restarted.checkForUpdates();
  assert.equal(f.requests.length, 2);
  f.control.now += 15 * 60 * 1000;
  assert.ok((await restarted.checkForUpdates()).error);
  assert.equal(f.requests.length, 3);
});

test('an obsolete in-flight hash cannot replace a newer installed release', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const oldUrl = '/' + f.files['map-tiles/0.webp'].url;
  const opened = deferred();
  const release = deferred();
  f.control.onAsset = async url => { if (url === oldUrl) { opened.resolve(); await release.promise; } };
  const oldRequest = f.manager.ensureAsset('map-tiles/0.webp');
  await opened.promise;
  f.entry('map-tiles/0.webp', 'newest tile');
  await f.manager.checkForUpdates({ force: true });
  const newest = await f.manager.ensureAsset('map-tiles/0.webp');
  release.resolve();
  assert.equal(await oldRequest, newest);
  assert.equal(f.manager.cachedPath('map-tiles/0.webp'), newest);
  assert.equal(await fs.readFile(newest, 'utf8'), 'newest tile');
  assert.equal(f.manager.state.files['map-tiles/0.webp'].sha256, f.files['map-tiles/0.webp'].sha256);
});

test('manifest validation rejects unsafe keys, URLs, invalid sizes and incomplete releases', async t => {
  const f = await fixture(t);
  assert.equal(validateManifest(f.manifest()).schema, 1);
  const reject = mutate => {
    const manifest = structuredClone(f.manifest());
    mutate(manifest);
    assert.throws(() => validateManifest(manifest));
  };
  for (const key of ['../config.json', 'map-tiles/../../config.json', 'map-tiles/196.webp', 'names/xx.json']) {
    reject(manifest => { manifest.files[key] = manifest.files['names/en.json']; });
    await assert.rejects(f.manager.ensureAsset(key), /Unknown data asset/);
  }
  for (const url of ['../state.json', '/objects/file.json.br', 'https://example.com/data.json.br',
    'objects/../../state.json', `${f.files['names/fr.json'].url}?redirect=1`]) {
    reject(manifest => { manifest.files['names/fr.json'].url = url; });
  }
  reject(manifest => { manifest.schema = 3; });
  reject(manifest => { manifest.version = 'broken'; });
  reject(manifest => { delete manifest.files['map-tiles/195.webp']; });
  reject(manifest => { manifest.files['names/fr.json'].sha256 = '../state.json'; });
  reject(manifest => { manifest.files['names/fr.json'].bytes = 0; });
  reject(manifest => { manifest.files['names/fr.json'].bytes = 8 * 1024 * 1024 + 1; });
  reject(manifest => { manifest.files['names/fr.json'].downloadBytes = 8 * 1024 * 1024 + 1; });
  reject(manifest => { manifest.files['names/fr.json'].encoding = 'identity'; });
  assert.equal(f.requests.length, 0);
});

test('invalid remote and persisted manifests preserve safe local fallback', async t => {
  const f = await fixture(t);
  const bundled = await f.bundled('map-tiles/0.webp', 'offline fallback');
  await f.manager.checkForUpdates();
  const version = f.manager.getInfo().version;
  f.files['names/fr.json'].url = '../config.json';
  assert.ok((await f.manager.checkForUpdates({ force: true })).error);
  assert.equal(f.manager.getInfo().version, version);
  assert.equal(f.manager.cachedPath('map-tiles/0.webp'), bundled);

  const stateFile = path.join(f.options.rootDir, 'state.json');
  for (const contents of ['{broken JSON', JSON.stringify({
    url: f.options.manifestUrl, files: {}, manifest: f.manifest(),
  })]) {
    await fs.writeFile(stateFile, contents);
    const restarted = new DataUpdateManager(f.options);
    await restarted.initialize();
    assert.equal(restarted.getInfo().source, 'unavailable');
    assert.equal(restarted.cachedPath('map-tiles/0.webp'), bundled);
  }
  assert.equal(f.assets().length, 0);
});

test('wire hash is verified even if alternate Brotli bytes decode to the expected content', async t => {
  const f = await fixture(t);
  const decoded = Buffer.from(JSON.stringify({ hello: 'Bonjour '.repeat(500) }));
  const entry = f.entry('names/fr.json', decoded);
  const alternate = brotliCompressSync(decoded, { params: { [constants.BROTLI_PARAM_QUALITY]: 0 } });
  assert.notEqual(digest(alternate), digest(f.objects.get('/' + entry.url)));
  entry.downloadBytes = alternate.length;
  f.objects.set('/' + entry.url, alternate);
  await f.manager.checkForUpdates();
  assert.equal(await f.manager.ensureAsset('names/fr.json'), null);
  assert.equal(f.manager.state.files['names/fr.json'], undefined);
  assert.equal(f.assets().length, 1);
});

test('initialization removes orphan objects while preserving active objects and unrelated files', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const active = await f.manager.ensureAsset('map-tiles/0.webp');
  const objects = path.join(f.options.rootDir, 'objects');
  const orphan = path.join(objects, digest('orphan'));
  const unrelated = path.join(objects, 'notes.txt');
  const nestedDirectory = path.join(objects, digest('directory'));
  await fs.writeFile(orphan, 'orphan');
  await fs.writeFile(unrelated, 'keep');
  await fs.mkdir(nestedDirectory);
  await fs.writeFile(path.join(nestedDirectory, 'nested.txt'), 'keep nested');
  const restarted = new DataUpdateManager(f.options);
  await restarted.initialize();
  assert.equal(restarted.cachedPath('map-tiles/0.webp'), active);
  assert.equal(await fs.readFile(active, 'utf8'), 'tile 0');
  await assert.rejects(fs.stat(orphan), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(nestedDirectory, 'nested.txt'), 'utf8'), 'keep nested');
});

test('map warmup fills the shared disk cache before connection, deduplicates visible requests and reuses unchanged images', async t => {
  const f = await fixture(t);
  const errors = [];
  f.manager.log = message => errors.push(message);
  const icon = f.entry('map-icons/Vendor.png', 'vendor icon');
  f.entry('map-json/world_trees.json', '{"positions":[]}');
  const temper = f.entry('temper-icons/' + 'f'.repeat(64) + '.png', 'temper icon');
  await f.manager.checkForUpdates();
  const map = new MapTileManager({ dataManager: f.manager });
  const started = deferred(), release = deferred();
  f.control.onAsset = async url => {
    if (url === '/' + icon.url) { started.resolve(); await release.promise; }
  };
  const warmup = map.warmCache({ language: 'fr' });
  assert.equal(map.warmCache({ language: 'fr' }), warmup, 'startup and periodic calls share one worker');
  await started.promise;
  const visibleIcon = f.manager.ensureAsset('map-icons/Vendor.png');
  assert.equal(f.assets().length, 1, 'a visible map request joins the in-flight warmup request');
  release.resolve();
  await visibleIcon;
  const result = await warmup;
  assert.equal(result.complete, true, [...result.failed, ...errors].join('\n'));
  assert.equal(result.cached, 200, 'all tiles, map and temper icons, available POI layers and only the selected map locale');
  assert.equal(result.updated, true);
  assert.equal(f.control.peak, 1, 'background warmup uses one network slot');
  assert.equal(f.assets().filter(request => request.url === '/' + temper.url).length, 1);
  assert.equal(f.manager.cachedPath('names/fr.json'), null, 'unrelated catalogue is not prefetched');
  const tiles = f.assets().map(request => Object.keys(f.files).find(key => '/' + f.files[key].url === request.url))
    .filter(key => key.startsWith('map-tiles/'));
  assert.deepEqual(tiles.slice(0, 4), [90, 91, 104, 105].map(index => `map-tiles/${index}.webp`), 'center tiles arrive first');
  const downloads = f.assets().length;
  assert.equal((await map.warmCache({ language: 'fr' })).cached, 0);
  assert.equal(f.assets().length, downloads);

  const restarted = new DataUpdateManager(f.options);
  await restarted.initialize();
  const reopenedMap = new MapTileManager({ dataManager: restarted });
  assert.equal((await reopenedMap.warmCache({ language: 'fr' })).complete, true);
  assert.equal(f.assets().length, downloads, 'verified files survive an offline restart without downloading');
  f.entry('map-tiles/90.webp', 'changed center');
  f.entry('map-tiles/0.webp', 'changed edge');
  await restarted.checkForUpdates({ force: true });
  assert.equal((await reopenedMap.warmCache({ language: 'fr' })).complete, true);
  assert.equal(f.assets().length, downloads + 2, 'a new manifest only downloads changed map images');
  f.entry('map-tiles/90.webp', 'tile 90');
  f.entry('map-tiles/0.webp', 'tile 0');
  await restarted.checkForUpdates({ force: true });
  assert.equal((await reopenedMap.warmCache({ language: 'fr' })).complete, true);
  assert.equal(f.assets().length, downloads + 4, 'rolling back refills earlier hashes replaced by the newer release');
  await fs.unlink(restarted.cachedPath('map-tiles/90.webp'));
  await fs.writeFile(restarted.cachedPath('map-tiles/91.webp'), 'damaged cached tile');
  const repairMap = new MapTileManager({ dataManager: restarted });
  const repaired = await repairMap.warmCache({ language: 'fr' });
  assert.equal(repaired.complete, true);
  assert.equal(repaired.updated, true, 'repairing missing/corrupt objects with unchanged hashes reloads open map images');
  assert.equal(f.assets().length, downloads + 6, 'only damaged objects download again');
});

test('map warmup bounds failures, keeps older verified images and retries after shared backoff', async t => {
  const f = await fixture(t);
  const map = new MapTileManager({ dataManager: f.manager });
  assert.equal((await map.warmCache()).complete, false);
  assert.equal(f.requests.length, 0, 'no manifest means no speculative asset requests');
  await f.manager.checkForUpdates();
  const keys = [90, 91, 104].map(index => `map-tiles/${index}.webp`);
  const previous = await Promise.all(keys.map(key => f.manager.ensureAsset(key)));
  const correct = new Map();
  for (const key of keys) {
    const entry = f.entry(key, 'new ' + key);
    correct.set('/' + entry.url, f.objects.get('/' + entry.url));
    f.objects.set('/' + entry.url, Buffer.from('corrupt response'));
  }
  await f.manager.checkForUpdates({ force: true });
  const before = f.assets().length;
  const failed = await map.warmCache();
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.failed, keys);
  assert.equal(f.assets().length, before + 3, 'an outage does not attempt the whole map');
  assert.deepEqual(keys.map(key => f.manager.cachedPath(key)), previous, 'bad responses preserve usable cached tiles');
  await map.warmCache();
  assert.equal(f.assets().length, before + 3, 'warmup respects existing download retry backoff');
  for (const [url, bytes] of correct) f.objects.set(url, bytes);
  f.control.now += 15 * 60 * 1000 + 1;
  const recovered = await map.warmCache();
  assert.equal(recovered.complete, true, 'fallback files did not mark the failed warmup complete');
  assert.equal(recovered.cached, 196);
  for (const key of keys) assert.equal(await fs.readFile(f.manager.cachedPath(key), 'utf8'), 'new ' + key);
});

test('map warmup leaves capacity for visible assets and stops queuing downloads at quit', async t => {
  const f = await fixture(t);
  await f.manager.checkForUpdates();
  const map = new MapTileManager({ dataManager: f.manager });
  const started = deferred(), release = deferred();
  f.control.onAsset = async url => {
    if (url === '/' + f.files['map-tiles/90.webp'].url) { started.resolve(); await release.promise; }
  };
  const warmup = map.warmCache();
  await started.promise;
  assert.ok(await f.manager.ensureAsset('map-tiles/0.webp'), 'visible edge tile need not wait for background center tile');
  assert.equal(f.control.peak, 2);
  map.stopWarmup();
  release.resolve();
  const result = await warmup;
  assert.equal(result.complete, false);
  assert.equal(result.cached, 1);
  assert.equal(f.assets().length, 2, 'quit cancels every not-yet-started background request');
  await map.warmCache();
  assert.equal(f.assets().length, 2, 'warmup cannot restart during shutdown');
});
