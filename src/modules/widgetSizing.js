/* Shared widget dimensions and resize policy for main and sandboxed renderers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OverkotWidgetSizing = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const GRID_SIZE = 24;
  const MAX_SIZE = 32768;
  const COLLECTION_IDS = ['collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements',
    'crafting-planner', 'activity', 'crafting-log', 'session-analysis'];
  const WIDGET_IDS = Object.freeze(['boss', 'crafting', 'other', 'affiliation', 'factions', 'odeinfamy',
    'wiki', 'groupfinder', 'minimap', 'arena', 'world-watch', 'clock', 'weather', 'build-exporter',
    'temper-tracker', 'wolf-training', 'data-inventory', 'data-ee-log', 'player', ...COLLECTION_IDS, 'title-tracker']);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const known = id => typeof id === 'string' && WIDGET_IDS.includes(id);
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Math.round(value)));

  function widgetDimensions(id) {
    if (!known(id)) throw new Error('Choose a known overlay widget. Daily Brief and Market use their own pop-out sizes.');
    if (COLLECTION_IDS.includes(id)) return { width: 410, height: 560, minWidth: 300, minHeight: 160 };
    if (id === 'player') return { width: 390, height: 500, minWidth: 300, minHeight: 120 };
    if (id === 'data-inventory' || id === 'data-ee-log') return { width: 620, height: 560, minWidth: 360, minHeight: 360 };
    if (id === 'title-tracker') return { width: 350, height: 430, minWidth: 240, minHeight: 24 };
    if (id === 'minimap') return { width: 350, height: 350, minWidth: 150, minHeight: 150 };
    if (id === 'wolf-training') return { width: 350, height: 390, minWidth: 300, minHeight: 24 };
    if (id === 'world-watch') return { width: 350, height: 300, minWidth: 300, minHeight: 24 };
    return { width: 300, height: 200, minWidth: 200, minHeight: 24 };
  }

  function normalizeMode(value, { strict = false } = {}) {
    if (value === 'grid' || value === 'free') return value;
    if (strict) throw new Error('Choose Grid or Free sizing for widgets.');
    return 'grid';
  }

  /** Null means use the widget's automatic/default behaviour for that axis. */
  function normalizeSize(id, value, { strict = false } = {}) {
    const dimensions = widgetDimensions(id);
    if (!record(value)) {
      if (strict) throw new Error('Widget size must contain width and height choices.');
      value = {};
    }
    const result = { width: null, height: null };
    for (const [axis, minimum] of [['width', dimensions.minWidth], ['height', dimensions.minHeight]]) {
      const choice = value[axis];
      if (choice === null || choice === undefined) continue;
      if (Number.isSafeInteger(choice) && choice >= minimum && choice <= MAX_SIZE) result[axis] = choice;
      else if (strict) throw new Error(`Widget ${axis} must be a whole number from ${minimum} to ${MAX_SIZE} pixels, or Automatic.`);
    }
    return result;
  }

  function normalizeSizes(value, { strict = false } = {}) {
    if (value === undefined) return {};
    if (!record(value)) {
      if (strict) throw new Error('Widget sizes must be keyed by widget name.');
      return {};
    }
    const result = {};
    for (const [id, size] of Object.entries(value)) {
      if (!known(id)) {
        if (strict) throw new Error('Choose a known overlay widget for size settings.');
        continue;
      }
      const normalized = normalizeSize(id, size, { strict });
      if (normalized.width !== null || normalized.height !== null) result[id] = normalized;
    }
    return result;
  }

  /** Old card widgets resized width only; map and data windows used both axes. */
  function sizesFromLegacyBounds(bounds) {
    const result = {};
    if (!record(bounds)) return result;
    for (const id of WIDGET_IDS) {
      const value = bounds[id];
      if (!record(value)) continue;
      const size = normalizeSize(id, { width: value.width,
        height: id === 'minimap' || id.startsWith('data-') ? value.height : null });
      if (size.width !== null || size.height !== null) result[id] = size;
    }
    return result;
  }

  /** Grid snaps dimensions to 24 px; Free preserves one-pixel changes. */
  function resizeSize({ id, startWidth, startHeight, dx = 0, dy = 0, mode = 'grid', workArea, aspectRatio } = {}) {
    const dimensions = widgetDimensions(id);
    if (![startWidth, startHeight, dx, dy].every(Number.isFinite) || startWidth <= 0 || startHeight <= 0) {
      throw new Error('Widget resizing needs valid starting dimensions and pointer movement.');
    }
    const maxWidth = Number.isFinite(workArea?.width) && workArea.width > 0 ? Math.min(MAX_SIZE, Math.floor(workArea.width)) : MAX_SIZE;
    const maxHeight = Number.isFinite(workArea?.height) && workArea.height > 0 ? Math.min(MAX_SIZE, Math.floor(workArea.height)) : MAX_SIZE;
    const minWidth = Math.min(dimensions.minWidth, maxWidth), minHeight = Math.min(dimensions.minHeight, maxHeight);
    const step = normalizeMode(mode) === 'grid' ? GRID_SIZE : 1;
    const snap = value => Math.round(value / step) * step;
    if (Number.isFinite(aspectRatio) && aspectRatio > 0) {
      const widthDriven = Math.abs(dx) >= Math.abs(dy * aspectRatio);
      let width = snap(widthDriven ? startWidth + dx : (startHeight + dy) * aspectRatio);
      const low = Math.max(minWidth, minHeight * aspectRatio);
      const high = Math.min(maxWidth, maxHeight * aspectRatio);
      // Extremely narrow monitors cannot satisfy both original minimums and
      // the ratio. Screen containment takes priority over the old minimum.
      width = clamp(width, Math.min(low, high), high);
      return { width, height: clamp(width / aspectRatio, 1, maxHeight) };
    }
    // A horizontal drag must not change an untouched height merely because
    // that old value was not an exact multiple of the alignment grid.
    return { width: clamp(dx === 0 ? startWidth : snap(startWidth + dx), minWidth, maxWidth),
      height: clamp(dy === 0 ? startHeight : snap(startHeight + dy), minHeight, maxHeight) };
  }

  return Object.freeze({ GRID_SIZE, MAX_SIZE, WIDGET_IDS, known, widgetDimensions, normalizeMode,
    normalizeSize, normalizeSizes, sizesFromLegacyBounds, resizeSize });
});
