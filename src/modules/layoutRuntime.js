'use strict';

const Layouts = require('./layouts');
const { restoreBounds } = require('./windowGeometry');
const equalRect = (a, b) => a && b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;

/** Saved arrangements use live bounds; applying one never replaces other settings. */
function createLayoutRuntime({ config, screen, getDockDisplay, widgetWindows, widgetIds,
  widgetDimensions, getBounds, setBounds, onApplied = () => {} }) {
  function capture() {
    const widgetBounds = {};
    for (const [id, win] of widgetWindows) {
      if (!win.isDestroyed()) widgetBounds[id] = getBounds(win);
    }
    return Layouts.captureLayout(config.getAll(), { display: getDockDisplay().bounds, widgetBounds });
  }

  function apply(value) {
    const layout = Layouts.normalizeLayout(value, { strict: true });
    const displays = screen.getAllDisplays();
    const originalDisplay = displays.find(display => equalRect(display.bounds, layout.display));
    const display = originalDisplay || getDockDisplay();
    const supported = new Set([...widgetIds, 'market', 'daily']);
    const pick = map => Object.fromEntries(Object.entries(map).filter(([id]) => supported.has(id)));
    const patch = { dockEdge: layout.dockEdge, dockAutoHide: layout.dockAutoHide, dockDisplayId: display.id,
      dockWidgetOrder: layout.dockWidgetOrder.filter(id => supported.has(id)),
      widgetVisibility: pick(layout.widgetVisibility), widgetOpen: pick(layout.widgetOpen), widgetDocked: pick(layout.widgetDocked),
      widgetSizes: Object.fromEntries(Object.entries(layout.widgetSizes).filter(([id]) => widgetIds.includes(id))),
      widgetResizeMode: layout.widgetResizeMode };
    const bounds = new Map();
    for (const id of widgetIds) {
      const dimensions = widgetDimensions(id);
      const size = patch.widgetSizes[id];
      let saved = layout.widgetBounds[id];
      if (saved && layout.display && !originalDisplay) {
        // A shared layout or unplugged monitor moves with its dock screen.
        saved = { ...saved, x: saved.x + display.bounds.x - layout.display.x,
          y: saved.y + display.bounds.y - layout.display.y };
      }
      const target = saved && displays.some(candidate => intersects(saved, candidate.bounds))
        ? screen.getDisplayMatching(saved) : display;
      const next = restoreBounds(saved, { ...dimensions, width: size?.width ?? dimensions.width,
        height: size?.height ?? dimensions.height }, target.workArea,
        { width: dimensions.minWidth, height: dimensions.minHeight });
      // Retain which axes were deliberately fixed, but store the actual
      // geometry that can fit this monitor rather than an unreachable size.
      if (size) patch.widgetSizes[id] = {
        width: size.width === null ? null : next.width,
        height: size.height === null ? null : next.height,
      };
      patch['widgetBounds_' + id] = saved ? next : null;
      bounds.set(id, next);
    }
    // Persist before touching live windows; a failed save keeps the old space.
    if (config.setMany(patch) === false) return false;
    const live = [...widgetWindows].filter(([, win]) => !win.isDestroyed());
    for (const [, win] of live) {
      win._layoutApplying = true;
      win._cancelPendingBounds?.();
    }
    try {
      for (const [id, win] of live) if (bounds.has(id)) setBounds(win, bounds.get(id));
      onApplied();
    } finally {
      for (const [, win] of live) win._layoutApplying = false;
    }
    return true;
  }
  return { capture, apply };
}

module.exports = { createLayoutRuntime };
