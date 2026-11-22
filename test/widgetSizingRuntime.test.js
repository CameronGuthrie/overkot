'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WidgetSizing = require('../src/modules/widgetSizing');
const { constrainBounds, restoreBounds } = require('../src/modules/windowGeometry');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function fixture() {
  const callbacks = new Map(), writes = [], messages = [], changes = [];
  const area = { x: -1280, y: 0, width: 1280, height: 984 };
  const data = { widgetSizes: {}, widgetResizeMode: 'grid', widgetDocked: { clock: false } };
  let writable = true;
  const panel = id => ({ _widgetId: id, _widgetMinimumSize: [200, 24],
    bounds: { x: -1000, y: 100, width: 300, height: 200 }, isDestroyed: () => false,
    _cancelPendingBounds: () => changes.push('cancel-pending'),
    webContents: { send: (...values) => messages.push([id, ...values]) } });
  const clock = panel('clock'), windows = new Map([['clock', clock]]);
  const context = vm.createContext({
    WidgetSizing, constrainBounds, restoreBounds, Number, Date,
    widgetWindowDimensions: WidgetSizing.widgetDimensions,
    config: { get: (key, fallback) => data[key] ?? fallback, getAll: () => structuredClone(data),
      set(key, value) { writes.push({ [key]: value }); if (!writable) return false; data[key] = value; return true; },
      setMany(patch) { writes.push(patch); if (!writable) return false; Object.assign(data, patch); return true; } },
    BrowserWindow: { fromWebContents: sender => sender },
    screen: { getDisplayMatching: () => ({ workArea: area }) }, dockDisplay: () => ({ workArea: area }),
    ipcMain: { on: (name, callback) => callbacks.set(name, callback) },
    widgetWindows: windows, ALL_WIDGET_IDS: ['clock', 'weather'], layoutMovedWidgets: new Set(),
    mainWindow: {}, dailyBriefWindow: {}, layoutEditing: true,
    appearanceSession: { effectiveConfig: () => structuredClone(data) },
    getWindowBounds: win => ({ ...win.bounds }),
    setWindowBounds: (win, bounds) => { win.bounds = { ...bounds }; changes.push(['bounds', { ...bounds }]); },
    broadcastDockConfig: () => changes.push('broadcast'), layoutDockedPanels: () => changes.push('dock-layout'), resetWidgetPositions() {},
  });
  vm.runInContext(main.slice(main.indexOf('function resetWidgetSizes()'), main.indexOf('// ─── Group Finder window')), context);
  vm.runInContext(main.slice(main.indexOf("ipcMain.on('fit-window-size'"), main.indexOf('// ─── Group Finder IPC handlers')), context);
  return { clock, context, data, writes, messages, changes, windows, area,
    send: (name, ...values) => callbacks.get(name)({ sender: clock }, ...values),
    run: source => vm.runInContext(source, context), failWrites: () => { writable = false; } };
}

test('a native resize preview cannot be undone by delayed content fitting and persists only on commit', () => {
  const f = fixture();
  f.send('window-resize-to', 437, 173, { precise: true, commit: false });
  assert.equal(f.clock.bounds.width, 437); assert.equal(f.clock.bounds.height, 173);
  assert.equal(f.writes.length, 0, 'Pointer-move previews do not rewrite size preferences');
  f.send('fit-window-size', 300, 999);
  assert.equal(f.clock.bounds.height, 173, 'Old renderer measurements cannot fight the gesture');
  f.send('window-resize-to', 437, 173, { precise: true, commit: true });
  assert.equal(f.writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.data.widgetSizes.clock)), { width: 437, height: 173 });
  assert.deepEqual(f.data.widgetBounds_clock, f.clock.bounds);
  assert.equal(f.clock._manualResizePreview, null);
  f.send('fit-window-size', 600, 500);
  assert.equal(f.clock.bounds.width, 437); assert.equal(f.clock.bounds.height, 173, 'Manual axes survive later live content updates');
});

test('grid and precise native resize support both axes without changing an untouched dimension', () => {
  const f = fixture();
  f.send('window-resize-to', 350, 200, { commit: false });
  assert.equal(f.clock.bounds.width, 360); assert.equal(f.clock.bounds.height, 200);
  f.send('window-resize-to', 361, 201, { precise: true, commit: false });
  assert.equal(f.clock.bounds.width, 361); assert.equal(f.clock.bounds.height, 201);
  f.data.widgetResizeMode = 'free';
  f.send('window-resize-to', 362, 202, { commit: true });
  assert.equal(f.clock.bounds.width, 362); assert.equal(f.clock.bounds.height, 202);
});

test('leaving layout mode can commit the last preview and delayed final events cannot replace it', () => {
  const f = fixture();
  f.send('window-resize-to', 437, 173, { precise: true, commit: false });
  assert.equal(f.run('commitWidgetResize(widgetWindows.get("clock"))'), true);
  f.context.layoutEditing = false;
  f.send('window-resize-to', 800, 600, { precise: true, commit: true });
  assert.equal(f.clock.bounds.width, 437); assert.equal(f.clock.bounds.height, 173);
  assert.equal(f.writes.length, 1, 'A stale renderer final packet cannot save another size after editing has ended');
});

test('automatic axes follow content while manual axes and every window stay within its monitor', () => {
  const f = fixture();
  f.data.widgetSizes.clock = { width: 427, height: null };
  f.send('fit-window-size', 900, 111);
  assert.equal(f.clock.bounds.width, 427); assert.equal(f.clock.bounds.height, 111);
  f.send('fit-window-size', 300, 9999);
  assert.equal(f.clock.bounds.height, f.area.height);
  const normalized = f.run('clampWidgetSize("clock", {width:32768,height:32768})');
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), { width: 1280, height: 984 });
  f.run('applyWidgetSize("clock", {width:32768,height:32768})');
  assert.deepEqual(f.clock.bounds, { x: -1280, y: 0, width: 1280, height: 984 });
  assert.equal(f.clock._layoutApplying, false);
});

test('reset returns automatic fitting for open and closed widgets and preserves on-screen positions', () => {
  const f = fixture();
  f.data.widgetSizes = { clock: { width: 427, height: 173 }, weather: { width: 500, height: 400 } };
  f.data.widgetBounds_weather = { x: -900, y: 200, width: 500, height: 400 };
  assert.equal(f.run('resetWidgetSizes()'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.data.widgetSizes)), {});
  assert.deepEqual(f.clock.bounds, { x: -1000, y: 100, width: 300, height: 200 });
  assert.deepEqual(JSON.parse(JSON.stringify(f.data.widgetBounds_weather)), { x: -900, y: 200, width: 300, height: 200 });
  assert.ok(f.messages.some(([, name]) => name === 'reset-widget-sizes'));
  f.send('fit-window-size', 300, 117);
  assert.equal(f.clock.bounds.height, 117, 'Automatic content height resumes after reset');
});

test('failed preference persistence retains the old intent and does not claim a completed gesture', () => {
  const f = fixture();
  f.data.widgetSizes.clock = { width: 300, height: null };
  f.send('window-resize-to', 437, 173, { precise: true, commit: false });
  f.failWrites();
  assert.equal(f.run('commitWidgetResize(widgetWindows.get("clock"))'), false);
  assert.deepEqual(f.data.widgetSizes.clock, { width: 300, height: null });
  assert.ok(f.clock._manualResizePreview, 'An unsuccessful save remains available to retry instead of reporting success');
  assert.equal(f.changes.includes('broadcast'), false);
});
