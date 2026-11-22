const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cycle = require('../src/renderer/world-cycle');
const { WorldClock, serverTime, URL, DAY_MS, RETRY_MS } = require('../src/modules/worldClock');

const epoch = Date.parse('2026-09-12T09:15:47Z');
const response = () => ({ status: 200, data: { Time: epoch / 1000 - 15, WorldSeed: 'unused' }, headers: { date: new Date(epoch).toUTCString(), age: '15' } });
function fixture(t, http) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-clock-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  let now = epoch, mono = 0;
  const options = { cacheDir,
    now: () => now, monotonic: () => mono, http: http || { get: async () => response() } };
  return { options, clock: new WorldClock(options), advance: ms => { now += ms; mono += ms; }, jump: ms => { now += ms; } };
}

const dawn = cycle.EPOCH - cycle.SHIFT + cycle.DAWN / cycle.RATE;
test('native cycle changes at 06:00 and 22:00 and wraps without losing long-term phase', () => {
  for (const cycles of [-10000, 0, 137800, 200000]) {
    const start = dawn + cycle.CYCLE * cycles;
    assert.equal(cycle.at(start + .001).isDay, true);
    assert.equal(cycle.at(start + cycle.DAY + .001).isDay, false);
    assert.equal(cycle.at(start - 1).isDay, false);
    assert.ok(Math.abs(cycle.at(start - 1).remaining - 1) < .001);
    assert.ok(Math.abs(cycle.at(start + .001).remaining - cycle.DAY + .001) < .001);
  }
});
test('sky moves the sun left to right and moon right to left', () => {
  for (const [progress, x] of [[0, 39], [.5, 155], [.999, 271]]) {
    const day = cycle.at(dawn + .001 + cycle.DAY * progress);
    assert.ok(Math.abs(cycle.point(day.sunAngle).x - x) < 1);
    const night = cycle.at(dawn + cycle.DAY + .001 + cycle.NIGHT * progress);
    assert.ok(Math.abs(cycle.point(night.moonAngle).x - (310 - x)) < 1);
  }
});
test('cycle reproduces the recovered native formula, including float32 rate and offset', () => {
  // Independent native/disassembly calculation at the running game's server time.
  // Rounding the rate to .00833 or reusing the May empirical period breaks this.
  assert.equal(cycle.RATE, 0.008329999633133411);
  assert.equal(cycle.CYCLE, 2881.1525878749844);
  assert.equal(cycle.SHIFT, 1440.5762939453125);
  const state = cycle.at(1789210848.7812953);
  assert.ok(Math.abs(state.hour - 2.1926212790724944) < 1e-8);
  assert.equal(state.isDay, false);
  assert.ok(Math.abs(cycle.at(1789210858.7812953).remaining - state.remaining + 10) < 1e-6);
  assert.ok(Math.abs(cycle.at(1779464368).hour - 6.0112887473793375) < 1e-8);
});
test('world-state Time is aged once, never adding Age to the current HTTP Date', () => {
  assert.equal(serverTime(response()), epoch + 500);
  const fresh = response(); fresh.headers.age = '0'; fresh.data.Time = epoch / 1000;
  assert.equal(serverTime(fresh), epoch + 500);
});
test('invalid, stale and inconsistent server clocks are rejected', () => {
  for (const mutate of [r => r.data.Time = 'bad', r => r.headers.date = 'bad', r => r.headers.age = '600',
    r => r.headers.age = '-1', r => r.data.Time -= 45, r => r.status = 503, r => delete r.headers.date]) {
    const bad = response(); mutate(bad); assert.throws(() => serverTime(bad));
  }
});
test('daily synchronization is compressed, public, deduplicated and persisted across restart', async t => {
  let calls = 0, release;
  const f = fixture(t, { get: async (url, options) => {
    calls++; assert.equal(url, URL); assert.match(options.headers['Accept-Encoding'], /br/);
    assert.equal(options.headers.Authorization, undefined); assert.equal(options.maxRedirects, 0);
    await new Promise(resolve => { release = resolve; }); return response();
  } });
  const one = f.clock.refresh(), two = f.clock.refresh(); assert.equal(one, two); assert.equal(calls, 1);
  f.advance(200); release(); await one;
  assert.equal(f.clock.snapshot().time, epoch + 600);
  assert.equal(f.clock.snapshot().syncedAt, epoch + 200);
  assert.equal(await f.clock.refresh(), false);
  const restart = new WorldClock(f.options); assert.equal(await restart.refresh(), false); assert.equal(calls, 1);
  assert.equal(restart.snapshot().time, f.clock.snapshot().time);
  const saved = fs.readFileSync(f.clock.filename, 'utf8'); assert.ok(saved.length < 250); assert.ok(!saved.includes('WorldSeed'));
  f.advance(DAY_MS); const next = f.clock.refresh(); release(); await next; assert.equal(calls, 2);
});
test('offline startup and retries retain a live clock and do not request every renderer tick', async t => {
  let calls = 0;
  const f = fixture(t, { get: async () => { calls++; throw new Error('Offline'); } });
  assert.equal(await f.clock.refresh(), false); assert.equal(f.clock.snapshot().syncedAt, null);
  f.advance(12345); assert.equal(f.clock.snapshot().time, epoch + 12345);
  assert.equal(await f.clock.refresh(), false); assert.equal(calls, 1);
  const restart = new WorldClock(f.options); await restart.refresh(); assert.equal(calls, 1);
  f.advance(RETRY_MS); await f.clock.refresh(); assert.equal(calls, 2);
});
test('failed sync keeps the last server offset; wall-clock changes do not jump a running countdown', async t => {
  const f = fixture(t); await f.clock.refresh();
  const before = f.clock.snapshot().time;
  f.jump(60000); assert.equal(f.clock.snapshot().time, before);
  f.advance(2000); assert.equal(f.clock.snapshot().time, before + 2000);
  f.advance(DAY_MS); f.options.http.get = async () => { throw new Error('Offline'); };
  await f.clock.refresh(); assert.equal(f.clock.snapshot().syncedAt, epoch);
  assert.equal(f.clock.snapshot().time, before + 2000 + DAY_MS);
});
test('one shared clock ignores legacy per-user alignment and broadcasts server corrections', async t => {
  const f = fixture(t); let changes = 0; f.clock.on('changed', () => changes++);
  const legacy = new WorldClock({ ...f.options, config: { get: () => ({ anchor: 123, updatedAt: epoch }) } });
  assert.deepEqual(legacy.snapshot(), f.clock.snapshot());
  assert.deepEqual(Object.keys(f.clock.snapshot()).sort(), ['nextCheck', 'syncedAt', 'time']);
  assert.equal(f.clock.calibrate, undefined);
  await f.clock.refresh(); assert.equal(changes, 1);
  assert.equal(new WorldClock(f.options).snapshot().time, f.clock.snapshot().time);
});
