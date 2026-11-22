const test = require('node:test');
const assert = require('node:assert/strict');
const { WeatherForecast } = require('../src/modules/weatherForecast');

test('weather uses the shared server clock and predicts again at transitions and clock corrections', async () => {
  let time = 100000, syncedAt = null, calls = 0, refreshes = 0;
  const clock = { snapshot: () => ({ time, syncedAt }), refresh: async () => { refreshes++; syncedAt = time; } };
  const weather = new WeatherForecast({ clock, predict: time => {
    calls++;
    const start = Math.floor(time / 10000) * 10000;
    return { current: { start, end: start + 10000, kind: 'rain' }, upcoming: [{ start: start + 10000, end: start + 20000, kind: 'clear' }] };
  } });
  assert.equal(weather.snapshot().status, 'estimated');
  await weather.refresh();
  assert.equal(refreshes, 1);
  assert.equal(weather.snapshot().status, 'ready');
  time += 2000;
  assert.equal(weather.snapshot().time, 102000);
  assert.equal(calls, 1, 'No repeated forecast scans for renderer countdowns');
  time = 110000;
  assert.equal(weather.snapshot().current.start, 110000);
  assert.equal(calls, 2);
  time = 99000;
  assert.equal(weather.snapshot().current.start, 90000);
  assert.equal(calls, 3, 'A backwards server correction invalidates the period');
});

test('failed prediction does not present an expired period as current', () => {
  let time = 100000;
  const clock = { snapshot: () => ({ time, syncedAt: time }) };
  const weather = new WeatherForecast({ clock, predict: () => {
    if (time >= 110000) throw new Error('Unknown rule');
    return { current: { start: 100000, end: 110000, kind: 'rain' }, upcoming: [] };
  } });
  assert.equal(weather.snapshot().current.kind, 'rain');
  time = 110000;
  assert.equal(weather.snapshot().status, 'unavailable');
  assert.equal(weather.snapshot().current, null);
  time = 100000;
  assert.equal(weather.snapshot().current.kind, 'rain');
});
