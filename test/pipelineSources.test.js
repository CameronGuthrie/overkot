'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sourcePath, sourcePaths, tilePaths, TILE_COUNT } = require('../scripts/pipeline-paths');
const { openSource, hash } = require('../scripts/overlay-feed/source');

const layout = () => ({ tiles: Array.from({ length: TILE_COUNT }, (_, index) => ({ index, image: `renamedMap/${index}.webp` })) });

test('local imports prefer canonical artifacts, languages and map JSON with legacy fallback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-pipeline-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('overkot-pipeline-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of ['ava_api_items.json', 'Languages_en.json', 'map/map-json/world_trees.json']) {
    const [canonical, legacy] = sourcePaths(key);
    const write = name => {
      const filename = path.join(root, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, '{}');
      return filename;
    };
    assert.equal(sourcePath(root, key), path.join(root, canonical));
    const oldFile = write(legacy);
    assert.equal(sourcePath(root, key), oldFile);
    const current = write(canonical);
    assert.equal(sourcePath(root, key), current);
    assert.equal(sourcePath(root, canonical), current);
    fs.unlinkSync(current);
    assert.equal(sourcePath(root, canonical), oldFile);
  }
});

test('tile references reject traversal, absolute paths, duplicates and incomplete grids', () => {
  assert.equal(tilePaths(layout()).get(195), 'renamedMap/195.webp');
  for (const image of ['../secret.webp', '/0.webp', 'C:/0.webp', 'map\\0.webp', 'map//0.webp', 'map/./0.webp', 'https://host/0.webp']) {
    const value = layout(); value.tiles[0].image = image;
    assert.throws(() => tilePaths(value), /Unsafe tile layout image path/);
  }
  const duplicate = layout(); duplicate.tiles[195].index = 0;
  assert.throws(() => tilePaths(duplicate), /Invalid or duplicate/);
  const missing = layout(); missing.tiles.pop();
  assert.throws(() => tilePaths(missing), /exactly 196 tiles/);
});

function s3Fixture(files) {
  const build_id = 'fixture', prefix = `builds/${build_id}`, objects = new Map();
  const entries = Object.entries(files).map(([name, value]) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    objects.set(`${prefix}/${name}`, bytes);
    return { path: name, sha256: hash(bytes), bytes: bytes.length };
  });
  objects.set('current.json', Buffer.from(JSON.stringify({ build_id, prefix })));
  objects.set(`${prefix}/manifest.json`, Buffer.from(JSON.stringify({ build_id, files: entries })));
  const requests = [];
  return { objects, requests, getObject: async key => {
    requests.push(key);
    if (!objects.has(key)) throw new Error(`Unexpected S3 request: ${key}`);
    return objects.get(key);
  } };
}

test('S3 source resolves canonical files, validates their hashes and keeps raw JSON outside its allowlist', async () => {
  const f = s3Fixture({
    'Artifacts/ava_api_items.json': { items: ['current'] },
    'ava_api_items.json': { items: ['stale'] },
    'Languages/Languages_en.json': { current: 'language' },
    'maps/map-json/world_trees.json': { positions: [] },
    'maps/map-json/dungeon_entrances.json': { Crypt: [] },
    'maps/map-json/tile_layout.json': layout(),
    'maps/renamedMap/0.webp': 'tile 0',
    'maps/map-json/entities.json': { raw: 'private' },
  });
  const source = await openSource(f);
  assert.deepEqual(await source.readJSON('ava_api_items.json'), { items: ['current'] });
  assert.deepEqual(await source.readJSON('Languages_en.json'), { current: 'language' });
  assert.deepEqual(await source.readJSON('map/map-json/world_trees.json'), { positions: [] });
  assert.deepEqual(await source.readJSON('map/map-json/dungeon_entrances.json'), { Crypt: [] });
  assert.ok(!source.entries.has('maps/map-json/entities.json'));
  await assert.rejects(source.readJSON('maps/map-json/entities.json'), /outside overlay source allowlist/);
  await assert.rejects(source.readJSON('maps/renamedMap/0.webp'), /outside overlay source allowlist/);
  const tiles = await source.tileEntries();
  assert.equal(tiles.size, TILE_COUNT);
  assert.equal(tiles.get(0).path, 'maps/renamedMap/0.webp');
  assert.ok(tiles.get(0).entry);
  assert.equal(tiles.get(195).entry, undefined);
  f.objects.set('builds/fixture/maps/map-json/world_trees.json', Buffer.from('damaged'));
  const corrupt = await openSource(f);
  await assert.rejects(corrupt.readJSON('map/map-json/world_trees.json'), /S3 content hash mismatch/);
});

test('S3 source retains older exports with and without compatibility tile layouts', async () => {
  for (const withLayout of [false, true]) {
    const files = {
      'ava_api_items.json': { items: [] },
      'Languages_en.json': { old: 'language' },
      'map/map-json/world_trees.json': { positions: [] },
      'map/map-tiles/0.webp': 'tile 0',
    };
    if (withLayout) files['map/map-json/tile_layout.json'] = {
      tiles: layout().tiles.map(tile => ({ ...tile, image: `map-tiles/${tile.index}.webp` })),
    };
    const source = await openSource(s3Fixture(files));
    assert.deepEqual(await source.readJSON('Artifacts/ava_api_items.json'), { items: [] });
    assert.deepEqual(await source.readJSON('Languages/Languages_en.json'), { old: 'language' });
    assert.deepEqual(await source.readJSON('maps/map-json/world_trees.json'), { positions: [] });
    const tiles = await source.tileEntries();
    assert.equal(tiles.get(0).path, 'map/map-tiles/0.webp');
    assert.ok(tiles.get(0).entry);
  }
});
