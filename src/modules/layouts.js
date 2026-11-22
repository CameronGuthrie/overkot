'use strict';

// Layout files contain arrangements only. Account data, local paths, shortcuts
// and appearance presets never enter this format.
const VERSION = 1;
const WidgetSizing = require('./widgetSizing');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LAYOUTS = 50;
const WIDGET_IDS = Object.freeze(['boss', 'crafting', 'other', 'affiliation', 'factions', 'odeinfamy',
  'wiki', 'groupfinder', 'minimap', 'arena', 'world-watch', 'clock', 'weather', 'build-exporter',
  'temper-tracker', 'wolf-training', 'data-inventory', 'data-ee-log', 'player', 'daily',
  'collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements', 'crafting-planner',
  'activity', 'crafting-log', 'session-analysis', 'market', 'title-tracker']);
const EDGES = ['top', 'bottom', 'left', 'right'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);

function layoutName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new Error('Give the layout a name between 1 and 80 characters, without line breaks.');
  }
  return value.trim();
}

function rectangle(value, strict, label) {
  const valid = record(value) && ['x', 'y', 'width', 'height'].every(key =>
    has(value, key) && typeof value[key] === 'number' && Number.isFinite(value[key]))
    && Math.abs(value.x) <= 1_000_000 && Math.abs(value.y) <= 1_000_000
    && value.width >= 1 && value.width <= 32_768 && value.height >= 1 && value.height <= 32_768;
  if (!valid) {
    if (strict) throw new Error(`${label} must have valid screen coordinates and dimensions between 1 and 32768 pixels.`);
    return null;
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

/** Fill missing arrangement fields without copying unrelated configuration. */
function normalizeLayout(value, { strict = false } = {}) {
  if (!record(value)) {
    if (strict) throw new Error('The layout must contain widget arrangement values.');
    value = {};
  }
  const result = { dockEdge: 'bottom', dockAutoHide: false, dockWidgetOrder: [],
    widgetVisibility: {}, widgetOpen: {}, widgetDocked: {}, widgetBounds: {},
    widgetSizes: {}, widgetResizeMode: 'grid' };
  if (has(value, 'widgetResizeMode')) result.widgetResizeMode = WidgetSizing.normalizeMode(value.widgetResizeMode, { strict });
  if (has(value, 'dockEdge')) {
    if (!EDGES.includes(value.dockEdge) && strict) throw new Error('Choose a supported screen edge for the layout.');
    if (EDGES.includes(value.dockEdge)) result.dockEdge = value.dockEdge;
  }
  if (has(value, 'dockAutoHide')) {
    if (typeof value.dockAutoHide !== 'boolean' && strict) throw new Error('Layout auto-hide must be true or false.');
    result.dockAutoHide = value.dockAutoHide === true;
  }
  if (has(value, 'dockWidgetOrder') && !Array.isArray(value.dockWidgetOrder) && strict) {
    throw new Error('The layout widget order must be a list of widget names.');
  }
  const order = Array.isArray(value.dockWidgetOrder) ? value.dockWidgetOrder : [];
  for (const id of order) {
    if (!WIDGET_IDS.includes(id) || result.dockWidgetOrder.includes(id)) continue;
    result.dockWidgetOrder.push(id);
  }
  for (const id of WIDGET_IDS) if (!result.dockWidgetOrder.includes(id)) result.dockWidgetOrder.push(id);
  for (const [key, fallback] of [['widgetVisibility', false], ['widgetOpen', false], ['widgetDocked', true]]) {
    if (has(value, key) && !record(value[key]) && strict) throw new Error(`${key} must contain widget choices.`);
    const map = record(value[key]) ? value[key] : {};
    for (const id of WIDGET_IDS) {
      if (has(map, id) && typeof map[id] !== 'boolean' && strict) throw new Error(`The ${key} choice for ${id} must be true or false.`);
      result[key][id] = has(map, id) && typeof map[id] === 'boolean' ? map[id] : fallback;
    }
  }
  if (has(value, 'widgetBounds') && !record(value.widgetBounds) && strict) throw new Error('Widget positions must be keyed by widget name.');
  if (record(value.widgetBounds)) for (const id of WIDGET_IDS) {
    if (!has(value.widgetBounds, id)) continue;
    const bounds = rectangle(value.widgetBounds[id], strict, `The position of ${id}`);
    if (bounds) result.widgetBounds[id] = bounds;
  }
  result.widgetSizes = has(value, 'widgetSizes') ? WidgetSizing.normalizeSizes(value.widgetSizes, { strict })
    : WidgetSizing.sizesFromLegacyBounds(result.widgetBounds);
  if (has(value, 'display')) {
    const display = rectangle(value.display, strict, 'The source display');
    if (display) result.display = display;
  }
  return result;
}

/** Prefer current native panel bounds over the last persisted geometry. */
function captureLayout(config = {}, { display, widgetBounds } = {}) {
  const source = record(config) ? config : {};
  const bounds = {};
  for (const id of WIDGET_IDS) {
    const key = `widgetBounds_${id}`;
    if (has(source, key)) bounds[id] = source[key];
    if (record(widgetBounds) && has(widgetBounds, id)) bounds[id] = widgetBounds[id];
  }
  return normalizeLayout({ dockEdge: source.dockEdge ?? 'bottom', dockAutoHide: source.dockAutoHide ?? false,
    dockWidgetOrder: source.dockWidgetOrder ?? [], widgetVisibility: source.widgetVisibility ?? {},
    widgetOpen: source.widgetOpen ?? {}, widgetDocked: source.widgetDocked ?? {}, widgetBounds: bounds,
    ...(has(source, 'widgetSizes') ? { widgetSizes: source.widgetSizes } : {}),
    widgetResizeMode: source.widgetResizeMode ?? 'grid',
    ...(display === undefined ? {} : { display }) });
}

function normalizeSavedLayouts(value, { strict = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || (strict && value.length > MAX_LAYOUTS)) {
    if (strict) throw new Error(`Keep at most ${MAX_LAYOUTS} saved layouts.`);
    return [];
  }
  const result = [], seen = new Set();
  for (const entry of value.slice(0, MAX_LAYOUTS)) {
    try {
      if (!record(entry) || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(entry.id)
        || seen.has(entry.id)) throw new Error('Saved layout identifiers must be unique letters, numbers, dashes or underscores.');
      if (!record(entry.layout)) throw new Error('Each saved layout must contain widget arrangement values.');
      result.push({ id: entry.id, name: layoutName(entry.name), layout: normalizeLayout(entry.layout, { strict }) });
      seen.add(entry.id);
    } catch (error) { if (strict) throw error; }
  }
  return result;
}

function exportLayout(name, layout) {
  return JSON.stringify({ format: 'overkot-layout', version: VERSION, name: layoutName(name),
    layout: normalizeLayout(layout, { strict: true }) }, null, 2) + '\n';
}

function validateImport(text) {
  try {
    if (typeof text !== 'string') throw new Error('Choose an exported Overkot layout file.');
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('This layout is too large. Layout files must be 256 KB or smaller.');
    let value;
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('This file is not valid JSON. Choose an exported Overkot layout.'); }
    if (!record(value) || value.format !== 'overkot-layout') throw new Error('This is not an Overkot layout file.');
    if (value.version !== VERSION) throw new Error(`Layout version ${String(value.version ?? '(missing)')} is not supported. This app supports version ${VERSION}.`);
    if (!record(value.layout)) throw new Error('This file is missing its widget arrangement values.');
    return { ok: true, name: layoutName(value.name), layout: normalizeLayout(value.layout, { strict: true }) };
  } catch (error) { return { ok: false, message: error.message }; }
}

module.exports = { VERSION, MAX_FILE_BYTES, MAX_LAYOUTS, WIDGET_IDS, layoutName, normalizeLayout,
  captureLayout, normalizeSavedLayouts, exportLayout, validateImport };
