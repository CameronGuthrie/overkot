'use strict';

const { constrainBounds } = require('./windowGeometry');
const DOCK_SIZE = 48;
const { GRID_SIZE } = require('./widgetSizing');
const GAP = 8;
const EDGES = ['top', 'bottom', 'left', 'right'];
const validEdge = edge => EDGES.includes(edge) ? edge : 'bottom';

function railBounds(area, edge, hidden = false) {
  edge = validEdge(edge);
  const size = hidden ? 3 : DOCK_SIZE;
  if (edge === 'left' || edge === 'right') return {
    x: edge === 'left' ? area.x : area.x + area.width - size,
    y: area.y, width: size, height: area.height,
  };
  return { x: area.x, y: edge === 'top' ? area.y : area.y + area.height - size,
    width: area.width, height: size };
}

function widgetArea(area, edge, dockArea = area, dockHidden = false) {
  edge = validEdge(edge);
  // Work areas may already exclude a taskbar on the dock edge. Reserve space
  // against the actual screen-edge rail, rather than subtracting its full size
  // a second time from that smaller work area.
  if (dockHidden) return { x: area.x + GAP, y: area.y + GAP,
    width: Math.max(1, area.width - GAP * 2), height: Math.max(1, area.height - GAP * 2) };
  const rail = railBounds(dockArea, edge);
  const x = Math.max(area.x + GAP, edge === 'left' ? rail.x + rail.width + GAP : -Infinity);
  const y = Math.max(area.y + GAP, edge === 'top' ? rail.y + rail.height + GAP : -Infinity);
  const right = Math.min(area.x + area.width - GAP, edge === 'right' ? rail.x - GAP : Infinity);
  const bottom = Math.min(area.y + area.height - GAP, edge === 'bottom' ? rail.y - GAP : Infinity);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Place open panels in shelves growing inward from the rail. */
function layoutDockedWidgets(items, area, edge, dockArea = area, dockHidden = false) {
  edge = validEdge(edge);
  const vertical = edge === 'left' || edge === 'right';
  const usable = widgetArea(area, edge, dockArea, dockHidden);
  let along = 0, inward = 0, shelf = 0;
  return items.map(item => {
    const width = Math.min(item.width, usable.width), height = Math.min(item.height, usable.height);
    const length = vertical ? height : width, depth = vertical ? width : height;
    const limit = vertical ? usable.height : usable.width;
    if (along && along + length > limit) { inward += shelf + GAP; along = 0; shelf = 0; }
    let x = usable.x + (vertical ? inward : along), y = usable.y + (vertical ? along : inward);
    if (edge === 'right') x = usable.x + usable.width - inward - width;
    if (edge === 'bottom') y = usable.y + usable.height - inward - height;
    const bounds = constrainBounds({ x, y, width, height }, usable);
    along += length + GAP;
    shelf = Math.max(shelf, depth);
    return { id: item.id, ...bounds };
  });
}

function pointInBounds(point, bounds, padding = 0) {
  return point.x >= bounds.x - padding && point.x < bounds.x + bounds.width + padding
    && point.y >= bounds.y - padding && point.y < bounds.y + bounds.height + padding;
}

function snapWidgetToGrid(bounds, display, edge, onDockDisplay = true) {
  // Match the grid's origin even on monitors with negative coordinates.
  const origin = display.bounds;
  const usable = onDockDisplay ? widgetArea(display.workArea, edge, origin) : display.workArea;
  const constrained = constrainBounds(bounds, usable);
  const snapAxis = (coordinate, start, minimum, maximum, fallback) => {
    const first = start + Math.ceil((minimum - start) / GRID_SIZE) * GRID_SIZE;
    const last = start + Math.floor((maximum - start) / GRID_SIZE) * GRID_SIZE;
    // An oversized panel, or an area narrower than one grid interval, may have
    // no aligned position that fits. Keep it accessible at the bounded fallback.
    if (first > last) return fallback;
    const snapped = start + Math.round((coordinate - start) / GRID_SIZE) * GRID_SIZE;
    return Math.max(first, Math.min(last, snapped));
  };
  return { ...bounds,
    x: snapAxis(bounds.x, origin.x, usable.x, usable.x + usable.width - bounds.width, constrained.x),
    y: snapAxis(bounds.y, origin.y, usable.y, usable.y + usable.height - bounds.height, constrained.y) };
}

module.exports = { DOCK_SIZE, GRID_SIZE, GAP, EDGES, validEdge, railBounds, widgetArea,
  layoutDockedWidgets, pointInBounds, snapWidgetToGrid };
