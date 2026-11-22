'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { reminderPlacement, createFocusReminder, REMINDER_DURATION_MS } = require('../src/modules/focusReminder');
const { railBounds } = require('../src/modules/edgeDockGeometry');

test('the reminder points to the toolbar brand and fits every edge on negative displays', () => {
  const display = { x: -1920, y: -200, width: 1920, height: 1080 };
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const dock = railBounds(display, edge);
    const { bounds, arrowOffset } = reminderPlacement(dock, display, edge);
    assert.ok(bounds.x >= display.x && bounds.y >= display.y);
    assert.ok(bounds.x + bounds.width <= display.x + display.width);
    assert.ok(bounds.y + bounds.height <= display.y + display.height);
    assert.equal(arrowOffset, 28);
    if (edge === 'bottom') assert.equal(bounds.y + bounds.height, dock.y);
    if (edge === 'top') assert.equal(bounds.y, dock.y + dock.height);
    if (edge === 'left') assert.equal(bounds.x, dock.x + dock.width);
    if (edge === 'right') assert.equal(bounds.x + bounds.width, dock.x);
  }
});

function fixture(platform = 'win32', options = {}) {
  const windows = [], scheduled = [], stopped = [];
  let show = true, hotkey = 'Control+F8', warning = '', refresh;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.visible = false; this.destroyed = false;
      this.messages = []; this.webContents = { send: (...args) => this.messages.push(args) }; windows.push(this); }
    setIgnoreMouseEvents(value) { this.ignored = value; }
    setAlwaysOnTop(value, level) { this.onTop = [value, level]; }
    setVisibleOnAllWorkspaces(value) { this.allWorkspaces = value; }
    loadFile(file) { this.file = file; }
    setBounds(bounds) { this.bounds = bounds; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    moveTop() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const reminder = createFocusReminder({ BrowserWindow: Window, platformSupport: { platform },
    getDockBounds: () => railBounds(display, 'bottom'), getDisplay: () => display, getEdge: () => 'bottom',
    getHotkey: () => hotkey, getWarning: () => warning, canShow: () => show,
    schedule: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
    cancel: timer => stopped.push(timer), poll: callback => { refresh = callback; return 1; }, stopPoll: id => stopped.push(id),
    ...options,
  });
  return { reminder, windows, scheduled, stopped, refresh: () => refresh(), setShow: value => { show = value; },
    setHotkey: value => { hotkey = value; }, setWarning: value => { warning = value; } };
}

test('one passive cold-launch bubble expires after 60 seconds without renewing after hide or config changes', () => {
  const f = fixture();
  f.reminder.start();
  const win = f.windows[0];
  assert.equal(win.options.focusable, false);
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.ignored, true);
  assert.equal(win.visible, false);
  assert.equal(f.scheduled.length, 0, 'Do not spend the deadline waiting for the renderer');
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  assert.equal(f.scheduled[0].delay, REMINDER_DURATION_MS);
  f.setShow(false); f.refresh();
  assert.equal(win.visible, false);
  f.setShow(true); f.setHotkey('Alt+F7'); f.refresh();
  assert.equal(win.messages.at(-1)[1].hotkey, 'Alt+F7');
  f.setWarning('Unavailable'); f.refresh();
  assert.equal(win.messages.at(-1)[1].warning, 'Unavailable');
  assert.equal(f.scheduled.length, 1, 'Restoring the overlay keeps the original deadline');
  f.scheduled[0].callback();
  assert.equal(win.destroyed, true);
  f.reminder.start(); f.reminder.refresh();
  assert.equal(f.windows.length, 1, 'It cannot reappear in the same app session');
});

test('using the hotkey before the reminder finishes loading prevents a late flash', () => {
  const f = fixture();
  f.reminder.start();
  const win = f.windows[0];
  f.reminder.dismiss();
  win.emit('ready-to-show');
  assert.equal(win.visible, false);
  assert.equal(win.destroyed, true);
  assert.equal(f.scheduled.length, 0);
});

test('each passive reminder raise restores higher alerts immediately and hidden refreshes leave them alone', () => {
  const calls = [];
  const f = fixture('win32', { onRaised: () => calls.push('alerts') });
  f.reminder.start();
  const win = f.windows[0];
  win.moveTop = () => calls.push('reminder');
  win.focus = () => assert.fail('A passive stack refresh must not take focus');
  assert.deepEqual(calls, [], 'Loading alone must not reorder windows');
  win.emit('ready-to-show');
  f.refresh();
  assert.deepEqual(calls, ['reminder', 'alerts', 'reminder', 'alerts']);
  calls.length = 0;
  f.setShow(false); f.refresh(); f.refresh();
  assert.equal(win.visible, false);
  assert.deepEqual(calls, [], 'Hidden reminders must not raise themselves or alerts');
  f.setShow(true); f.refresh();
  assert.deepEqual(calls, ['reminder', 'alerts']);
  calls.length = 0;
  f.reminder.dismiss(); f.refresh();
  assert.deepEqual(calls, [], 'Dismissed reminders must not reorder windows');
});

test('a tray launch waits to show the reminder and Linux marks it as a passive dock on every workspace', () => {
  const f = fixture('linux');
  f.setShow(false); f.reminder.start();
  assert.equal(f.windows.length, 0);
  f.setShow(true); f.refresh();
  const win = f.windows[0];
  assert.equal(win.options.type, 'dock');
  assert.equal(win.allWorkspaces, true);
  win.emit('ready-to-show');
  assert.equal(f.scheduled.length, 1);
  f.reminder.dispose();
  assert.equal(win.destroyed, true);
  assert.ok(f.stopped.includes(f.scheduled[0]));
});
