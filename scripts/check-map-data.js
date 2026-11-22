// Read-only pipeline/feed comparison, with an optional local feed for native QA.
// Usage: node scripts/check-map-data.js <pipeline/maps or pipeline/map directory> [--serve]
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { brotliCompressSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const axios = require('axios');
const { DataUpdateManager, MANIFEST_URL } = require('../src/modules/dataUpdates');
const MapPOIs = require('../src/renderer/map-pois');
const { projectMapLayer } = require('./build-data');
const { sourcePath, tilePaths } = require('./pipeline-paths');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const counts = markers => markers.reduce((result, marker) => {
  result[marker.category] = (result[marker.category] || 0) + 1;
  return result;
}, {});

async function main() {
  const [directory, option] = process.argv.slice(2);
  if (!directory || (option && option !== '--serve')) throw new Error('Usage: node scripts/check-map-data.js <pipeline/maps or pipeline/map directory> [--serve]');
  const mapDir = path.resolve(directory);
  const out = path.resolve(__dirname, '../output/map-data-review');
  const read = name => fs.readFile(path.join(mapDir, 'map-json', `${name}.json`), 'utf8').then(JSON.parse);
  const local = Object.fromEntries(await Promise.all(MapPOIs.layers.map(async name => [name, await read(name)])));
  const metadata = await read('metadata'), layout = await read('tile_layout');
  const images = tilePaths(layout);
  assert.equal(metadata.world_bounds.pixels_per_world_unit, 2);
  assert.equal(metadata.world_bounds.map_size_pixels, 7168);
  assert.equal(layout.tiles.length, 196);
  const indices = new Set();
  for (const tile of layout.tiles) {
    assert.ok(Number.isInteger(tile.index) && tile.index >= 0 && tile.index < 196 && !indices.has(tile.index));
    indices.add(tile.index);
    const bounds = tile.world_bounds;
    const pixel = MapPOIs.worldToMapPixel(bounds.min_x, bounds.max_z);
    assert.deepEqual(MapPOIs.getTilePos(tile.index), { x: pixel.px, y: pixel.py });
    assert.equal((bounds.max_x - bounds.min_x) * 2, 512);
    assert.equal((bounds.max_z - bounds.min_z) * 2, 512);
  }
  const manifestUrl = process.env.OVERKOT_DATA_MANIFEST_URL || MANIFEST_URL;
  const manager = new DataUpdateManager({ rootDir: path.join(out, 'cache'), manifestUrl });
  await manager.initialize();
  await manager.checkForUpdates({ force: true });
  if (!manager.manifest) throw new Error('Public manifest unavailable');
  const remote = {};
  for (const name of MapPOIs.layers) {
    const key = `map-json/${name}.json`;
    await manager.ensureAsset(key);
    remote[name] = manager.readJSON(key);
  }
  const tiles = await Promise.all(Array.from({ length: 196 }, async (_, index) => {
    const key = `map-tiles/${index}.webp`;
    return { key, bytes: await fs.readFile(path.join(mapDir, images.get(index))) };
  }));
  const localMarkers = MapPOIs.normalize(local), remoteMarkers = MapPOIs.normalize(remote);
  const locationKey = 'locations/en.json';
  await manager.ensureAsset(locationKey);
  const publicNames = manager.readJSON(locationKey) || {};
  const localNames = JSON.parse(await fs.readFile(sourcePath(path.dirname(mapDir), 'Languages_en.json'), 'utf8'));
  const namedLocations = (markers, names) => markers.filter(row => row.category === 'locations')
    .map(({ px, py, label, labelKey }) => ({ px, py, label: names[labelKey] || label }));
  const localLocations = namedLocations(localMarkers, localNames);
  const publicLocations = namedLocations(remoteMarkers, publicNames);
  const signatures = markers => markers.map(({ category, px, py, label }) => JSON.stringify([category, px, py, label])).sort();
  const report = {
    generatedAt: new Date().toISOString(), sourceGeneratedAt: metadata.generated_at,
    manifestUrl, version: manager.manifest.version,
    local: { count: localMarkers.length, categories: counts(localMarkers), namedLocations: localLocations },
    public: { count: remoteMarkers.length, categories: counts(remoteMarkers) },
    missingPublicLayers: MapPOIs.layers.filter(name => !manager.manifest.files[`map-json/${name}.json`]),
    markerDataMatches: JSON.stringify(signatures(localMarkers)) === JSON.stringify(signatures(remoteMarkers)),
    locationLabelsMatch: JSON.stringify(localLocations) === JSON.stringify(publicLocations),
    tileLayoutVerified: 196,
    changedTiles: tiles.filter(tile => digest(tile.bytes) !== manager.manifest.files[tile.key]?.sha256).map(tile => tile.key),
    warnings: manager.manifest.warnings || {},
  };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (option !== '--serve') return;

  // Replace only map data in an isolated fixture. Other public display assets
  // retain their verified manifest hashes and are fetched on demand.
  const files = { ...manager.manifest.files }, objects = new Map();
  function add(key, bytes, encoding) {
    const wire = encoding === 'br' ? brotliCompressSync(bytes) : bytes;
    const url = `objects/${digest(wire)}.${encoding === 'br' ? 'json.br' : 'webp'}`;
    files[key] = { sha256: digest(bytes), bytes: bytes.length, downloadBytes: wire.length, encoding, url };
    objects.set(url, wire);
  }
  for (const name of MapPOIs.layers) add(`map-json/${name}.json`, Buffer.from(JSON.stringify(projectMapLayer(name, local[name]))), 'br');
  for (const tile of tiles) add(tile.key, tile.bytes, 'identity');
  const manifest = { ...manager.manifest, files, warnings: {}, version: digest(JSON.stringify(files)) };
  const allowed = new Set(Object.values(files).map(entry => entry.url));
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/overlay/v1/manifest.json') {
        const etag = `"${manifest.version}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag }).end(JSON.stringify(manifest));
        return;
      }
      const key = req.url?.startsWith('/overlay/v1/') ? req.url.slice('/overlay/v1/'.length) : '';
      if (!allowed.has(key)) { res.writeHead(404).end(); return; }
      if (!objects.has(key)) objects.set(key, Buffer.from((await axios.get(new URL(key, manifestUrl).href,
        { responseType: 'arraybuffer', timeout: 30000 })).data));
      res.writeHead(200).end(objects.get(key));
    } catch (error) { res.writeHead(502).end(); console.error(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log(`Local map fixture: http://127.0.0.1:${server.address().port}/overlay/v1/manifest.json`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
