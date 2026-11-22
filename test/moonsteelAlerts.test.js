'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoonsteelAlerts, MAX_SEEN_DROPS } = require('../src/modules/moonsteelAlerts');
const Settings = require('../src/modules/moonsteelAlertSettings');

const weapon = fields => ({ id: 'drop-a', kind: 'weapon', shiny: true, name: 'Stultin', position: { x: 5, y: 2, z: 3 }, ...fields });
function fixture() {
  let clock = 10000, preferences = { ...Settings.DEFAULTS };
  const alerts = [];
  const detector = createMoonsteelAlerts({ now: () => clock, getSettings: () => preferences, onAlert: data => alerts.push(data) });
  const frame = (items = [weapon()], fields = {}) => ({ status: 'found', source: 'memory', sampledAt: clock,
    trackingSession: 'process-a', instanceId: 'entry-a', zone: '/SF/Levels/MidrathRedux', isOverworld: true,
    position: { x: 0, y: 0, z: 0 }, worldDrops: { status: 'available', sampledAt: clock, items }, ...fields });
  return { detector, alerts, frame, tick(ms = 1) { clock += ms; }, settings(value) { preferences = { ...preferences, ...value }; } };
}

test('main-process telemetry alerts once per confirmed drop without any minimap or discovery context', () => {
  const f = fixture();
  assert.equal(f.detector.receive(f.frame()), 1);
  assert.equal(f.detector.receive(f.frame()), 0);
  for (let sample = 0; sample < 10; sample++) { f.tick(200); assert.equal(f.detector.receive(f.frame()), 0); }
  assert.equal(f.alerts.length, 1);
  assert.deepEqual(f.alerts[0], { items: [{ id: 'drop-a', name: 'Stultin', position: { x: 5, y: 2, z: 3 } }],
    settings: Settings.DEFAULTS, trackingSession: 'process-a', instanceId: 'entry-a', zone: '/SF/Levels/MidrathRedux' });
  f.tick();
  assert.equal(f.detector.receive(f.frame([weapon({ id: 'unmapped-dungeon' })], {
    isOverworld: false, zone: '/SF/Levels/Procs/UnderCityGauntlet', instanceId: 'unmapped-entry',
  })), 1, 'A dungeon drop does not require a mapped or revealed dungeon');
});

test('a drop alerts when shiny is confirmed later, and multiple new drops share one alert', () => {
  const f = fixture();
  assert.equal(f.detector.receive(f.frame([weapon({ shiny: null }), weapon({ id: 'ordinary', shiny: false })])), 0);
  f.tick();
  assert.equal(f.detector.receive(f.frame([weapon(), weapon({ id: 'drop-b', name: 'Palladino' }), weapon()])), 2);
  assert.equal(f.alerts.length, 1);
  assert.deepEqual(f.alerts[0].items.map(item => item.name), ['Stultin', 'Palladino']);
});

test('missing telemetry, pickups and repeated IDs never replay a Moonsteel alert in the same area', () => {
  const f = fixture();
  f.detector.receive(f.frame());
  f.tick(); f.detector.receive({ status: 'unavailable', source: 'memory' });
  f.tick(); f.detector.receive(f.frame([], { worldDrops: { status: 'unavailable', sampledAt: 10002, items: [] } }));
  f.tick(); f.detector.receive(f.frame([]));
  f.tick(); f.detector.receive(f.frame());
  assert.equal(f.alerts.length, 1);
  f.tick(2500); f.detector.receive(f.frame([], { sampledAt: 10000 }));
  f.tick(); f.detector.receive(f.frame());
  assert.equal(f.alerts.length, 1, 'A stale gap does not reset deduplication');
});

test('new process sessions or area entries permit new alerts while older area packets cannot roll back scope', () => {
  const f = fixture();
  const old = f.frame(); f.detector.receive(old);
  f.tick(10); f.detector.receive(f.frame(undefined, { instanceId: 'entry-b' }));
  assert.equal(f.alerts.length, 2);
  f.detector.receive(old); assert.equal(f.alerts.length, 2, 'Older poses cannot restore an earlier scope');
  f.tick(); f.detector.receive(f.frame(undefined, { instanceId: 'entry-b', trackingSession: 'process-b' }));
  assert.equal(f.alerts.length, 3);
  f.detector.clear(); f.detector.receive(f.frame()); assert.equal(f.alerts.length, 4);
});

test('disabled or completely silent alerts consume observations and do not replay when enabled', () => {
  for (const disabled of [{ enabled: false }, { flashEnabled: false, soundEnabled: false },
    { flashEnabled: false, volume: 0 }, { soundEnabled: false, opacity: 0 }]) {
    const f = fixture(); f.settings(disabled);
    assert.equal(f.detector.receive(f.frame()), 1); assert.equal(f.alerts.length, 0);
    f.settings(Settings.DEFAULTS); f.tick(); f.detector.receive(f.frame()); assert.equal(f.alerts.length, 0);
    f.tick(); f.detector.receive(f.frame([weapon({ id: 'new-drop' })])); assert.equal(f.alerts.length, 1);
  }
});

test('stale, malformed, non-memory, far-away and unknown observations cannot generate alerts', () => {
  assert.equal(fixture().detector.receive({}), 0);
  const invalid = [null, { status: 'unavailable' }, { source: 'capture' }, { sampledAt: 7999 }, { sampledAt: 10001 },
    { trackingSession: '' }, { trackingSession: '../private' }, { instanceId: null }, { zone: '/SF/Levels/../Private' },
    { isOverworld: null }, { position: { x: 0, y: NaN, z: 0 } },
    { worldDrops: { status: 'available', sampledAt: 7999, items: [weapon()] } },
    { worldDrops: { status: 'available', sampledAt: 10001, items: [weapon()] } },
    { worldDrops: { status: 'available', sampledAt: 10000, items: Array(65).fill(weapon()) } }];
  for (const fields of invalid) {
    const f = fixture(); assert.equal(f.detector.receive(fields === null ? null : f.frame(undefined, fields)), 0);
    assert.equal(f.alerts.length, 0);
  }
  for (const item of [weapon({ id: '' }), weapon({ id: '../private' }), weapon({ shiny: 'true' }), weapon({ kind: 'resource' }),
    weapon({ position: { x: 81, y: 0, z: 0 } }), weapon({ position: { x: 0, y: 81, z: 0 } }), weapon({ position: { x: NaN, y: 0, z: 0 } })]) {
    const f = fixture(); assert.equal(f.detector.receive(f.frame([item])), 0); assert.equal(f.alerts.length, 0);
  }
});

test('out-of-order drop snapshots cannot resurrect an earlier confirmation', () => {
  const f = fixture();
  const previous = f.frame();
  f.tick(10); f.detector.receive(f.frame([]));
  assert.equal(f.detector.receive(f.frame(undefined, { worldDrops: previous.worldDrops })), 0);
  assert.equal(f.alerts.length, 0);
  f.tick(); f.detector.receive(f.frame()); assert.equal(f.alerts.length, 1);
});

test('alert payloads copy positions and never leak invalid labels or arbitrary telemetry', () => {
  const f = fixture(), source = weapon({ name: '/SF/Weapons/PrivateType', pointer: 'private' });
  f.detector.receive(f.frame([source]));
  source.position.x = 999;
  assert.deepEqual(f.alerts[0].items, [{ id: 'drop-a', name: 'Dropped weapon', position: { x: 5, y: 2, z: 3 } }]);
  assert.equal(JSON.stringify(f.alerts[0]).includes('private'), false);
});

test('deduplication stays bounded without evicting and replaying older alerts', () => {
  const f = fixture();
  for (let start = 0; start < MAX_SEEN_DROPS; start += 64) {
    f.tick(); f.detector.receive(f.frame(Array.from({ length: Math.min(64, MAX_SEEN_DROPS - start) }, (_, index) => weapon({ id: 'drop-' + (start + index) }))));
  }
  assert.equal(f.alerts.flatMap(alert => alert.items).length, MAX_SEEN_DROPS);
  f.tick(); assert.equal(f.detector.receive(f.frame([weapon({ id: 'overflow' }), weapon({ id: 'drop-0' })])), 0);
  f.tick(); assert.equal(f.detector.receive(f.frame([weapon({ id: 'overflow' })], { instanceId: 'next-entry' })), 1);
});
