const test = require('node:test');
const assert = require('node:assert/strict');
const { weatherAt, chooseWeather, forecast } = require('../src/modules/weatherCycle');
const signature = weather => `${weather.kind}:${weather.rainbowChance}`;

// Independent native chooser output: Soulframe 2026-09-24 under emulation.
// Source: soulkit/src/weather.rs, oreo 996962b25e2620e61cf2dfb1f32682bb4550c0fd.
const GOLDEN = [
  [1793464097, 4, 1], [1770246633, 2, 1], [1802992312, 3, 0], [1837366946, 3, 2],
  [1756480894, 2, 1], [1759722233, 1, 0], [1821924865, 4, 1], [1762633920, 1, 0],
  [1799081935, 2, 0], [1828220482, 4, 1], [1757784483, 1, 0], [1818106871, 3, 1],
  [1778816302, 1, 0], [1755032582, 3, 0], [1761535642, 1, 0], [1808202938, 4, 1],
  [1806126116, 4, 0], [1759375836, 2, 1], [1782301241, 3, 1], [1762175294, 2, 1],
  [1823960310, 3, 2], [1806978001, 2, 0], [1757933677, 2, 0], [1825893910, 3, 0],
];

test('weather chooser matches independent native samples across years', () => {
  for (const [time, tier, keyIndex] of GOLDEN) assert.deepEqual(chooseWeather(time), { tier, keyIndex }, `t=${time}`);
});

test('forecast boundaries use exact seconds and advance at the next change', () => {
  const time = Date.parse('2026-09-27T20:00:00Z');
  const result = forecast(time);
  assert.equal(result.upcoming.length, 4);
  const periods = [result.current, ...result.upcoming];
  assert.ok(result.current.start <= time && result.current.end > time);
  for (let index = 0; index < periods.length; index++) {
    const period = periods[index];
    assert.ok(period.end > period.start);
    assert.equal(weatherAt(period.start / 1000).typeId, period.typeId);
    assert.notEqual(signature(weatherAt(period.start / 1000 - 1)), signature(period));
    assert.equal(signature(weatherAt(period.end / 1000 - 1)), signature(period));
    assert.notEqual(signature(weatherAt(period.end / 1000)), signature(period));
    if (index) {
      assert.equal(periods[index - 1].end, period.start);
      assert.notEqual(signature(periods[index - 1]), signature(period));
    }
  }
  assert.deepEqual(forecast(result.current.end).current, result.upcoming[0]);
});

test('equivalent presets share one displayed period without hiding rainbow chance changes', () => {
  // Native bucket change switches light.1 to light.0, both displayed as Breeze.
  const boundary = 1789876440;
  assert.equal(weatherAt(boundary - 1).typeId, 'light.1');
  assert.equal(weatherAt(boundary).typeId, 'light.0');
  const before = forecast((boundary - 1) * 1000).current;
  const after = forecast(boundary * 1000).current;
  assert.deepEqual(before, after);
  assert.ok(before.start < boundary * 1000 && before.end > boundary * 1000);
  assert.equal(before.typeId, weatherAt(before.start / 1000).typeId);

  const chanceBoundary = 1789881169;
  assert.equal(weatherAt(chanceBoundary - 1).typeId, 'moderate.2');
  assert.equal(weatherAt(chanceBoundary).typeId, 'heavy.0');
  assert.equal(forecast((chanceBoundary - 1) * 1000).current.end, chanceBoundary * 1000);
  assert.equal(forecast(chanceBoundary * 1000).current.start, chanceBoundary * 1000);

  for (const time of [Date.parse('2026-09-20T00:00:00Z'), Date.parse('2026-09-27T12:00:00Z')]) {
    const result = forecast(time, 12);
    for (const period of [result.current, ...result.upcoming]) {
      for (let second = period.start / 1000; second < period.end / 1000; second++) {
        assert.equal(signature(weatherAt(second)), signature(period));
      }
    }
  }
});

test('weather remains calculable beyond the sample calendar and never promises rainbows', () => {
  const result = forecast(Date.parse('2030-06-01T00:00:00Z'));
  assert.equal(result.upcoming.length, 4);
  for (const [time] of GOLDEN) {
    const weather = weatherAt(time);
    assert.notEqual(weather.kind, 'rainbow');
    assert.notEqual(weather.kind, 'fog');
    assert.equal(weather.rainbowChance, weather.typeId === 'moderate.2' ? .2 : 0);
  }
});

test('weather rejects invalid inputs without scanning unbounded time', () => {
  for (const time of [NaN, Infinity, -1, 4102444801]) assert.throws(() => weatherAt(time), /Invalid weather time/);
  for (const count of [0, 13, 1.5]) assert.throws(() => forecast(Date.now(), count), /Invalid forecast count/);
});
