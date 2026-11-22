'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fitDungeonFrames } = require('../src/modules/dungeonFrameAlignment');

const state = { active: true, status: 'ready', instanceId: 'current-entry',
  levelPath: '/SF/Levels/Procs/GladesofAndurin/GladesProcLevel', layoutCode: 'abcDEF' };
const transforms = [
  { x: 0, y: 0, z: 0, rotation: 0 },
  { x: 17.3, y: -6.25, z: -35.7, rotation: Math.PI },
  { x: 91, y: 27.75, z: -202.25, rotation: Math.PI * 4 },
  { x: -43.75, y: -.25, z: -238.75, rotation: Math.PI * 5 }
];
const layout = rooms => ({ status: 'ready', coordinateSpace: 'layout-local', state: { ...state },
  rooms: (rooms || transforms).map(transform => ({ transform: { ...transform } })) });
function frame(t, root = { x: -58, y: 990, z: 119, rotation: .37 }) {
  const c = Math.cos(root.rotation), s = Math.sin(root.rotation), yaw = t.rotation + root.rotation;
  return { source: 'level-info', matrix: [Math.cos(yaw), 0, -Math.sin(yaw), 0, 0, 1, 0, 0,
    Math.sin(yaw), 0, Math.cos(yaw), 0, c * t.x + s * t.z + root.x,
    t.y + root.y, -s * t.x + c * t.z + root.z, 1] };
}
const cloud = root => transforms.map(t => frame(t, root));
function assertRoot(actual, expected) {
  assert.ok(actual); assert.equal(actual.source, 'level-info-fit');
  assert.equal(actual.levelPath, state.levelPath); assert.equal(actual.layoutCode, state.layoutCode);
  assert.ok(Math.abs(actual.matrix[12] - expected.x) < 1e-5);
  assert.ok(Math.abs(actual.matrix[13] - expected.y) < 1e-5);
  assert.ok(Math.abs(actual.matrix[14] - expected.z) < 1e-5);
  const yaw = Math.atan2(actual.matrix[8], actual.matrix[10]);
  assert.ok(Math.abs(Math.atan2(Math.sin(yaw - expected.rotation), Math.cos(yaw - expected.rotation))) < 1e-8);
}

test('a complete irregular layout recovers native translation and rotation with unrelated frames present', () => {
  for (const rotation of [0, .37, Math.PI, -Math.PI / 2, Math.PI * 2 - .01]) {
    const root = { x: -58, y: 990, z: 119, rotation };
    const frames = [frame({ x: 1500, y: -500, z: 2000, rotation: 0 }), ...cloud(root).reverse()];
    assertRoot(fitDungeonFrames(frames, layout()), root);
  }
});

test('native float32 roundoff and repeated equivalent anchor fits do not prevent registration', () => {
  const frames = cloud().map(value => ({ source: value.source, matrix: value.matrix.map(Math.fround) }));
  const fit = fitDungeonFrames([...frames, frames[0]], layout());
  assert.ok(fit); assert.ok(Math.abs(fit.matrix[12] + 58) < .0001);
  assert.ok(Math.abs(fit.matrix[14] - 119) < .0001);
});

test('every room is required and the cloud cannot use a single native entity to prove multiple rooms', () => {
  assert.equal(fitDungeonFrames(cloud().slice(1), layout()), null);
  const collapsed = layout([transforms[0], { ...transforms[0], x: .01 }, { ...transforms[0], x: .015 }]);
  const frames = [frame(transforms[0]), frame({ ...transforms[0], x: 10 }), frame({ ...transforms[0], x: 20 })];
  assert.equal(fitDungeonFrames(frames, collapsed), null);
  assert.equal(fitDungeonFrames(Array(4).fill(cloud()[0]), layout()), null);
});

test('a second complete graph is ambiguous even when all rooms and headings agree', () => {
  const two = [...cloud(), ...cloud({ x: 500, y: 990, z: -400, rotation: -.83 })];
  assert.equal(fitDungeonFrames(two, layout()), null);
  // A graph with rotational symmetry can also describe multiple final roots.
  const symmetric = [{ x: 0, y: 0, z: 0, rotation: 0 }, { x: 0, y: 0, z: 0, rotation: 2 * Math.PI / 3 },
    { x: 0, y: 0, z: 0, rotation: -2 * Math.PI / 3 }];
  assert.equal(fitDungeonFrames(symmetric.map(t => frame(t)), layout(symmetric)), null);
});

test('heights and headings disambiguate rooms rather than only comparing the floor plan', () => {
  const wrongHeight = cloud(); wrongHeight[2].matrix[13] += .1;
  assert.equal(fitDungeonFrames(wrongHeight, layout()), null);
  const wrongHeading = cloud(); wrongHeading[2] = frame({ ...transforms[2], rotation: transforms[2].rotation + .002 });
  assert.equal(fitDungeonFrames(wrongHeading, layout()), null);
  const reflected = cloud().map(value => { const copy = structuredClone(value); copy.matrix[0] *= -1; copy.matrix[8] *= -1; return copy; });
  assert.equal(fitDungeonFrames(reflected, layout()), null);
});

test('partial, unplaced, oversized, stale-context, or malformed inputs fail closed', () => {
  const valid = layout();
  for (const value of [null, {}, { ...valid, status: 'loading' }, { ...valid, coordinateSpace: 'world' },
    { ...valid, state: { ...state, active: false } }, { ...valid, state: { ...state, status: 'waiting' } },
    { ...valid, state: { ...state, instanceId: '' } }, { ...valid, state: { ...state, levelPath: '/bad' } },
    { ...valid, state: { ...state, layoutCode: null } }, { ...valid, rooms: [] },
    layout([transforms[0], transforms[1]]), layout([transforms[0], transforms[0], transforms[1]]),
    { ...valid, rooms: [{ transform: null }, ...valid.rooms] }, layout(Array(65).fill(transforms[0])),
    layout([{ ...transforms[0], x: NaN }, ...transforms.slice(1)])]) {
    assert.equal(fitDungeonFrames(cloud(), value), null);
  }
  for (const frames of [null, {}, Array(65).fill(cloud()[0]), cloud().map(value => ({ ...value, source: 'guessed' })),
    cloud().map(value => ({ ...value, matrix: [1, 2, 3] }))]) assert.equal(fitDungeonFrames(frames, valid), null);
});

test('fitting never mutates matrices or exposes native frame metadata', () => {
  const frames = cloud().map(value => ({ ...value, pointer: 'private' })), before = structuredClone(frames), current = layout();
  const fit = fitDungeonFrames(frames, current);
  assert.deepEqual(frames, before);
  assert.deepEqual(Object.keys(fit).sort(), ['layoutCode', 'levelPath', 'matrix', 'source']);
  fit.matrix[12] = 900; assert.deepEqual(frames, before);
});
