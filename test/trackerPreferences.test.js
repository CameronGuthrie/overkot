'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTitleTrackerPreferences: title, normalizeTemperTrackerPreferences: temper } = require('../src/modules/trackerPreferences');

test('tracker preference defaults are independent and tolerate malformed saved profiles', () => {
  for (const value of [undefined, null, false, 1, 'all', []]) {
    assert.deepEqual(title(value), { showCompleted: true, showIncomplete: true, pinnedOnly: false, pinned: [], search: '' });
    assert.deepEqual(temper(value), { view: 'blacksmith', filter: 'held', groupings: { blacksmith: 'status', weapons: 'origin' },
      hiddenStatuses: [], collapsed: [], search: '' });
  }
  const first = temper(); first.groupings.blacksmith = 'name'; first.hiddenStatuses.push('unlocked');
  assert.equal(temper().groupings.blacksmith, 'status');
  assert.deepEqual(temper().hiddenStatuses, []);
});

test('title filters preserve explicit false values and multiple distinct pins', () => {
  const source = { showCompleted: false, showIncomplete: false, pinned: ['/SF/Titles/First', '/SF/Titles/Second', '/SF/Titles/First', 3, '', 'bad\u0000id'], search: 'Hunter', extra: 'ignored' };
  assert.deepEqual(title(source), { showCompleted: false, showIncomplete: false, pinnedOnly: false, pinned: ['/SF/Titles/First', '/SF/Titles/Second'], search: 'Hunter' });
  assert.equal(source.pinned.length, 6);
  assert.equal(title({ showCompleted: 'false', showIncomplete: 0 }).showCompleted, true);
  assert.equal(title({ showIncomplete: 0 }).showIncomplete, true);
});

test('pinned-only view accepts saved booleans and defaults older or malformed preferences to false', () => {
  assert.equal(title({ pinnedOnly: true }).pinnedOnly, true);
  assert.equal(title({ pinnedOnly: false }).pinnedOnly, false);
  for (const pinnedOnly of [undefined, null, 'true', 1, [], {}]) assert.equal(title({ pinnedOnly }).pinnedOnly, false);
});

test('temper validates each view grouping, filters and collapsible groups independently', () => {
  assert.deepEqual(temper({ view: 'weapons', filter: 'missing', groupings: { blacksmith: 'name', weapons: 'weapon' },
    hiddenStatuses: ['incomplete', 'unlocked', 'incomplete', 'unknown'],
    collapsed: ['status:unlocked', 'origin:Envoy', 'weapon:Vetch', 'weapon:Vetch', 'name:', 'bad:group', 'origin:bad\nname'], search: 'Vetch' }),
  { view: 'weapons', filter: 'missing', groupings: { blacksmith: 'name', weapons: 'weapon' },
    hiddenStatuses: ['incomplete', 'unlocked'], collapsed: ['status:unlocked', 'origin:Envoy', 'weapon:Vetch'], search: 'Vetch' });
  assert.deepEqual(temper({ view: 'invalid', filter: false, groupings: { blacksmith: 'weapon', weapons: 'status' } }).groupings,
    { blacksmith: 'status', weapons: 'origin' });
});

test('saved search, pins and collapsed groups have bounded sizes', () => {
  assert.equal(title({ pinned: Array.from({ length: 1000 }, (_, i) => `title-${i}`), search: 'x'.repeat(1000) }).pinned.length, 500);
  assert.equal(title({ pinned: ['x'.repeat(301)], search: 'x'.repeat(1000) }).search.length, 300);
  assert.deepEqual(title({ pinned: ['x'.repeat(301)] }).pinned, []);
  assert.equal(temper({ collapsed: Array.from({ length: 1000 }, (_, i) => `origin:Group ${i}`) }).collapsed.length, 500);
});
