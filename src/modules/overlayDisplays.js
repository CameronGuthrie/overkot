'use strict';

function normalizeDisplayId(value) {
  return Number.isSafeInteger(value) && value !== -1 ? value : null;
}

/** Describe connected displays without exposing native handles or mutable objects. */
function displayOptions(displays, primaryId) {
  const seen = new Set(), result = [];
  for (const display of Array.isArray(displays) ? displays : []) {
    const id = normalizeDisplayId(display?.id), source = display?.bounds;
    if (id === null || seen.has(id) || !source
      || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(source[key]))
      || source.width <= 0 || source.height <= 0) continue;
    const bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(source[key])]));
    if (bounds.width < 1 || bounds.height < 1) continue;
    const name = typeof display.label === 'string'
      ? display.label.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80) : '';
    const primary = id === primaryId;
    const ordinal = result.length + 1;
    const label = `Display ${ordinal}${name ? ': ' + name : ''} · ${bounds.width} × ${bounds.height}${primary ? ' · Primary' : ''}`;
    result.push({ id, label, bounds, primary });
    seen.add(id);
  }
  return result;
}

module.exports = { normalizeDisplayId, displayOptions };
