'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DungeonDiscoveryStore, contextKey } = require('../src/modules/dungeonDiscoveryStore');
const { createExploration } = require('../src/modules/dungeonExploration');
const { fitAlignment } = require('../src/modules/mapAlignment');
const { alignmentFromRoot } = require('../src/modules/dungeonRootAlignment');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const context = (extra = {}) => ({ account: 'private-account', process: 'process-session', instanceId: 'entry-1',
  levelPath: '/SF/Levels/Procs/FixtureDungeon', layoutCode: 'ABC123', revision: 'feed-1', coordinateSpace: 'world', ...extra });
const input = value => ({ instanceId: value.instanceId, revision: value.revision });
const exploration = (...cells) => ({ schema: 1, radius: 45, cellSize: 8, cells });
const scene = value => ({ mode: 'placed', version: value.revision, coordinateSpace: value.coordinateSpace,
  state: { active: true, instanceId: value.instanceId }, rooms: [{ transform: { x: 0, z: 0, rotation: 0 },
    outline: [{ closed: true, points: [[0, 0], [100, 0], [100, 100], [0, 100]] }] }] });
const mapPoints = [{ x: 10, z: 10 }, { x: 40, z: 10 }, { x: 10, z: 40 }];
const worldPoint = point => ({ x: point.z + 120, z: -point.x - 320 });
const observations = mapPoints.map(map => ({ map, world: worldPoint(map) }));
const detecting = { status: 'detecting', source: 'level-info-fit', points: 0 };
const nativeRoot = (value = context(), { yaw = Math.PI / 2, x = 120, z = -320, height = 5, ...extra } = {}) => ({
  source: 'level-info-fit', levelPath: value.levelPath, layoutCode: value.layoutCode,
  matrix: [Math.cos(yaw), 0, -Math.sin(yaw), 0, 0, 1, 0, 0, Math.sin(yaw), 0, Math.cos(yaw), 0, x, height, z, 1], ...extra,
});

function memoryFs() {
  const files = new Map(), calls = [], hooks = {};
  return { files, calls, hooks,
    async stat(file) { calls.push(['stat', file]); if (hooks.stat) return hooks.stat(file); if (!files.has(file)) throw new Error('Missing'); return { size: Buffer.byteLength(files.get(file)) }; },
    async readFile(file) { calls.push(['read', file]); if (hooks.read) return hooks.read(file); return files.get(file); },
    async mkdir(directory) { calls.push(['mkdir', directory]); if (hooks.mkdir) await hooks.mkdir(directory); },
    async writeFile(file, value) { calls.push(['write', file]); if (hooks.write) await hooks.write(file, value); files.set(file, value); },
    async rename(from, to) { calls.push(['rename', from, to]); if (hooks.rename) await hooks.rename(from, to); files.set(to, files.get(from)); files.delete(from); },
    async unlink(file) { calls.push(['unlink', file]); files.delete(file); },
  };
}

function fixture(options = {}) {
  let current = context(options.context), owner = { account: current.account, process: current.process }, now = 10000, pose = null, sceneReply;
  const fs = options.fs || memoryFs(), events = [], timers = new Map(); let timerId = 0;
  const directory = path.resolve(__dirname, '../.build/discovery-store-fixture');
  const store = new DungeonDiscoveryStore({ directory, fsImpl: fs, getContext: () => current, getOwner: () => owner,
    getPose: () => pose, getScene: async () => typeof sceneReply === 'function' ? sceneReply() : sceneReply || scene(current), now: () => now,
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); } });
  store.on('changed', data => events.push(data));
  return { store, fs, events, timers, directory,
    get context() { return current; }, set context(value) { current = value; },
    get owner() { return owner; }, set owner(value) { owner = value; },
    get now() { return now; }, set now(value) { now = value; },
    get pose() { return pose; }, set pose(value) { pose = value; },
    set scene(value) { sceneReply = value; },
    location(position = { x: 10, z: 10 }, extra = {}) { return { status: 'found', source: 'memory', instanceId: current.instanceId,
      trackingSession: current.process, sampledAt: now, position, heading: 90, isOverworld: false, ...extra }; },
    disk(value = current) { return path.join(directory, `${contextKey(value)}.json`); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await tick();
    },
  };
}

async function align(f) {
  for (const map of mapPoints) {
    f.pose = f.location(worldPoint(map));
    const result = await f.store.addPoint({ ...input(f.context), map });
    assert.equal(result.ok, true, result.message);
  }
  return f.store.load(input(f.context));
}

test('scopes hide account/process identifiers and all identity dimensions have separate disk keys', async () => {
  const f = fixture();
  const result = await f.store.load(input(f.context));
  assert.equal(result.ok, true);
  assert.match(result.scope, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.alignment, { status: 'verified', points: 3 });
  assert.deepEqual(result.exploration.cells, []);
  assert.equal(JSON.stringify(result).includes('private-account'), false);
  for (const field of ['account', 'process', 'instanceId', 'levelPath', 'layoutCode', 'revision', 'coordinateSpace']) {
    assert.notEqual(contextKey(f.context), contextKey({ ...f.context, [field]: `${f.context[field]}-different` }), field);
  }
  assert.equal(f.fs.calls[0][1], f.disk());
  assert.doesNotMatch(f.fs.calls[0][1], /private-account|process-session|ABC123/);
});

test('malformed contexts, missing owners and mismatched scene requests do not read or write disk', async () => {
  for (const field of ['account', 'process', 'instanceId', 'levelPath', 'layoutCode', 'revision']) {
    for (const value of [null, '', ' ', false, 1, {}, [], 'bad\nvalue', 'x'.repeat(4097)]) {
      const f = fixture(); f.context = { ...f.context, [field]: value };
      assert.equal((await f.store.load(input(f.context))).ok, false, `${field}: ${String(value).slice(0, 20)}`);
      assert.deepEqual(f.fs.calls, []);
    }
  }
  for (const change of [f => { f.context = null; }, f => { f.owner = null; },
    f => { f.owner = { ...f.owner, account: 'other' }; }, f => { f.context = { ...f.context, coordinateSpace: 'schematic' }; }]) {
    const f = fixture(); change(f);
    assert.equal((await f.store.load(input(context()))).ok, false);
    assert.deepEqual(f.fs.calls, []);
  }
  const f = fixture();
  for (const bad of [null, [], {}, { instanceId: 'other', revision: 'feed-1' }, { instanceId: 'entry-1', revision: 'old' }]) assert.equal((await f.store.load(bad)).ok, false);
  assert.deepEqual(f.fs.calls, []);
});

test('two windows and delayed stale snapshots merge monotonically without revealing connecting corridors', async () => {
  const f = fixture(); const first = await f.store.load(input(f.context));
  const saves = await Promise.all([
    f.store.save({ scope: first.scope, exploration: exploration([0, 0]) }),
    f.store.save({ scope: first.scope, exploration: exploration([100, 0]) }),
  ]);
  assert.ok(saves.every(result => result.ok));
  const result = await f.store.save({ scope: first.scope, exploration: exploration([0, 0]) });
  assert.deepEqual(result.exploration.cells, [[0, 0], [100, 0]]);
  const model = createExploration(); model.restore(result.exploration);
  assert.equal(model.isRevealed(50, 0), false, 'Saved circle lists are not interpreted as player movement');
  assert.deepEqual(JSON.parse(f.fs.files.get(f.disk())).exploration, result.exploration);
  assert.equal(f.events.length, 3);
});

test('forged scopes, malformed exploration and other account/process owners cannot save', async () => {
  const f = fixture(); const first = await f.store.load(input(f.context));
  for (const bad of [null, {}, { scope: '../escape', exploration: exploration([0, 0]) },
    { scope: first.scope, exploration: exploration([NaN, 0]) }, { scope: first.scope, exploration: { ...exploration(), radius: 999 } }]) {
    assert.equal((await f.store.save(bad)).ok, false);
  }
  for (const owner of [null, { account: 'other', process: f.context.process }, { account: f.context.account, process: 'other' }]) {
    f.owner = owner;
    assert.equal((await f.store.save({ scope: first.scope, exploration: exploration([0, 0]) })).ok, false);
  }
  assert.equal(f.fs.calls.some(([name]) => name === 'write'), false);
});

test('a retired scene accepts its closing window final save only while account and process still own it', async () => {
  const f = fixture(); const old = await f.store.load(input(f.context));
  const oldContext = f.context;
  f.context = { ...f.context, instanceId: 'entry-2' };
  const next = await f.store.load(input(f.context));
  assert.notEqual(next.scope, old.scope);
  const retired = await f.store.save({ scope: old.scope, exploration: exploration([20, 20]) });
  assert.equal(retired.ok, true);
  assert.deepEqual(JSON.parse(f.fs.files.get(f.disk(oldContext))).exploration.cells, [[20, 20]]);
  assert.deepEqual((await f.store.load(input(f.context))).exploration.cells, []);
  assert.equal(f.events.length, 0, 'Retired saves never broadcast into the current dungeon');
  f.context = null;
  assert.equal((await f.store.save({ scope: old.scope, exploration: exploration([40, 40]) })).ok, true, 'Outside transition preserves the current game owner');
  f.owner = { account: 'other-account', process: oldContext.process };
  assert.equal((await f.store.save({ scope: old.scope, exploration: exploration([60, 60]) })).ok, false);
});

test('reset rotates scope, clears discovery and rejects stale or queued old-scope saves', async () => {
  const f = fixture(); const first = await f.store.load(input(f.context));
  await f.store.save({ scope: first.scope, exploration: exploration([0, 0]) });
  const resetting = f.store.reset(input(f.context)); await tick();
  const reset = await resetting;
  assert.equal(reset.ok, true); assert.equal(reset.reset, true); assert.equal(reset.previousScope, first.scope);
  assert.notEqual(reset.scope, first.scope); assert.deepEqual(reset.exploration.cells, []);
  assert.equal((await f.store.save({ scope: first.scope, exploration: exploration([100, 100]) })).ok, false);
  assert.equal((await f.store.save({ scope: reset.scope, exploration: exploration([20, 20]) })).ok, true);
  const persisted = JSON.parse(f.fs.files.get(f.disk()));
  assert.equal(persisted.generation, 1); assert.deepEqual(persisted.exploration.cells, [[20, 20]]);
  const restarted = fixture({ fs: f.fs });
  assert.equal((await restarted.store.load(input(restarted.context))).scope, reset.scope);
});

test('unaligned local maps cannot accept discovery and require three matching floor observations', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } });
  const first = await f.store.load(input(f.context));
  assert.deepEqual(first.alignment, detecting);
  assert.equal((await f.store.save({ scope: first.scope, exploration: exploration([10, 10]) })).ok, false);
  assert.equal(f.store.mappedPose(f.location(worldPoint(mapPoints[0]))), null);
  const verified = await align(f);
  assert.deepEqual(verified.alignment, { status: 'verified', points: 3 });
  assert.equal((await f.store.addPoint({ ...input(f.context), map: mapPoints[0] })).ok, false, 'Verified transforms require an explicit reset');
  f.pose = f.location(worldPoint({ x: 20, z: 30 }));
  const mapped = f.store.mappedPose(f.pose);
  assert.ok(Math.abs(mapped.position.x - 20) < 1e-8); assert.ok(Math.abs(mapped.position.z - 30) < 1e-8);
  assert.ok(Math.abs(mapped.heading) < 1e-8);
  assert.equal(mapped.alignmentVerified, true); assert.equal(mapped.scope, verified.scope);
});

test('persisted verified and partial alignment loads only with matching, validated observations', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } });
  f.pose = f.location(worldPoint(mapPoints[0]));
  await f.store.addPoint({ ...input(f.context), map: mapPoints[0] });
  const partial = fixture({ fs: f.fs, context: { coordinateSpace: 'layout-local' } });
  assert.deepEqual((await partial.store.load(input(partial.context))).alignment, { status: 'collecting', points: 1 });
  for (const map of mapPoints.slice(1)) {
    partial.pose = partial.location(worldPoint(map));
    assert.equal((await partial.store.addPoint({ ...input(partial.context), map })).ok, true);
  }
  const verified = await partial.store.load(input(partial.context));
  await partial.store.save({ scope: verified.scope, exploration: exploration([20, 20]) });
  const restarted = fixture({ fs: f.fs, context: { coordinateSpace: 'layout-local' } });
  const restored = await restarted.store.load(input(restarted.context));
  assert.deepEqual(restored.alignment, { status: 'verified', points: 3 });
  assert.deepEqual(restored.exploration.cells, [[20, 20]]);
  assert.ok(restarted.store.mappedPose(restarted.location(worldPoint({ x: 20, z: 20 }))));
});

test('alignment rejects stale/wrong-session poses, unknown rooms, mismatched geometry, short or collinear movement', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } });
  for (const extra of [{ status: 'unavailable' }, { source: 'screenshot' }, { sampledAt: f.now - 751 }, { sampledAt: f.now + 1 },
    { instanceId: 'other' }, { trackingSession: 'other' }, { isOverworld: true }, { position: null }]) {
    f.pose = f.location(worldPoint(mapPoints[0]), extra);
    assert.equal((await f.store.addPoint({ ...input(f.context), map: mapPoints[0] })).ok, false);
  }
  f.pose = f.location(worldPoint(mapPoints[0]));
  assert.equal((await f.store.addPoint({ ...input(f.context), map: { x: 500, z: 500 } })).ok, false);
  f.scene = { ...scene(f.context), version: 'old' };
  assert.equal((await f.store.addPoint({ ...input(f.context), map: mapPoints[0] })).ok, false);
  f.scene = null;
  assert.equal((await f.store.addPoint({ ...input(f.context), map: mapPoints[0] })).ok, true);
  assert.match((await f.store.addPoint({ ...input(f.context), map: mapPoints[0] })).message, /8 game units/);
  f.pose = f.location(worldPoint(mapPoints[1]));
  assert.equal((await f.store.addPoint({ ...input(f.context), map: mapPoints[1] })).ok, true);
  const straight = { x: 70, z: 10 }; f.pose = f.location(worldPoint(straight));
  assert.match((await f.store.addPoint({ ...input(f.context), map: straight })).message, /turn/);
  assert.deepEqual((await f.store.load(input(f.context))).alignment, { status: 'collecting', points: 2 });
});

test('mapped poses require the current owner, process, instance, recent memory data and finite coordinates', async () => {
  const f = fixture(); await f.store.load(input(f.context));
  for (const bad of [null, {}, f.location(null), f.location({ x: NaN, z: 0 }), f.location({ x: 1e8, z: 0 }),
    f.location(undefined, { sampledAt: f.now - 2001 }), f.location(undefined, { sampledAt: f.now + 1 }),
    f.location(undefined, { sampledAt: '10000' }), f.location(undefined, { status: 'missing' }), f.location(undefined, { source: 'screenshot' }),
    f.location(undefined, { isOverworld: true }), f.location(undefined, { instanceId: 'old' }), f.location(undefined, { trackingSession: 'old' })]) {
    assert.equal(f.store.mappedPose(bad), null);
  }
  const pose = f.location({ x: 4, z: 5 }, { heading: null });
  const result = f.store.mappedPose(pose);
  assert.deepEqual(result.position, { x: 4, z: 5 }); assert.equal(result.heading, null);
  result.position.x = 999;
  assert.equal(pose.position.x, 4, 'Mapped output does not expose the source position object');
  const oldContext = f.context;
  f.owner = { ...f.owner, account: 'other' };
  assert.equal(f.store.mappedPose(pose), null);
  f.owner = { account: oldContext.account, process: oldContext.process };
  f.context = { ...oldContext, instanceId: 'new' };
  assert.equal(f.store.mappedPose(pose, oldContext), null);
});

test('invalid or oversized disk files never restore fog or an unverified local transform', async () => {
  const local = context({ coordinateSpace: 'layout-local' }), alignment = fitAlignment(observations).alignment;
  const valid = { schema: 1, key: contextKey(local), generation: 2, alignment, points: observations, exploration: exploration([20, 20]) };
  for (const saved of [null, [], { ...valid, schema: 2 }, { ...valid, key: 'other' }, { ...valid, generation: -1 },
    { ...valid, generation: 1e20 }, { ...valid, exploration: exploration([null, 20]) },
    { ...valid, alignment: null }, { ...valid, points: [] }, { ...valid, points: [null, null, null] },
    { ...valid, alignment: { ...alignment, translation: { x: 999, z: 999 } } },
    { ...valid, points: [...observations.slice(0, 2), { map: { x: 70, z: 10 }, world: worldPoint({ x: 70, z: 10 }) }] }]) {
    const f = fixture({ context: { coordinateSpace: 'layout-local' } });
    f.fs.files.set(f.disk(), JSON.stringify(saved));
    const result = await f.store.load(input(f.context));
    assert.equal(result.ok, true); assert.deepEqual(result.exploration.cells, []); assert.equal(result.alignment.status, 'detecting');
  }
  const broken = fixture(); broken.fs.files.set(broken.disk(), '{broken');
  assert.deepEqual((await broken.store.load(input(broken.context))).exploration.cells, []);
  const oversized = fixture(); oversized.fs.hooks.stat = () => ({ size: 4 * 1024 * 1024 + 1 });
  assert.deepEqual((await oversized.store.load(input(oversized.context))).exploration.cells, []);
  assert.equal(oversized.fs.calls.some(([name]) => name === 'read'), false);
});

test('write failures preserve the last file, scope, calibration and visible discovery until a successful retry', async () => {
  const f = fixture(); const loaded = await f.store.load(input(f.context));
  await f.store.save({ scope: loaded.scope, exploration: exploration([0, 0]) });
  const before = f.fs.files.get(f.disk());
  f.fs.hooks.rename = () => { throw new Error('Disk unavailable'); };
  assert.equal((await f.store.save({ scope: loaded.scope, exploration: exploration([100, 100]) })).ok, false);
  assert.equal((await f.store.reset(input(f.context))).ok, false);
  const after = await f.store.load(input(f.context));
  assert.equal(after.scope, loaded.scope); assert.deepEqual(after.exploration.cells, [[0, 0]]);
  assert.equal(f.fs.files.get(f.disk()), before);
  assert.equal([...f.fs.files.keys()].some(file => file.endsWith('.tmp')), false);
  delete f.fs.hooks.rename;
  assert.equal((await f.store.save({ scope: loaded.scope, exploration: exploration([100, 100]) })).ok, true);

  const local = fixture({ context: { coordinateSpace: 'layout-local' } });
  for (const map of mapPoints.slice(0, 2)) { local.pose = local.location(worldPoint(map)); await local.store.addPoint({ ...input(local.context), map }); }
  local.pose = local.location(worldPoint(mapPoints[2]));
  local.fs.hooks.write = () => { throw new Error('Write failed'); };
  assert.equal((await local.store.addPoint({ ...input(local.context), map: mapPoints[2] })).ok, false);
  assert.deepEqual((await local.store.load(input(local.context))).alignment, { status: 'collecting', points: 2 });
  assert.equal(local.store.mappedPose(local.pose), null, 'A failed verification write cannot enable tracking');
});

test('context changes during a pending load or alignment cannot publish into the next dungeon', async () => {
  const f = fixture(), gate = deferred();
  f.fs.hooks.stat = async () => { await gate.promise; throw new Error('Missing'); };
  const loading = f.store.load(input(f.context));
  f.context = { ...f.context, instanceId: 'entry-2' }; gate.resolve();
  assert.equal((await loading).ok, false);
  const local = fixture({ context: { coordinateSpace: 'layout-local' } }), sceneGate = deferred();
  local.pose = local.location(worldPoint(mapPoints[0]));
  const oldScene = scene(local.context); local.scene = () => sceneGate.promise;
  const marking = local.store.addPoint({ ...input(local.context), map: mapPoints[0] }); await tick();
  local.context = { ...local.context, instanceId: 'entry-2' }; sceneGate.resolve(oldScene);
  assert.equal((await marking).ok, false); assert.equal(local.events.length, 0);
});

test('serialized reset cannot be undone by a save queued with its old scope', async () => {
  const f = fixture(), loaded = await f.store.load(input(f.context)), gate = deferred(), started = deferred();
  f.fs.hooks.rename = async () => { started.resolve(); await gate.promise; };
  const resetting = f.store.reset(input(f.context)); await started.promise;
  const stale = f.store.save({ scope: loaded.scope, exploration: exploration([80, 80]) });
  assert.equal((await f.store.load(input(f.context))).scope, loaded.scope, 'Scope changes only after atomic persistence');
  gate.resolve(); const reset = await resetting;
  assert.equal(reset.ok, true); assert.equal((await stale).ok, false);
  assert.deepEqual((await f.store.load(input(f.context))).exploration.cells, []);
});

test('an alignment point awaiting scene data cannot survive a later reset or emit after entry changes', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), sceneGate = deferred(), entered = deferred();
  await f.store.load(input(f.context));
  const oldScene = scene(f.context);
  f.scene = () => { entered.resolve(); return sceneGate.promise; };
  f.pose = f.location(worldPoint(mapPoints[0]));
  const marking = f.store.addPoint({ ...input(f.context), map: mapPoints[0] }); await entered.promise;
  const resetting = f.store.reset(input(f.context)); await tick();
  sceneGate.resolve(oldScene);
  assert.equal((await marking).ok, true);
  const reset = await resetting;
  assert.equal(reset.ok, true);
  assert.deepEqual(reset.alignment, detecting);
  assert.equal(f.events.at(-1).reset, true);
  assert.deepEqual((await f.store.load(input(f.context))).alignment, detecting);

  const started = deferred(), diskGate = deferred();
  f.scene = null; f.fs.hooks.rename = async () => { started.resolve(); await diskGate.promise; };
  const again = f.store.addPoint({ ...input(f.context), map: mapPoints[0] }); await started.promise;
  const eventCount = f.events.length;
  f.context = { ...f.context, instanceId: 'entry-2' }; diskGate.resolve();
  assert.equal((await again).ok, false); assert.equal(f.events.length, eventCount);
});

test('alignment uses the click-time pose and rejects it if asynchronous room data makes it stale', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), gate = deferred(), entered = deferred();
  f.pose = f.location(worldPoint(mapPoints[0]));
  f.scene = () => { entered.resolve(); return gate.promise; };
  const marking = f.store.addPoint({ ...input(f.context), map: mapPoints[0] }); await entered.promise;
  f.now += 751; f.pose = f.location(worldPoint(mapPoints[1]));
  gate.resolve(scene(f.context));
  assert.equal((await marking).ok, false);
  assert.deepEqual((await f.store.load(input(f.context))).alignment, detecting);
});

test('the issued scope cache is bounded and evicted scenes cannot submit final saves', async () => {
  const f = fixture(); const first = await f.store.load(input(f.context));
  for (let index = 2; index <= 30; index++) { f.context = { ...f.context, instanceId: `entry-${index}` }; await f.store.load(input(f.context)); }
  assert.equal(f.store.records.size, 24); assert.equal(f.store.scopes.size, 24);
  assert.equal((await f.store.save({ scope: first.scope, exploration: exploration([0, 0]) })).ok, false);
});

test('server observations reveal and remember walking while every map window is closed', async () => {
  const f = fixture();
  assert.equal(await f.store.observePose(f.location({ x: 0, z: 0 })), true);
  f.now += 100; assert.equal(await f.store.observePose(f.location({ x: 100, z: 0 })), true);
  const current = await f.store.load(input(f.context)), model = createExploration(); model.restore(current.exploration);
  assert.equal(model.isRevealed(50, 0), true, 'Normal accepted movement is interpolated');
  assert.equal(f.fs.calls.some(([name]) => name === 'write'), false, 'Samples are batched rather than written each tick');
  await f.advance(750); await f.store.flush();
  assert.ok(f.fs.files.has(f.disk())); assert.equal(f.timers.size, 0); assert.equal(f.events.length, 1);
  const restarted = fixture({ fs: f.fs });
  assert.deepEqual((await restarted.store.load(input(restarted.context))).exploration, current.exploration);
});

test('server observations reject stale/scoped poses and never connect across long gaps or teleports', async () => {
  const f = fixture(); await f.store.load(input(f.context));
  for (const pose of [null, f.location(undefined, { instanceId: 'other' }), f.location(undefined, { trackingSession: 'other' }),
    f.location(undefined, { source: 'screenshot' }), f.location(undefined, { sampledAt: f.now - 2001 })]) assert.equal(await f.store.observePose(pose), false);
  await f.store.observePose(f.location({ x: 0, z: 0 }));
  f.now += 2100; await f.store.observePose(f.location({ x: 100, z: 0 }));
  f.now += 100; await f.store.observePose(f.location({ x: 500, z: 0 }));
  const model = createExploration(); model.restore((await f.store.load(input(f.context))).exploration);
  assert.equal(model.isRevealed(50, 0), false); assert.equal(model.isRevealed(300, 0), false);
  const before = model.snapshot();
  assert.equal(await f.store.observePose(f.location({ x: 900, z: 0 }, { sampledAt: f.now - 1 })), false);
  assert.deepEqual((await f.store.load(input(f.context))).exploration, before);
  await f.store.flush();
});

test('flush persists the final unbatched observation and failed writes retry without losing walked discovery', async () => {
  const f = fixture(); await f.store.observePose(f.location({ x: 0, z: 0 }));
  f.fs.hooks.write = () => { throw new Error('Storage unavailable'); };
  await f.store.flush();
  assert.equal(f.timers.size, 0); assert.equal(f.fs.files.has(f.disk()), false);
  assert.deepEqual((await f.store.load(input(f.context))).exploration.cells, [[0, 0]]);
  delete f.fs.hooks.write;
  f.now += 100; await f.store.observePose(f.location({ x: 0, z: 0 }));
  assert.equal(f.timers.size, 1, 'An unchanged position retries dirty discovery');
  await f.store.flush();
  assert.deepEqual(JSON.parse(f.fs.files.get(f.disk())).exploration.cells, [[0, 0]]);
  assert.equal(f.timers.size, 0);
});

test('automatic native placement verifies the exact dungeon without calibration or changing its initial scope', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context);
  const initial = await f.store.load(input(f.context));
  assert.deepEqual(initial.alignment, detecting);
  const pose = f.location(worldPoint({ x: 20, z: 30 }), { dungeonRoot: root });
  assert.equal(await f.store.applyRoot(root, pose), true);
  const ready = await f.store.load(input(f.context));
  assert.equal(ready.scope, initial.scope); assert.deepEqual(ready.exploration.cells, []);
  assert.deepEqual(ready.alignment, { status: 'verified', source: 'level-info-fit', points: 0 });
  assert.equal(f.events.length, 1); assert.equal(f.events[0].reset, undefined);
  const mapped = f.store.mappedPose(pose);
  assert.ok(Math.abs(mapped.position.x - 20) < 1e-8); assert.ok(Math.abs(mapped.position.z - 30) < 1e-8);
  assert.ok(Math.abs(mapped.heading) < 1e-8); assert.equal(mapped.scope, initial.scope);
});

test('repeated identical native proofs are idempotent without writing or broadcasting at pose frequency', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context);
  for (let index = 0; index < 25; index++) {
    f.now += 100;
    assert.equal(await f.store.applyRoot(root, f.location(worldPoint(mapPoints[0]))), true);
  }
  assert.equal(f.fs.calls.filter(([name]) => name === 'write').length, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.store.peek().generation, 0);
});

test('automatic placement requires valid native data and a fresh pose for the exact account/process/entry', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context);
  for (const invalid of [null, {}, { ...root, source: 'guessed' }, { ...root, levelPath: '/SF/Levels/Procs/Other' },
    { ...root, layoutCode: 'OTHER' }, { ...root, matrix: root.matrix.slice(0, 15) }]) {
    assert.equal(await f.store.applyRoot(invalid, f.location()), false);
  }
  for (const extra of [{ status: 'missing' }, { source: 'screenshot' }, { instanceId: 'other' }, { trackingSession: 'other' },
    { sampledAt: f.now - 751 }, { sampledAt: f.now + 1 }, { isOverworld: true }, { position: { x: NaN, z: 0 } }]) {
    assert.equal(await f.store.applyRoot(root, f.location(undefined, extra)), false);
  }
  f.owner = { ...f.owner, account: 'other' };
  assert.equal(await f.store.applyRoot(root, f.location()), false);
  assert.equal(f.events.length, 0); assert.equal(f.fs.calls.some(([name]) => name === 'write'), false);
});

test('every mapped native pose must carry the matching current root, including exact generator identity', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context);
  const pose = f.location(worldPoint(mapPoints[0]), { dungeonRoot: root });
  assert.equal(await f.store.applyRoot(root, pose), true);
  for (const different of [undefined, null, { ...root, layoutCode: 'OTHER' }, { ...root, levelPath: '/SF/Levels/Procs/Other' },
    nativeRoot(f.context, { x: 121 }), nativeRoot(f.context, { yaw: Math.PI / 2 + .01 }), nativeRoot(f.context, { height: 6 })]) {
    const invalid = { ...pose, dungeonRoot: different };
    assert.equal(f.store.mappedPose(invalid), null);
    assert.equal(await f.store.observePose(invalid), false);
  }
  assert.ok(f.store.mappedPose(pose));
  assert.equal(await f.store.observePose(pose), true);
  await f.store.flush();
});

test('persisted native alignment retains discovery but requires a fresh native proof before mapping or saving again', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context);
  const pose = f.location(worldPoint(mapPoints[0]), { dungeonRoot: root });
  await f.store.applyRoot(root, pose); await f.store.observePose(pose); await f.store.flush();
  const saved = await f.store.load(input(f.context));
  const restarted = fixture({ fs: f.fs, context: { coordinateSpace: 'layout-local' } });
  const loaded = await restarted.store.load(input(restarted.context));
  assert.equal(loaded.scope, saved.scope); assert.deepEqual(loaded.exploration, saved.exploration); assert.deepEqual(loaded.alignment, detecting);
  const fresh = restarted.location(worldPoint(mapPoints[1]), { dungeonRoot: root });
  assert.equal(restarted.store.mappedPose(fresh), null); assert.equal(await restarted.store.observePose(fresh), false);
  assert.equal((await restarted.store.save({ scope: loaded.scope, exploration: exploration([90, 90]) })).ok, false);
  const writes = f.fs.calls.filter(([name]) => name === 'write').length;
  assert.equal(await restarted.store.applyRoot(root, fresh), true);
  assert.equal(f.fs.calls.filter(([name]) => name === 'write').length, writes, 'The persisted identical transform is not written again');
  assert.equal((await restarted.store.load(input(restarted.context))).scope, saved.scope);
  assert.ok(restarted.store.mappedPose(fresh));
});

test('invalid persisted native identities or nonempty manual observations cannot restore their discovery', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } });
  const root = nativeRoot(f.context), alignment = alignmentFromRoot(root, { ...f.context, active: true, status: 'ready' });
  const valid = { schema: 1, key: contextKey(f.context), generation: 3, alignment, points: [], exploration: exploration([20, 20]) };
  for (const saved of [
    { ...valid, alignment: { ...alignment, levelPath: '/SF/Levels/Procs/Other' } },
    { ...valid, alignment: { ...alignment, layoutCode: 'OTHER' } },
    { ...valid, alignment: { ...alignment, height: null } },
    { ...valid, points: observations },
  ]) {
    const next = fixture({ context: { coordinateSpace: 'layout-local' } });
    next.fs.files.set(next.disk(), JSON.stringify(saved));
    const result = await next.store.load(input(next.context));
    assert.deepEqual(result.exploration.cells, []); assert.deepEqual(result.alignment, detecting);
  }
});

test('a changed native transform clears prior discovery, rotates scope and rejects older roots and stale saves', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context);
  const oldPose = f.location(worldPoint(mapPoints[0]), { dungeonRoot: root });
  await f.store.applyRoot(root, oldPose); await f.store.observePose(oldPose); await f.store.flush();
  const old = await f.store.load(input(f.context));
  f.now += 100;
  const changed = nativeRoot(f.context, { x: 150 }), pose = f.location({ x: 160, z: -330 }, { dungeonRoot: changed });
  assert.equal(await f.store.applyRoot(changed, pose), true);
  const next = await f.store.load(input(f.context));
  assert.notEqual(next.scope, old.scope); assert.deepEqual(next.exploration.cells, []);
  assert.equal(f.store.peek().generation, 1);
  assert.equal(f.events.at(-1).reset, true); assert.equal(f.events.at(-1).previousScope, old.scope);
  assert.equal((await f.store.save({ scope: old.scope, exploration: old.exploration })).ok, false);
  assert.equal(await f.store.applyRoot(root, oldPose), false); assert.equal(f.store.mappedPose(oldPose), null);
  assert.equal((await f.store.load(input(f.context))).scope, next.scope);
});

test('failed native placement writes never expose verified state or destroy the previous committed fog and scope', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context);
  const pose = f.location(worldPoint(mapPoints[0]), { dungeonRoot: root });
  f.fs.hooks.write = () => { throw new Error('Storage unavailable'); };
  assert.equal(await f.store.applyRoot(root, pose), false);
  assert.deepEqual((await f.store.load(input(f.context))).alignment, detecting);
  assert.equal(f.store.mappedPose(pose), null); assert.equal(f.events.length, 0);
  delete f.fs.hooks.write;
  assert.equal(await f.store.applyRoot(root, pose), true, 'The exact same native packet may retry an unsuccessful commit');
  await f.store.observePose(pose); await f.store.flush();
  const old = await f.store.load(input(f.context)); f.now += 100;
  const changed = nativeRoot(f.context, { height: 9 }), fresh = f.location(worldPoint(mapPoints[0]), { dungeonRoot: changed });
  f.fs.hooks.rename = () => { throw new Error('Rename failed'); };
  assert.equal(await f.store.applyRoot(changed, fresh), false);
  const failed = await f.store.load(input(f.context));
  assert.equal(failed.scope, old.scope); assert.deepEqual(failed.exploration, old.exploration); assert.deepEqual(failed.alignment, detecting);
  assert.equal(f.store.mappedPose(fresh), null); assert.equal(f.store.mappedPose(pose), null);
  delete f.fs.hooks.rename;
  assert.equal(await f.store.applyRoot(changed, fresh), true);
  assert.notEqual((await f.store.load(input(f.context))).scope, old.scope);
});

test('native placement finishing after an entry change cannot publish a verified root into the next dungeon', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context), gate = deferred(), started = deferred();
  f.fs.hooks.rename = async () => { started.resolve(); await gate.promise; };
  const pending = f.store.applyRoot(root, f.location(worldPoint(mapPoints[0]), { dungeonRoot: root })); await started.promise;
  const oldContext = f.context; f.context = { ...f.context, instanceId: 'next-entry' }; gate.resolve();
  assert.equal(await pending, false); assert.equal(f.events.length, 0);
  assert.equal(f.store.peek(oldContext).rootVerified, false);
  assert.deepEqual((await f.store.load(input(f.context))).alignment, detecting);
});

test('a native proof queued behind reset cannot reactivate its old generation', async () => {
  const f = fixture({ context: { coordinateSpace: 'layout-local' } }), root = nativeRoot(f.context), gate = deferred(), started = deferred();
  await f.store.applyRoot(root, f.location());
  f.fs.hooks.rename = async () => { started.resolve(); await gate.promise; };
  const resetting = f.store.reset(input(f.context)); await started.promise;
  const stale = f.store.applyRoot(root, f.location()); await tick();
  gate.resolve(); const reset = await resetting;
  assert.equal(reset.ok, true); assert.equal(await stale, false);
  assert.deepEqual((await f.store.load(input(f.context))).alignment, detecting);
  f.now += 100; assert.equal(await f.store.applyRoot(root, f.location()), true);
  assert.equal((await f.store.load(input(f.context))).scope, reset.scope, 'A fresh proof uses the reset generation rather than rotating twice');
});
