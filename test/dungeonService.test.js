'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DungeonMap } = require('../src/modules/dungeonMap');
const table = require('./fixtures/underCityCliffCave.json');
const cliffTown = require('./fixtures/underCityCliffTown.json');
const glades = require('./fixtures/gladesProcLevel.json');

const state = code => ({ active: true, set: 'UnderCityMidrath', key: 'underCityMidrath',
  levelPath: table.level_path, layoutCode: code });
const document = { rooms: [...table.spawns, ...table.components].map(entry => ({ room: entry.room,
  outline: [{ closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }] })) };

test('concurrent layout requests upgrade cached legacy tables before the scheduled data check', async () => {
  let version = 'old', forced = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const legacy = { ...table }; delete legacy.serialization;
  const manager = {
    getInfo: () => ({ version }), ensureAsset: async () => {},
    checkForUpdates: async options => {
      if (options?.force) { forced++; await gate; version = 'new'; }
    },
    readJSON: key => key.endsWith('/rooms.json') ? document
      : key.endsWith('/layouts.json') ? { layouts: [version === 'old' ? legacy : table] } : null,
  };
  const maps = new DungeonMap({ dataManager: manager });
  const scenes = [maps.getSnapshot(state('KhGCACHMpRNZ3fAghiCAAQjA')),
    maps.getSnapshot(state('ShGaIa5IZlKJq676AAGIIAhAEYA'))];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forced, 1, 'Concurrent layout requests share the early metadata refresh');
  release();
  const results = await Promise.all(scenes);
  assert.deepEqual(results.map(scene => [scene.version, scene.mode, scene.rooms.length]),
    [['new', 'placed', 8], ['new', 'placed', 9]]);
  for (const scene of results) assert.deepEqual(scene.missingRooms, []);
});

test('an offline metadata upgrade returns no rooms without repeated forced requests', async () => {
  let forced = 0;
  const legacy = { ...table }; delete legacy.serialization;
  const manager = { getInfo: () => ({ version: 'old' }), ensureAsset: async () => {},
    checkForUpdates: async options => { if (options?.force) { forced++; return { error: 'offline' }; } },
    readJSON: key => key.endsWith('/rooms.json') ? document : key.endsWith('/layouts.json') ? { layouts: [legacy] } : null };
  const maps = new DungeonMap({ dataManager: manager });
  for (let i = 0; i < 2; i++) {
    const scene = await maps.getSnapshot(state('KhGCACHMpRNZ3fAghiCAAQjA'));
    assert.equal(scene.mode, 'unavailable'); assert.deepEqual(scene.rooms, []); assert.equal(scene.bounds, null);
  }
  assert.equal(forced, 1);
});

test('every generator can upgrade a legacy table and resolve a fresh instance', async () => {
  for (const [freshTable, key, code, expectedCount] of [
    [cliffTown, 'underCityMidrath', 'ShF45xiBqkiijMpxNZ2XU-QAGIIQACEAABGA', 13],
    [glades, 'gladesofAndurin', 'SeXCNGh9IRWPOteCiCAIQgAI', 10],
  ]) {
    let version = 'old', forced = 0;
    const legacy = { ...freshTable }; delete legacy.serialization;
    const rooms = { rooms: [...freshTable.spawns, ...freshTable.components].map(entry => ({ room: entry.room,
      outline: [{ closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }] })) };
    const manager = { getInfo: () => ({ version }), ensureAsset: async () => {},
      checkForUpdates: async options => { if (options?.force) { forced++; version = 'new'; } },
      readJSON: path => path.endsWith('/rooms.json') ? rooms
        : path.endsWith('/layouts.json') ? { layouts: [version === 'old' ? legacy : freshTable] } : null };
    const result = await new DungeonMap({ dataManager: manager }).getSnapshot({ active: true, key,
      levelPath: freshTable.level_path, layoutCode: code });
    assert.equal(forced, 1); assert.equal(result.version, 'new');
    assert.equal(result.mode, 'placed'); assert.equal(result.rooms.length, expectedCount);
    assert.deepEqual(result.missingRooms, []);
  }
});

test('re-entering a generator replaces the previous instance with the fresh route', async () => {
  const document = { rooms: [...cliffTown.spawns, ...cliffTown.components].map(entry => ({ room: entry.room,
    outline: [{ closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }] })) };
  const manager = { getInfo: () => ({ version: 'feed' }), ensureAsset: async () => {}, checkForUpdates: async () => {},
    readJSON: key => key.endsWith('/rooms.json') ? document : key.endsWith('/layouts.json') ? { layouts: [cliffTown] } : null };
  const map = new DungeonMap({ dataManager: manager });
  const state = { active: true, key: 'underCityMidrath', levelPath: cliffTown.level_path };
  const first = await map.getSnapshot({ ...state, layoutCode: 'ShF45xiBqkiijMpxNZ2XU-QAGIIQACEAABGA' });
  assert.equal(first.mode, 'placed'); assert.equal(first.rooms.length, 13);
  assert.equal((await map.getSnapshot({ active: false })).reason, 'outside');
  const waiting = await map.getSnapshot({ ...state, layoutCode: null });
  assert.equal(waiting.reason, 'waiting'); assert.deepEqual(waiting.rooms, []);
  const next = await map.getSnapshot({ ...state, layoutCode: 'SeJaAJFQ5lSJqxhhy-AkBiAAAAgCMA' });
  assert.equal(next.mode, 'placed'); assert.equal(next.rooms.length, 10);
  assert.notDeepEqual(first.rooms.map(room => room.room), next.rooms.map(room => room.room));
});
