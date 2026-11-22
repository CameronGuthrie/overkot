'use strict';

// One Midrath model for every clock window. Recovered from the game's
// SyncSkiesWithWorldState and native sky clock; see docs/world-clock.md.
(function(root) {
  const EPOCH = 1391990400;
  const RATE = Math.fround(0.00833); // Stored as a float32 in DynamicSky.TimeRate.
  const CYCLE = 24 / RATE;
  const SHIFT = Math.fround(CYCLE / 2); // Lua's second native argument is also float32.
  const DAWN = 6, DUSK = 22;
  const DAY = (DUSK - DAWN) / RATE;
  const NIGHT = CYCLE - DAY;
  function at(unixSeconds) {
    const elapsed = unixSeconds - EPOCH + SHIFT;
    const hour = ((elapsed % CYCLE + CYCLE) % CYCLE) / CYCLE * 24;
    const isDay = hour >= DAWN && hour < DUSK;
    const phaseHours = isDay ? hour - DAWN : (hour - DUSK + 24) % 24;
    const duration = isDay ? DAY : NIGHT;
    const progress = phaseHours / RATE / duration;
    return { hour, isDay, progress, remaining: duration - phaseHours / RATE,
      sunAngle: isDay ? -90 + progress * 180 : 90 + progress * 180,
      moonAngle: isDay ? 270 - progress * 180 : 90 - progress * 180 };
  }
  function point(angle) {
    const radians = angle * Math.PI / 180;
    return { x: 155 + 116 * Math.sin(radians), y: 143 - 116 * Math.cos(radians) };
  }
  const api = Object.freeze({ EPOCH, RATE, CYCLE, SHIFT, DAWN, DUSK, DAY, NIGHT, at, point });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorldCycle = api;
})(globalThis);
