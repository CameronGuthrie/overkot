'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLayoutRuntime } = require('../src/modules/layoutRuntime');
const { captureLayout } = require('../src/modules/layouts');

function fixture() {
  const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, bounds: { x: -1280, y: -100, width: 1280, height: 1024 }, workArea: { x: -1280, y: -100, width: 1280, height: 984 } }];
  const data = { dockEdge: 'left', dockAutoHide: true, dockDisplayId: 2,
    widgetVisibility: { minimap: true, clock: true, market: true }, widgetOpen: { minimap: true, clock: false },
    widgetDocked: { minimap: false }, dockWidgetOrder: ['minimap', 'clock'],
    widgetBounds_minimap: { x: -1000, y: 20, width: 300, height: 300 },
    widgetBounds_clock: { x: -700, y: 30, width: 400, height: 100 },
    accountId: 'private', screenshotDir: 'private/path', overlayVisibilityHotkey: 'Ctrl+F2', appearance: { global: { cornerRadius: 22 } },
    savedLayouts: [{ id: 'local', name: 'Local', layout: {} }] };
  const calls = [];
  let writable = true;
  const window = (id, bounds, destroyed = false) => ({ isDestroyed: () => destroyed, bounds: { ...bounds }, id });
  const windows = new Map([['minimap', window('minimap', { x: -900, y: 40, width: 430, height: 430 })],
    ['clock', window('clock', { x: -700, y: 30, width: 400, height: 100 }, true)]]);
  const screen = { getAllDisplays: () => displays,
    getDisplayMatching: bounds => displays.find(display => bounds.x < display.bounds.x + display.bounds.width
      && bounds.x + bounds.width > display.bounds.x) || displays[0] };
  const runtime = createLayoutRuntime({
    config: { getAll: () => structuredClone(data), setMany(patch) { calls.push('persist'); if (!writable) return false; Object.assign(data, patch); return true; } },
    screen, getDockDisplay: () => displays.find(display => display.id === data.dockDisplayId) || displays[0],
    widgetWindows: windows, widgetIds: ['minimap', 'clock'],
    widgetDimensions: id => id === 'minimap' ? { width: 350, height: 350, minWidth: 150, minHeight: 150 }
      : { width: 300, height: 200, minWidth: 200, minHeight: 24 },
    getBounds: win => ({ ...win.bounds }), setBounds(win, bounds) { calls.push(win.id); win.bounds = { ...bounds }; },
    onApplied: () => calls.push('sync'),
  });
  return { runtime, data, calls, windows, displays, failSave: () => { writable = false; } };
}

test('saving captures current geometry before debounce and retains bounds for unmounted widgets', () => {
  const f = fixture();
  const saved = f.runtime.capture();
  assert.deepEqual(saved.widgetBounds.minimap, f.windows.get('minimap').bounds);
  assert.deepEqual(saved.widgetBounds.clock, f.data.widgetBounds_clock);
  assert.deepEqual(saved.display, f.displays[1].bounds);
  assert.equal(saved.widgetOpen.clock, false);
  assert.equal(saved.widgetDocked.minimap, false);
  assert.equal(JSON.stringify(saved).includes('private'), false);
});

test('applying restores native size and position, enabled/open states and docking without replacing unrelated preferences', () => {
  const f = fixture();
  const original = structuredClone(f.data);
  const saved = f.runtime.capture();
  saved.widgetBounds.minimap = { x: -1100, y: 50, width: 500, height: 500 };
  saved.dockEdge = 'top';
  saved.widgetOpen.clock = true;
  assert.equal(f.runtime.apply(saved), true);
  assert.deepEqual(f.windows.get('minimap').bounds, saved.widgetBounds.minimap);
  assert.equal(f.data.dockDisplayId, 2);
  assert.equal(f.data.dockEdge, 'top');
  assert.equal(f.data.widgetOpen.clock, true);
  assert.equal(f.data.widgetDocked.minimap, false);
  assert.equal(f.data.widgetVisibility.market, true);
  for (const key of ['accountId', 'screenshotDir', 'overlayVisibilityHotkey', 'appearance', 'savedLayouts']) {
    assert.deepEqual(f.data[key], original[key], key);
  }
  assert.deepEqual(f.calls, ['persist', 'minimap', 'sync']);
});

test('a removed source monitor remaps floating panels onto the current screen and clamps oversized imports', () => {
  const f = fixture();
  const saved = f.runtime.capture();
  saved.widgetBounds.minimap = { x: -1200, y: -50, width: 3000, height: 2000 };
  f.displays.pop();
  assert.equal(f.runtime.apply(saved), true);
  assert.deepEqual(f.windows.get('minimap').bounds, { x: 0, y: 0, width: 1920, height: 1040 });
  assert.equal(f.data.dockDisplayId, 1);
});

test('unselected widget sizes return to defaults instead of leaking the previous arrangement', () => {
  const f = fixture();
  const saved = captureLayout({ widgetVisibility: { minimap: true }, widgetOpen: { minimap: true } });
  assert.equal(f.runtime.apply(saved), true);
  assert.deepEqual(f.windows.get('minimap').bounds, { x: -815, y: 217, width: 350, height: 350 });
  assert.equal(f.data.widgetBounds_minimap, null);
  assert.equal(f.data.widgetVisibility.clock, false);
  assert.equal(f.data.widgetOpen.clock, false);
  assert.equal(f.data.widgetDocked.minimap, true);
});

test('failed persistence and malformed layouts leave the live arrangement untouched', () => {
  const f = fixture();
  const original = structuredClone(f.data);
  const bounds = { ...f.windows.get('minimap').bounds };
  const saved = f.runtime.capture();
  saved.dockEdge = 'bottom';
  f.failSave();
  assert.equal(f.runtime.apply(saved), false);
  assert.deepEqual(f.data, original);
  assert.deepEqual(f.windows.get('minimap').bounds, bounds);
  assert.deepEqual(f.calls, ['persist']);
  assert.throws(() => f.runtime.apply({ dockEdge: 'anywhere' }));
  assert.deepEqual(f.calls, ['persist']);
});

test('layouts from another build cannot enable or open unsupported widgets', () => {
  const f = fixture();
  const saved = captureLayout({ widgetVisibility: { 'title-tracker': true, clock: true }, widgetOpen: { 'title-tracker': true } });
  f.runtime.apply(saved);
  assert.equal(f.data.widgetVisibility.clock, true);
  assert.equal(Object.hasOwn(f.data.widgetVisibility, 'title-tracker'), false);
  assert.equal(Object.hasOwn(f.data.widgetOpen, 'title-tracker'), false);
  assert.equal(f.data.dockWidgetOrder.includes('title-tracker'), false);
});

test('manual axis intent and resize mode restore for open and closed widgets without changing Auto axes', () => {
  const f = fixture();
  const saved = captureLayout({ widgetVisibility: { minimap: true, clock: true, daily: true, market: true },
    widgetOpen: { minimap: true }, widgetSizes: { minimap: { width: 504, height: 408 }, clock: { width: null, height: 173 } },
    widgetResizeMode: 'free' });
  assert.equal(f.runtime.apply(saved), true);
  assert.deepEqual(f.data.widgetSizes, { minimap: { width: 504, height: 408 }, clock: { width: null, height: 173 } });
  assert.equal(f.data.widgetResizeMode, 'free');
  assert.equal(f.windows.get('minimap').bounds.width, 504);
  assert.equal(f.windows.get('minimap').bounds.height, 408);
  assert.equal(f.data.widgetVisibility.daily, true, 'Daily Brief remains a launcher even though it has no docked native widget');
  assert.equal(f.data.widgetVisibility.market, true);
  assert.equal(Object.hasOwn(f.data.widgetSizes, 'daily'), false);
});

test('a size reset saved in a layout clears earlier fixed preferences instead of inheriting them', () => {
  const f = fixture();
  f.data.widgetSizes = { minimap: { width: 600, height: 600 }, clock: { width: 401, height: null } };
  f.data.widgetResizeMode = 'free';
  const saved = captureLayout({ widgetVisibility: { minimap: true }, widgetSizes: {}, widgetResizeMode: 'grid' });
  assert.equal(f.runtime.apply(saved), true);
  assert.deepEqual(f.data.widgetSizes, {});
  assert.equal(f.data.widgetResizeMode, 'grid');
});

test('imported manual size intent is clamped with the actual bounds on a smaller monitor', () => {
  const f = fixture(), saved = f.runtime.capture();
  saved.widgetBounds.minimap = { x: -1200, y: -50, width: 3000, height: 2000 };
  saved.widgetSizes.minimap = { width: 3000, height: 2000 };
  f.displays.pop();
  assert.equal(f.runtime.apply(saved), true);
  assert.deepEqual(f.data.widgetSizes.minimap, { width: 1920, height: 1040 });
  assert.deepEqual(f.windows.get('minimap').bounds, { x: 0, y: 0, width: 1920, height: 1040 });
});
