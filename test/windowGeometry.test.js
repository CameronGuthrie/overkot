'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { constrainBounds, restoreBounds, moveDragTarget, snapBounds, expandedBoundsAtPosition, dockAvailableSpace } = require('../src/modules/windowGeometry');

const desktop = { x: 0, y: 0, width: 1920, height: 1040 };

test('small drag deltas escape snapping instead of sticking to the displayed edge', () => {
  let target = { x: 5, y: 200, width: 300, height: 80 };
  let displayed;
  for (let i = 0; i < 20; i++) {
    target = moveDragTarget(target, 1, 0);
    displayed = snapBounds(target, desktop);
  }
  assert.equal(displayed.x, 25);
  assert.equal(displayed.width, 300);
});

test('clamped drag accumulates enough travel to reach an adjacent monitor', () => {
  let target = { x: 1620, y: 200, width: 300, height: 80 };
  let displayed;
  for (let i = 0; i < 40; i++) {
    target = moveDragTarget(target, 10, 0);
    const area = target.x + target.width / 2 >= 1920 ? { ...desktop, x: 1920 } : desktop;
    displayed = constrainBounds(target, area);
  }
  assert.equal(displayed.x, 2020);
  assert.equal(displayed.width, 300);
});

test('nearest snap wins regardless of window creation order', () => {
  const moving = { x: 302, y: 200, width: 100, height: 80 };
  const others = [
    { x: 300, y: 210, width: 100, height: 80 },
    { x: 310, y: 210, width: 100, height: 80 },
  ];
  assert.equal(snapBounds(moving, desktop, others).x, 300);
  assert.deepEqual(snapBounds(moving, desktop, others), snapBounds(moving, desktop, [...others].reverse()));
});

test('distant windows do not pull an unrelated drag into alignment', () => {
  const moving = { x: 302, y: 200, width: 100, height: 80 };
  assert.equal(snapBounds(moving, desktop, [{ x: 300, y: 800, width: 100, height: 80 }]).x, 302);
});

test('restore keeps negative monitor origins and respects a left or top taskbar', () => {
  const area = { x: -1880, y: -1040, width: 1880, height: 1040 };
  assert.deepEqual(restoreBounds({ x: -1920, y: -1080, width: 450, height: 500 }, {}, area),
    { x: -1880, y: -1040, width: 450, height: 500 });
});

test('restore recovers a disconnected monitor and invalid or oversized dimensions', () => {
  assert.deepEqual(restoreBounds({ x: 3000, y: 1800, width: Infinity, height: 3000 },
    { width: 450, height: 500 }, desktop, { width: 200, height: 40 }),
  { x: 1470, y: 0, width: 450, height: 1040 });
  assert.deepEqual(restoreBounds(null, { width: 450, height: 500 }, { x: 0, y: 0, width: 160, height: 120 },
    { width: 200, height: 150 }), { x: 0, y: 0, width: 160, height: 120 });
});

test('expanding a moved collapsed widget preserves its new position and original size', () => {
  assert.deepEqual(expandedBoundsAtPosition({ x: 100, y: 100, width: 350, height: 350 },
    { x: 600, y: 400, width: 350, height: 24 }),
  { x: 600, y: 400, width: 350, height: 350 });
});

test('dock uses space above a bottom-edge toolbar and below a top-edge toolbar', () => {
  assert.deepEqual(dockAvailableSpace({ x: 100, y: 990, width: 300, height: 40 }, desktop),
    { above: true, height: 978 });
  assert.deepEqual(dockAvailableSpace({ x: 100, y: 0, width: 300, height: 40 }, desktop),
    { above: false, height: 988 });
});
