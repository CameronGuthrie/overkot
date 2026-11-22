const test = require('node:test');
const assert = require('node:assert/strict');
const MapPOIs = require('../src/renderer/map-pois');
const { projectMapLayer } = require('../scripts/build-data');
const at = (x, extra = {}) => ({ position: { x, y: -30, z: 20 }, ...extra });

test('null and omitted overrides remain visible; explicit disabled and invalid positions do not', () => {
  const pools = [at(10, { enabled: null }), at(20), at(30, { enabled: true }), at(40, { enabled: false }),
    at(1793), at('50'), at(NaN), { position: { x: 60, y: null, z: 20 } }, null];
  const markers = MapPOIs.normalize({ vadagar_pools: { pools }, world_trees: { positions: [at(10, { enabled: false })] } });
  assert.equal(markers.length, 3);
  assert.ok(markers.every(marker => marker.category === 'vadagar' && /may be inactive/.test(MapPOIs.title(marker))));
});

test('waypoints supply all dungeon categories without drawing a second legacy entrance', () => {
  const markers = MapPOIs.normalize({
    dungeon_entrances: { Crypt: [at(53.5, { name: 'CryptEntranceSouth', portal: at(49.5) })],
      FallenFortress: [at(623.1756, { name: 'FallenFortressOne' })], Undercity: [at(-560.46)] },
    named_locations: [at(53.5, { name: 'CryptDungeon', has_position: true }), at(100, { name: 'FortCurlail' })],
  });
  assert.equal(markers.length, 4);
  const entrances = markers.filter(marker => marker.category === 'dungeons');
  assert.equal(entrances.length, 3);
  assert.equal(entrances[0].px, (53.5 + 1792) * 2);
  assert.ok(entrances.every(marker => marker.icon === 'EntranceDown.webp' && /access requirements/.test(marker.detail)));
  assert.equal(entrances[2].label, 'Undercity');
  assert.equal(MapPOIs.normalize({ dungeon_entrances: { positions: [at(1)] } })[0].category, 'dungeons');
});

test('legacy dungeon fallback is used only when the dedicated layer is unavailable', () => {
  const named_locations = [at(10, { name: 'GladesDungeon' })];
  assert.equal(MapPOIs.normalize({ named_locations })[0].category, 'dungeons');
  assert.equal(MapPOIs.normalize({ named_locations, dungeon_entrances: null }).length, 1);
  assert.equal(MapPOIs.normalize({ named_locations, dungeon_entrances: {} }).length, 0);
});

test('vendor types, duplicate records, hidden placements and missing boss labels are handled independently', () => {
  const boss = at(3, { subboss_type: 'SubBossSpider' });
  const markers = MapPOIs.normalize({
    avakot_spawns: { positions: [at(1, { npc_type: 'AvakotNpc' }), at(2, { npc_type: 'AvakotVendorNpc', start_hidden: true })] },
    boss_encounters: [boss, boss, at(3, { subboss_type: 'SubBossMaceBanneret' }), at(4), at(5, { is_siege: true }), at(6, { enabled: false })],
  });
  assert.equal(markers.length, 4);
  assert.match(markers[0].detail, /Hidden initially/);
  assert.equal(markers.at(-1).label, 'Boss Encounter');
});

test('generic bannerets, banneret patrols and collector ships are hidden while named bosses remain', () => {
  const types = ['BossBanneret', 'BossBanneretPatrol', 'BossCollectorShip', 'SubBossMaceBanneret', 'SubBossSpider'];
  const markers = MapPOIs.normalize({ boss_encounters: types.map((subboss_type, i) => at(i, { subboss_type })) });
  assert.deepEqual(markers.map(marker => marker.label), ['Mace Banneret', 'Spider']);
  assert.equal(projectMapLayer('boss_encounters', types.map((subboss_type, i) => at(i, { subboss_type }))).length, 2);
});

test('map labels use each corrected lore key, with a readable fallback when a resource is missing', async () => {
  const prefix = '/SF/Language/Locations/';
  const markers = await MapPOIs.load({
    getMapData: async name => name === 'named_locations' ? [
      at(1, { name: 'FortCurlail', loc_tag: prefix + 'FortCurlail' }),
      at(2, { name: 'FonnishFortRuinsName', loc_tag: prefix + 'FonnishFortRuinsName' }),
      at(3, { name: 'Wyndoun', loc_tag: null }),
    ] : null,
    resolveLocationNames: async () => ({ [prefix + 'FortCurlail']: 'Fort Curlail', [prefix + 'FonnishFortRuinsName']: 'Fonnish Fort Ruins' }),
  });
  assert.deepEqual(markers.map(marker => marker.label), ['Fort Curlail', 'Fonnish Fort Ruins', 'Wyndoun']);
});

test('a missing optional layer or localization failure does not hide other layers', async () => {
  const requests = [];
  const markers = await MapPOIs.load({
    getMapData: async name => {
      requests.push(name);
      if (name === 'dungeon_entrances') throw new Error('Unknown map layer');
      return name === 'world_trees' ? { positions: [at(1)] } : null;
    },
    resolveLocationNames: async () => { throw new Error('Offline'); },
  });
  assert.deepEqual(requests, MapPOIs.layers);
  assert.equal(markers[0].label, 'World Tree');
  assert.deepEqual(await MapPOIs.load({}, () => false), []);
});

test('localized names are resolved together and shared by both map renderers', async () => {
  let calls = 0;
  const markers = await MapPOIs.load({
    getMapData: async name => name === 'world_trees' ? { positions: [at(1), at(2)] } : null,
    resolveLocationNames: async keys => {
      calls++;
      assert.deepEqual(keys, ['/SF/Language/Locations/MapTree']);
      return { [keys[0]]: 'Arbre-Monde' };
    },
  });
  assert.equal(calls, 1);
  assert.ok(markers.every(marker => marker.label === 'Arbre-Monde'));
});

test('schema 2 projection preserves nullable overrides and entrance positions without extraction internals', () => {
  const pools = projectMapLayer('vadagar_pools', { pools: [at(1, { enabled: null }), at(2, { enabled: false })] });
  assert.equal(pools.pools.length, 1);
  assert.equal(pools.pools[0].enabled, null);
  const entrances = projectMapLayer('dungeon_entrances', { Crypt: [at(53.5, { body_offset: 123, portal: at(49.5) })] });
  assert.deepEqual(entrances, { positions: [at(53.5, { category: 'Crypt' })] });
  assert.equal(MapPOIs.normalize({ dungeon_entrances: entrances }).length, 1);
});

test('north-up world coordinates align with column-major south-to-north tile filenames', () => {
  assert.deepEqual(MapPOIs.worldToMapPixel(-1792, 1792), { px: 0, py: 0 });
  assert.deepEqual(MapPOIs.worldToMapPixel(1792, -1792), { px: 7168, py: 7168 });
  assert.deepEqual(MapPOIs.getTilePos(0), { x: 0, y: 6656 });
  assert.deepEqual(MapPOIs.getTilePos(13), { x: 0, y: 0 });
  assert.deepEqual(MapPOIs.getTilePos(195), { x: 6656, y: 0 });
});
