'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ArenaPresence } = require('../src/modules/arenaPresence');
const { DungeonMap } = require('../src/modules/dungeonMap');
const { ArenaWatcher } = require('../src/modules/arenaWatcher');
const table = require('./fixtures/underCityGauntlet.json');
const glades = require('./fixtures/gladesProcLevel.json');
const gladesArena = require('./fixtures/gladesArenaEvidence.json');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = code => ({ active: true, status: 'ready', key: 'underCityMidrath', set: 'UnderCityMidrath', levelPath: table.level_path, layoutCode: code });
const ready = (captured, rooms = ['UnderCityEntranceHall', 'UnderCityArena'], version = 'feed') => ({ state: { ...captured }, status: 'ready', version, rooms: rooms.map(room => ({ room })) });

function fixture({ read, retryMs = 10000 } = {}) {
  let current = state(table.test_vectors.arena), version = 'feed', now = 100;
  const locations = [], tiles = [], requests = [];
  const arenaWatcher = { setDungeonState(value) { locations.push(value); }, setTilePresence(value) { tiles.push(value); } };
  const dungeonMap = { getLayoutSnapshot(value) { requests.push(value); return read ? read(value) : Promise.resolve(ready(value, undefined, version)); } };
  const controller = new ArenaPresence({ arenaWatcher, dungeonMap, getState: () => current, getVersion: () => version, retryMs, now: () => now });
  return { controller, requests, locations, tiles,
    get state() { return current; }, set state(value) { current = value; }, set version(value) { version = value; }, set now(value) { now = value; } };
}

test('the real decoder confirms an arena without room outlines and rejects a complete non-arena layout', async () => {
  const requests = [];
  const map = new DungeonMap({ dataManager: { getInfo: () => ({ version: 'feed' }), checkForUpdates: async () => {},
    ensureAsset: async key => { requests.push(key); if (key.endsWith('/rooms.json')) throw new Error('Geometry unavailable'); },
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: [table] } : null } });
  const f = fixture({ read: value => map.getLayoutSnapshot(value) });
  await f.controller.update(); assert.equal(f.tiles.at(-1), true);
  assert.equal(requests.some(key => key.endsWith('/rooms.json')), false, 'Presence does not request image/outline data');
  f.state = state(table.test_vectors.without_arena);
  await f.controller.update(); assert.equal(f.tiles.at(-1), false);
});

test('missing diagnostics and unavailable metadata stay pending until real room decoding recovers', async () => {
  let current = state(table.test_vectors.arena), available = false, now = 0;
  const watcher = new ArenaWatcher();
  const map = new DungeonMap({ dataManager: { getInfo: () => ({ version: 'feed' }),
    checkForUpdates: async () => {}, ensureAsset: async () => {},
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: available ? [table] : [] } : null } });
  const controller = new ArenaPresence({ arenaWatcher: watcher, dungeonMap: map,
    getState: () => current, getVersion: () => 'feed', now: () => now });
  const enter = () => watcher._processLine(`STATS ENTER_LEVEL ${current.levelPath}/${current.layoutCode}.lp`);
  enter(); await controller.update();
  assert.deepEqual(watcher.getDetection(), { state: 'unknown', source: 'none' }, 'No physics error does not prove arena absence');
  available = true; now = 10000; await controller.update();
  assert.deepEqual(watcher.getDetection(), { state: 'arena', source: 'tiles' }, 'Room decoding needs neither Windows tracking nor a physics error');
  current = state(table.test_vectors.without_arena); enter(); await controller.update();
  assert.deepEqual(watcher.getDetection(), { state: 'no_arena', source: 'tiles' }, 'Only a complete current room list confirms absence');
});

test('only the exact wave-arena room confirms presence', async () => {
  const f = fixture({ read: value => Promise.resolve(ready(value, ['GoAxGarrenRoodBossArena', 'UnderCityArenaDecoration', 'OtherArena'])) });
  await f.controller.update(); assert.equal(f.tiles.at(-1), false);
});

test('real Glades tables identify the wave room independently of the reused Undercity script name', async () => {
  const map = new DungeonMap({ dataManager: { getInfo: () => ({ version: 'feed' }), checkForUpdates: async () => {},
    ensureAsset: async key => { assert.doesNotMatch(key, /rooms\.json/); },
    readJSON: key => key === 'dungeons/index.json'
      ? { sets: [{ key: 'gladesofAndurin', level_paths: [glades.level_path] }] }
      : key === 'dungeons/gladesofAndurin/layouts.json' ? { layouts: [glades] } : null } });
  const watcher = new ArenaWatcher();
  const f = fixture({ read: captured => map.getLayoutSnapshot(captured) });
  f.controller.arenaWatcher = watcher;
  // A feed alias must still use the canonical decoded set's room identity.
  f.state = { active: true, status: 'ready', key: 'feedAlias', set: 'GladesofAndurin',
    levelPath: glades.level_path, layoutCode: gladesArena.test_vectors.arena };
  watcher._processLine(`STATS ENTER_LEVEL ${glades.level_path}/${f.state.layoutCode}.lp`);
  const positive = await f.controller.update();
  assert.equal(positive.setKey, 'gladesofAndurin');
  assert.ok(positive.rooms.some(room => room.room === gladesArena.room));
  assert.deepEqual(watcher.getDetection(), { state: 'arena', source: 'tiles' });
  // Wave parsing remains shared: this Glades room runs UnderCityArena.lua.
  // Use the canonical watcher state so its independent raw cursor can bind.
  watcher.setDungeonState({ ...f.state, key: 'gladesofAndurin' }); watcher.setTilePresence(true);
  for (const line of ['UnderCityArena.lua: New wave:', 'Wave Number: 7', 'Tier: 2']) watcher._processLine(line);
  assert.equal(watcher.getWave().wave, 7);
  for (const layoutCode of [gladesArena.test_vectors.without_arena, 'SeXCNGh9IRWPOteCiCAIQgAI']) {
    f.state = { ...f.state, layoutCode };
    await f.controller.update();
    assert.deepEqual(watcher.getDetection(), { state: 'no_arena', source: 'tiles' });
  }
});

test('Glades quest boss and similarly named rooms never confirm the wave arena', async () => {
  for (const rooms of [[gladesArena.excluded_quest_room.room], ['GoAxDeadendGarrenRoodDecoration'], ['UnderCityArena']]) {
    const f = fixture({ read: captured => Promise.resolve(ready(captured, rooms)) });
    f.state = { active: true, status: 'ready', key: 'gladesofAndurin', levelPath: glades.level_path,
      layoutCode: gladesArena.test_vectors.arena };
    await f.controller.update(); assert.equal(f.tiles.at(-1), false);
  }
});

test('same-fingerprint reentry rejects the previous entry decoder response', async () => {
  const gate = deferred(), f = fixture({ read: captured => captured.instanceId === 'old-entry' ? gate.promise : Promise.resolve(ready(captured, ['UnderCityEntranceHall'])) });
  f.state = { ...f.state, instanceId: 'old-entry' };
  const old = f.controller.update(); await tick();
  const captured = f.state;
  f.state = { ...f.state, instanceId: 'new-entry' }; await f.controller.update();
  assert.equal(f.tiles.at(-1), false);
  gate.resolve(ready(captured)); await old;
  assert.equal(f.tiles.at(-1), false, 'Old arena tile confirmation cannot return after reentry');
});

test('location changes are delivered immediately and same-instance concurrent lookups share one request', async () => {
  const gate = deferred(), f = fixture({ read: () => gate.promise });
  const initial = f.controller.update();
  assert.deepEqual(f.locations.at(-1), f.state); assert.notEqual(f.locations.at(-1), f.state);
  const duplicate = f.controller.update(); assert.equal(duplicate, initial);
  await tick(); assert.equal(f.requests.length, 1);
  gate.resolve(ready(f.state)); await initial;
  await f.controller.update(); assert.equal(f.requests.length, 1, 'Successful same-version decoding is cached');
});

test('metadata failures preserve fallback and retry only after the configured delay', async () => {
  let unavailable = true;
  const f = fixture({ read: value => unavailable ? Promise.reject(new Error('Offline metadata')) : Promise.resolve(ready(value)) });
  await f.controller.update(); assert.equal(f.tiles.at(-1), null);
  await f.controller.update(); assert.equal(f.requests.length, 1);
  f.now = 10100; unavailable = false; await f.controller.update();
  assert.equal(f.requests.length, 2); assert.equal(f.tiles.at(-1), true);
});

test('an unavailable response is retryable while empty or malformed ready lists cannot assert absence', async () => {
  for (const response of [{ status: 'unavailable', rooms: [] }, { status: 'ready', rooms: [] }, { status: 'ready', rooms: [{ room: null }] }]) {
    const f = fixture({ read: value => Promise.resolve({ state: value, version: 'feed', ...response }) });
    await f.controller.update(); assert.equal(f.tiles.at(-1), null);
    await f.controller.update(); assert.equal(f.requests.length, 1);
    f.now = 10100; await f.controller.update(); assert.equal(f.requests.length, 2);
  }
});

test('new fingerprints invalidate pending results and preserve the new authoritative result', async () => {
  const old = deferred(), f = fixture({ read: value => value.layoutCode === table.test_vectors.arena ? old.promise : Promise.resolve(ready(value, ['UnderCityConGreenhouse'])) });
  const first = f.controller.update(); await tick();
  const prior = f.state; f.state = state(table.test_vectors.without_arena);
  await f.controller.update(); assert.equal(f.tiles.at(-1), false);
  old.resolve(ready(prior)); assert.equal(await first, null); assert.equal(f.tiles.at(-1), false);
});

test('leaving invalidates pending work even when no second update has run yet', async () => {
  const gate = deferred(), f = fixture({ read: () => gate.promise });
  const old = f.state, pending = f.controller.update(); await tick();
  f.state = { status: 'outside', active: false };
  gate.resolve(ready(old)); assert.equal(await pending, null); assert.notEqual(f.tiles.at(-1), true);
  await f.controller.update(); assert.deepEqual(f.locations.at(-1), f.state); assert.equal(f.tiles.at(-1), null);
});

test('scope mismatches cannot promote a response to authoritative tile evidence', async () => {
  for (const override of [{ key: 'other' }, { levelPath: '/SF/Levels/Procs/Other' }, { layoutCode: 'AA' }, { status: 'waiting' }]) {
    const f = fixture({ read: value => Promise.resolve({ ...ready(value), state: { ...value, ...override } }) });
    await f.controller.update(); assert.equal(f.tiles.at(-1), null);
  }
});

test('a metadata version change retries immediately and stale-version completion is ignored', async () => {
  const f = fixture(); await f.controller.update();
  f.version = 'new'; await f.controller.update(); assert.equal(f.requests.length, 2); assert.equal(f.tiles.at(-1), true);
  const old = deferred(), g = fixture({ read: () => old.promise });
  const pending = g.controller.update(); await tick(); g.version = 'new';
  old.resolve(ready(g.state)); assert.equal(await pending, null); assert.equal(g.tiles.at(-1), null);
});

test('a refresh that upgrades metadata within one request is accepted and cached at the new version', async () => {
  const f = fixture({ read: value => { f.version = 'upgraded'; return Promise.resolve(ready(value, undefined, 'upgraded')); } });
  await f.controller.update(); assert.equal(f.tiles.at(-1), true);
  await f.controller.update(); assert.equal(f.requests.length, 1);
});

test('waiting and malformed instances do not request layouts or mutate their input', async () => {
  for (const override of [{ status: 'waiting' }, { key: '../other' }, { levelPath: '/SF/Levels/Procs/../Other' }, { layoutCode: '%bad' }, { active: false }]) {
    const f = fixture(); f.state = Object.freeze({ ...f.state, ...override });
    const original = { ...f.state }; await f.controller.update();
    assert.equal(f.requests.length, 0); assert.equal(f.tiles.at(-1), null); assert.deepEqual(f.state, original);
  }
});

test('stop cancels pending work, clears location and restarts cleanly without leaking a timer', async () => {
  const gate = deferred(), f = fixture({ read: () => gate.promise });
  f.controller.start(); const interval = f.controller.interval;
  f.controller.start(); assert.equal(f.controller.interval, interval);
  await tick(); const oldState = f.state;
  f.controller.stop(); assert.equal(f.controller.interval, null); assert.deepEqual(f.locations.at(-1), { status: 'unknown', active: false });
  gate.resolve(ready(oldState)); await tick(); assert.equal(f.tiles.at(-1), null);
  assert.equal(await f.controller.update(), null);
  f.controller.start(); await tick(); assert.equal(f.tiles.at(-1), true); f.controller.stop();
});

test('unavailable state readers and inert native-test watchers normalize to unknown without requesting metadata', async () => {
  let calls = 0;
  const controller = new ArenaPresence({ arenaWatcher: {}, getState() { throw new Error('Watcher not available'); },
    dungeonMap: { getLayoutSnapshot() { calls++; } } });
  assert.equal(await controller.update(), null); assert.equal(calls, 0);
  controller.start(); controller.stop(); assert.equal(calls, 0);
});
