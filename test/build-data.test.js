'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { tile } = require('./fixtures/map-assets');
const {
  buildData, canonicalJSON, projectMapLayer, projectLocations, validateOutputDirectory,
  POI_LAYERS, TILE_COUNT,
} = require('../scripts/build-data');

const APP_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(APP_DIR, 'output');
const { SUPPORTED_LOCALES: LOCALES } = require('../src/modules/gameLocales');
const position = { x: 10, y: -30, z: 20 };

test('canonical JSON is independent of dictionary order, preserving array order', () => {
  assert.equal(canonicalJSON({ z: { b: 1, a: 2 }, a: [3, 2, 1] }), '{"a":[3,2,1],"z":{"a":2,"b":1}}');
  assert.equal(canonicalJSON({ z: 2, a: 1 }), canonicalJSON({ a: 1, z: 2 }));
});

test('map projection strips extraction details and rejects unusable pipeline data', () => {
  assert.deepEqual(projectMapLayer('world_trees', { positions: [{ position, position_offset: 456144, note: 'raw extraction' }] }), {
    positions: [{ position }],
  });
  assert.deepEqual(projectMapLayer('avakot_spawns', { positions: [] }), { positions: [] });
  assert.deepEqual(projectMapLayer('named_locations', [{ has_position: false, name: 'FortCurlail' }]), []);
  assert.deepEqual(projectMapLayer('faction_enclaves', { enclaves: [{ entity_type: 'FlootTotemADeco', position }] }), { enclaves: [] });
  assert.throws(() => projectMapLayer('world_trees', { positions: [{ position: { x: 0, y: 56.61, z: 3895.21 } }] }), /outside the current map/);
});

test('location packs include actual marker labels without unrelated language data', () => {
  const data = {
    '/SF/Language/Locations/MapTree': 'World Tree',
    '/SF/Language/NPC/Avakot': 'Avakot',
    '/SF/Language/Items/WevetWoodSap': 'Sap',
    '/SF/Language/Characters/SubBossSpider': 'Spider',
    '/SF/Language/Characters/Unused': 'Unused',
    '/Credits/Credits': 'Credits',
  };
  const result = projectLocations(data, { named_locations: [], boss_encounters: [{ subboss_type: 'SubBossSpider' }] });
  assert.equal(Object.keys(result).length, 4);
  assert.equal(result['/SF/Language/Characters/SubBossSpider'], 'Spider');
  assert.equal(result['/Credits/Credits'], undefined);
});

test('publisher cannot write outside the application output directory', async () => {
  await assert.rejects(validateOutputDirectory(APP_DIR), /must be a subdirectory/);
  await assert.rejects(validateOutputDirectory(path.resolve(APP_DIR, '..', 'outside')), /must be a subdirectory/);
});

for (const schema of ['legacy', 'canonical']) test(`${schema} feeds are deterministic and a single language edit only creates its changed object`, async (t) => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(OUTPUT_DIR, 'test-build-data-'));
  t.after(async () => {
    const relative = path.relative(OUTPUT_DIR, fixture);
    assert.ok(relative.startsWith('test-build-data-') && !relative.includes(path.sep));
    await fs.rm(fixture, { recursive: true, force: true });
  });
  const source = path.join(fixture, 'pipeline');
  const out = path.join(fixture, 'feed');
  const maps = path.join(source, schema === 'canonical' ? 'maps' : 'map', 'map-json');
  const tiles = path.join(source, schema === 'canonical' ? 'maps/renamedExporter' : 'map/map-tiles');
  const languages = schema === 'canonical' ? path.join(source, 'Languages') : source;
  await fs.mkdir(maps, { recursive: true });
  await fs.mkdir(tiles, { recursive: true });
  await fs.mkdir(languages, { recursive: true });
  if (schema === 'canonical') await fs.writeFile(path.join(maps, 'tile_layout.json'), JSON.stringify({
    tiles: Array.from({ length: TILE_COUNT }, (_, index) => ({ index, image: `renamedExporter/${index}.webp` })),
  }));
  const marker = { position };
  const layerFixtures = {
    faction_enclaves: { enclaves: [{ ...marker, entity_type: 'MapChampionFactionMarkerInfo' }] },
    world_trees: { positions: [marker] },
    avakot_spawns: { positions: [{ ...marker, npc_type: 'AvakotVendorNpc' }] },
    sap_trees: { positions: [marker] },
    vadagar_pools: { pools: [{ ...marker, enabled: true }] },
    ode_organs: { positions: [marker] },
    boss_encounters: [{ ...marker, subboss_type: 'SubBossSpider', is_siege: false }],
    named_locations: [{ ...marker, has_position: true, name: 'Fort', loc_tag: '/SF/Language/Locations/FortCurlail' }],
    dungeon_entrances: { Crypt: [{ ...marker, name: 'CryptEntranceSouth', marker_kind: 'dungeon_entrance' }] },
  };
  for (const name of POI_LAYERS) await fs.writeFile(path.join(maps, `${name}.json`), JSON.stringify(layerFixtures[name]));
  await Promise.all(Array.from({ length: TILE_COUNT }, (_, i) => fs.writeFile(path.join(tiles, `${i}.webp`), tile)));
  const language = {
    '/SF/Language/Locations/MapTree': 'World Tree',
    '/SF/Language/Locations/FortCurlail': 'Fort Curlail',
    '/SF/Language/Items/WevetSeedConsumableName': 'Wevet Seed',
  };
  for (const locale of LOCALES) await fs.writeFile(path.join(languages, `Languages_${locale}.json`), JSON.stringify(language));
  if (schema === 'canonical') {
    // A stale compatibility copy must not override the canonical dictionary.
    await fs.writeFile(path.join(source, 'Languages_en.json'), '{}');
  }

  const first = await buildData({ source, out });
  const { validateManifest } = require('../src/modules/dataUpdates');
  assert.equal(validateManifest(first.manifest), first.manifest);
  assert.equal(first.stats.files, 206 + 2 * LOCALES.length);
  assert.ok(Object.keys(first.manifest.files).every(key => !/^(?:maps|Languages|Artifacts)\//.test(key)));
  for (const entry of Object.values(first.manifest.files)) {
    const compressed = await fs.readFile(path.join(out, entry.url));
    const decoded = entry.encoding === 'br' ? zlib.brotliDecompressSync(compressed) : compressed;
    assert.equal(compressed.length, entry.downloadBytes);
    assert.equal(path.basename(entry.url).split('.')[0], crypto.createHash('sha256').update(compressed).digest('hex'));
    assert.equal(decoded.length, entry.bytes);
    assert.equal(crypto.createHash('sha256').update(decoded).digest('hex'), entry.sha256);
  }
  const second = await buildData({ source, out });
  assert.equal(first.manifest.version, second.manifest.version);
  assert.equal(second.stats.objectsWritten, 0);

  const edited = { ...language, '/SF/Language/Items/WevetSeedConsumableName': 'Updated Seed' };
  await fs.writeFile(path.join(languages, 'Languages_en.json'), JSON.stringify(edited));
  const third = await buildData({ source, out });
  assert.equal(third.stats.objectsWritten, 1);
  assert.deepEqual(Object.keys(first.manifest.files).filter(key =>
    first.manifest.files[key].sha256 !== third.manifest.files[key].sha256), ['names/en.json']);
  assert.notEqual(first.manifest.version, third.manifest.version);

  await fs.unlink(path.join(maps, 'dungeon_entrances.json'));
  const legacy = await buildData({ source, out });
  assert.equal(legacy.manifest.files['map-json/dungeon_entrances.json'], undefined);
  assert.equal(legacy.stats.files, first.stats.files - 1);

  const manifestBeforeFailure = await fs.readFile(path.join(out, 'manifest.json'), 'utf8');
  await fs.unlink(path.join(tiles, '195.webp'));
  await assert.rejects(buildData({ source, out }), schema === 'canonical' ? /ENOENT/ : /exactly 0.webp through 195.webp/);
  assert.equal(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'), manifestBeforeFailure);
});
