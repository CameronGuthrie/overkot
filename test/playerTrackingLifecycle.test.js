'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PlayerTracking } = require('../src/modules/playerTracking');

const tick = () => new Promise(resolve => setImmediate(resolve));
const dungeon = instanceId => ({ active: true, status: 'ready', instanceId, layoutCode: 'SAME',
  levelPath: '/SF/Levels/Procs/UnderCityGauntlet', key: 'underCityMidrath' });
const capture = overrides => ({ status: 'found', zone: '/SF/Levels/MidrathRedux', isOverworld: true,
  position: { x: 5, y: 2, z: 9 }, heading: 35, ...overrides });

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overkot-tracking-life-'));
  let state = { active: false, status: 'outside', instanceId: 'world-one', levelPath: '/SF/Levels/Procs/MidrathProc' };
  let account = 'account-one', now = 10000;
  const reader = new EventEmitter(); reader.status = { status: 'stopped', trackingSession: null };
  reader.getState = () => reader.status;
  reader.start = pid => { reader.pid = pid; };
  reader.update = (status, trackingSession = 'process-one') => {
    reader.status = { status, trackingSession }; reader.emit('status', reader.status);
  };
  reader.stop = () => { reader.pid = null; reader.update('stopped', null); };
  const tracking = new PlayerTracking({ directory, reader, now: () => now,
    getState: () => state, getAccountId: () => account, getVersion: () => 'feed',
    getLayoutSnapshot: options.getLayoutSnapshot || (async captured => ({ state: captured,
      status: 'ready', version: 'feed', coordinateSpace: 'world' })),
    getScene: async captured => ({ state: captured, version: 'feed', mode: 'placed', rooms: [] }) });
  const locations = []; tracking.on('location', value => locations.push(value));
  tracking.start(123); reader.update('tracking');
  t.after(async () => { tracking.stop(); await tracking.discovery.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { tracking, reader, locations,
    pose(overrides = {}) { reader.emit('pose', { source: 'memory', sampledAt: now, trackingSession: reader.status.trackingSession,
      position: { x: 100, y: 20, z: -10 }, heading: 90, ...overrides }); },
    get state() { return state; }, set state(value) { state = value; },
    set account(value) { account = value; }, set now(value) { now = value; } };
}

test('a pending F6 capture completes on area change and its delayed old-area result cannot return', async t => {
  const f = await fixture(t);
  f.tracking.beginCapture();
  f.state = dungeon('dungeon-two'); f.tracking.refresh();
  assert.equal(f.locations.at(-1).captureCompleted, true);
  f.tracking.acceptCapture(capture());
  assert.equal(f.tracking.getLocation().status, 'unavailable');
  assert.equal(f.locations.some(location => location.source === 'capture'), false);
});

test('logout invalidates pending captures, while a newly requested F6 fallback works without native tracking', async t => {
  const f = await fixture(t);
  f.tracking.beginCapture(); f.account = null; f.tracking.refresh();
  assert.equal(f.locations.at(-1).captureCompleted, true);
  f.tracking.acceptCapture(capture());
  assert.equal(f.tracking.getLocation().status, 'unavailable');
  f.reader.update('unsupported-build', null);
  f.tracking.beginCapture(); f.tracking.acceptCapture(capture());
  assert.equal(f.tracking.getLocation().source, 'capture');
});

test('a process-session change invalidates an old capture while retaining the new live marker', async t => {
  const f = await fixture(t);
  f.tracking.beginCapture(); f.reader.update('searching', null);
  f.reader.update('tracking', 'process-two'); f.pose();
  assert.equal(f.locations.some(location => location.captureCompleted), true);
  f.tracking.acceptCapture(capture());
  assert.equal(f.tracking.getLocation().source, 'memory');
  assert.equal(f.tracking.getLocation().trackingSession, 'process-two');
  assert.equal(f.tracking.getLocation().position.x, 100);
});

test('helper availability changes preserve the manual F6 fallback in the same game process', async t => {
  const f = await fixture(t); f.reader.update('not-found', null);
  f.tracking.beginCapture(); f.reader.update('searching', null); f.reader.update('scan-incomplete', null);
  f.tracking.acceptCapture(capture());
  assert.equal(f.tracking.getLocation().source, 'capture');
  f.reader.update('searching', null); assert.equal(f.tracking.getLocation().source, 'capture');
});

test('captures must match a known current zone but retain the fallback when log context is unknown', async t => {
  const f = await fixture(t);
  f.tracking.beginCapture();
  f.tracking.acceptCapture(capture({ zone: '/SF/Levels/Procs/UnderCityGauntlet', isOverworld: false }));
  assert.equal(f.tracking.getLocation().status, 'unavailable');
  f.state = { active: false, status: 'unknown' }; f.tracking.refresh();
  f.tracking.beginCapture(); f.tracking.acceptCapture(capture());
  assert.equal(f.tracking.getLocation().source, 'capture');
});

test('initial live dungeon samples gain their discovery scope once layout loading finishes', async t => {
  let resolveLayout;
  const f = await fixture(t, { getLayoutSnapshot: state => new Promise(resolve => { resolveLayout = value => resolve({ state,
    status: 'ready', version: 'feed', coordinateSpace: 'world', ...value }); }) });
  f.state = dungeon('initial-entry'); const task = f.tracking.refresh(); await tick();
  f.pose(); assert.equal(f.locations.at(-1).dungeon, undefined);
  resolveLayout({}); await task;
  assert.equal(f.locations.at(-1).dungeon.instanceId, 'initial-entry');
  assert.equal(typeof f.locations.at(-1).dungeon.scope, 'string');
});

test('overlapping layout loads cannot replace the newest entry or clear its pending request', async t => {
  const requests = new Map();
  const f = await fixture(t, { getLayoutSnapshot: state => new Promise(resolve => requests.set(state.instanceId, () => resolve({ state,
    status: 'ready', version: 'feed', coordinateSpace: 'world' }))) });
  f.state = dungeon('first'); const first = f.tracking.refresh(); await tick();
  f.state = dungeon('second'); const second = f.tracking.refresh(); await tick();
  requests.get('first')(); await first;
  assert.equal(f.tracking.pending, second);
  assert.equal(f.tracking.context, null);
  requests.get('second')(); await second; f.pose();
  assert.equal(f.tracking.context.instanceId, 'second');
  assert.equal(f.tracking.getLocation().dungeon.instanceId, 'second');
  assert.equal(f.tracking.pending, null);
});

test('discovery final saves cannot cross an account switch between periodic refreshes', async t => {
  const f = await fixture(t); f.state = dungeon('save-entry'); await f.tracking.refresh(); f.pose();
  const snapshot = await f.tracking.discovery.load({ instanceId: 'save-entry', revision: 'feed' });
  f.account = 'account-two';
  const result = await f.tracking.discovery.save({ scope: snapshot.scope, exploration: snapshot.exploration });
  assert.equal(result.ok, false);
  assert.equal(f.tracking.getOwner(), null);
});

test('synchronous status observers can request a location without recursive status emission', async t => {
  const f = await fixture(t); let notifications = 0;
  f.tracking.on('status', () => { notifications++; f.tracking.getLocation(); });
  f.reader.update('searching', null); f.reader.update('tracking'); f.pose();
  assert.ok(notifications > 0 && notifications < 10);
  assert.equal(f.tracking.getStatus().status, 'tracking');
});
