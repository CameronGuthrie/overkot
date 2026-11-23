'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PlayerTracking } = require('../src/modules/playerTracking');
const { DungeonWatcher } = require('../src/modules/dungeonWatcher');

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
  reader.processStartMs = options.processStartMs;
  reader.getState = () => reader.status;
  reader.start = pid => { reader.pid = pid; };
  reader.update = (status, trackingSession = 'process-one') => {
    reader.status = { status, trackingSession }; reader.emit('status', reader.status);
  };
  reader.stop = () => { reader.pid = null; reader.update('stopped', null); };
  const tracking = new PlayerTracking({ directory, reader, now: () => now,
    getState: options.getState || (() => state), getAccountId: options.getAccountId || (() => account), getVersion: () => 'feed',
    canShowAnonymousOverworld: options.canShowAnonymousOverworld, isPlayerAreaCurrent: options.isPlayerAreaCurrent,
    getAnonymousDungeonVisit: options.getAnonymousDungeonVisit,
    getLayoutSnapshot: options.getLayoutSnapshot || (async captured => ({ state: captured,
      status: 'ready', version: 'feed', coordinateSpace: 'world' })),
    getScene: async captured => ({ state: captured, version: 'feed', mode: 'placed', rooms: [] }) });
  const locations = []; tracking.on('location', value => locations.push(value));
  tracking.start(123); reader.update('tracking');
  t.after(async () => { tracking.stop(); await tracking.discovery.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { tracking, reader, locations, directory,
    pose(overrides = {}) { reader.emit('pose', { source: 'memory', sampledAt: now, trackingSession: reader.status.trackingSession,
      position: { x: 100, y: 20, z: -10 }, heading: 90, ...overrides }); },
    get state() { return state; }, set state(value) { state = value; },
    set account(value) { account = value; }, set now(value) { now = value; } };
}

test('the first fresh pose is visible after a logged game login even while inventory is unavailable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overkot-tracking-login-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'EE.log');
  const watcher = new DungeonWatcher({ candidates: () => [file] });
  const account = 'a'.repeat(24);
  let inventoryAccount = null;
  await fs.writeFile(file, `12.345 Sys [Info]: Logged in FirstEnvoy (${account})\nSTATS ENTER_LEVEL /SF/Levels/Procs/MidrathProc\n`);
  watcher._poll();
  const f = await fixture(t, { processStartMs: (await fs.stat(file)).mtimeMs - 1000, getState: () => watcher.getState(),
    getAccountId: startMs => watcher.getPlayerAccountId(inventoryAccount, startMs),
    canShowAnonymousOverworld: startMs => watcher.canUseAreaWithoutAccount(startMs),
    isPlayerAreaCurrent: startMs => watcher.isPlayerAreaCurrent(startMs) });
  f.pose();
  assert.equal(f.tracking.getStatus().status, 'tracking');
  assert.equal(f.tracking.getLocation().isOverworld, true);
  assert.equal(f.tracking.getOwner().account, account);
  assert.equal(JSON.stringify(f.tracking.getLocation()).includes(account), false);
  inventoryAccount = account;
  assert.equal(f.tracking.getLocation().status, 'found');
  inventoryAccount = null;
  assert.equal(f.tracking.getLocation().status, 'found');

  inventoryAccount = account;
  watcher._processLine('QUIT :Logged out of game');
  f.pose();
  assert.equal(f.tracking.getLocation().status, 'unavailable');
  assert.equal(f.tracking.getOwner(), null);
  const nextAccount = 'b'.repeat(24);
  watcher._processLine(`Sys [Info]: Logged in SecondEnvoy (${nextAccount})`);
  watcher._processLine('STATS ENTER_LEVEL /SF/Levels/MidrathRedux');
  f.pose();
  assert.equal(f.tracking.getLocation().status, 'unavailable');
  assert.equal(f.tracking.getOwner(), null, 'Conflicting login and poller identities cannot own discovery');
  inventoryAccount = null; f.pose();
  assert.equal(f.tracking.getLocation().isOverworld, true);
  assert.equal(f.tracking.getOwner().account, nextAccount);
});

test('a current game log with overworld evidence and no login record places the player until explicit logout', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overkot-tracking-area-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'EE.log');
  const watcher = new DungeonWatcher({ candidates: () => [file] });
  await fs.writeFile(file, 'STATS ENTER_LEVEL /SF/Levels/MidrathRedux\n');
  watcher._poll();
  const f = await fixture(t, { processStartMs: (await fs.stat(file)).mtimeMs - 1000,
    getState: () => watcher.getState(), getAccountId: start => watcher.getPlayerAccountId(null, start),
    canShowAnonymousOverworld: start => watcher.canUseAreaWithoutAccount(start),
    isPlayerAreaCurrent: start => watcher.isPlayerAreaCurrent(start) });
  f.reader.update('searching', null); f.pose();
  assert.equal(f.tracking.getStatus().status, 'searching');
  assert.equal(f.tracking.getLocation().status, 'unavailable');
  f.reader.update('tracking'); f.pose();
  assert.equal(f.tracking.getStatus().status, 'tracking');
  assert.equal(f.tracking.getLocation().isOverworld, true); assert.equal(f.tracking.getOwner(), null);
  await fs.appendFile(file, 'QUIT :Logged out of game\nSTATS ENTER_LEVEL /SF/Levels/MidrathRedux\n'); watcher._poll();
  f.pose(); assert.equal(f.tracking.getLocation().status, 'unavailable');
  await fs.unlink(file); watcher._poll(); f.pose();
  assert.equal(f.tracking.getStatus().status, 'waiting-for-area');
  await fs.writeFile(file, 'STATS ENTER_LEVEL /SF/Levels/MidrathRedux\n');
  await fs.utimes(file, new Date(1000), new Date(1000)); watcher._poll(); f.pose();
  assert.equal(f.tracking.getStatus().status, 'waiting-for-area');
  assert.equal(f.tracking.getLocation().status, 'unavailable');
});

test('restart inside a name-only login reveals the current dungeon and discards the trail on logout', async t => {
  const logDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'overkot-dungeon-replay-'));
  t.after(() => fs.rm(logDirectory, { recursive: true, force: true }));
  const file = path.join(logDirectory, 'EE.log');
  const levelPath = '/SF/Levels/Procs/UnderCityCliffCave', layoutCode = 'KhGCACHMpRNZ3fAghiCAAQjA';
  const enter = `Sys [Info]: Game successfully connected to: ${levelPath}/${layoutCode}.lp\n`;
  await fs.writeFile(file, '12.345 Sys [Info]: Logged in First Envoy\n' + enter);
  const watcher = new DungeonWatcher({ candidates: () => [file] });
  watcher._poll();
  const entry = watcher.getState();
  assert.equal(entry.status, 'ready');
  assert.equal(entry.layoutCode, layoutCode);
  const rooms = [[0, 0, 0], [30, 1, 7], [-13, -2, 44]].map(([x, y, z]) => ({ transform: { x, y, z, rotation: 0 } }));
  const frames = rooms.map(({ transform: room }) => ({ source: 'level-info',
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100 + room.x, 990 + room.y, -200 + room.z, 1] }));
  const f = await fixture(t, {
    processStartMs: (await fs.stat(file)).mtimeMs - 1000,
    getState: () => watcher.getState(), getAccountId: start => watcher.getPlayerAccountId(null, start),
    isPlayerAreaCurrent: start => watcher.isPlayerAreaCurrent(start),
    getAnonymousDungeonVisit: start => watcher.getAnonymousDungeonVisit(start),
    getLayoutSnapshot: async state => ({ state, status: 'ready', version: 'feed', coordinateSpace: 'layout-local', rooms }),
  });
  const target = { instanceId: entry.instanceId, revision: 'feed' };
  await f.tracking.refresh();
  f.pose({ dungeonFrames: frames.slice(0, 2), dungeonFramesTimestamp: 10000 });
  await f.tracking.flush();
  assert.equal(f.tracking.getLocation().dungeon, undefined, 'A partial set of room frames cannot position a marker');
  f.now = 10100;
  f.pose({ dungeonFrames: frames, dungeonFramesTimestamp: 10100, position: { x: 107, y: 991, z: -188 } });
  await f.tracking.flush();
  const mapped = f.tracking.getLocation().dungeon;
  assert.ok(mapped?.alignmentVerified, 'Fresh placement maps the existing entry without another log event');
  assert.deepEqual(mapped.position, { x: 7, z: 12 });
  assert.equal(mapped.instanceId, entry.instanceId);
  const trail = await f.tracking.discovery.load(target);
  assert.equal(trail.alignment.status, 'verified');
  assert.equal(trail.alignment.source, 'level-info-fit');
  assert.ok(trail.exploration.cells.length > 0, 'Progressive reveal receives the first mapped cell');
  f.now = 10200;
  f.pose({ dungeonFrames: frames, dungeonFramesTimestamp: 10200, position: { x: 139, y: 991, z: -188 } });
  await f.tracking.flush();
  assert.ok((await f.tracking.discovery.load(target)).exploration.cells.length > trail.exploration.cells.length);
  assert.equal(f.tracking.getAccountId(), null);
  assert.equal(f.tracking.getOwner()?.account ?? null, null);
  assert.deepEqual(await fs.readdir(f.directory), [], 'The anonymous visit stays in memory');

  await fs.appendFile(file, 'QUIT :Logged out of game\n');
  watcher._poll(); await f.tracking.refresh();
  assert.equal(f.tracking.getLocation().status, 'unavailable');
  assert.equal((await f.tracking.discovery.load(target)).ok, false);
  const account = 'b'.repeat(24);
  await fs.appendFile(file, `Sys [Info]: Logged in Second (${account})\n` + enter);
  watcher._poll(); await f.tracking.refresh();
  const nextEntry = watcher.getState();
  assert.notEqual(nextEntry.instanceId, entry.instanceId);
  const next = await f.tracking.discovery.load({ instanceId: nextEntry.instanceId, revision: 'feed' });
  assert.equal(next.ok, true);
  assert.notEqual(next.scope, trail.scope);
  assert.deepEqual(next.exploration.cells, []);
  assert.equal((await f.tracking.discovery.save({ scope: trail.scope, exploration: trail.exploration })).ok, false);
});

test('support report distinguishes map placement without sharing locations or changing tracker state', async t => {
  const f = await fixture(t);
  f.reader.getDiagnostics = () => ({ readerStage: 'tracking' });
  const report = () => f.tracking.getDiagnostics();
  assert.deepEqual(report(), { mapStatus: 'stale', mapPlacement: 'no-live-sample', loginRecognized: true,
    areaRecognized: true, readerStage: 'tracking' });
  f.pose();
  const emitted = f.locations.length;
  assert.equal(report().mapPlacement, 'overworld');
  assert.equal(f.locations.length, emitted);
  f.pose({ position: { x: 1800, y: 0, z: 0 } });
  assert.equal(report().mapPlacement, 'outside-overworld-bounds');
  f.state = { active: false, status: 'outside', levelPath: '/SF/Levels/Other' }; f.pose();
  assert.equal(report().mapPlacement, 'other-area');
  f.state = dungeon('entry'); f.pose();
  assert.equal(report().mapPlacement, 'dungeon');
  f.account = null; f.tracking.refresh();
  assert.equal(report().mapStatus, 'waiting-for-login');
  assert.equal(report().loginRecognized, false);
});

test('a current Midrath entry can show a live marker before login identity is known', async t => {
  let allow = true;
  const f = await fixture(t, { processStartMs: 9000, getAccountId: () => null,
    canShowAnonymousOverworld: start => start === 9000 && allow });
  f.reader.getDiagnostics = () => ({ readerStage: 'tracking' });
  f.pose({ dungeonFrames: [{ source: 'level-info', matrix: [] }], dungeonFramesTimestamp: 10000 });
  const marker = f.tracking.getLocation();
  assert.equal(marker.status, 'found'); assert.equal(marker.isOverworld, true);
  assert.equal(marker.trackingSession, 'process-one');
  assert.equal(marker.heading, 90); assert.deepEqual(marker.position, { x: 100, y: 20, z: -10 });
  assert.equal(f.tracking.getDiagnostics().mapStatus, 'tracking');
  assert.equal(f.tracking.getDiagnostics().loginRecognized, false);
  assert.equal(f.tracking.getOwner(), null); assert.equal(f.tracking.frameCloud, null);
  assert.equal(marker.dungeon, undefined);
  f.reader.emit('world-drops', { type: 'world-drops', source: 'memory', status: 'available', sampledAt: 10000,
    trackingSession: 'process-one', items: [] });
  assert.equal(f.tracking.getLocation().worldDrops.status, 'unavailable');

  allow = false; // An explicit logout or conflicting identity can arrive without a new level.
  assert.equal(f.tracking.getLocation().status, 'unavailable'); f.pose();
  assert.equal(f.tracking.getStatus().status, 'waiting-for-login');
  allow = true; assert.equal(f.tracking.getLocation().status, 'unavailable');
  f.pose(); assert.equal(f.tracking.getLocation().status, 'found');
  f.tracking.setEnabled(false); f.pose(); assert.equal(f.tracking.getLocation().status, 'unavailable');
});

test('an unowned live pose cannot identify an area, cross processes or unlock dungeon discovery', async t => {
  let areaCurrent = true;
  const f = await fixture(t, { getAccountId: () => null, processStartMs: 9000,
    canShowAnonymousOverworld: () => true, isPlayerAreaCurrent: start => start === 9000 && areaCurrent });
  f.pose();
  areaCurrent = false; assert.equal(f.tracking.getLocation().status, 'unavailable');
  f.pose(); assert.equal(f.tracking.getStatus().status, 'waiting-for-area');
  areaCurrent = true;
  for (const state of [{ active: false, status: 'unknown' },
    { active: false, status: 'outside', levelPath: '/SF/Levels/PlayerTower' }, dungeon('other-entry')]) {
    f.state = state; f.pose(); assert.equal(f.tracking.getLocation().status, 'unavailable');
    assert.equal(f.tracking.context, null); assert.equal(f.tracking.getOwner(), null);
  }
  f.state = { active: false, status: 'outside', levelPath: '/SF/Levels/MidrathRedux', instanceId: 'entry' };
  f.reader.processStartMs = 10001; f.reader.update('tracking', 'new-process'); f.pose();
  assert.equal(f.tracking.getStatus().status, 'waiting-for-area');
  assert.equal(f.tracking.getLocation().status, 'unavailable');
});

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

test('a delayed layout cannot grant discovery after an anonymous login changes', async t => {
  let visit = 'first-login', resolveLayout;
  const f = await fixture(t, { getAnonymousDungeonVisit: () => visit,
    getLayoutSnapshot: state => new Promise(resolve => {
      resolveLayout = () => resolve({ state, status: 'ready', version: 'feed', coordinateSpace: 'world' });
    }) });
  f.account = null;
  f.state = dungeon('entered');
  const pending = f.tracking.refresh();
  await tick(); f.pose();
  visit = null;
  resolveLayout(); await pending;
  assert.equal(f.tracking.context, null);
  assert.equal((await f.tracking.discovery.load({ instanceId: 'entered', revision: 'feed' })).ok, false);
  assert.equal(f.locations.some(location => location.dungeon), false);
  assert.deepEqual(await fs.readdir(f.directory), []);
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

test('settings receive search progress changes even while the tracking status stays the same', async t => {
  const f = await fixture(t), updates = [];
  f.tracking.on('status', update => updates.push(update));
  for (const percent of [0, 25, 25, 63]) {
    f.reader.status = { status: 'searching', trackingSession: null, scanProgress: percent };
    f.reader.emit('status', f.reader.status);
    assert.equal(f.tracking.getStatus().scanProgress, percent);
  }
  assert.deepEqual(updates.map(update => update.scanProgress), [0, 25, 63]);
  f.reader.update('not-found', null);
  assert.deepEqual(f.tracking.getStatus(), { status: 'not-found' });
});

test('synchronous status observers can request a location without recursive status emission', async t => {
  const f = await fixture(t); let notifications = 0;
  f.tracking.on('status', () => { notifications++; f.tracking.getLocation(); });
  f.reader.update('searching', null); f.reader.update('tracking'); f.pose();
  assert.ok(notifications > 0 && notifications < 10);
  assert.equal(f.tracking.getStatus().status, 'tracking');
});
