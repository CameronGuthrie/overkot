'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_WORLD_DROPS, WORLD_DROP_TTL_MS, normalizeWorldDropsMessage, createWorldDropsStore } = require('../src/modules/worldDrops');

const now = 10000;
const type = '/SF/Weapons/Melee/OneHand/MockeryStultion/MockeryStultionMeleeWeapon';
const langKey = '/SF/Language/Weapons/MockeryStultionMeleeWeaponName';
const drop = fields => ({ id: 'opaque-drop-a', itemType: type, position: { x: 1, y: 2, z: 3 }, shiny: null, ...fields });
const frame = fields => ({ type: 'world-drops', source: 'memory', timestamp: now, status: 'available', items: [drop()], ...fields });
const message = fields => ({ ...normalizeWorldDropsMessage(frame(), now), trackingSession: 'verified-session-a', ...fields });
const catalog = { items: [{ category: 'Weapon', itemType: type, name: 'Stultin', langKey }] };
const setup = options => {
  let clock = now;
  const store = createWorldDropsStore({ now: () => clock, getCatalog: () => catalog, ...options });
  return { store, tick: value => { clock = value; } };
};

test('native drop frames strip private metadata and keep unknown quality and shiny unknown', () => {
  const parsed = normalizeWorldDropsMessage(frame({ privateAddress: 'private', items: [drop({
    name: 'Invented name', quality: 'IQ_WORN', shiny: 'false', privateAddress: 'private',
    position: { x: 1, y: 2, z: 3, privateAddress: 'private' },
  })] }), now);
  assert.deepEqual(parsed, { type: 'world-drops', source: 'memory', status: 'available', sampledAt: now, items: [drop()] });
  assert.equal(JSON.stringify(parsed).includes('private'), false);
  for (const shiny of [true, false]) assert.equal(normalizeWorldDropsMessage(frame({ items: [drop({ shiny })] }), now).items[0].shiny, shiny);
  assert.equal(normalizeWorldDropsMessage(frame({ items: [drop({ itemType: null })] }), now).items[0].itemType, null);
});

test('malformed, unbounded, stale and conflicting complete snapshots cannot enter the store', () => {
  const invalid = [null, [], {}, frame({ source: 'log' }), frame({ status: 'partial' }), frame({ timestamp: now - WORLD_DROP_TTL_MS - 1 }),
    frame({ timestamp: now + 1001 }), frame({ timestamp: 1.2 }), frame({ items: {} }), frame({ items: Array(MAX_WORLD_DROPS + 1).fill(drop()) })];
  for (const row of [drop({ id: '../address' }), drop({ id: '' }), drop({ id: 'x'.repeat(97) }), drop({ itemType: '/SF/Types/PickUps/WeaponPickUp' }),
    drop({ itemType: type + '/../Unknown' }), drop({ itemType: '/SF/Weapons/' + 'a'.repeat(301) }), drop({ itemType: 'Stultin' }),
    drop({ position: { x: '1', y: 2, z: 3 } }), drop({ position: { x: NaN, y: 2, z: 3 } }), drop({ position: { x: 1, y: 2, z: 1000001 } })]) {
    invalid.push(frame({ items: [row] }));
  }
  invalid.push(frame({ items: [drop(), drop({ shiny: true })] }));
  for (const value of invalid) assert.equal(normalizeWorldDropsMessage(value, now), null, JSON.stringify(value));
  assert.equal(normalizeWorldDropsMessage(frame({ items: [drop(), drop()] }), now).items.length, 1);
});

test('catalogue-confirmed weapon identity resolves localization, then English, without exposing types or trusting supplied names', () => {
  let names = { [langKey]: 'Localized Stultin' };
  const { store } = setup({ getNames: () => names });
  assert.equal(store.receive(message()), true);
  assert.deepEqual(store.read('verified-session-a'), { status: 'available', sampledAt: now,
    items: [{ id: 'opaque-drop-a', name: 'Localized Stultin', kind: 'weapon', shiny: null, position: { x: 1, y: 2, z: 3 } }] });
  names = { [type]: 'Canonical name' }; assert.equal(store.read('verified-session-a').items[0].name, 'Canonical name');
  names = new Map([[langKey, 'Map name']]); assert.equal(store.read('verified-session-a').items[0].name, 'Map name');
  for (const invalid of ['', '<b>Stultin</b>', 'bad\u202ename', 'x'.repeat(121), '/SF/Weapons/NotALabel']) {
    names = { [langKey]: invalid };
    assert.equal(store.read('verified-session-a').items[0].name, 'Stultin');
  }
  names = {}; assert.equal(store.read('verified-session-a').items[0].name, 'Stultin');
  const result = store.read('verified-session-a');
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['id', 'kind', 'name', 'position', 'shiny']);
  result.items[0].position.x = 999;
  assert.equal(store.read('verified-session-a').items[0].position.x, 1, 'callers cannot modify retained positions');
});

test('unknown types, non-weapons and unavailable metadata remain nameless rather than guessed', () => {
  const { store } = setup({ getCatalog: () => ({ items: [{ ...catalog.items[0], category: 'Blueprint' }] }) });
  assert.equal(store.receive(message()), true); assert.equal(store.read('verified-session-a').items[0].name, null);
  for (const itemType of [null, '/SF/Weapons/Melee/UnknownWeapon']) {
    const f = setup(); assert.equal(f.store.receive(message({ items: [drop({ itemType, name: 'Stultin' })] })), true);
    assert.equal(f.store.read('verified-session-a').items[0].name, null);
  }
  const missing = setup({ getCatalog: () => { throw Error('unavailable'); } });
  missing.store.receive(message()); assert.equal(missing.store.read('verified-session-a').items[0].name, null);
});

test('complete replacements handle pickup/despawn and reject replay without extending a stale observation', () => {
  const { store, tick } = setup();
  assert.equal(store.receive(message()), true);
  assert.equal(store.receive(message({ items: [] })), false, 'duplicate time cannot remove current drops');
  assert.equal(store.receive(message({ sampledAt: now - 1 })), false);
  assert.equal(store.receive(message({ sampledAt: now + 1, items: [] })), true);
  tick(now + 1); assert.deepEqual(store.read('verified-session-a').items, []);
  assert.equal(store.receive(message({ sampledAt: now + 2 })), true);
  tick(now + 2); assert.equal(store.read('verified-session-a').items.length, 1);
  tick(now + WORLD_DROP_TTL_MS + 3); assert.equal(store.read('verified-session-a').status, 'unavailable');
  assert.equal(store.receive(message({ sampledAt: now + 2 })), false);
  assert.equal(store.read('verified-session-a').items.length, 0);
});

test('status loss, session changes, clear, future time and invalid frames cannot leak old session drops', () => {
  const { store, tick } = setup();
  assert.equal(store.read('verified-session-a').status, 'unavailable');
  store.receive(message());
  assert.equal(store.receive(message({ sampledAt: now + 1, items: [{ broken: true }] })), false);
  assert.equal(store.read('verified-session-a').items.length, 1, 'a rejected frame retains the still-fresh complete set');
  assert.equal(store.receive(message({ status: 'unavailable', sampledAt: now + 1 })), true);
  tick(now + 1); assert.equal(store.read('verified-session-a').items.length, 0);
  assert.equal(store.receive(message()), false, 'older available frame cannot undo an explicit loss');
  assert.equal(store.receive(message({ trackingSession: 'verified-session-b' })), true);
  assert.equal(store.read('verified-session-b').items.length, 1);
  assert.equal(store.read('verified-session-a').items.length, 0);
  assert.equal(store.read('verified-session-b').items.length, 0, 'mismatched session invalidates the retained observation');
  store.receive(message({ sampledAt: now + 100 }));
  assert.equal(store.read('verified-session-a').status, 'unavailable', 'future samples never publish markers');
  tick(now + 100); assert.equal(store.read('verified-session-a').status, 'available');
  store.clear(); assert.equal(store.read('verified-session-a').items.length, 0);
  assert.equal(store.receive(message({ trackingSession: null })), false);
});

test('sixty-four independent drops remain bounded and stock Stultin resolves from the bundled catalogue', () => {
  const { store } = setup({ getCatalog: undefined });
  const items = Array.from({ length: MAX_WORLD_DROPS }, (_, index) => drop({ id: 'drop-' + index, shiny: false }));
  assert.equal(store.receive(message({ items })), true);
  const result = store.read('verified-session-a');
  assert.equal(result.items.length, MAX_WORLD_DROPS);
  assert.equal(result.items[0].name, 'Stultin'); assert.equal(result.items[0].shiny, false);
});
