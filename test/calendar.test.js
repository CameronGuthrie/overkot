const test = require('node:test');
const assert = require('node:assert/strict');
const { CalendarService, inventoryUnlocks, questComplete, QUESTS } = require('../src/modules/calendar');
const { OPTIONAL, ANCESTORS, dateNumber, dateAt, projectCalendar, validateCalendar } = require('../src/modules/calendarData');
const data = require('../src/data/calendar.json');

function service() {
  const values = {};
  return new CalendarService({ config: { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } },
    feed: { data }, now: () => Date.parse('2026-09-12T23:30:00Z') });
}
const completed = name => ({ ItemType: QUESTS[name], Completed: 'opaque-progress', CompletionDate: { $date: { $numberLong: '1780000000000' } } });

test('quest completion uses the completion date, not opaque progress strings', () => {
  assert.equal(questComplete({ Completed: 'not-empty', CompletionDate: { $date: { $numberLong: '0' } } }), false);
  assert.equal(questComplete({ Completed: 'not-empty' }), false);
  assert.equal(questComplete(completed('Bromius')), true);
  assert.equal(questComplete({ Completed: true }), true);
});

test('account unlocks include beast quests and exclude pre-created locked residents', () => {
  const unlocks = inventoryUnlocks({ Quests: [completed('Garren Rood'), completed('Bromius'), completed('Orengall')], Ancestors: [
    { ItemType: '/SF/Types/Game/Ancestors/Orlick/OrlickAncestor', Rank: 0 },
    { ItemType: '/SF/Types/Game/Ancestors/Verminia/VerminiaAncestor', Rank: -1 },
    { ItemType: '/SF/Types/Game/Ancestors/MestraCarmo/MestraCarmoAncestor', Rank: 9 },
  ] });
  assert.deepEqual(unlocks, { 'Garren Rood': true, Bromius: true, Orengall: true, Tuvalkane: false, Verminia: false, Orlick: true });
  assert.ok(Object.values(inventoryUnlocks(null)).every(value => value === null));
  assert.ok(Object.values(inventoryUnlocks({ Quests: [] })).every(value => value === false));
  assert.equal(inventoryUnlocks({ Quests: [{ ItemType: QUESTS.Orlick, Completed: 'in-progress' }], Ancestors: [{ ItemType: '/SF/Types/Game/Ancestors/Orlick/OrlickAncestor', Rank: 2 }] }).Orlick, false);
});

test('matches known pipeline offers and all-unlocked encounter in UTC', () => {
  const calendar = service();
  calendar.updateInventory({ Quests: OPTIONAL.map(completed) }, 'player-a');
  const day = calendar.getDay();
  assert.equal(day.date, '2026-09-12');
  assert.equal(day.ancestor, 'Orengall');
  assert.deepEqual(day.offers, [{ name: 'Maestro', price: 240 }, { name: 'Rook', price: 215 }, { name: 'Cenotaph', price: 250 }, { name: 'Seathorn', price: 220 }]);
  assert.equal(calendar.getDay('2026-09-13').ancestor, 'Zenith');
});

test('each of the 64 account combinations uses its own schedule and never selects locked ancestors', () => {
  const calendar = service();
  for (let mask = 0; mask < 64; mask++) {
    const unlocked = OPTIONAL.filter((_, index) => mask & 1 << index);
    calendar.updateInventory({ Quests: unlocked.map(completed) }, 'player-a');
    for (let offset = 0; offset < data.encounters.days.length; offset++) {
      const day = calendar.getDay(dateAt(data.encounters.from, offset));
      assert.equal(day.ancestor, ANCESTORS[Number(data.encounters.days[offset][mask])]);
      assert.ok(['Zenith', 'Dale Seer', ...unlocked].includes(day.ancestor));
    }
  }
});

test('manual overrides persist through inventory updates; reset follows the latest account', () => {
  const calendar = service();
  calendar.updateInventory({ Quests: [] }, 'player-a', true);
  calendar.setAncestor('Bromius', true);
  calendar.setAncestor('Orengall', false);
  calendar.updateInventory({ Quests: [completed('Orengall')] }, 'player-a');
  assert.equal(calendar.getSettings().ancestors.find(row => row.name === 'Bromius').unlocked, true);
  assert.equal(calendar.getSettings().ancestors.find(row => row.name === 'Orengall').unlocked, false);
  calendar.reset();
  assert.equal(calendar.getSettings().customized, false);
  assert.equal(calendar.getSettings().source, 'live');
  assert.equal(calendar.getSettings().ancestors.find(row => row.name === 'Bromius').unlocked, false);
  assert.equal(calendar.getSettings().ancestors.find(row => row.name === 'Orengall').unlocked, true);
  calendar.setAncestor('Bromius', true);
  calendar.updateInventory({ Quests: [] }, 'player-b');
  assert.equal(calendar.getSettings().customized, false);
  assert.equal(calendar.getSettings().ancestors.find(row => row.name === 'Bromius').unlocked, false);
  assert.throws(() => calendar.setAncestor('Zenith', false));
  assert.throws(() => calendar.setAncestor('Bromius', 'yes'));
});

test('missing inventory is explicit and manual selection can supply the complete pool', () => {
  const calendar = service();
  assert.equal(calendar.getDay().ancestor, null);
  assert.equal(calendar.getDay().inventoryReady, false);
  for (const name of OPTIONAL) calendar.setAncestor(name, false);
  assert.equal(calendar.getDay().inventoryReady, true);
  assert.ok(['Zenith', 'Dale Seer'].includes(calendar.getDay().ancestor));
  calendar.reset();
  assert.equal(calendar.getDay().inventoryReady, false);
});

test('UTC dates validate leap days and do not invent out-of-range schedules', () => {
  assert.equal(dateAt('2028-02-28', 1), '2028-02-29');
  assert.equal(dateAt('2026-12-31', 1), '2027-01-01');
  for (const date of ['2026-02-29', '2026-04-31', '2026-9-12', '../other', '2026-09-12T00:00:00Z']) assert.throws(() => dateNumber(date));
  const calendar = service();
  calendar.updateInventory({ Quests: [] }, 'player-a');
  assert.equal(calendar.getDay('2027-01-01').offers, null);
  assert.equal(calendar.getDay('2027-01-01').encounterAvailable, false);
});

test('compact projection preserves all variants and rejects gaps, duplicate pools and locked selections', () => {
  const index = { from_utc: '2026-09-12', days: 1, variation_count: 64, variations: [] };
  const variations = [];
  for (let mask = 0; mask < 64; mask++) {
    const optional = OPTIONAL.filter((_, bit) => mask & 1 << bit);
    index.variations.push({ unlocked_ancestors: ['Zenith', 'Moose', ...optional] });
    variations.push({ from_utc: index.from_utc, rotations: [{ date_utc: index.from_utc, selected: { internal_name: (optional[0]?.replaceAll(' ', '') || 'Moose') + 'BoonNpc' } }] });
  }
  const zenith = { from_utc: index.from_utc, days: 1, rotations: [{ date_utc: index.from_utc, offers: [{ name: 'Rook', premium_price: 215 }] }] };
  const result = projectCalendar(zenith, index, variations);
  assert.equal(result.encounters.days[0][0], '1'); // Moose display alias.
  assert.equal(result.encounters.days[0][1], '2'); // Garren Rood.
  assert.deepEqual(result.weapons, [['Rook', 215]]);
  const invalid = structuredClone(result); invalid.encounters.days[0] = '7' + invalid.encounters.days[0].slice(1);
  assert.throws(() => validateCalendar(invalid), /locked/);
  index.variations[1] = index.variations[0];
  assert.throws(() => projectCalendar(zenith, index, variations), /Duplicate/);
  zenith.rotations[0].date_utc = '2026-09-13';
  assert.throws(() => projectCalendar(zenith, index, variations), /consecutive/);
});
