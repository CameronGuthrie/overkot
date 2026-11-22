'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appearance = require('../src/modules/mapAppearance');

test('map colours accept opaque hex values and independently recover safe defaults', () => {
  assert.equal(appearance.playerColor({ playerMarkerColor: '#AB12ef' }), '#AB12ef');
  assert.equal(appearance.playerOutlineColor({ playerMarkerOutlineColor: '#AB12ef' }), '#AB12ef');
  assert.equal(appearance.outlineColor({ dungeonMapOutlineColor: '#123456' }), '#123456');
  for (const value of [undefined, null, {}, 0, '#fff', '#11223344', 'red', 'var(--accent)', 'url(x)', '#11zz33', ' #112233']) {
    assert.equal(appearance.isColor(value), false);
    assert.equal(appearance.playerColor({ playerMarkerColor: value }), '#f4b642');
    assert.equal(appearance.playerOutlineColor({ playerMarkerOutlineColor: value }), '#241708');
    assert.equal(appearance.outlineColor({ dungeonMapOutlineColor: value }), '#d8d8d8');
  }
  assert.equal(appearance.playerColor(null), '#f4b642');
  assert.equal(appearance.playerOutlineColor(null), '#241708');
  assert.equal(appearance.outlineColor(null), '#d8d8d8');
});

function drawing() {
  const calls = [];
  const context = new Proxy({}, { get: (target, key) => target[key] || ((...args) => calls.push([key, ...args])) });
  return { context, calls };
}

test('the player symbol has a pointed tip, inset base and independently coloured dark outline', () => {
  const { context, calls } = drawing();
  assert.equal(appearance.drawPlayerMarker(context, { x: 50, y: 70, heading: 90,
    color: '#d15b40', outlineColor: '#321008', scale: 2 }), true);
  assert.deepEqual(calls.find(row => row[0] === 'translate'), ['translate', 50, 70]);
  assert.deepEqual(calls.find(row => row[0] === 'rotate'), ['rotate', Math.PI / 2]);
  const vertices = calls.filter(row => ['moveTo', 'lineTo'].includes(row[0])).map(row => row.slice(1));
  assert.equal(vertices.length, 4);
  assert.equal(vertices[1][1], vertices[3][1], 'The two tail corners share the same depth');
  assert.equal(vertices[1][0], -vertices[3][0]);
  assert.equal(vertices[2][0], 0, 'The base inset is centered on the tip');
  assert.ok(vertices[2][1] > vertices[0][1] && vertices[2][1] < vertices[1][1], 'The base is visibly notched');
  assert.ok((vertices[1][1] - vertices[0][1]) / (vertices[1][0] - vertices[3][0]) > 1.2, 'The marker is longer than it is wide');
  assert.ok(vertices[0][1] < 0 && vertices[1][1] > 0);
  assert.equal(context.fillStyle, '#d15b40');
  assert.equal(context.strokeStyle, '#321008');
  assert.equal(context.lineWidth, 4, 'Outline stays legible at doubled scale');
  assert.equal(calls.at(-1)[0], 'restore');
});

test('unknown facing draws a dot and malformed coordinates never reach canvas', () => {
  const { context, calls } = drawing();
  appearance.drawPlayerMarker(context, { x: 0, y: 0, heading: null, color: 'invalid' });
  assert.equal(calls.some(row => row[0] === 'rotate'), false);
  assert.equal(calls.some(row => row[0] === 'arc'), true);
  assert.equal(context.fillStyle, '#f4b642');
  assert.equal(context.strokeStyle, '#241708');
  for (const values of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: 0, y: 0, scale: 0 }]) {
    calls.length = 0; assert.equal(appearance.drawPlayerMarker(context, values), false); assert.equal(calls.length, 0);
  }
});

test('browser script loading exposes the same drawing contract without Node dependencies', () => {
  const window = {}, context = vm.createContext({ window });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/modules/mapAppearance.js'), 'utf8'), context);
  assert.equal(window.MapAppearance.playerColor({}), appearance.DEFAULT_PLAYER_COLOR);
  assert.equal(window.MapAppearance.playerOutlineColor({}), appearance.DEFAULT_PLAYER_OUTLINE_COLOR);
  assert.equal(typeof window.MapAppearance.drawPlayerMarker, 'function');
});
