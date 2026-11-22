'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMatrix, validateRoot, alignmentFromRoot, validRootAlignment, selectRoot } = require('../src/modules/dungeonRootAlignment');
const { validAlignment, worldToMap, mapToWorld, headingToMap } = require('../src/modules/mapAlignment');

const state = { active: true, status: 'ready', instanceId: 'entry', levelPath: '/SF/Levels/Procs/GladesofAndurin/GladesProcLevel', layoutCode: 'KWaQsfyJVjnBRACEIRA' };
const root = (yaw = 0) => ({ source: 'stream-region', levelPath: state.levelPath, layoutCode: state.layoutCode,
  matrix: [Math.cos(yaw), 0, -Math.sin(yaw), 0, 0, 1, 0, 0, Math.sin(yaw), 0, Math.cos(yaw), 0, 100, 1000, -200, 1] });

test('the loaded region matrix maps positions and facing without artificial calibration points', () => {
  for (const yaw of [0, Math.PI / 2, -Math.PI / 2, Math.PI, .37]) {
    const alignment = alignmentFromRoot(root(yaw), state);
    assert.equal(validRootAlignment(alignment), true); assert.equal(validAlignment(alignment), true);
    assert.equal(alignment.points, 0); assert.equal(alignment.source, 'stream-region'); assert.equal(alignment.height, 1000);
    const mapped = { x: 23, z: -14 }, world = mapToWorld(mapped, alignment), restored = worldToMap(world, alignment);
    assert.ok(Math.hypot(restored.x - mapped.x, restored.z - mapped.z) < 1e-10);
    assert.ok(Math.abs(headingToMap(45 + yaw * 180 / Math.PI, alignment) - 45) < 1e-9);
  }
});

test('only the exact current ready dungeon can consume a native root', () => {
  for (const current of [{ ...state, active: false }, { ...state, status: 'waiting' }, { ...state, instanceId: null },
    { ...state, levelPath: '/SF/Levels/Procs/Other' }, { ...state, layoutCode: 'another' }, null]) {
    assert.equal(alignmentFromRoot(root(), current), null);
  }
});

test('root validation rejects reflected, scaled, tilted and nonaffine transforms', () => {
  const malformed = [value => { value.matrix[0] = -1; }, value => { value.matrix[5] = 2; },
    value => { value.matrix[1] = .1; }, value => { value.matrix[15] = 0; }, value => { value.matrix[3] = .1; },
    value => { value.matrix[12] = 1e7; }, value => { value.matrix[10] = NaN; }, value => { value.matrix.pop(); },
    value => { value.matrix[4] = Infinity; }, value => { value.matrix[0] = '1'; }];
  for (const mutate of malformed) { const value = root(); mutate(value); assert.equal(validateRoot(value), null); }
  assert.equal(validateRoot({ ...root(), source: 'estimated' }), null);
});

test('sanitized roots copy their matrix and whitelist their public data', () => {
  const input = { ...root(), pointer: 'private' }, checked = validateRoot(input);
  assert.equal('pointer' in checked, false); assert.notEqual(checked.matrix, input.matrix);
  input.matrix[12] = 999; assert.equal(checked.matrix[12], 100);
  for (const levelPath of ['/SF/Levels/Procs/../secret', '/SF/Levels/Procs//Invalid', '/SF/Levels/Other', state.levelPath + '.lp']) {
    assert.equal(validateRoot({ ...root(), levelPath }), null);
  }
});

test('a generator placement can bind separately to the trusted current log fingerprint', () => {
  const value = root(); delete value.layoutCode;
  assert.equal(validateRoot(value).layoutCode, undefined);
  assert.equal(alignmentFromRoot(value, state).layoutCode, state.layoutCode);
  const nextEntry = { ...state, instanceId: 'new-entry', layoutCode: 'DIFFERENT' };
  assert.equal(alignmentFromRoot(value, nextEntry).layoutCode, 'DIFFERENT');
  assert.equal(alignmentFromRoot(root(), nextEntry), null, 'An explicit fingerprint must still match');
});

test('placement selection uses the exact current generator and rejects conflicts', () => {
  const value = root(), other = { ...root(), levelPath: '/SF/Levels/Procs/UnderCityCliffCave' };
  assert.deepEqual(selectRoot([other, value], state), value);
  assert.equal(selectRoot([other], state), null);
  assert.deepEqual(selectRoot([value, root()], state), value);
  const moved = root(); moved.matrix[12] += 1;
  assert.equal(selectRoot([value, moved], state), null);
  assert.equal(selectRoot(Array(33).fill(value), state), null);
});

test('room-frame fits preserve their provenance through persisted alignment validation', () => {
  const value = { ...root(.37), source: 'level-info-fit' };
  assert.equal(validateRoot(value).source, 'level-info-fit');
  const alignment = alignmentFromRoot(value, state);
  assert.equal(alignment.source, 'level-info-fit');
  assert.equal(validRootAlignment(alignment), true);
  assert.deepEqual(validateMatrix(value.matrix), value.matrix);
  const sparse = [...value.matrix]; delete sparse[0];
  assert.equal(validateMatrix(sparse), null);
});
