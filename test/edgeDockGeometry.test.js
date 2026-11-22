'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DOCK_SIZE, GRID_SIZE, GAP, EDGES, railBounds, widgetArea, layoutDockedWidgets,
  pointInBounds, snapWidgetToGrid } = require('../src/modules/edgeDockGeometry');

const area = { x: -1600, y: -900, width: 1000, height: 700 };
const inside = (bounds, container) => bounds.x >= container.x && bounds.y >= container.y
  && bounds.x + bounds.width <= container.x + container.width
  && bounds.y + bounds.height <= container.y + container.height;
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;

test('rails span every screen edge at 48 DIP, including displays above and left of the primary', () => {
  const expected = {
    top: { x: -1600, y: -900, width: 1000, height: 48 },
    bottom: { x: -1600, y: -248, width: 1000, height: 48 },
    left: { x: -1600, y: -900, width: 48, height: 700 },
    right: { x: -648, y: -900, width: 48, height: 700 },
  };
  for (const edge of EDGES) {
    assert.deepEqual(railBounds(area, edge), expected[edge]);
    const hidden = railBounds(area, edge, true);
    const vertical = edge === 'left' || edge === 'right';
    assert.equal(vertical ? hidden.width : hidden.height, 3, edge);
    assert.equal(vertical ? hidden.height : hidden.width, vertical ? area.height : area.width, edge);
    assert.ok(inside(hidden, area), edge);
  }
  assert.deepEqual(railBounds(area, 'invalid'), expected.bottom);
  assert.equal(DOCK_SIZE, 48);
});

test('dock panels sit beside the rail without overlap and wrap inward when a shelf fills', () => {
  const items = Array.from({ length: 4 }, (_, index) => ({ id: String(index), width: 250, height: 200 }));
  for (const edge of EDGES) {
    const panels = layoutDockedWidgets(items, area, edge);
    const rail = railBounds(area, edge), usable = widgetArea(area, edge);
    assert.deepEqual(panels.map(panel => panel.id), items.map(item => item.id), edge);
    for (let index = 0; index < panels.length; index++) {
      assert.ok(inside(panels[index], usable), `${edge} panel ${index} stays on screen`);
      assert.equal(overlaps(panels[index], rail), false, `${edge} panel ${index} leaves the rail available`);
      for (let other = index + 1; other < panels.length; other++) {
        assert.equal(overlaps(panels[index], panels[other]), false, `${edge} panels ${index}/${other}`);
      }
    }
    const first = panels[0], second = panels[1], wrapped = panels[3];
    if (edge === 'left' || edge === 'right') {
      assert.equal(first.x, second.x, edge);
      assert.equal(second.y, first.y + first.height + GAP, edge);
      assert.equal(wrapped.y, first.y, `${edge} starts a new shelf`);
      assert.equal(wrapped.x - first.x, (edge === 'left' ? 1 : -1) * (first.width + GAP), edge);
    } else {
      assert.equal(first.y, second.y, edge);
      assert.equal(second.x, first.x + first.width + GAP, edge);
      assert.equal(wrapped.x, first.x, `${edge} starts a new shelf`);
      assert.equal(wrapped.y - first.y, (edge === 'top' ? 1 : -1) * (first.height + GAP), edge);
    }
  }
  assert.deepEqual(layoutDockedWidgets([], area, 'bottom'), []);
});

test('mixed panel sizes reserve the deepest shelf and oversized panels fit the available space', () => {
  const items = [{ id: 'tall', width: 480, height: 240 }, { id: 'short', width: 480, height: 80 },
    { id: 'wrapped', width: 300, height: 100 }];
  const panels = layoutDockedWidgets(items, area, 'top');
  assert.equal(panels[2].y, panels[0].y + 240 + GAP);
  assert.equal(overlaps(panels[0], panels[2]), false);
  const usable = widgetArea(area, 'right');
  const [oversized] = layoutDockedWidgets([{ id: 'map', width: 4000, height: 3000 }], area, 'right');
  assert.equal(oversized.width, usable.width);
  assert.equal(oversized.height, usable.height);
  assert.ok(inside(oversized, usable));
});

test('auto-hidden docks release the entire rail space to attached panels on every edge', () => {
  const item = [{ id: 'map', width: 250, height: 200 }];
  for (const edge of EDGES) {
    const [visible] = layoutDockedWidgets(item, area, edge, area);
    const [hidden] = layoutDockedWidgets(item, area, edge, area, true);
    const axis = edge === 'left' || edge === 'right' ? 'x' : 'y';
    assert.equal(hidden[axis] - visible[axis], ['left', 'top'].includes(edge) ? -DOCK_SIZE : DOCK_SIZE, edge);
    assert.ok(inside(hidden, area), edge);
  }
});

test('panels use the actual screen rail when the work area already excludes an edge taskbar', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  const taskbarAreas = {
    bottom: { x: 0, y: 0, width: 1920, height: 1040 },
    top: { x: 0, y: 40, width: 1920, height: 1040 },
    left: { x: 40, y: 0, width: 1880, height: 1080 },
    right: { x: 0, y: 0, width: 1880, height: 1080 },
  };
  for (const edge of EDGES) {
    const workArea = taskbarAreas[edge];
    const [panel] = layoutDockedWidgets([{ id: 'boss', width: 300, height: 200 }], workArea, edge, screen);
    const rail = railBounds(screen, edge);
    assert.ok(inside(panel, workArea), edge);
    assert.ok(inside(panel, widgetArea(workArea, edge, screen)), edge);
    const gap = edge === 'bottom' ? rail.y - panel.y - panel.height
      : edge === 'top' ? panel.y - rail.y - rail.height
      : edge === 'left' ? panel.x - rail.x - rail.width
      : rail.x - panel.x - panel.width;
    assert.equal(gap, GAP, `${edge} leaves one gap instead of reserving the taskbar twice`);
  }
  const workArea = { x: 0, y: 0, width: 1920, height: 980 };
  const [panel] = layoutDockedWidgets([{ id: 'boss', width: 300, height: 200 }], workArea, 'bottom', screen);
  assert.equal(panel.y + panel.height, workArea.height - GAP,
    'a taskbar larger than the rail remains outside the available widget space');
});

test('explicit grid snapping uses the monitor origin and leaves the unsnapped drag position intact', () => {
  const display = { bounds: { x: -1365, y: -768, width: 1365, height: 768 },
    workArea: { x: -1365, y: -740, width: 1365, height: 740 } };
  const dragged = { x: -1250, y: -650, width: 120, height: 100 };
  const saved = { ...dragged };
  const snapped = snapWidgetToGrid(dragged, display, 'bottom');
  assert.deepEqual(dragged, saved, 'dragging does not mutate a position to the grid');
  assert.deepEqual(snapped, { x: -1245, y: -648, width: 120, height: 100 });
  assert.equal((snapped.x - display.bounds.x) % GRID_SIZE, 0);
  assert.equal((snapped.y - display.bounds.y) % GRID_SIZE, 0);
  assert.notEqual((snapped.y - display.workArea.y) % GRID_SIZE, 0, 'taskbar offsets do not move the visible grid origin');
});

test('snapping clamps near monitor edges and reserves the dock only on its display', () => {
  const display = { bounds: { ...area }, workArea: { ...area } };
  for (const edge of EDGES) {
    for (const bounds of [{ x: -5000, y: -5000, width: 300, height: 200 },
      { x: 5000, y: 5000, width: 300, height: 200 }]) {
      const snapped = snapWidgetToGrid(bounds, display, edge);
      assert.ok(inside(snapped, widgetArea(area, edge)), edge);
      assert.equal((snapped.x - display.bounds.x) % GRID_SIZE, 0, `${edge} x stays on a grid line`);
      assert.equal((snapped.y - display.bounds.y) % GRID_SIZE, 0, `${edge} y stays on a grid line`);
    }
  }
  const floating = { x: area.x, y: area.y, width: 300, height: 200 };
  assert.deepEqual(snapWidgetToGrid(floating, display, 'left', false), floating,
    'a second monitor does not reserve space for a rail on another display');
  assert.equal(snapWidgetToGrid(floating, display, 'left', true).x, area.x + Math.ceil((DOCK_SIZE + GAP) / GRID_SIZE) * GRID_SIZE);
});

test('left and top boundary clamps choose visible grid lines outside the rail and taskbar', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const nearOrigin = { x: 10, y: 10, width: 300, height: 200 };
  const left = snapWidgetToGrid(nearOrigin, display, 'left');
  assert.deepEqual(left, { ...nearOrigin, x: 72, y: 24 });
  const top = snapWidgetToGrid(nearOrigin, display, 'top');
  assert.deepEqual(top, { ...nearOrigin, x: 24, y: 72 });
  display.workArea = { x: 0, y: 40, width: 1920, height: 1040 };
  assert.equal(snapWidgetToGrid(nearOrigin, display, 'top').y, 72,
    'the taskbar does not add a second rail inset');
});

test('boundary snapping follows a negative monitor origin without shifting the visible grid', () => {
  const display = { bounds: { x: -1365, y: -768, width: 1365, height: 768 },
    workArea: { x: -1325, y: -740, width: 1325, height: 740 } };
  for (const edge of EDGES) {
    for (const location of [{ x: -5000, y: -5000 }, { x: 5000, y: 5000 }]) {
      const snapped = snapWidgetToGrid({ ...location, width: 300, height: 200 }, display, edge);
      assert.ok(inside(snapped, widgetArea(display.workArea, edge, display.bounds)), edge);
      assert.equal((snapped.x - display.bounds.x) % GRID_SIZE, 0, edge);
      assert.equal((snapped.y - display.bounds.y) % GRID_SIZE, 0, edge);
    }
  }
});

test('a panel without any grid-aligned position falls back to constrained bounds', () => {
  const display = { bounds: { x: 0, y: 0, width: 320, height: 240 },
    workArea: { x: 0, y: 0, width: 320, height: 240 } };
  const usable = widgetArea(display.workArea, 'left', display.bounds);
  const nearlyFull = { x: -50, y: -50, width: usable.width, height: usable.height };
  const snapped = snapWidgetToGrid(nearlyFull, display, 'left');
  assert.deepEqual(snapped, { ...nearlyFull, x: usable.x, y: usable.y });
  assert.ok(inside(snapped, usable));
});

test('redock hit testing accepts the bar and optional target padding, including negative coordinates', () => {
  const rail = railBounds(area, 'left');
  assert.equal(pointInBounds({ x: rail.x, y: rail.y }, rail), true);
  assert.equal(pointInBounds({ x: rail.x + 47, y: rail.y + 699 }, rail), true);
  assert.equal(pointInBounds({ x: rail.x + 48, y: rail.y + 100 }, rail), false);
  assert.equal(pointInBounds({ x: rail.x, y: rail.y + 700 }, rail), false);
  assert.equal(pointInBounds({ x: rail.x + 52, y: rail.y + 100 }, rail, 8), true);
  assert.equal(pointInBounds({ x: rail.x - 9, y: rail.y + 100 }, rail, 8), false);
});
