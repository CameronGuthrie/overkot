'use strict';

// All coordinates are Electron device-independent pixels, including monitors
// positioned left of or above the primary display.
function clamp(value, min, max) {
  return Math.max(min, Math.min(Math.round(value), Math.max(min, max)));
}

function constrainBounds(bounds, workArea) {
  return {
    ...bounds,
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - bounds.width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - bounds.height),
  };
}

function restoreBounds(saved, defaults, workArea, minimum = {}) {
  const size = (key) => clamp(
    Number.isFinite(saved?.[key]) && saved[key] > 0 ? saved[key] : defaults[key],
    Math.min(minimum[key] || 1, workArea[key]),
    workArea[key],
  );
  const width = size('width');
  const height = size('height');
  return constrainBounds({
    width,
    height,
    x: Number.isFinite(saved?.x) ? saved.x : workArea.x + (workArea.width - width) / 2,
    y: Number.isFinite(saved?.y) ? saved.y : workArea.y + (workArea.height - height) / 2,
  }, workArea);
}

function moveDragTarget(target, dx, dy) {
  // Keep the requested location separate from the displayed, snapped location.
  // Otherwise a series of small moves never escapes an edge's snap threshold.
  return { ...target, x: target.x + dx, y: target.y + dy };
}

function snapBounds(bounds, workArea, otherBounds = [], distance = 12, margin = 5) {
  const xs = [workArea.x + margin, workArea.x + workArea.width - margin - bounds.width];
  const ys = [workArea.y + margin, workArea.y + workArea.height - margin - bounds.height];
  const nearby = (start, length, otherStart, otherLength) => (
    start <= otherStart + otherLength + margin + distance
    && start + length >= otherStart - margin - distance
  );
  for (const other of otherBounds) {
    if (nearby(bounds.y, bounds.height, other.y, other.height)) {
      xs.push(other.x - margin - bounds.width, other.x,
        other.x + other.width + margin, other.x + other.width - bounds.width);
    }
    if (nearby(bounds.x, bounds.width, other.x, other.width)) {
      ys.push(other.y - margin - bounds.height, other.y,
        other.y + other.height + margin, other.y + other.height - bounds.height);
    }
  }
  const closest = (value, candidates) => {
    let result = value;
    let bestDistance = distance;
    for (const candidate of candidates) {
      const delta = Math.abs(value - candidate);
      if (delta < bestDistance || (delta === bestDistance && delta < distance && candidate < result)) {
        result = candidate;
        bestDistance = delta;
      }
    }
    return result;
  };
  return constrainBounds({ ...bounds, x: closest(bounds.x, xs), y: closest(bounds.y, ys) }, workArea);
}

function expandedBoundsAtPosition(expanded, current) {
  return { ...expanded, x: current.x, y: current.y };
}

function dockAvailableSpace(mainBounds, workArea) {
  const below = Math.max(0, workArea.y + workArea.height - mainBounds.y - mainBounds.height - 12);
  const above = Math.max(0, mainBounds.y - workArea.y - 12);
  const useAbove = below < 120 && above > below;
  return { above: useAbove, height: Math.max(40, useAbove ? above : below) };
}

module.exports = { constrainBounds, restoreBounds, moveDragTarget, snapBounds, expandedBoundsAtPosition, dockAvailableSpace };
