'use strict';

// Native DynamicSky chooser, build 2026-09-24. This is an algorithm, not a
// dated calendar. Input is the shared public server clock (Unix seconds).
// Provenance and known limits: docs/weather-cycle.md.
const f = Math.fround;
const CYCLE_SECONDS = 2678400;
const ANGLE_PER_SECOND = 2.345872650530013e-6;
const NOISE_RADIUS = f(118.41128);
const KEY_BUCKETS_PER_SECOND = 8.417508417508418e-5;
const TIER_NAMES = ['clear', 'light', 'moderate', 'heavy'];
const KEY_COUNTS = [1, 2, 3, 2];
const PERM = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
  140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
  247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
  57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
  74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
  60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
  65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
  200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64,
  52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212,
  207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
  119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
  129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104,
  218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
  81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
  184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
  222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
];

const perm = i => PERM[i & 255];
function gradient(hash, u, v) {
  const h = hash & 63;
  if (h >= 4) [u, v] = [v, u];
  if (h & 1) u = -u;
  v = h & 2 ? f(v * -2) : f(v + v);
  return f(v + u);
}
function corner(x, y, hash) {
  let t = f(f(0.5 - f(x * x)) - f(y * y));
  if (t < 0) return 0;
  t = f(t * t);
  return f(gradient(hash, x, y) * f(t * t));
}
function simplex(x, y) {
  const F2 = f(0.36602539), G2 = f(0.21132487), G2X2_MINUS_1 = f(0.57735026);
  // This intentionally follows the client's nonpositive truncation rule.
  const floor = v => Math.trunc(v) - Number(v <= 0);
  const s = f(f(x + y) * F2);
  const i = floor(f(s + x)), j = floor(f(s + y));
  const t = f(f(i + j) * G2);
  const x0 = f(x - f(i - t)), y0 = f(y - f(j - t));
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const ii = i & 255, jj = j & 255;
  const n0 = corner(x0, y0, perm(ii + perm(jj)));
  const n1 = corner(f(f(x0 - i1) + G2), f(f(y0 - j1) + G2), perm(ii + i1 + perm(jj + j1)));
  const n2 = corner(f(x0 - G2X2_MINUS_1), f(y0 - G2X2_MINUS_1), perm(ii + 1 + perm(jj + 1)));
  return f(f(f(n1 + n0) + n2) * f(45.230652));
}

function chooseWeather(unixSeconds, keyCounts = KEY_COUNTS) {
  if (!Number.isFinite(unixSeconds) || unixSeconds < 0 || unixSeconds > 4102444800) throw new RangeError('Invalid weather time');
  const angle = (unixSeconds % CYCLE_SECONDS) * ANGLE_PER_SECOND;
  const noise = simplex(f(f(Math.cos(angle)) * NOISE_RADIUS), f(f(Math.sin(angle)) * NOISE_RADIUS));
  const v = f(Math.pow(f(f(noise + 1) * 0.5), 1.25));
  const tier = v < .25 ? 1 : v < .5 ? 2 : v < .75 ? 3 : 4;
  let h = (Math.trunc(unixSeconds * KEY_BUCKETS_PER_SECOND) >>> 0) ^ Math.imul(tier, 0x9e3779b1);
  h = Math.imul((h >>> 16) ^ h, 0x045d9f3b);
  h = ((h >>> 16) ^ h) >>> 0;
  const count = keyCounts[tier - 1];
  return { tier, keyIndex: count ? h % count : 0 };
}

// These eight interpretations follow DynamicSkyMidrath's native key arrays.
// Internal Windy is wind, not a promise of a rainbow. Fog is not inferred.
// A rainbow is only a chance after the shower preset and is never forecast
// as an independently predictable state.
function profile(tier, keyIndex, kind, overcastAmount, windAmount, rain, lightning, rainbowChance = 0) {
  const key = Object.freeze({ overcastAmount, windAmount, rain, lightning, rainbowChance });
  return Object.freeze({ typeId: `${TIER_NAMES[tier - 1]}.${keyIndex}`, tier: TIER_NAMES[tier - 1], keyIndex, kind, rainbowChance, key });
}
const PROFILES = Object.freeze([
  Object.freeze([profile(1, 0, 'clear', 0, 0, 0, 0)]),
  Object.freeze([profile(2, 0, 'breeze', 0, .60000002, 0, 0), profile(2, 1, 'breeze', .1, .30000001, 0, 0)]),
  Object.freeze([profile(3, 0, 'wind', .1, 1, 0, 0), profile(3, 1, 'overcast', .5, .60000002, 0, 0), profile(3, 2, 'rain', .5, .60000002, 1, 0, .2)]),
  Object.freeze([profile(4, 0, 'rain', 1, 1, 1, 0), profile(4, 1, 'thunder', 1, 1, 1, 1)]),
]);
function weatherAt(unixSeconds) {
  const { tier, keyIndex } = chooseWeather(unixSeconds);
  return PROFILES[tier - 1][keyIndex];
}
const sameDisplay = (a, b) => a.kind === b.kind && a.rainbowChance === b.rainbowChance;

function forecast(timeMs, count = 4) {
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new RangeError('Invalid forecast count');
  const second = Math.floor(timeMs / 1000);
  const currentType = weatherAt(second);
  const lower = Math.max(0, second - 86400), upper = Math.min(4102444800, second + 86400);
  let start = second;
  while (start > lower && sameDisplay(weatherAt(start - 1), currentType)) start--;
  if (start === lower) throw new Error('Weather start outside forecast horizon');
  const periods = [];
  // The card describes conditions rather than internal preset changes. Keep
  // equivalent conditions together, retaining the first preset as provenance.
  let type = weatherAt(start);
  // Sample every second: minute-sized steps can miss brief real changes at
  // a threshold, and countdowns must land on the first changed second.
  for (let at = second + 1; at <= upper; at++) {
    const next = weatherAt(at);
    if (sameDisplay(next, type)) continue;
    periods.push({ ...type, start: start * 1000, end: at * 1000 });
    if (periods.length === count + 1) return { current: periods[0], upcoming: periods.slice(1) };
    start = at; type = next;
  }
  throw new Error('Weather changes outside forecast horizon');
}

module.exports = { weatherAt, forecast, chooseWeather, CYCLE_SECONDS };
