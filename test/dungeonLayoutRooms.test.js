'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DungeonMap } = require('../src/modules/dungeonMap');
const { decodeLayout } = require('../src/modules/dungeonLayout');
const glades = require('./fixtures/gladesProcLevel.json');
const cliff = require('./fixtures/underCityCliffCave.json');
const GLADES_CODE = 'SeXCNGh9IRWPOteCiCAIQgAI';
const state = (layoutCode = GLADES_CODE) => ({ active: true, set: 'GladesofAndurin', key: 'gladesofAndurin',
  levelPath: glades.level_path, layoutCode });
const shapes = table => ({ rooms: [...table.spawns, ...table.components].map(entry => ({ room: entry.room,
  outline: [{ closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }] })) });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('fully decoded room identities do not require geometry or a rendered minimap', async () => {
  const requested = [];
  const service = new DungeonMap({ dataManager: {
    getInfo: () => ({ version: 'fixture' }), checkForUpdates: async () => {},
    ensureAsset: async key => { requested.push(key); if (key.endsWith('/rooms.json')) throw new Error('Geometry unavailable'); },
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: [glades] } : null,
  } });
  const result = await service.getLayoutSnapshot(state());
  assert.equal(result.status, 'ready'); assert.equal(result.reason, null); assert.equal(result.version, 'fixture');
  assert.deepEqual(result.rooms.map(room => room.room), decodeLayout(GLADES_CODE, glades).rooms.map(room => room.room));
  assert.equal(result.rooms.length, 10);
  assert.equal(result.rooms.some(room => room.room === 'GoAxDeadendGarrenRood'), false, 'This captured Glades layout does not contain its wave-arena room');
  assert.equal(requested.some(key => key.endsWith('/rooms.json')), false, 'Presence checks never download outlines');
  const map = await service.getSnapshot(state());
  assert.equal(map.mode, 'unavailable'); assert.equal(map.reason, 'data'); assert.deepEqual(map.rooms, []);
  assert.equal((await service.getLayoutSnapshot(state())).status, 'ready', 'A map geometry failure cannot invalidate decoded identities');
});

test('maps and room checks share one concurrent layout request and return independent snapshots', async () => {
  let release, layoutRequests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = new DungeonMap({ dataManager: {
    getInfo: () => ({ version: 'fixture' }), checkForUpdates: async () => {},
    ensureAsset: async key => { if (key.endsWith('/layouts.json')) { layoutRequests++; await gate; } },
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: [glades] } : key.endsWith('/rooms.json') ? shapes(glades) : null,
  } });
  const mutable = state(), roomsRequest = service.getLayoutSnapshot(mutable), mapRequest = service.getSnapshot(state());
  mutable.layoutCode = 'not-the-captured-instance';
  await tick(); assert.equal(layoutRequests, 1); release();
  const [rooms, map] = await Promise.all([roomsRequest, mapRequest]);
  assert.equal(rooms.status, 'ready'); assert.equal(map.rooms.length, rooms.rooms.length);
  assert.equal(rooms.state.layoutCode, GLADES_CODE);
  rooms.rooms[0].room = 'Modified by consumer'; rooms.state.layoutCode = 'changed';
  const next = await service.getLayoutSnapshot(state());
  assert.equal(next.state.layoutCode, GLADES_CODE); assert.equal(next.rooms[0].room, glades.spawns[0].room);
  assert.equal(layoutRequests, 1, 'A completed fingerprint reuses the decoder cache');
});

test('incomplete and corrupt fingerprints never return a partial ready room list', async () => {
  const service = new DungeonMap({ dataManager: {
    getInfo: () => ({ version: 'fixture' }), checkForUpdates: async () => {}, ensureAsset: async () => {},
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: [glades] } : null,
  } });
  for (const code of [null, '', GLADES_CODE.slice(0, -2), GLADES_CODE + 'AAAA', '../not-a-layout']) {
    const result = await service.getLayoutSnapshot(state(code));
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.rooms, []);
    assert.equal(result.reason, code ? 'decode' : 'waiting');
  }
  const concurrent = await Promise.all([service.getLayoutSnapshot(state('not-a-fingerprint')),
    service.getLayoutSnapshot(state('not-a-fingerprint'))]);
  assert.ok(concurrent.every(result => result.status === 'unavailable' && result.rooms.length === 0));
  assert.equal((await service.getLayoutSnapshot(state())).status, 'ready');
});

test('exact feed aliases use the same generator table without loading geometry', async () => {
  const requested = [];
  const service = new DungeonMap({ dataManager: {
    getInfo: () => ({ version: 'indexed' }), checkForUpdates: async () => {}, ensureAsset: async key => requested.push(key),
    readJSON: key => key === 'dungeons/index.json' ? { sets: [{ key: 'gladesofAndurin', level_paths: [glades.level_path] }] }
      : key === 'dungeons/gladesofAndurin/layouts.json' ? { layouts: [glades] } : null,
  } });
  const result = await service.getLayoutSnapshot({ ...state(), key: 'futureAlias', levelPath: glades.level_path + '.level' });
  assert.equal(result.status, 'ready'); assert.equal(result.rooms.length, 10);
  assert.ok(requested.includes('dungeons/gladesofAndurin/layouts.json'));
  assert.equal(requested.some(key => /futureAlias|rooms\.json/.test(key)), false);
});

test('unavailable metadata is retryable at the same feed version and upgrades are bounded', async () => {
  let available = false, forced = 0;
  const service = new DungeonMap({ dataManager: {
    getInfo: () => ({ version: 'same-feed' }), ensureAsset: async () => {},
    checkForUpdates: async options => { if (options?.force) forced++; },
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: available ? [glades] : [] } : null,
  } });
  for (let i = 0; i < 2; i++) {
    const result = await service.getLayoutSnapshot(state());
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.rooms, []);
  }
  assert.equal(forced, 1);
  available = true;
  assert.equal((await service.getLayoutSnapshot(state())).status, 'ready');
  assert.equal(forced, 1);
});

test('concurrent room checks upgrade legacy tables without any room outlines', async () => {
  let version = 'old', forced = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const legacy = { ...cliff }; delete legacy.serialization;
  const service = new DungeonMap({ dataManager: {
    getInfo: () => ({ version }), ensureAsset: async () => {},
    checkForUpdates: async options => { if (options?.force) { forced++; await gate; version = 'new'; } },
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: [version === 'old' ? legacy : cliff] } : null,
  } });
  const makeState = layoutCode => ({ active: true, set: 'UnderCityMidrath', key: 'underCityMidrath', levelPath: cliff.level_path, layoutCode });
  const first = service.getLayoutSnapshot(makeState('KhGCACHMpRNZ3fAghiCAAQjA'));
  const second = service.getLayoutSnapshot(makeState('ShGaIa5IZlKJq676AAGIIAhAEYA'));
  await tick(); assert.equal(forced, 1); release();
  const result = await Promise.all([first, second]);
  assert.deepEqual(result.map(item => [item.status, item.version, item.rooms.length]), [['ready', 'new', 8], ['ready', 'new', 9]]);
});

test('outside, unsafe sets and unavailable update services cannot manufacture room presence', async () => {
  let requests = 0;
  const service = new DungeonMap({ dataManager: {
    getInfo: () => ({ version: 'fixture' }), ensureAsset: async () => { requests++; }, readJSON: () => null,
    checkForUpdates: async () => { throw new Error('Offline'); },
  } });
  assert.equal((await service.getLayoutSnapshot({ active: false })).reason, 'outside');
  assert.equal((await service.getLayoutSnapshot({ ...state(), key: '../unsafe' })).reason, 'unsupported');
  const result = await service.getLayoutSnapshot(state());
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.rooms, []); assert.equal(requests, 0);
});

test('the verified Fortress fallback decodes without geometry only for its exact generator', async () => {
  const service = new DungeonMap({ dataManager: {
    getInfo: () => ({ version: 'fixture' }), ensureAsset: async () => {}, readJSON: () => null, checkForUpdates: async () => {},
  } });
  const fortress = { active: true, set: 'FallenFortress', key: 'fallenFortress',
    levelPath: '/SF/Levels/Procs/FallenFortress/FallenFortressProcLevel', layoutCode: 'SSMCETyBURHUPG29PZBAQAAAAIAIIgA' };
  assert.equal((await service.getLayoutSnapshot(fortress)).status, 'ready');
  const other = await service.getLayoutSnapshot({ ...fortress, levelPath: '/SF/Levels/Procs/FallenFortress/UnknownLevel' });
  assert.equal(other.status, 'unavailable'); assert.equal(other.reason, 'unsupported'); assert.deepEqual(other.rooms, []);
});
