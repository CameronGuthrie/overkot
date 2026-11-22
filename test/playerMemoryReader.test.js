'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { PlayerMemoryReader, parseMessage, helperPath, HELPER, LINUX_HELPER, MAX_LINE_BYTES, MAX_CARRY_BYTES } = require('../src/modules/playerMemoryReader');

const now = 10000;
const identity = { processStartUtcTicks: '639300105603881999', moduleHash: 'a'.repeat(64) };
const status = (value = 'tracking', fields = identity) => ({ type: 'status', status: value, ...fields });
const pose = (fields = {}) => ({ type: 'pose', source: 'memory', timestamp: now, position: { x: 12, y: -4, z: 56 }, heading: -90, ...fields });
const worldDrops = (fields = {}) => ({ type: 'world-drops', source: 'memory', timestamp: now, status: 'available',
  items: [{ id: 'opaque-drop-a', itemType: '/SF/Weapons/Melee/OneHand/MockeryStultion/MockeryStultionMeleeWeapon',
    position: { x: 13, y: -4, z: 57 }, shiny: null }], ...fields });
const dungeonRoot = fields => ({ source: 'stream-region', levelPath: '/SF/Levels/Procs/UnderCityGauntlet',
  layoutCode: 'ShGaIa5IZlKJq676AAGIIAhAEYA',
  matrix: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 100, -3, 200, 1], ...fields });
const dungeonFrame = fields => ({ source: 'level-info', matrix: dungeonRoot().matrix, ...fields });

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.killed = 0; }
  kill() { this.killed++; return true; }
}

function setup(options = {}) {
  const children = []; const calls = [];
  const reader = new PlayerMemoryReader({ executable: 'native-reader.exe', exists: () => true, platform: 'win32', now: () => now,
    spawnImpl: (...args) => { const child = new FakeChild(); children.push(child); calls.push(args); return child; }, ...options });
  const poses = []; const statuses = []; const drops = [];
  reader.on('pose', value => poses.push(value)); reader.on('status', value => statuses.push(value));
  reader.on('world-drops', value => drops.push(value));
  return { reader, children, calls, poses, statuses, drops };
}
function send(child, message) { child.stdout.write(`${JSON.stringify(message)}\n`); }

test('helper resolution uses packaged resources and prefers the compiled development helper', () => {
  const root = path.resolve('test-root');
  for (const [platform, name] of [['win32', HELPER], ['linux', LINUX_HELPER]]) {
    const development = path.join(root, '.build', 'bin', name);
    const asset = path.join(root, 'assets', 'bin', name);
    assert.equal(helperPath({ platform, root, resourcesPath: undefined, exists: file => file === development }), development);
    assert.equal(helperPath({ platform, root, resourcesPath: undefined, exists: () => false }), asset);
    assert.equal(helperPath({ platform, root, resourcesPath: undefined, exists: () => { throw Error('unreadable'); } }), asset);
    assert.equal(helperPath({ platform, root, resourcesPath: 'resources', exists: () => true }), path.join('resources', 'bin', name));
    assert.equal(helperPath({ platform, root, resourcesPath: 'electron-resources', defaultApp: true, exists: () => true }), development);
  }
});

test('Linux launches its native reader and accepts verified poses, room frames and pickup snapshots', () => {
  const f = setup({ platform: 'linux', executable: '/packaged/resources/bin/overkot-position-reader' });
  f.reader.start(123);
  assert.equal(f.calls[0][0], '/packaged/resources/bin/overkot-position-reader');
  assert.deepEqual(f.calls[0][1], ['--pid', '123']);
  send(f.children[0], status());
  send(f.children[0], pose({ dungeonFrames: [dungeonFrame()], dungeonFramesTimestamp: now }));
  send(f.children[0], worldDrops());
  assert.equal(f.reader.getState().status, 'tracking');
  assert.equal(f.poses.length, 1); assert.equal(f.poses[0].dungeonFrames.length, 1);
  assert.equal(f.drops.length, 1); assert.equal(f.drops[0].trackingSession, f.poses[0].trackingSession);
  f.reader.stop();
});

test('Linux permission denial preserves the actionable status and rejects later pose packets', () => {
  const f = setup({ platform: 'linux' }); f.reader.start(123);
  send(f.children[0], status('permission-denied', {})); send(f.children[0], pose());
  f.children[0].emit('exit', 1);
  assert.equal(f.reader.getState().status, 'permission-denied'); assert.equal(f.poses.length, 0);
});

test('protocol accepts bounded native statuses and strips untrusted details', () => {
  assert.deepEqual(parseMessage(JSON.stringify(status('scan-incomplete', { ...identity, privateAddress: 'never forward' })), now), {
    type: 'status', status: 'scan-incomplete', ...identity,
  });
  assert.equal(parseMessage(JSON.stringify(status('not-a-status')), now), null);
  for (const invalid of ['0', '-1', '01', '3155378976000000000', '1'.repeat(100)]) {
    assert.equal(parseMessage(JSON.stringify(status('searching', { ...identity, processStartUtcTicks: invalid })), now).processStartUtcTicks, null);
  }
  assert.equal(parseMessage(JSON.stringify(status('unsupported-build', { moduleHash: null })), now).moduleHash, null);
});

test('pose parser bounds coordinates, heading, timestamp, and source', () => {
  assert.deepEqual(parseMessage(JSON.stringify(pose({ extra: 'discard' })), now), {
    type: 'pose', source: 'memory', sampledAt: now, position: { x: 12, y: -4, z: 56 }, heading: 270,
  });
  assert.equal(parseMessage(JSON.stringify(pose({ heading: null })), now).heading, null);
  for (const fields of [
    { position: { x: 1000001, y: 0, z: 0 } }, { position: { x: '12', y: 0, z: 0 } }, { position: null },
    { heading: '90' }, { heading: 361 }, { heading: undefined }, { timestamp: now - 2001 },
    { timestamp: now + 1001 }, { timestamp: now + 0.1 }, { timestamp: 0 }, { source: 'screenshot' },
  ]) assert.equal(parseMessage(JSON.stringify(pose(fields)), now), null);
  for (const text of ['not-json', 'null', '[]', '"pose"', ' '.repeat(8193)]) assert.equal(parseMessage(text, now), null);
});

test('world-drop protocol accepts complete bounded memory snapshots without leaking private fields or fabricating metadata', () => {
  const frame = worldDrops();
  frame.items[0].privateAddress = 'discard'; frame.items[0].name = 'Forged name'; frame.privateAddress = 'discard';
  const parsed = parseMessage(JSON.stringify(frame), now);
  assert.deepEqual(parsed, { type: 'world-drops', source: 'memory', sampledAt: now, status: 'available', items: worldDrops().items });
  assert.equal(JSON.stringify(parsed).includes('discard'), false);
  for (const fields of [{ source: 'log' }, { timestamp: now - 2001 }, { timestamp: now + 1001 },
    { status: 'partial' }, { items: Array(65).fill(frame.items[0]) }, { items: [frame.items[0], { ...frame.items[0], shiny: true }] }]) {
    assert.equal(parseMessage(JSON.stringify(worldDrops(fields)), now), null);
  }
  const unavailable = parseMessage(JSON.stringify(worldDrops({ status: 'unavailable' })), now);
  assert.deepEqual(unavailable.items, [], 'a native unavailable observation never republishes old items');
});

test('world drops require the verified session and their ordering is independent of pose packets', () => {
  const { reader, children, poses, drops } = setup(); reader.start(123); const child = children[0];
  send(child, worldDrops()); assert.equal(drops.length, 0);
  send(child, status()); send(child, pose({ timestamp: now + 100 })); send(child, worldDrops());
  assert.equal(drops.length, 1); assert.equal(poses.length, 1);
  assert.equal(drops[0].trackingSession, poses[0].trackingSession);
  send(child, worldDrops()); send(child, worldDrops({ timestamp: now - 1 })); assert.equal(drops.length, 1);
  send(child, worldDrops({ timestamp: now + 1, status: 'unavailable' }));
  assert.equal(drops.length, 2); assert.equal(drops[1].status, 'unavailable');
  send(child, pose({ timestamp: now + 101 })); assert.equal(poses.length, 2, 'drop packets do not consume pose ordering');
  send(child, status('searching')); send(child, worldDrops({ timestamp: now + 2 })); assert.equal(drops.length, 2);
  send(child, status('tracking', { ...identity, processStartUtcTicks: '639300105603882000' }));
  send(child, worldDrops({ timestamp: now - 1 }));
  assert.equal(drops.length, 3); assert.notEqual(drops[2].trackingSession, drops[0].trackingSession);
});

test('chunked world-drop packets are ignored after stop, process loss or helper replacement', () => {
  const { reader, children, drops } = setup(); reader.start(123); const first = children[0]; send(first, status());
  const encoded = JSON.stringify(worldDrops());
  first.stdout.write(encoded.slice(0, 40)); assert.equal(drops.length, 0);
  first.stdout.write(encoded.slice(40) + '\n'); assert.equal(drops.length, 1);
  reader.start(124); const second = children[1];
  send(first, worldDrops({ timestamp: now + 1 })); assert.equal(drops.length, 1);
  send(second, status()); send(second, worldDrops()); assert.equal(drops.length, 2);
  second.emit('exit', 0); send(second, worldDrops({ timestamp: now + 1 })); assert.equal(drops.length, 2);
  reader.start(125); send(children[2], status()); reader.stop();
  send(children[2], worldDrops()); assert.equal(drops.length, 2);
});

test('pose protocol retains only a verified upright stream-region dungeon root', () => {
  const root = dungeonRoot();
  const parsed = parseMessage(JSON.stringify(pose({ dungeonRoot: { ...root, privatePointer: 'discard' }, privatePointer: 'discard' })), now);
  assert.deepEqual(parsed.dungeonRoot, root);
  assert.deepEqual(Object.keys(parsed.dungeonRoot).sort(), ['layoutCode', 'levelPath', 'matrix', 'source']);
  assert.equal('privatePointer' in parsed, false);
  assert.deepEqual(parsed.position, { x: 12, y: -4, z: 56 });
  const largestCode = parseMessage(JSON.stringify(pose({ dungeonRoot: dungeonRoot({ layoutCode: 'A'.repeat(4096) }) })), now);
  assert.equal(largestCode.dungeonRoot.layoutCode.length, 4096);
});

test('malformed optional dungeon roots are dropped without losing a valid world pose', () => {
  const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const matrixWith = (index, value) => { const matrix = [...identityMatrix]; matrix[index] = value; return matrix; };
  const invalid = [null, [], 'root', {}, dungeonRoot({ source: 'capture' }),
    dungeonRoot({ levelPath: '/SF/Levels/MidrathRedux' }), dungeonRoot({ levelPath: '/SF/Levels/Procs/../PlayerTower' }),
    dungeonRoot({ levelPath: '/SF/Levels/Procs/Test?secret=1' }), dungeonRoot({ levelPath: '/SF/Levels/Procs/' + 'A'.repeat(513) }),
    dungeonRoot({ layoutCode: '' }), dungeonRoot({ layoutCode: 'A'.repeat(4097) }), dungeonRoot({ layoutCode: 'ABC/DEF' }),
    dungeonRoot({ layoutCode: 'ABC_DEF' }), dungeonRoot({ matrix: identityMatrix.slice(0, 15) }),
    dungeonRoot({ matrix: [...identityMatrix, 0] }), dungeonRoot({ matrix: matrixWith(12, 1000001) }),
    dungeonRoot({ matrix: matrixWith(3, .1) }), dungeonRoot({ matrix: matrixWith(15, .8) }),
    dungeonRoot({ matrix: matrixWith(0, 2) }), dungeonRoot({ matrix: matrixWith(0, -1) }),
    dungeonRoot({ matrix: matrixWith(4, .2) }), dungeonRoot({ matrix: matrixWith(5, -1) }),
    dungeonRoot({ matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1] }),
    dungeonRoot({ matrix: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] }),
    dungeonRoot({ matrix: matrixWith(12, null) }), dungeonRoot({ matrix: matrixWith(12, '1') }),
    dungeonRoot({ matrix: matrixWith(12, Infinity) }), dungeonRoot({ matrix: matrixWith(12, NaN) }),
  ];
  for (const root of invalid) {
    const parsed = parseMessage(JSON.stringify(pose({ dungeonRoot: root })), now);
    assert.equal(parsed.heading, 270);
    assert.deepEqual(parsed.position, { x: 12, y: -4, z: 56 });
    assert.equal('dungeonRoot' in parsed, false, JSON.stringify(root));
  }
  const encoded = JSON.stringify(pose({ dungeonRoot: dungeonRoot() })).replace('"source":"stream-region"', '"__proto__":{"polluted":true},"source":"stream-region"');
  const parsed = parseMessage(encoded, now);
  assert.deepEqual(parsed.dungeonRoot, dungeonRoot());
  assert.equal(Object.hasOwn(parsed.dungeonRoot, '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('reader forwards dungeon roots only within a verified session and never retains a rejected old root', () => {
  const { reader, children, poses } = setup(); reader.start(123); const child = children[0];
  send(child, pose({ dungeonRoot: dungeonRoot() })); assert.equal(poses.length, 0);
  send(child, status()); send(child, pose({ dungeonRoot: dungeonRoot() }));
  assert.deepEqual(poses[0].dungeonRoot, dungeonRoot());
  send(child, pose({ timestamp: now + 1, dungeonRoot: dungeonRoot({ source: 'unverified' }) }));
  assert.equal(poses.length, 2); assert.equal('dungeonRoot' in poses[1], false);
  assert.equal(poses[1].trackingSession, poses[0].trackingSession);
});

test('plural dungeon roots accept bounded independent anchors without fabricating a layout code', () => {
  const roots = Array.from({ length: 32 }, (_, index) => {
    const root = dungeonRoot({ levelPath: '/SF/Levels/Procs/Room' + index + 'A'.repeat(350), privatePointer: 'discard' });
    delete root.layoutCode; return root;
  });
  const encoded = JSON.stringify(pose({ dungeonRoots: roots }));
  assert.ok(Buffer.byteLength(encoded) > 8192 && Buffer.byteLength(encoded) <= MAX_LINE_BYTES);
  const parsed = parseMessage(encoded, now);
  assert.equal(parsed.dungeonRoots.length, 32);
  assert.equal('dungeonRoot' in parsed, false);
  for (const root of parsed.dungeonRoots) {
    assert.equal(Object.hasOwn(root, 'layoutCode'), false);
    assert.equal(Object.hasOwn(root, 'privatePointer'), false);
    assert.deepEqual(Object.keys(root).sort(), ['levelPath', 'matrix', 'source']);
  }
  const { reader, children, poses } = setup(); reader.start(123); send(children[0], status());
  children[0].stdout.write(encoded.slice(0, 12000)); assert.equal(poses.length, 0);
  children[0].stdout.write(encoded.slice(12000) + '\n'); assert.equal(poses.length, 1);
  assert.equal(poses[0].dungeonRoots.length, 32);
});

test('invalid plural roots drop individually while an oversized list is ignored and world pose survives', () => {
  const noCode = dungeonRoot({ levelPath: '/SF/Levels/Procs/GladesofAndurin/GladesProcLevel' }); delete noCode.layoutCode;
  const parsed = parseMessage(JSON.stringify(pose({ dungeonRoots: [null, {}, dungeonRoot({ matrix: [] }),
    dungeonRoot({ layoutCode: null }), noCode, dungeonRoot()] })), now);
  assert.equal(parsed.dungeonRoots.length, 2);
  assert.equal(parsed.dungeonRoots[0].levelPath, noCode.levelPath);
  assert.equal(Object.hasOwn(parsed.dungeonRoots[0], 'layoutCode'), false);
  for (const invalid of [{}, 'roots', Array(33).fill(dungeonRoot())]) {
    const result = parseMessage(JSON.stringify(pose({ dungeonRoots: invalid })), now);
    assert.equal('dungeonRoots' in result, false);
    assert.deepEqual(result.position, { x: 12, y: -4, z: 56 });
  }
});

test('identical roots collapse and conflicting generator anchors are omitted instead of choosing the first', () => {
  const first = dungeonRoot(), conflicting = dungeonRoot(); conflicting.matrix[12] += 5;
  const other = dungeonRoot({ levelPath: '/SF/Levels/Procs/GladesofAndurin/GladesProcLevel' });
  const same = parseMessage(JSON.stringify(pose({ dungeonRoots: [first, first, first] })), now);
  assert.deepEqual(same.dungeonRoots, [first]);
  for (const roots of [[first, conflicting, other, first], [conflicting, first, other, conflicting]]) {
    const result = parseMessage(JSON.stringify(pose({ dungeonRoots: roots })), now);
    assert.deepEqual(result.dungeonRoots, [other]);
    assert.equal(result.heading, 270);
  }
  const differentCode = dungeonRoot({ layoutCode: 'ANOTHER' });
  assert.deepEqual(parseMessage(JSON.stringify(pose({ dungeonRoots: [first, differentCode] })), now).dungeonRoots, []);
  const mixed = parseMessage(JSON.stringify(pose({ dungeonRoot: conflicting, dungeonRoots: [first, other] })), now);
  assert.equal(Object.hasOwn(mixed, 'dungeonRoot'), false);
  assert.deepEqual(mixed.dungeonRoots, [other]);
});

test('fresh level-info frame clouds retain only bounded sanitized upright matrices', () => {
  const frame = dungeonFrame();
  const parsed = parseMessage(JSON.stringify(pose({ dungeonFrames: [{ ...frame, entityPointer: 'discard' }, frame,
    null, [], {}, dungeonFrame({ source: 'guessed' }), dungeonFrame({ matrix: [] })], dungeonFramesTimestamp: now - 1000 })), now);
  assert.deepEqual(parsed.dungeonFrames, [frame]);
  assert.equal(parsed.dungeonFramesTimestamp, now - 1000);
  assert.deepEqual(Object.keys(parsed.dungeonFrames[0]).sort(), ['matrix', 'source']);
  assert.deepEqual(parsed.position, { x: 12, y: -4, z: 56 });
  const encoded = JSON.stringify(pose({ dungeonFrames: [frame], dungeonFramesTimestamp: now }))
    .replace('"source":"level-info"', '"__proto__":{"polluted":true},"source":"level-info"');
  const clean = parseMessage(encoded, now);
  assert.deepEqual(clean.dungeonFrames, [frame]);
  assert.equal(Object.hasOwn(clean.dungeonFrames[0], '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('old, future, malformed and oversized clouds are omitted while the valid world pose survives', () => {
  const frames = [dungeonFrame()];
  for (const timestamp of [undefined, null, '10000', 0, now - 2001, now + 1, now - .5]) {
    const parsed = parseMessage(JSON.stringify(pose({ dungeonFrames: frames, dungeonFramesTimestamp: timestamp })), now);
    assert.equal(Object.hasOwn(parsed, 'dungeonFrames'), false);
    assert.equal(Object.hasOwn(parsed, 'dungeonFramesTimestamp'), false);
    assert.equal(parsed.heading, 270);
  }
  for (const dungeonFrames of [{}, 'cloud', Array(65).fill(dungeonFrame())]) {
    const parsed = parseMessage(JSON.stringify(pose({ dungeonFrames, dungeonFramesTimestamp: now })), now);
    assert.equal(Object.hasOwn(parsed, 'dungeonFrames'), false);
    assert.deepEqual(parsed.position, { x: 12, y: -4, z: 56 });
  }
  const aheadOfPose = parseMessage(JSON.stringify(pose({ timestamp: now - 1000, dungeonFrames: frames, dungeonFramesTimestamp: now })), now);
  assert.equal(Object.hasOwn(aheadOfPose, 'dungeonFrames'), false);
  const boundary = parseMessage(JSON.stringify(pose({ timestamp: now - 1000, dungeonFrames: frames, dungeonFramesTimestamp: now - 900 })), now);
  assert.equal(boundary.dungeonFrames.length, 1, 'a cloud may finish at most 100ms after its pose');
});

test('room-frame packets never fall back to a legacy loading root when their cloud is rejected', () => {
  const root = dungeonRoot();
  const legacy = parseMessage(JSON.stringify(pose({ dungeonRoot: root, dungeonRoots: [root] })), now);
  assert.deepEqual(legacy.dungeonRoot, root); assert.deepEqual(legacy.dungeonRoots, [root]);
  for (const cloud of [
    { dungeonFrames: [dungeonFrame()], dungeonFramesTimestamp: now - 2001 },
    { dungeonFrames: [dungeonFrame()], dungeonFramesTimestamp: now + 1 },
    { dungeonFrames: null, dungeonFramesTimestamp: now },
    { dungeonFrames: {}, dungeonFramesTimestamp: now },
    { dungeonFrames: Array(65).fill(dungeonFrame()), dungeonFramesTimestamp: now },
    { dungeonFrames: [], dungeonFramesTimestamp: now },
    { dungeonFrames: [dungeonFrame()], dungeonFramesTimestamp: now },
  ]) {
    const parsed = parseMessage(JSON.stringify(pose({ dungeonRoot: root, dungeonRoots: [root], ...cloud })), now);
    assert.equal(Object.hasOwn(parsed, 'dungeonRoot'), false);
    assert.equal(Object.hasOwn(parsed, 'dungeonRoots'), false);
    assert.deepEqual(parsed.position, { x: 12, y: -4, z: 56 }); assert.equal(parsed.heading, 270);
  }
});

test('up to 64 native frame anchors fit the bounded protocol and older clouds are never replayed by the reader', () => {
  const frames = Array.from({ length: 64 }, (_, index) => {
    const yaw = (index + 1) * .017, c = Math.cos(yaw), s = Math.sin(yaw);
    return dungeonFrame({ matrix: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0,
      index * 5.123456789, -3.456789, 200.123456789 + index, 1] });
  });
  const encoded = JSON.stringify(pose({ dungeonFrames: frames, dungeonFramesTimestamp: now }));
  assert.ok(Buffer.byteLength(encoded) > 8192 && Buffer.byteLength(encoded) <= MAX_LINE_BYTES);
  const { reader, children, poses } = setup(); reader.start(123); const child = children[0]; send(child, status());
  child.stdout.write(encoded.slice(0, 9000)); assert.equal(poses.length, 0);
  child.stdout.write(encoded.slice(9000) + '\n');
  assert.equal(poses[0].dungeonFrames.length, 64);
  assert.equal(poses[0].dungeonFramesTimestamp, now);
  send(child, pose({ timestamp: now + 1, dungeonFrames: frames, dungeonFramesTimestamp: now - 2001 }));
  assert.equal(poses.length, 2);
  assert.equal(Object.hasOwn(poses[1], 'dungeonFrames'), false);
  assert.equal(Object.hasOwn(poses[1], 'dungeonFramesTimestamp'), false);
});

test('only a verified tracking session forwards fresh poses', () => {
  const { reader, children, calls, poses } = setup(); reader.start(123); const child = children[0];
  assert.deepEqual(calls[0], ['native-reader.exe', ['--pid', '123'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }]);
  send(child, pose()); assert.equal(poses.length, 0);
  send(child, status('searching')); send(child, pose()); assert.equal(poses.length, 0);
  send(child, status()); send(child, pose()); assert.equal(poses.length, 1);
  assert.match(poses[0].trackingSession, /^[a-f0-9]{64}$/);
  assert.equal(poses[0].heading, 270);
  assert.equal(reader.getState().trackingSession, poses[0].trackingSession);
  reader.start(123); assert.equal(children.length, 1);
  reader.stop(); assert.equal(child.killed, 1); assert.equal(reader.getState().trackingSession, null);
});

test('partial frames, multiple frames, and bounded malformed frames do not expose raw data', () => {
  const { reader, children, poses } = setup(); reader.start(123); const child = children[0];
  const encoded = `${JSON.stringify(status())}\r\n${JSON.stringify(pose())}\n`;
  child.stdout.write(encoded.slice(0, 35)); assert.equal(poses.length, 0);
  child.stdout.write(encoded.slice(35)); assert.equal(poses.length, 1);
  child.stdout.write(`not-json\n${JSON.stringify({ type: 'diagnostic', memory: 'private' })}\n`);
  send(child, pose({ timestamp: now + 100 })); assert.equal(poses.length, 2);
  assert.equal(JSON.stringify(poses).includes('private'), false);
});

test('losing identity or leaving tracking invalidates the active session', () => {
  const { reader, children, poses } = setup(); reader.start(123); const child = children[0];
  send(child, status()); send(child, pose()); const original = poses[0].trackingSession;
  send(child, status('scan-incomplete')); assert.equal(reader.getState().trackingSession, null);
  send(child, pose({ timestamp: now + 100 })); assert.equal(poses.length, 1);
  send(child, status()); send(child, pose({ timestamp: now + 200 }));
  assert.equal(poses[1].trackingSession, original);
  send(child, status('tracking', {})); assert.equal(reader.getState().status, 'unavailable');
  assert.equal(reader.getState().trackingSession, null);
  send(child, pose({ timestamp: now + 300 })); assert.equal(poses.length, 2);
});

test('duplicate and out-of-order poses are dropped while a new process identity resets ordering', () => {
  const { reader, children, poses } = setup(); reader.start(123); const child = children[0];
  send(child, status()); send(child, pose()); send(child, pose()); send(child, pose({ timestamp: now - 1 }));
  assert.equal(poses.length, 1);
  send(child, status('tracking', { ...identity, processStartUtcTicks: '639300105603882000' }));
  send(child, pose({ timestamp: now - 1 })); assert.equal(poses.length, 2);
  assert.notEqual(poses[1].trackingSession, poses[0].trackingSession);
});

test('restarting ignores every callback from a previous child', () => {
  const { reader, children, poses } = setup(); reader.start(123); const first = children[0];
  send(first, status()); send(first, pose()); const original = poses[0].trackingSession;
  reader.start(124); const second = children[1]; assert.equal(first.killed, 1);
  send(first, status()); send(first, pose({ timestamp: now + 1 })); first.emit('error', Error('old')); first.emit('exit', 1);
  assert.equal(poses.length, 1); assert.equal(reader.getState().status, 'searching');
  send(second, status()); send(second, pose()); assert.equal(poses.length, 2);
  assert.notEqual(poses[1].trackingSession, original);
});

test('a status listener can restart the reader without processing remaining frames from the old child', () => {
  const { reader, children, poses } = setup(); let restarted = false;
  reader.on('status', value => { if (value.status === 'tracking' && !restarted) { restarted = true; reader.start(124); } });
  reader.start(123); const first = children[0];
  first.stdout.write(`${JSON.stringify(status())}\n${JSON.stringify(pose())}\n`);
  assert.equal(children.length, 2); assert.equal(poses.length, 0); assert.equal(reader.getState().status, 'searching');
  send(children[1], status()); send(children[1], pose()); assert.equal(poses.length, 1);
});

test('helper exit clears active session and preserves specific terminal reasons', () => {
  for (const terminal of ['scan-incomplete', 'ambiguous', 'not-found', 'permission-denied', 'unsupported-build', 'profile-mismatch']) {
    const { reader, children } = setup(); reader.start(123); const child = children[0];
    send(child, status()); send(child, pose()); send(child, status(terminal)); child.emit('exit', 4);
    assert.deepEqual(reader.getState(), { status: terminal, trackingSession: null });
    assert.equal(reader.child, null); assert.equal(reader.pid, null);
  }
  const { reader, children } = setup(); reader.start(123); send(children[0], status()); children[0].emit('exit', 0);
  assert.deepEqual(reader.getState(), { status: 'process-gone', trackingSession: null });
});

test('spawn errors, missing helpers, invalid PIDs, and unsupported platforms fail cleanly', () => {
  for (const options of [
    { spawnImpl: () => { throw Error('spawn failed'); } }, { spawnImpl: () => null },
  ]) {
    const { reader } = setup(options); assert.doesNotThrow(() => reader.start(123));
    assert.deepEqual(reader.getState(), { status: 'unavailable', trackingSession: null }); assert.equal(reader.pid, null);
  }
  for (const exists of [() => false, () => { throw Error('denied'); }]) {
    const { reader, children } = setup({ exists }); reader.start(123);
    assert.equal(reader.getState().status, 'helper-unavailable'); assert.equal(children.length, 0);
  }
  for (const pid of [0, -1, 0x80000000, '123', 1.5, NaN]) {
    const { reader, children } = setup(); reader.start(pid);
    assert.equal(reader.getState().status, 'process-gone'); assert.equal(children.length, 0);
  }
  const unsupported = setup({ platform: 'darwin' }); unsupported.reader.start(123);
  assert.equal(unsupported.reader.getState().status, 'unsupported-platform'); assert.equal(unsupported.children.length, 0);
  const { reader, children } = setup(); reader.start(123); send(children[0], status()); children[0].emit('error', Error('spawn failed'));
  assert.deepEqual(reader.getState(), { status: 'unavailable', trackingSession: null }); assert.equal(children[0].killed, 1);
});

test('oversized completed or partial frames stop the helper and invalidate its session', () => {
  for (const frame of [' '.repeat(MAX_CARRY_BYTES + 1), `${' '.repeat(MAX_LINE_BYTES + 1)}\n`, `${JSON.stringify(pose())}${' '.repeat(MAX_LINE_BYTES + 1)}\n`]) {
    const { reader, children, poses } = setup(); reader.start(123); const child = children[0];
    send(child, status()); child.stdout.write(frame);
    assert.deepEqual(reader.getState(), { status: 'unavailable', trackingSession: null }); assert.equal(child.killed, 1);
    send(child, pose()); assert.equal(poses.length, 0);
  }
});

test('partial buffering has a separate bounded carry budget and completed frames still obey the line cap', () => {
  const { reader, children } = setup(); reader.start(123); const child = children[0]; send(child, status());
  child.stdout.write(' '.repeat(MAX_LINE_BYTES + 1));
  assert.equal(reader.getState().status, 'tracking');
  child.stdout.write('\n');
  assert.equal(reader.getState().status, 'unavailable');
  assert.equal(child.killed, 1);
  assert.equal(parseMessage(JSON.stringify(pose()) + ' '.repeat(MAX_LINE_BYTES), now), null);
});

test('root refresh queues only its fixed command for a current verified tracking session', () => {
  const { reader, children } = setup();
  assert.equal(reader.refreshRoots(), false);
  reader.start(123); const child = children[0];
  let written = ''; child.stdin.on('data', value => { written += String(value); });
  assert.equal(reader.refreshRoots(), false, 'searching has no verified character session');
  send(child, status());
  assert.equal(reader.refreshRoots('untrusted input is ignored'), true);
  assert.equal(written, 'refresh-roots\n');
  assert.equal(reader.getState().status, 'tracking');
  send(child, status('searching'));
  assert.equal(reader.refreshRoots(), false);
  assert.equal(written, 'refresh-roots\n');
  reader.stop(); assert.equal(reader.refreshRoots(), false);
});

test('root refresh treats backpressure as queued and ignores closed-pipe errors without losing live tracking', () => {
  const { reader, children } = setup(); reader.start(123); const child = children[0]; send(child, status());
  const writes = []; child.stdin.write = value => { writes.push(value); return false; };
  assert.equal(reader.refreshRoots(), true); assert.deepEqual(writes, ['refresh-roots\n']);
  assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(Error('closed'), { code: 'EPIPE' })));
  assert.equal(reader.getState().status, 'tracking');
  child.stdin.write = () => { throw Error('closed'); };
  assert.equal(reader.refreshRoots(), false);
  child.stdin.destroy(); assert.equal(reader.refreshRoots(), false);
});
