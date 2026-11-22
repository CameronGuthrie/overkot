'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionGainsModel, stackObservation } = require('../src/modules/sessionGains');

const START = 1800000000000;
const HOUR = 3600000;
const ore = '/SF/Types/PickUps/Resources/BlueOreResource';
const herb = '/SF/Types/PickUps/Resources/GreenLeafResource';
const seed = '/SF/Types/Items/Consumables/WevetSeed';
const stack = (ItemType, ItemCount) => ({ ItemType, ItemCount });
const inventory = (quantity = 10) => ({ MiscItems: [stack(ore, quantity)], Consumables: [stack(seed, 2)],
  RegularCredits: 100, PremiumCredits: 5 });
const context = (hours = 0, extra = {}) => ({ status: 'live', accountId: 'account-a', sessionEpoch: 1,
  updatedAt: START + hours * HOUR, now: START + hours * HOUR, names: { [ore]: 'Blue ore' }, ...extra });
const row = (snapshot, type = ore) => snapshot.rows.find(item => item.itemType === type);

test('first live observation seeds physical holdings and duplicate stacks aggregate', () => {
  const model = createSessionGainsModel();
  const raw = inventory(); raw.MiscItems.push(stack(ore, '4'));
  const result = model.read(raw, context());
  assert.equal(result.status, 'live'); assert.equal(result.tracking, true);
  assert.equal(result.baselineAt, START); assert.equal(result.elapsedHours, 0);
  assert.equal(row(result).name, 'Blue ore'); assert.equal(row(result).current, 14);
  assert.equal(row(result).baseline, 14); assert.equal(row(result).net, 0); assert.equal(row(result).perHour, null);
  assert.deepEqual(result.withheldSections, []);
});

test('net changes include gains, spending, newly held items and complete removals with honest rates', () => {
  const model = createSessionGainsModel(); model.read(inventory(), context());
  const raw = inventory(18); raw.MiscItems.push(stack(herb, 3)); raw.Consumables = [];
  raw.RegularCredits = 70; raw.PremiumCredits = 8;
  const result = model.read(raw, context(2));
  assert.equal(result.elapsedHours, 2); assert.equal(row(result).net, 8); assert.equal(row(result).perHour, 4);
  assert.equal(row(result, herb).baseline, 0); assert.equal(row(result, herb).net, 3);
  assert.equal(row(result, seed).current, 0); assert.equal(row(result, seed).net, -2);
  assert.equal(row(result, 'RegularCredits').net, -30); assert.equal(row(result, 'RegularCredits').perHour, -15);
  assert.equal(row(result, 'PremiumCredits').net, 3);
  assert.equal(result.rows[0].itemType, 'RegularCredits', 'Largest absolute changes sort first');
});

test('a missing section withholds its rows without inventing losses and recovers against its original baseline', () => {
  const model = createSessionGainsModel(); model.read(inventory(), context());
  const partial = inventory(99); delete partial.MiscItems; delete partial.RegularCredits;
  const missing = model.read(partial, context(1));
  assert.equal(row(missing), undefined); assert.equal(row(missing, 'RegularCredits'), undefined);
  assert.deepEqual(missing.withheldSections, ['MiscItems', 'RegularCredits']);
  const restored = model.read(inventory(13), context(2));
  assert.equal(row(restored).net, 3); assert.equal(row(restored).baseline, 10);
  assert.equal(row(restored).perHour, 1.5);
});

test('an incomplete section is entirely withheld, including malformed records and unsafe summed counts', () => {
  const model = createSessionGainsModel(); model.read(inventory(), context());
  for (const entries of [[stack(ore, 1), null], [stack(ore, -1)], [stack(ore, 1.1)], [stack('', 3)],
    [stack(ore, Number.MAX_SAFE_INTEGER), stack(ore, 1)], [{ ItemType: ore }], [stack(ore, Infinity)],
    [stack('/SF/Bad\nPath', 2)]]) {
    const result = model.read({ ...inventory(), MiscItems: entries }, context(1));
    assert.equal(row(result), undefined); assert.ok(result.withheldSections.includes('MiscItems'));
  }
  assert.equal(model.read(inventory(12), context(2)).rows.find(item => item.itemType === ore).net, 2);
});

test('sections first observed later have independent baselines and rates', () => {
  const model = createSessionGainsModel();
  const initial = inventory(); delete initial.Consumables; delete initial.PremiumCredits;
  model.read(initial, context());
  const second = model.read(inventory(), context(1));
  assert.equal(row(second, seed).baselineAt, START + HOUR); assert.equal(row(second, seed).net, 0);
  assert.equal(row(second, seed).perHour, null);
  assert.deepEqual(second.seededSections, ['Consumables', 'PremiumCredits']);
  const next = inventory(14); next.Consumables[0].ItemCount = 4;
  const third = model.read(next, context(2));
  assert.equal(row(third).perHour, 2); assert.equal(row(third, seed).perHour, 2);
  assert.deepEqual(third.seededSections, ['Consumables', 'PremiumCredits'], 'Late-section provenance remains visible');
});

test('cached inventory never establishes or advances the live baseline', () => {
  const model = createSessionGainsModel();
  const first = model.read(inventory(500), context(0, { status: 'cached' }));
  assert.equal(first.baselineAt, null); assert.deepEqual(first.rows, []); assert.equal(first.tracking, false);
  model.read(inventory(10), context(1));
  const live = model.read(inventory(16), context(2));
  const saved = model.read(inventory(900), context(8, { status: 'cached' }));
  assert.deepEqual(saved.rows, live.rows); assert.equal(saved.elapsedHours, 1); assert.equal(saved.tracking, false);
  const resumed = model.read(inventory(20), context(3));
  assert.equal(row(resumed).net, 10); assert.equal(row(resumed).perHour, 5);
});

test('cached and out-of-order reads cannot resurrect a section withheld by the latest live observation', () => {
  const model = createSessionGainsModel(); model.read(inventory(), context());
  const partial = inventory(12); delete partial.MiscItems;
  model.read(partial, context(2));
  const saved = model.read(inventory(50), context(3, { status: 'cached' }));
  assert.equal(row(saved), undefined); assert.deepEqual(saved.withheldSections, ['MiscItems']);
  const old = model.read(inventory(50), context(1));
  assert.equal(row(old), undefined); assert.deepEqual(old.withheldSections, ['MiscItems']);
  model.read(null, context(3));
  assert.deepEqual(model.read(inventory(50), context(4, { status: 'cached' })).rows, []);
});

test('disconnect, missing-live-data wait, account change and new session each clear tracking', () => {
  for (const boundary of [{ status: 'connect' }, { status: 'waiting' }, { accountId: 'account-b' }, { sessionEpoch: 2 }]) {
    const model = createSessionGainsModel(); model.read(inventory(10), context());
    model.read(inventory(100), context(1));
    const boundaryContext = context(2, boundary);
    const boundaryResult = model.read(inventory(200), boundaryContext);
    const resumed = model.read(inventory(220), { ...boundaryContext, status: 'live', updatedAt: START + 3 * HOUR });
    if (boundary.status) {
      assert.equal(boundaryResult.baselineAt, null); assert.deepEqual(boundaryResult.rows, []);
      assert.equal(row(resumed).net, 0);
    } else {
      assert.equal(row(boundaryResult).net, 0); assert.equal(row(resumed).net, 20);
    }
  }
});

test('out-of-order live snapshots do not roll back values or stretch the observed window', () => {
  const model = createSessionGainsModel(); model.read(inventory(), context());
  const latest = model.read(inventory(18), context(2));
  const stale = model.read(inventory(99), context(1));
  assert.deepEqual(stale.rows, latest.rows); assert.equal(stale.observedAt, START + 2 * HOUR);
});

test('restart begins again from the next live observation without using a cached baseline', () => {
  const model = createSessionGainsModel(); model.read(inventory(), context());
  model.read(inventory(20), context(1));
  assert.deepEqual(model.action('reset', context(1)), { ok: true });
  const reset = model.read(inventory(20), context(1));
  assert.equal(row(reset).net, 0); assert.equal(reset.baselineAt, START + HOUR); assert.equal(reset.resetAt, START + HOUR);
  assert.equal(row(model.read(inventory(23), context(2))).net, 3);
  model.action('reset', context(2));
  assert.equal(model.read(inventory(99), context(3, { status: 'cached' })).baselineAt, null);
  assert.equal(row(model.read(inventory(50), context(4))).net, 0);
  assert.deepEqual(model.action('unknown', context()), { ok: false, reason: 'unknown-action' });
});

test('currency aliases, malformed values and missing sections cannot masquerade as known zero holdings', () => {
  const model = createSessionGainsModel();
  const result = model.read({ MiscItems: [], Consumables: [], Credits: 1000, PremiumCredits: 'unknown' }, context());
  assert.deepEqual(result.rows, []); assert.deepEqual(result.withheldSections, ['RegularCredits', 'PremiumCredits']);
  const valid = model.read({ ...inventory(), RegularCredits: '120' }, context(1));
  assert.equal(row(valid, 'RegularCredits').baseline, 120); assert.equal(row(valid, 'RegularCredits').net, 0);
});

test('wrapped inventories work, private account fields stay out of snapshots, and input is never mutated', () => {
  const model = createSessionGainsModel();
  const raw = inventory(); raw.AccountId = 'private'; raw.Nonce = 'secret';
  const before = structuredClone(raw);
  const result = model.read({ inventory: raw }, context());
  assert.equal(row(result).current, 10); assert.deepEqual(raw, before);
  assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(stackObservation({}, 'MiscItems'), null);
});

test('rates use observed inventory timestamps, remain finite, and never advance on render time alone', () => {
  const model = createSessionGainsModel(); model.read(inventory(), context());
  const result = model.read(inventory(20), context(1, { now: START + 10 * HOUR }));
  assert.equal(result.elapsedHours, 1); assert.equal(row(result).perHour, 10);
  const repeated = model.read(inventory(20), context(1, { now: START + 20 * HOUR }));
  assert.deepEqual(repeated.rows, result.rows);
});
