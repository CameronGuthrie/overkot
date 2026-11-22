/** Shared Moonsteel alert preferences for the main process and Settings. */
(function (root, factory) {
  const settings = factory();
  if (typeof module === 'object' && module.exports) module.exports = settings;
  else root.MoonsteelAlertSettings = settings;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true, flashEnabled: true, soundEnabled: true,
    color: '#da75ff', opacity: .65, borderWidth: 48, blur: 32,
    duration: 4, pulseSpeed: 1, sound: 'chime', volume: .5, monitor: 'primary',
  });
  const RANGES = Object.freeze({
    opacity: Object.freeze([0, 1]), borderWidth: Object.freeze([4, 160]),
    blur: Object.freeze([0, 120]), duration: Object.freeze([1, 12]),
    pulseSpeed: Object.freeze([.25, 2]), volume: Object.freeze([0, 1]),
  });
  const SOUNDS = Object.freeze(['chime', 'soft', 'beacon']);
  const MONITORS = Object.freeze(['primary', 'cursor', 'all']);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function validField(key, value) {
    if (!Object.hasOwn(DEFAULTS, key)) return false;
    if (typeof DEFAULTS[key] === 'boolean') return typeof value === 'boolean';
    if (key === 'color') return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    if (key === 'sound') return SOUNDS.includes(value);
    if (key === 'monitor') return MONITORS.includes(value);
    const range = RANGES[key];
    return !!range && typeof value === 'number' && Number.isFinite(value) && value >= range[0] && value <= range[1];
  }
  /** Invalid saved fields fall back independently without losing valid preferences. */
  function normalize(value) {
    const result = { ...DEFAULTS };
    if (!record(value)) return result;
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(value, key) && validField(key, value[key])) result[key] = key === 'color' ? value[key].toLowerCase() : value[key];
    }
    return result;
  }
  /** Validate a complete preference object or a patch before accepting IPC writes. */
  function validate(value) {
    return record(value) && Object.entries(value).every(([key, entry]) => validField(key, entry));
  }
  function merge(current, patch) {
    return validate(patch) ? normalize({ ...normalize(current), ...patch }) : null;
  }
  return { DEFAULTS, RANGES, SOUNDS, MONITORS, normalize, validate, merge };
});
