'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMoonsteelAlertWindow, SOUND_TAIL_MS, LOAD_TIMEOUT_MS } = require('../src/modules/moonsteelAlertWindow');

function fixture(options = {}) {
  const windows = [], timers = new Map(), errors = [], workspace = [];
  let nextTimer = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, options[key]])); this.destroyed = false; this.visible = false; this.messages = [];
      this.webContents = Object.assign(new EventEmitter(), { send: (...args) => this.messages.push(args) });
      windows.push(this);
    }
    setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
    setAlwaysOnTop(...args) { this.top = args; }
    setVisibleOnAllWorkspaces(value) { this.workspaces = value; }
    loadFile(file) { this.file = file; return options.loadFailure ? Promise.reject(new Error('Fixture load failure')) : Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; if (options.showClamp) { this.bounds.height -= 48; this.emit('resize'); } this.emit('show'); }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; this.boundsChanges = (this.boundsChanges || 0) + 1; this.emit('resize'); }
    moveTop() { this.raises = (this.raises || 0) + 1; }
    focus() { assert.fail('Moonsteel alerts must never activate themselves'); }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const primary = { id: 1, bounds: { x: -1920, y: -100, width: 1920, height: 1080 }, workArea: { x: -1920, y: -100, width: 1920, height: 1040 } };
  const secondary = { id: 2, bounds: { x: 0, y: 0, width: 1080, height: 1920 } };
  const controller = createMoonsteelAlertWindow({ BrowserWindow: Window,
    screen: { getAllDisplays: () => options.mirrored ? [primary, { id: 3, bounds: { ...primary.bounds } }] : [primary, secondary], getPrimaryDisplay: () => primary,
      getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => secondary },
    platformSupport: { platform: options.platform || 'win32' },
    configureOverlayWorkspace: win => workspace.push(win), onError: error => errors.push(error),
    schedule(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    cancel: id => timers.delete(id),
  });
  const flushGeometry = () => { for (const [id, timer] of [...timers]) if (timer.delay === 50) { timers.delete(id); timer.callback(); } };
  const ready = win => { win.emit('ready-to-show'); win.webContents.emit('did-finish-load'); flushGeometry(); };
  return { controller, windows, timers, primary, secondary, errors, workspace, ready, flushGeometry };
}

test('the alert covers the entire monitor without taking focus, keyboard input or mouse input', () => {
  const f = fixture();
  assert.equal(f.controller.show({ items: [{ id: 'moonsteel', name: 'Stultin' }] }), true);
  const win = f.windows[0];
  for (const key of ['x', 'y', 'width', 'height']) assert.equal(win.options[key], f.primary.bounds[key]);
  assert.equal(win.options.height, 1080, 'The taskbar does not shorten the edge flash');
  assert.equal(win.options.frame, false); assert.equal(win.options.transparent, true);
  assert.equal(win.options.focusable, false); assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.options.webPreferences.autoplayPolicy, 'no-user-gesture-required');
  assert.equal(win.options.webPreferences.sandbox, true); assert.equal(win.ignoreMouse, true);
  assert.equal(win._moonsteelAlert, true); assert.deepEqual(win.top, [true, 'screen-saver', 6]);
  assert.equal(win.visible, false); assert.equal(win.messages.length, 0);
  assert.equal([...f.timers.values()][0].delay, LOAD_TIMEOUT_MS);
  win.webContents.emit('did-finish-load'); assert.equal(win.visible, false, 'Wait for first paint as well as preload readiness');
  win.emit('ready-to-show');
  f.flushGeometry();
  assert.equal(win.visible, true); assert.equal(win.messages.length, 1);
  assert.equal(win.messages[0][0], 'moonsteel-alert:data');
  assert.equal(win.messages[0][1].settings.color, '#da75ff');
  assert.equal([...f.timers.values()][0].delay, 4250);
  assert.equal(f.workspace[0], win);
  const exposed = f.controller.activeWindows; exposed.length = 0;
  assert.equal(f.controller.activeWindows.length, 1, 'Callers cannot mutate surface ownership');
  f.controller.raise(); assert.equal(win.raises, 2);
  [...f.timers.values()][0].callback();
  assert.equal(f.controller.activeWindows.length, 0); assert.equal(f.timers.size, 0);
});

test('Windows work-area clamps after mapping are repaired to the full monitor without activation', () => {
  const f = fixture({ showClamp: true }); f.controller.show({});
  const win = f.windows[0]; f.ready(win);
  assert.equal(win.boundsChanges, 1);
  assert.deepEqual(win.getBounds(), f.primary.bounds);
  assert.equal(f.timers.size, 1, 'Geometry reconciliation settles instead of polling');
  win.bounds.height -= 48; win.emit('resize'); f.flushGeometry(); f.flushGeometry();
  assert.deepEqual(win.getBounds(), f.primary.bounds);
  assert.equal(f.timers.size, 1);
  f.controller.dispose(); assert.equal(f.timers.size, 0);
});

test('all-monitor flashes play one sound even when the displays finish loading in reverse order', () => {
  const f = fixture(); f.controller.show({ settings: { monitor: 'all', volume: .7, sound: 'beacon' } });
  assert.equal(f.windows.length, 2);
  f.ready(f.windows[1]); f.ready(f.windows[0]);
  assert.equal(f.windows.filter(win => win.messages[0][1].settings.soundEnabled).length, 1);
  assert.equal(f.windows[1].messages[0][1].settings.volume, .7);
  assert.equal(f.windows[1].messages[0][1].settings.sound, 'beacon');
  assert(f.windows.every(win => win.visible && win.ignoreMouse));
  f.controller.close(); assert(f.windows.every(win => win.destroyed)); assert.equal(f.timers.size, 0);
});

test('cursor monitoring and Linux workspace hints use the chosen display bounds', () => {
  const f = fixture({ platform: 'linux' }); f.controller.show({ settings: { monitor: 'cursor' } });
  const win = f.windows[0];
  assert.equal(win.options.x, f.secondary.bounds.x); assert.equal(win.options.height, f.secondary.bounds.height);
  assert.equal(win.options.type, 'dock'); assert.equal(win.workspaces, true);
  f.ready(win); f.controller.dispose();
});

test('mirrored displays share one flash surface instead of doubling the selected intensity', () => {
  const f = fixture({ mirrored: true });
  f.controller.show({ settings: { monitor: 'all' } });
  assert.equal(f.windows.length, 1, 'Distinct display IDs with identical desktop rectangles must not stack');
  f.ready(f.windows[0]);
  assert.equal(f.windows[0].messages[0][1].settings.soundEnabled, true);
  assert.equal(f.windows[0].messages[0][1].settings.opacity, .65);
  f.controller.dispose(); assert.equal(f.timers.size, 0);
});

test('sound-only alerts use one hidden tiny surface instead of covering or mapping every display', () => {
  const f = fixture(); f.controller.show({ settings: { monitor: 'all', flashEnabled: false, duration: 12 } });
  assert.equal(f.windows.length, 1);
  const win = f.windows[0]; f.ready(win);
  assert.equal(win.options.width, 1); assert.equal(win.options.height, 1); assert.equal(win.visible, false);
  assert.equal(win.messages[0][1].settings.flashEnabled, false);
  assert.equal(win.messages[0][1].settings.soundEnabled, true);
  assert.equal([...f.timers.values()][0].delay, SOUND_TAIL_MS + 250);
  f.controller.dispose();
});

test('replacement alerts cancel old deadlines and ignore late loading events', () => {
  const f = fixture(); f.controller.show({});
  const old = f.windows[0], expired = [...f.timers.values()][0].callback;
  f.controller.show({ settings: { duration: 2 } });
  const current = f.windows[1];
  assert.equal(old.destroyed, true); assert.equal(f.timers.size, 1);
  f.ready(old); expired(); assert.equal(old.messages.length, 0); assert.equal(current.destroyed, false);
  f.ready(current); assert.equal(current.visible, true);
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 2250);
  f.controller.dispose();
  assert.equal(f.controller.show({ preview: true }), false); assert.equal(f.windows.length, 2);
});

test('disabled or fully silent preferences close existing surfaces while an explicit preview can test a disabled alert', () => {
  const f = fixture();
  assert.equal(f.controller.show({ settings: { enabled: false } }), false);
  assert.equal(f.controller.show({ settings: { flashEnabled: false, soundEnabled: false } }), false);
  assert.equal(f.controller.show({ settings: { flashEnabled: false, volume: 0 } }), false);
  assert.equal(f.windows.length, 0);
  assert.equal(f.controller.show({ settings: { enabled: false }, preview: true }), true);
  f.ready(f.windows[0]);
  f.controller.show({ settings: { enabled: false } });
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.timers.size, 0);
});

test('failed or stalled renderer loads release their native windows and deadlines', async () => {
  const failed = fixture({ loadFailure: true }); failed.controller.show({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.errors.length, 1); assert.equal(failed.controller.activeWindows.length, 0); assert.equal(failed.timers.size, 0);
  const stalled = fixture(); stalled.controller.show({});
  const win = stalled.windows[0]; [...stalled.timers.values()][0].callback();
  stalled.ready(win); assert.equal(win.destroyed, true); assert.equal(win.messages.length, 0); assert.equal(stalled.timers.size, 0);
});
