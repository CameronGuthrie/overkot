'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDisplayId, displayOptions } = require('../src/modules/overlayDisplays');

test('display identifiers preserve native IDs without accepting strings or invalid sentinels', () => {
  for (const id of [0, 1, -10, 192837465]) assert.equal(normalizeDisplayId(id), id);
  for (const value of [-1, null, undefined, '', '1', true, 1.5, NaN, Infinity, {}, Number.MAX_SAFE_INTEGER + 1]) assert.equal(normalizeDisplayId(value), null);
});

test('connected monitor options carry stable IDs, primary status and copied monitor geometry', () => {
  const bounds = { x: -1920, y: -120, width: 1920, height: 1080 };
  const rows = displayOptions([{ id: 7, label: 'DELL U2720Q', bounds }, { id: 9, label: 'DELL U2720Q', bounds: { x: 0, y: 0, width: 2560, height: 1440 } }], 9);
  assert.deepEqual(rows.map(row => [row.id, row.primary]), [[7, false], [9, true]]);
  assert.equal(rows[0].label, 'Display 1: DELL U2720Q · 1920 × 1080');
  assert.equal(rows[1].label, 'Display 2: DELL U2720Q · 2560 × 1440 · Primary');
  assert.deepEqual(rows[0].bounds, bounds); assert.notEqual(rows[0].bounds, bounds);
});

test('bad or repeated monitor metadata cannot populate an unusable display option', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const rows = displayOptions([null, { id: -1, bounds }, { id: 1, label: '\nMain\u202e screen\u0000', bounds },
    { id: 1, label: 'duplicate', bounds }, { id: 2, bounds: { ...bounds, width: 0 } }, { id: 3, bounds: { ...bounds, y: NaN } }, { id: 4, bounds }], 1);
  assert.deepEqual(rows.map(row => row.id), [1, 4]);
  assert.equal(rows[0].label, 'Display 1: Main screen · 1920 × 1080 · Primary');
  assert.equal(rows[1].label, 'Display 2 · 1920 × 1080');
  assert.deepEqual(displayOptions(null, 1), []);
});
