'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createExploration, MAX_CELLS } = require('../src/modules/dungeonExploration');

test('discovery reveals circles around observed positions, not the square or whole room', () => {
  const exploration = createExploration({ radius: 10, cellSize: 2 });
  assert.deepEqual(exploration.reveal({ x: 0, z: 0 }), { changed: true, added: 1, limited: false });
  assert.equal(exploration.isRevealed(0, 0), true);
  assert.equal(exploration.isRevealed(6, 8), true, 'Exact circle edge is visible');
  assert.equal(exploration.isRevealed(8, 8), false, 'Square corners remain hidden');
  assert.equal(exploration.isRevealed(10.01, 0), false);
  assert.equal(exploration.isRevealed(500, 0), false);
});

test('ordinary movement reveals a continuous trail and remembers places left behind', () => {
  const exploration = createExploration({ radius: 10, cellSize: 2 });
  exploration.reveal({ x: -20, z: -20 });
  exploration.reveal({ x: 20, z: -20 });
  for (let x = -20; x <= 20; x += 0.5) assert.equal(exploration.isRevealed(x, -20), true, `Trail at ${x}`);
  exploration.reveal({ x: 20, z: 20 });
  assert.equal(exploration.isRevealed(-20, -20), true);
  assert.equal(exploration.isRevealed(0, 0), false, 'Movement around a corner does not reveal its interior');
  assert.equal(exploration.isRevealed(20, 0), true);
});

test('teleports and explicit discontinuities reveal endpoints without imaginary connecting paths', () => {
  const exploration = createExploration({ radius: 10, cellSize: 2 });
  exploration.reveal({ x: 0, z: 0 });
  exploration.reveal({ x: 100, z: 0 });
  assert.equal(exploration.isRevealed(50, 0), false);
  assert.equal(exploration.isRevealed(100, 0), true);
  exploration.reveal({ x: 100, z: 40 }, { continuous: false });
  assert.equal(exploration.isRevealed(100, 20), false);
  exploration.reveal({ x: 110, z: 40 });
  assert.equal(exploration.isRevealed(105, 40), true);
  assert.equal(exploration.isRevealed(0, 0), true);
});

test('stationary jitter is deduplicated while negative coordinate buckets stay independent', () => {
  const exploration = createExploration({ radius: 10, cellSize: 2 });
  exploration.reveal({ x: 0.1, z: 0.1 });
  assert.deepEqual(exploration.reveal({ x: 1.9, z: 1.9 }), { changed: false, added: 0, limited: false });
  exploration.reveal({ x: -0.1, z: -0.1 });
  assert.equal(exploration.size, 2);
  assert.deepEqual(exploration.circles(), [[0.1, 0.1], [-0.1, -0.1]]);
});

test('serializable snapshots restore discovery without restoring a stale movement connection', () => {
  const original = createExploration({ radius: 10, cellSize: 2 });
  original.reveal({ x: -30, z: 10 });
  original.reveal({ x: -10, z: 10 });
  const saved = JSON.parse(JSON.stringify(original.snapshot()));
  const restored = createExploration({ radius: 10, cellSize: 2 });
  restored.reveal({ x: 30, z: 10 });
  assert.equal(restored.restore(saved), true);
  assert.deepEqual(restored.snapshot(), saved);
  assert.equal(restored.isRevealed(-20, 10), true);
  restored.reveal({ x: 30, z: 10 });
  assert.equal(restored.isRevealed(10, 10), false, 'Restoring never links a previous session position');
});

test('snapshots, rendering circles, and restored input are independent copies', () => {
  const exploration = createExploration();
  exploration.reveal({ x: 0, z: 0 });
  const snapshot = exploration.snapshot(), circles = exploration.circles();
  snapshot.cells[0][0] = 1000;
  circles[0][1] = 1000;
  assert.equal(exploration.isRevealed(0, 0), true);
  assert.equal(exploration.isRevealed(1000, 0), false);
  const valid = { schema: 1, radius: 45, cellSize: 8, cells: [[100, 100]] };
  assert.equal(exploration.restore(valid), true);
  valid.cells[0][0] = 0;
  assert.equal(exploration.isRevealed(100, 100), true);
  assert.equal(exploration.isRevealed(0, 100), false);
});

test('malformed and oversized saves are rejected atomically', () => {
  const exploration = createExploration({ maxCells: 2 });
  exploration.reveal({ x: 0, z: 0 });
  const before = exploration.snapshot();
  const save = cells => ({ schema: 1, radius: 45, cellSize: 8, cells });
  for (const invalid of [
    null, [], false, {}, { ...before, schema: 2 }, { ...before, radius: 46 }, { ...before, cellSize: 4 },
    save({}), save([[100, 100], [NaN, 0]]), save([[Infinity, 0]]), save([[10000001, 0]]),
    save([[1, '2']]), save([[1]]), save([[1, 2, 3]]), save([[0, 0], [1, 1]]),
    save([[0, 0], [20, 20], [40, 40]]),
  ]) {
    assert.equal(exploration.restore(invalid), false);
    assert.deepEqual(exploration.snapshot(), before);
  }
});

test('capacity preserves existing discovery and reports an explicit limit without eviction', () => {
  const exploration = createExploration({ radius: 10, cellSize: 2, maxCells: 2 });
  exploration.reveal({ x: 0, z: 0 });
  exploration.reveal({ x: 100, z: 0 });
  assert.deepEqual(exploration.reveal({ x: 200, z: 0 }), { changed: false, added: 0, limited: true });
  assert.equal(exploration.size, 2);
  assert.equal(exploration.isRevealed(0, 0), true);
  assert.equal(exploration.isRevealed(100, 0), true);
  assert.equal(exploration.isRevealed(200, 0), false);
  assert.deepEqual(exploration.reveal({ x: 100, z: 0 }), { changed: false, added: 0, limited: false });
  assert.equal(exploration.snapshot().cells.length, 2);
});

test('nonfinite, nonnumeric and out-of-range readings reveal nothing and interrupt continuity', () => {
  const exploration = createExploration({ radius: 10, cellSize: 2 });
  for (const position of [null, undefined, {}, { x: '0', z: 0 }, { x: NaN, z: 0 }, { x: 0, z: Infinity }, { x: 10000001, z: 0 }]) {
    exploration.reveal({ x: 0, z: 0 });
    assert.deepEqual(exploration.reveal(position), { changed: false, added: 0, limited: false });
    exploration.reveal({ x: 40, z: 0 });
    assert.equal(exploration.isRevealed(20, 0), false);
    exploration.clear();
  }
  for (const value of [NaN, Infinity, '0', null, 10000001]) assert.equal(exploration.isRevealed(value, 0), false);
});

test('clear resets both saved discovery and interpolation state', () => {
  const exploration = createExploration({ radius: 10, cellSize: 2 });
  exploration.reveal({ x: 0, z: 0 });
  assert.equal(exploration.clear(), true);
  assert.equal(exploration.clear(), false);
  assert.equal(exploration.size, 0);
  assert.equal(exploration.isRevealed(0, 0), false);
  exploration.reveal({ x: 40, z: 0 });
  assert.equal(exploration.isRevealed(20, 0), false);
  assert.deepEqual(exploration.snapshot().cells, [[40, 0]]);
});

test('configuration and interpolation work remain bounded', () => {
  for (const options of [
    { radius: 0 }, { radius: Number.MIN_VALUE }, { radius: NaN }, { radius: Infinity }, { radius: 10001 },
    { cellSize: 0 }, { cellSize: Number.MIN_VALUE }, { cellSize: NaN }, { cellSize: 23 },
    { maxCells: 0 }, { maxCells: 1.5 }, { maxCells: MAX_CELLS + 1 },
  ]) assert.throws(() => createExploration(options), RangeError);
  const exploration = createExploration({ radius: 10, cellSize: 0.000001 });
  exploration.reveal({ x: 0, z: 0 });
  assert.equal(exploration.reveal({ x: 40, z: 0 }).added, 16);
  assert.equal(exploration.size, 17, 'Tiny deduplication cells cannot create millions of interpolation stamps');
  for (let x = 0; x <= 40; x += 0.5) assert.equal(exploration.isRevealed(x, 0), true);
});

test('the same module runs in a browser without Node or account identifiers', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/dungeonExploration'), 'utf8'), context);
  const exploration = context.window.DungeonExploration.createExploration();
  exploration.reveal({ x: 10, z: 20, accountId: 'private-account', instanceId: 'private-instance' });
  assert.equal(exploration.isRevealed(10, 20), true);
  assert.equal(JSON.stringify(exploration.snapshot()).includes('private'), false);
  assert.deepEqual(Object.keys(exploration.snapshot()).sort(), ['cellSize', 'cells', 'radius', 'schema']);
});
