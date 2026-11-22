'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Sizing = require('../src/modules/widgetSizing');
const Geometry = require('../src/modules/edgeDockGeometry');

test('main, grid geometry and browser share one widget size policy', () => {
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/widgetSizing.js'), 'utf8'), browser);
  assert.equal(browser.OverkotWidgetSizing.GRID_SIZE, Geometry.GRID_SIZE);
  assert.equal(Sizing.GRID_SIZE, 24);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.OverkotWidgetSizing.widgetDimensions('resources'))), Sizing.widgetDimensions('resources'));
  assert.deepEqual(Sizing.widgetDimensions('minimap'), { width: 350, height: 350, minWidth: 150, minHeight: 150 });
  assert.equal(Sizing.widgetDimensions('resources').minWidth, 300);
  assert.equal(Sizing.widgetDimensions('data-inventory').minHeight, 360);
  for (const id of ['daily', 'market', 'unknown', '__proto__']) assert.throws(() => Sizing.widgetDimensions(id), /known overlay widget/);
});

test('fixed width and height are independent and null restores automatic sizing', () => {
  assert.deepEqual(Sizing.normalizeSize('clock', { width: 457, height: null }, { strict: true }), { width: 457, height: null });
  assert.deepEqual(Sizing.normalizeSize('clock', { width: null, height: 137 }, { strict: true }), { width: null, height: 137 });
  assert.deepEqual(Sizing.normalizeSizes({ clock: { width: null, height: null }, resources: { width: 451, height: 517 } }),
    { resources: { width: 451, height: 517 } });
  for (const value of [NaN, Infinity, -1, 0, 199, 201.5, '400', 32769]) {
    assert.throws(() => Sizing.normalizeSize('clock', { width: value }, { strict: true }), /Widget width/);
  }
  assert.deepEqual(Sizing.normalizeSize('clock', { width: Infinity, height: 134 }), { width: null, height: 134 });
  assert.equal(Sizing.normalizeMode('free', { strict: true }), 'free');
  assert.equal(Sizing.normalizeMode('corrupt'), 'grid');
  assert.throws(() => Sizing.normalizeMode('corrupt', { strict: true }), /Grid or Free/);
});

test('unknown and prototype keys cannot add size preferences or leak local paths', () => {
  const input = JSON.parse('{"clock":{"width":431,"height":null,"eeLogPath":"private"},"daily":{"width":500},"__proto__":{"width":600},"constructor":{"width":600}}');
  assert.deepEqual(Sizing.normalizeSizes(input), { clock: { width: 431, height: null } });
  assert.throws(() => Sizing.normalizeSizes(input, { strict: true }), /known overlay widget/);
  assert.equal({}.width, undefined);
  assert.deepEqual(Sizing.normalizeSizes([]), {});
});

test('grid resize changes both axes while Free mode permits exact one-pixel sizes', () => {
  const initial = { id: 'resources', startWidth: 410, startHeight: 560, dx: 43, dy: -29 };
  assert.deepEqual(Sizing.resizeSize({ ...initial, mode: 'grid' }), { width: 456, height: 528 });
  assert.deepEqual(Sizing.resizeSize({ ...initial, mode: 'free' }), { width: 453, height: 531 });
  assert.deepEqual(Sizing.resizeSize({ ...initial, mode: 'free', dx: 1, dy: 1 }), { width: 411, height: 561 });
  assert.deepEqual(Sizing.resizeSize({ id: 'clock', startWidth: 300, startHeight: 200, dx: 50, dy: 0, mode: 'grid' }), { width: 360, height: 200 });
  assert.deepEqual(Sizing.resizeSize({ id: 'clock', startWidth: 300, startHeight: 200, dx: 0, dy: 50, mode: 'grid' }), { width: 300, height: 240 });
  assert.deepEqual(Sizing.resizeSize({ ...initial, dx: -10000, dy: -10000 }), { width: 300, height: 160 });
  assert.deepEqual(Sizing.resizeSize({ ...initial, dx: 10000, dy: 10000, workArea: { width: 900, height: 700 } }), { width: 900, height: 700 });
  assert.throws(() => Sizing.resizeSize({ ...initial, dx: NaN }), /valid starting/);
});

test('optional aspect lock remains bounded and supports vertical pointer movement', () => {
  const initial = { id: 'minimap', startWidth: 350, startHeight: 350, aspectRatio: 1, mode: 'free' };
  assert.deepEqual(Sizing.resizeSize({ ...initial, dx: 0, dy: 71 }), { width: 421, height: 421 });
  assert.deepEqual(Sizing.resizeSize({ ...initial, dx: 1000, dy: 0, workArea: { width: 800, height: 600 } }), { width: 600, height: 600 });
  assert.deepEqual(Sizing.resizeSize({ ...initial, dx: -1000, dy: -1000 }), { width: 150, height: 150 });
  assert.deepEqual(Sizing.resizeSize({ ...initial, dx: 1000, workArea: { width: 120, height: 100 } }), { width: 100, height: 100 });
});

test('legacy card heights remain automatic while map and data sizes retain both axes', () => {
  assert.deepEqual(Sizing.sizesFromLegacyBounds({ clock: { width: 441, height: 77 }, minimap: { width: 477, height: 399 },
    'data-inventory': { width: 661, height: 577 }, daily: { width: 700, height: 500 }, unknown: { width: 800 } }), {
    clock: { width: 441, height: null }, minimap: { width: 477, height: 399 },
    'data-inventory': { width: 661, height: 577 },
  });
});
