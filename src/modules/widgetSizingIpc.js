'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const Sizing = require('./widgetSizing');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = message => ({ ok: false, message });

/** Settings edits size intent; content fitting and gesture IPC stay in main. */
function registerWidgetSizingIpc({ ipcMain, rendererRoot, config, widgetIds = Sizing.WIDGET_IDS,
  getCurrentSize = () => null, constrainSize = (_id, size) => size, onApply = () => {}, onChanged = () => {} }) {
  const supported = [...new Set(widgetIds.filter(Sizing.known))];
  const allowed = event => {
    try {
      return !event.sender.isDestroyed?.() && event.senderFrame === event.sender.mainFrame
        && path.relative(rendererRoot, fileURLToPath(event.senderFrame.url)) === 'settings.html';
    } catch { return false; }
  };
  const savedSizes = () => Sizing.normalizeSizes(config.get('widgetSizes', {}));
  const sizes = () => Object.fromEntries(Object.entries(savedSizes())
    .filter(([id]) => supported.includes(id)));
  const state = () => ({ ok: true, sizes: sizes(), mode: Sizing.normalizeMode(config.get('widgetResizeMode', 'grid')),
    widgets: supported.map(id => {
      const current = getCurrentSize(id), dimensions = Sizing.widgetDimensions(id);
      return { id, ...dimensions,
        ...(Number.isFinite(current?.width) && current.width > 0 ? { currentWidth: Math.round(current.width) } : {}),
        ...(Number.isFinite(current?.height) && current.height > 0 ? { currentHeight: Math.round(current.height) } : {}) };
    }) });
  const save = patch => config.setMany ? config.setMany(patch) : Object.entries(patch).every(([key, value]) => config.set(key, value) !== false);
  const handle = (name, callback) => ipcMain.handle('widget-sizing:' + name, (event, value) => {
    if (!allowed(event)) return failure('Open Settings to change widget sizes.');
    try { return callback(value); }
    catch (error) { return failure(error.message || 'The widget size could not be changed.'); }
  });
  const idFrom = value => {
    if (!record(value) || !supported.includes(value.id)) throw new Error('Choose a known overlay widget to resize.');
    return value.id;
  };
  const changed = () => { onChanged(); return state(); };
  handle('get', state);
  handle('set', value => {
    const id = idFrom(value), requested = Sizing.normalizeSize(id, value, { strict: true });
    // Main supplies monitor limits. Apply them before the transaction so the
    // persisted fields, Settings reply and native viewport agree immediately.
    const size = Sizing.normalizeSize(id, constrainSize(id, requested), { strict: true }), next = savedSizes();
    if (size.width === null && size.height === null) delete next[id];
    else next[id] = size;
    if (save({ widgetSizes: next }) === false) return failure('The widget size could not be saved. Try again.');
    onApply(id, next[id] || null);
    return changed();
  });
  handle('reset', value => {
    const id = idFrom(value), next = savedSizes(); delete next[id];
    if (save({ widgetSizes: next }) === false) return failure('The widget size could not be reset. Try again.');
    onApply(id, null);
    return changed();
  });
  handle('reset-all', () => {
    if (save({ widgetSizes: {} }) === false) return failure('Widget sizes could not be reset. Try again.');
    for (const id of supported) onApply(id, null);
    return changed();
  });
  handle('mode', value => {
    const mode = Sizing.normalizeMode(value, { strict: true });
    if (save({ widgetResizeMode: mode }) === false) return failure('The resize mode could not be saved. Try again.');
    return changed();
  });
  return { getState: state };
}

module.exports = { registerWidgetSizingIpc };
