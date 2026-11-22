'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PlayerTracking, zoneOf } = require('../src/modules/playerTracking');
const tick = () => new Promise(resolve => setImmediate(resolve));
const dungeon = (id = 'entry-1') => ({ active: true, status: 'ready', instanceId: id, layoutCode: 'ABC',
  levelPath: '/SF/Levels/Procs/UnderCityGauntlet', key: 'underCityMidrath' });

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overkot-tracking-'));
  let now = 10000, account = 'account-one', state = { active: false, status: 'outside',
    instanceId: 'overworld-entry', levelPath: '/SF/Levels/Procs/MidrathProc' }, version = 'feed';
  const reader = new EventEmitter(); reader.status = { status: 'stopped', trackingSession: null };
  reader.getState = () => reader.status;
  reader.start = pid => { reader.pid = pid; };
  reader.stop = () => { reader.pid = null; reader.update('stopped', null); };
  reader.update = (status, trackingSession = 'process-session') => {
    reader.status = { status, trackingSession }; reader.emit('status', reader.status);
  };
  const tracking = new PlayerTracking({ directory, reader, now: () => now, getState: () => state,
    getAccountId: () => account, getVersion: () => version,
    getLayoutSnapshot: options.getLayoutSnapshot || (async captured => ({ state: captured, status: 'ready', version,
      coordinateSpace: options.space || 'layout-local', rooms: options.rooms || [] })),
    getScene: async captured => ({ state: captured, version, mode: 'placed', rooms: [] }) });
  const locations = []; tracking.on('location', value => locations.push(value));
  t.after(async () => { tracking.stop(); await tracking.discovery.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  tracking.start(123); reader.update('tracking');
  return { tracking, reader, locations, directory,
    pose(heading = -90, extra = {}) { reader.emit('pose', { source: 'memory', sampledAt: now, trackingSession: 'process-session',
      position: { x: 100, y: 20, z: -10 }, heading, ...extra }); },
    set state(value) { state = value; }, get state() { return state; }, set account(value) { account = value; },
    set version(value) { version = value; }, set now(value) { now = value; } };
}

test('canonical zone mapping recognizes only the verified overworld wrapper', () => {
  assert.equal(zoneOf({ active: false, levelPath: '/SF/Levels/Procs/MidrathProc' }), '/SF/Levels/MidrathRedux');
  assert.equal(zoneOf({ active: true, levelPath: '/SF/Levels/Procs/MidrathProc' }), '/SF/Levels/Procs/MidrathProc');
  assert.equal(zoneOf({ active: false, levelPath: '/SF/Levels/Unknown' }), '/SF/Levels/Unknown');
  for (const levelPath of [null, {}, '/SF/Levels/../foo', '/SF/Levels/Foo?bar']) assert.equal(zoneOf({ levelPath }), null);
});

test('live poses expose a scoped position and body heading without private helper fields', async t => {
  const f = await fixture(t); f.pose(-90, { pointer: 'private', cameraForward: { x: 1 } });
  const location = f.tracking.getLocation();
  assert.equal(location.source, 'memory'); assert.equal(location.isOverworld, true); assert.equal(location.heading, 270);
  assert.deepEqual(location.position, { x: 100, y: 20, z: -10 });
  assert.equal(location.instanceId, 'overworld-entry'); assert.equal(location.zone, '/SF/Levels/MidrathRedux');
  assert.equal('pointer' in location, false); assert.equal('cameraForward' in location, false);
  assert.equal(f.tracking.getStatus().status, 'tracking');
  f.pose(null); assert.equal(f.tracking.getLocation().heading, null);
});

const droppedStultin = (fields = {}) => ({ id: 'drop-1',
  itemType: '/SF/Weapons/Melee/OneHand/MockeryStultion/MockeryStultionMeleeWeapon',
  position: { x: 102, y: 20, z: -11 }, shiny: false, ...fields });
function drops(f, sampledAt = 10000, items = [droppedStultin()], fields = {}) {
  f.reader.emit('world-drops', { type: 'world-drops', source: 'memory', status: 'available',
    sampledAt, trackingSession: 'process-session', items, ...fields });
}

test('a live ground-weapon snapshot publishes a resolved name without leaking native fields', async t => {
  const f = await fixture(t); f.pose();
  drops(f, 10000, [droppedStultin({ privateAddress: 'discard', quality: 'stock', tempers: [] })]);
  const snapshot = f.tracking.getLocation().worldDrops;
  assert.equal(snapshot.status, 'available'); assert.equal(snapshot.sampledAt, 10000);
  assert.deepEqual(snapshot.items, [{ id: 'drop-1', name: 'Stultin', kind: 'weapon', shiny: false,
    position: { x: 102, y: 20, z: -11 } }]);
  assert.deepEqual(f.locations.at(-1).worldDrops, snapshot, 'Drop refresh publishes immediately without waiting for movement');
  drops(f, 10001, [droppedStultin({ id: 'shiny-1', shiny: true })]);
  f.now = 10001;
  assert.equal(f.tracking.getLocation().worldDrops.items[0].shiny, true);
});

test('pickup, missing telemetry and stale drops clear markers while player tracking continues', async t => {
  const f = await fixture(t); f.pose(); drops(f);
  f.now = 10100; drops(f, 10100, []);
  assert.deepEqual(f.tracking.getLocation().worldDrops.items, [], 'An empty complete set removes picked-up weapons');
  f.now = 10200; drops(f, 10200); f.now = 10300;
  drops(f, 10300, [], { status: 'unavailable' });
  assert.equal(f.tracking.getLocation().worldDrops.status, 'unavailable');
  f.now = 10400; drops(f, 10400); f.now = 12500; f.pose();
  assert.equal(f.tracking.getLocation().status, 'found');
  assert.deepEqual(f.tracking.getLocation().worldDrops.items, [], 'A current player pose cannot prolong stale loot');
});

test('drop snapshots require a fresh player, the current entry and matching process session', async t => {
  const f = await fixture(t); drops(f);
  assert.equal(f.tracking.worldDrops.read('process-session').status, 'unavailable', 'No drop set is retained before a live player pose');
  f.pose(); drops(f, 10000, [droppedStultin()], { trackingSession: 'another-process' });
  assert.equal(f.tracking.getLocation().worldDrops.status, 'unavailable');
  drops(f); assert.equal(f.tracking.getLocation().worldDrops.items.length, 1);
  f.now = 10100; f.state = { ...f.state, instanceId: 'overworld-reentry' }; await f.tracking.refresh(); f.pose();
  drops(f, 10099);
  assert.equal(f.tracking.getLocation().worldDrops.status, 'unavailable', 'Packets from before an entry transition cannot reappear');
  drops(f, 10100); assert.equal(f.tracking.getLocation().worldDrops.items.length, 1);
  f.account = null; f.tracking.refresh();
  assert.equal(f.tracking.getLocation().status, 'unavailable');
  assert.deepEqual(f.tracking.worldDrops.read('process-session').items, []);
});

test('only nearby actual drop positions reach the map feed', async t => {
  const f = await fixture(t); f.pose();
  drops(f, 10000, [droppedStultin(), droppedStultin({ id: 'distant', position: { x: 181, y: 20, z: -10 } }),
    droppedStultin({ id: 'far-above', position: { x: 100, y: 101, z: -10 } })]);
  assert.deepEqual(f.tracking.getLocation().worldDrops.items.map(item => item.id), ['drop-1']);
});

test('dungeon drops share the verified player transform without revealing new exploration', async t => {
  const f = await fixture(t); f.state = dungeon(); await f.tracking.refresh();
  const root = { source: 'stream-region', levelPath: f.state.levelPath, layoutCode: f.state.layoutCode,
    matrix: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 100, 1000, -200, 1] };
  f.pose(135, { position: { x: 110, y: 990, z: -205 }, dungeonRoot: root });
  await f.tracking.flush();
  const before = (await f.tracking.discovery.load({ instanceId: f.state.instanceId, revision: 'feed' })).exploration;
  drops(f, 10000, [droppedStultin({ position: { x: 112, y: 990, z: -208 } })]);
  const location = f.tracking.getLocation(), mapped = location.worldDrops.items[0].dungeon;
  assert.deepEqual(mapped.position, { x: 8, z: 12 });
  assert.equal(mapped.scope, location.dungeon.scope); assert.equal(mapped.alignmentVerified, true);
  assert.equal('dungeonRoot' in location.worldDrops.items[0], false);
  await f.tracking.flush();
  assert.deepEqual((await f.tracking.discovery.load({ instanceId: f.state.instanceId, revision: 'feed' })).exploration, before,
    'Observing a weapon never expands discovered map area');
  f.now = 10100; f.pose(135, { position: { x: 110, y: 990, z: -205 } });
  assert.equal(f.tracking.getLocation().worldDrops.items[0].dungeon, undefined, 'Missing current placement proof hides a dungeon marker');
});

test('stale, future, wrong-session and malformed samples cannot replace a valid pose', async t => {
  const f = await fixture(t); f.pose(); const count = f.locations.length;
  for (const extra of [{ sampledAt: 7999 }, { sampledAt: 10001 }, { trackingSession: 'other' }, { position: { x: Infinity, y: 0, z: 0 } }]) f.pose(0, extra);
  assert.equal(f.locations.length, count);
  f.now = 12001; assert.equal(f.tracking.getLocation().status, 'unavailable'); assert.equal(f.tracking.getStatus().status, 'stale');
});

test('area entry and logout clear poses synchronously and never reuse captured positions', async t => {
  const f = await fixture(t); f.pose();
  f.state = dungeon(); f.tracking.refresh();
  assert.equal(f.locations.at(-1).status, 'unavailable'); assert.equal(f.tracking.getLocation().status, 'unavailable');
  f.pose(); assert.equal(f.tracking.getLocation().isOverworld, false); assert.equal(f.tracking.getLocation().dungeon, undefined);
  f.account = null; assert.equal(f.tracking.getLocation().status, 'unavailable'); assert.equal(f.tracking.getOwner(), null);
  f.pose(); assert.equal(f.tracking.getLocation().status, 'unavailable');
});

test('layout-local coordinates remain unavailable until a verified alignment exists', async t => {
  const f = await fixture(t); f.state = dungeon(); await f.tracking.refresh(); f.pose();
  assert.equal(f.tracking.getLocation().dungeon, undefined);
  const saved = await f.tracking.discovery.load({ instanceId: f.state.instanceId, revision: 'feed' });
  assert.equal(saved.ok, true); assert.equal(saved.alignment.status, 'detecting'); assert.equal(saved.exploration.cells.length, 0);
});

test('world-space dungeon tables map poses to the exact issued discovery scope', async t => {
  const f = await fixture(t, { space: 'world' }); f.state = dungeon(); await f.tracking.refresh(); f.pose(45);
  const location = f.tracking.getLocation();
  assert.deepEqual(location.dungeon.position, { x: 100, z: -10 }); assert.equal(location.dungeon.heading, 45);
  assert.equal(location.dungeon.alignmentVerified, true); assert.equal(location.dungeon.coordinateSpace, 'world');
  const discovery = await f.tracking.discovery.load({ instanceId: f.state.instanceId, revision: 'feed' });
  assert.equal(location.dungeon.scope, discovery.scope);
});

test('a delayed layout response cannot bind a departed dungeon or another account', async t => {
  let resolve; const pending = new Promise(yes => { resolve = yes; });
  const f = await fixture(t, { getLayoutSnapshot: () => pending });
  f.state = dungeon(); const oldState = f.state, task = f.tracking.refresh(); await tick();
  f.state = { active: false, status: 'outside' }; f.account = 'another-account'; f.tracking.refresh();
  resolve({ state: oldState, status: 'ready', version: 'feed', coordinateSpace: 'world' }); await task;
  assert.equal(f.tracking.context, null); assert.equal(f.tracking.getLocation().status, 'unavailable');
});

test('new entries, feed revisions and process sessions receive separate contexts', async t => {
  const f = await fixture(t, { space: 'world' }); f.state = dungeon(); await f.tracking.refresh(); f.pose();
  const first = f.tracking.getLocation().dungeon.scope;
  f.state = dungeon('entry-2'); await f.tracking.refresh(); f.pose(); assert.notEqual(f.tracking.getLocation().dungeon.scope, first);
  const second = f.tracking.getLocation().dungeon.scope;
  f.version = 'feed-two'; await f.tracking.refresh(); f.pose(); assert.notEqual(f.tracking.getLocation().dungeon.scope, second);
  f.reader.update('searching', null); assert.equal(f.tracking.getLocation().status, 'unavailable');
  assert.equal(f.tracking.getOwner(), null);
});

test('disabling stops the helper and suppresses samples; reenable restarts it', async t => {
  const f = await fixture(t); f.pose(); f.tracking.setEnabled(false);
  assert.equal(f.reader.pid, null); assert.equal(f.tracking.getStatus().status, 'disabled');
  f.pose(); assert.equal(f.tracking.getLocation().status, 'unavailable');
  f.tracking.setEnabled(true); assert.equal(f.reader.pid, 123);
  f.reader.update('tracking'); f.pose(); assert.equal(f.tracking.getLocation().status, 'found');
});

test('explicit F6 captures work without native tracking and expire on a context change', async t => {
  const f = await fixture(t); f.reader.update('unsupported-build', null);
  f.tracking.beginCapture();
  f.tracking.acceptCapture({ status: 'found', position: { x: 1, y: 2, z: 3 }, heading: 30, zone: '/SF/Levels/MidrathRedux', isOverworld: true });
  assert.equal(f.tracking.getLocation().source, 'capture');
  f.state = dungeon(); f.tracking.refresh(); assert.equal(f.tracking.getLocation().status, 'unavailable');
});

test('a completed F6 capture clears its UI while preserving newer live character tracking', async t => {
  const f = await fixture(t); f.pose(90);
  f.tracking.beginCapture();
  f.tracking.acceptCapture({ status: 'found', position: { x: 1, y: 2, z: 3 }, heading: 30, zone: '/SF/Levels/MidrathRedux', isOverworld: true });
  assert.equal(f.locations.at(-1).captureCompleted, true); assert.equal(f.locations.at(-1).source, 'memory');
  assert.equal(f.locations.at(-1).heading, 90); assert.equal(f.locations.at(-1).position.x, 100);
  assert.equal(f.tracking.getLocation().captureCompleted, undefined);
});

test('native dungeon placement enables local tracking and discovery without position clicks', async t => {
  const f = await fixture(t); f.state = dungeon(); await f.tracking.refresh();
  const root = { source: 'stream-region', levelPath: f.state.levelPath, layoutCode: f.state.layoutCode,
    matrix: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 100, 1000, -200, 1] };
  f.pose(135, { position: { x: 110, y: 990, z: -205 }, dungeonRoot: root });
  await f.tracking.flush();
  const location = f.tracking.getLocation();
  assert.ok(Math.hypot(location.dungeon.position.x - 5, location.dungeon.position.z - 10) < 1e-10);
  assert.equal(location.dungeon.heading, 45);
  assert.equal(location.dungeon.alignmentVerified, true); assert.equal('dungeonRoot' in location, false);
  const saved = await f.tracking.discovery.load({ instanceId: f.state.instanceId, revision: 'feed' });
  assert.equal(saved.alignment.status, 'verified'); assert.equal(saved.alignment.points, 0);
  assert.ok(saved.exploration.cells.length > 0, 'The backend remembers movement with no map window');
  f.now = 10100; f.pose(135, { position: { x: 111, y: 990, z: -205 } });
  assert.equal(f.tracking.getLocation().dungeon, undefined, 'A packet without current root proof cannot use the old transform');
});

test('a delayed root from another dungeon cannot enable discovery in the current entry', async t => {
  const f = await fixture(t); f.state = dungeon(); await f.tracking.refresh();
  f.pose(0, { dungeonRoot: { source: 'stream-region', levelPath: '/SF/Levels/Procs/Other', layoutCode: f.state.layoutCode,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 1000, -200, 1] } });
  await f.tracking.flush();
  assert.equal(f.tracking.getLocation().dungeon, undefined);
  assert.equal((await f.tracking.discovery.load({ instanceId: f.state.instanceId, revision: 'feed' })).exploration.cells.length, 0);
});

test('a newly streamed dungeon requests one background root refresh without restarting player tracking', async t => {
  const f = await fixture(t); let refreshes = 0;
  f.reader.refreshRoots = () => { refreshes++; return true; };
  f.pose(); assert.equal(refreshes, 0, 'Overworld samples do not request dungeon searches');
  f.state = dungeon(); await f.tracking.refresh();
  f.pose(); f.now = 10100; f.pose(); f.now = 10200; f.pose(); assert.equal(refreshes, 1);
  assert.equal(f.reader.pid, 123, 'The live player helper remains attached');
  f.state = dungeon('another-entry'); await f.tracking.refresh(); f.pose(); assert.equal(refreshes, 2);
});

const frameRooms = [
  { transform: { x: 0, y: 0, z: 0, rotation: 0 } },
  { transform: { x: 30, y: 1, z: 7, rotation: .7 } },
  { transform: { x: -13, y: -2, z: 44, rotation: -.2 } },
];
const frameCloud = (x = 100, y = 990, z = -200) => frameRooms.map(({ transform: room }) => {
  const c = Math.cos(room.rotation), s = Math.sin(room.rotation);
  return { source: 'level-info', matrix: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x + room.x, y + room.y, z + room.z, 1] };
});

test('the complete native room graph maps and remembers a player without exposing raw frames', async t => {
  const f = await fixture(t, { rooms: frameRooms }); f.state = dungeon(); await f.tracking.refresh();
  f.pose(45, { position: { x: 107, y: 991, z: -188 }, dungeonFrames: frameCloud(), dungeonFramesTimestamp: 10000 });
  await f.tracking.flush();
  const location = f.tracking.getLocation();
  assert.deepEqual(location.dungeon.position, { x: 7, z: 12 }); assert.equal(location.dungeon.heading, 45);
  for (const key of ['dungeonFrames', 'dungeonFramesTimestamp', 'dungeonRoot']) assert.equal(Object.hasOwn(location, key), false);
  const saved = await f.tracking.discovery.load({ instanceId: f.state.instanceId, revision: 'feed' });
  assert.equal(saved.alignment.source, 'level-info-fit'); assert.equal(saved.alignment.points, 0);
  assert.ok(saved.exploration.cells.length > 0);
  f.now = 10100; f.pose(45, { position: { x: 108, y: 991, z: -188 }, dungeonFrames: frameCloud(), dungeonFramesTimestamp: 10000 });
  await f.tracking.flush(); assert.deepEqual(f.tracking.getLocation().dungeon.position, { x: 8, z: 12 });
});

test('missing, stale and pre-entry room clouds cannot use a remembered root or legacy loading origin', async t => {
  const f = await fixture(t, { rooms: frameRooms }); f.state = dungeon(); await f.tracking.refresh();
  const legacy = { source: 'stream-region', levelPath: f.state.levelPath, layoutCode: f.state.layoutCode,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1000, 0, 1] };
  for (const [timestamp, frames] of [[9999, frameCloud()], [10001, frameCloud()], [10000, frameCloud().slice(1)], [10000, []]]) {
    f.pose(0, { dungeonFrames: frames, dungeonFramesTimestamp: timestamp, dungeonRoot: legacy });
    await f.tracking.flush(); assert.equal(f.tracking.getLocation().dungeon, undefined);
  }
  f.pose(0, { dungeonFrames: frameCloud(), dungeonFramesTimestamp: 10000 }); await f.tracking.flush();
  assert.ok(f.tracking.getLocation().dungeon);
  f.now = 12100; f.pose(0, { dungeonFrames: frameCloud(), dungeonFramesTimestamp: 10000 });
  await f.tracking.flush(); assert.equal(f.tracking.getLocation().dungeon, undefined);
  f.state = dungeon('next-entry'); await f.tracking.refresh();
  f.pose(0, { dungeonFrames: frameCloud(), dungeonFramesTimestamp: 12099 });
  await f.tracking.flush(); assert.equal(f.tracking.getLocation().dungeon, undefined);
  f.pose(0, { dungeonFrames: frameCloud(), dungeonFramesTimestamp: 12100 });
  await f.tracking.flush(); assert.ok(f.tracking.getLocation().dungeon);
});

test('a cloud received while layout metadata loads is fitted once that exact entry is ready', async t => {
  let resolve; const pending = new Promise(yes => { resolve = yes; });
  const f = await fixture(t, { getLayoutSnapshot: () => pending }); f.state = dungeon(); const task = f.tracking.refresh();
  f.pose(0, { position: { x: 101, y: 990, z: -198 }, dungeonFrames: frameCloud(), dungeonFramesTimestamp: 10000 });
  assert.equal(f.tracking.getLocation().dungeon, undefined);
  resolve({ state: f.state, status: 'ready', version: 'feed', coordinateSpace: 'layout-local', rooms: frameRooms });
  await task; await f.tracking.flush();
  assert.deepEqual(f.tracking.getLocation().dungeon.position, { x: 1, z: 2 });
});
