'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sizing = require('../src/modules/widgetSizing');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(widgetId = 'wiki') {
  function surface() {
    const listeners = new Map();
    const classes = new Set();
    const captures = new Set();
    return {
      style: {}, dataset: {},
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
        contains: name => classes.has(name),
      },
      addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
      dispatch(type, event = {}) { for (const callback of [...(listeners.get(type) || [])]) callback(event); },
      count: type => listeners.get(type)?.size || 0,
      setPointerCapture: pointer => captures.add(pointer), hasPointerCapture: pointer => captures.has(pointer),
      releasePointerCapture(pointer) { captures.delete(pointer); this.dispatch('lostpointercapture', { pointerId: pointer }); },
      getBoundingClientRect: () => ({ right: 300, bottom: 200, height: 200 }),
    };
  }
  const document = surface(), window = surface(), widget = surface(), handle = surface();
  const calls = [], frames = new Map();
  let frameId = 0;
  let monitorStatus;
  const content = { closest: () => null };
  const button = { closest: selector => selector === 'button' ? {} : null };
  handle.closest = selector => selector === '#resize-handle' ? handle : null;
  widget.contains = target => target === content || target === button;
  document.body = surface();
  document.hasFocus = () => true;
  document.querySelector = selector => selector.startsWith('.timer-widget') ? widget : null;
  document.getElementById = id => id === 'resize-handle' ? handle : null;
  window.location = { search: `?widget=${widgetId}` };
  window.outerWidth = window.innerWidth = 300;
  window.outerHeight = window.innerHeight = 200;
  window.OverkotWidgetSizing = sizing;
  window.api = {
    windowDragStart: (...args) => calls.push(['start', ...args]),
    windowMoveBy: (...args) => calls.push(['move', ...args]),
    windowDragEnd: (...args) => calls.push(['end', ...args]),
    windowResizeTo: (...args) => calls.push(plain(['resize', ...args])),
    setLayoutEditing: active => calls.push(['editing', active]),
    onLayoutKeyMonitorStatus: callback => { monitorStatus = callback; },
  };
  const context = vm.createContext({ window, document, URLSearchParams,
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id), setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/widget-host.js'), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  run('bindDragToMove(); bindResizeHandle(); nativeShiftTracking = true;');
  return { document, window, widget, handle, content, button, calls, run,
    monitorStatus: active => monitorStatus(active),
    event(surface, type, overrides = {}) {
      const event = { pointerId: 1, button: 0, buttons: 1, isPrimary: true,
        screenX: 100, screenY: 100, shiftKey: false, target: content,
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; }, ...overrides };
      surface.dispatch(type, event);
      return event;
    },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
  };
}

test('normal widget controls retain their pointer, click and keyboard behavior', () => {
  const f = fixture();
  for (const [type, overrides] of [['pointerdown', { target: f.button }], ['click', { target: f.button }], ['keydown', { key: 'Enter' }]]) {
    const event = f.event(f.document, type, overrides);
    assert.equal(event.prevented, false, type);
    assert.equal(event.stopped, false, type);
  }
  assert.deepEqual(f.calls, []);
});

test('holding Shift outside overlay focus cannot initiate widget dragging or swallow controls', () => {
  const f = fixture();
  f.document.hasFocus = () => false;
  for (const type of ['pointerdown', 'click', 'wheel']) {
    assert.equal(f.event(f.document, type, { shiftKey: true }).prevented, false, type);
  }
  assert.deepEqual(f.calls, []);
});

test('Shift captures widget controls for dragging and forwards unsnapped movement only', () => {
  const f = fixture();
  f.run('setLayoutEditing(true)');
  const start = f.event(f.document, 'pointerdown', { target: f.button, shiftKey: true });
  assert.equal(start.prevented, true);
  assert.equal(start.stopped, true);
  assert.ok(f.widget.hasPointerCapture(1));
  f.event(f.widget, 'pointermove', { screenX: 125, screenY: 140, shiftKey: true });
  f.frame();
  f.event(f.widget, 'pointerup', { buttons: 0 });
  assert.deepEqual(f.calls, [['start', 3, false], ['move', 25, 40, false], ['end', false]]);
  assert.equal(f.widget.hasPointerCapture(1), false);
  assert.equal(f.widget.count('pointermove'), 0);
  assert.equal(f.event(f.document, 'click', { target: f.button, shiftKey: true }).stopped, true);
});

test('a quick Shift drag enters layout mode before starting the native gesture', () => {
  const f = fixture();
  f.event(f.document, 'pointerdown', { target: f.button, shiftKey: true });
  assert.deepEqual(f.calls, [['editing', true], ['start', 3, false]]);
  assert.equal(f.document.body.classList.contains('layout-editing'), true);
});

test('releasing Shift flushes the final movement and prevents the drag from activating a button', () => {
  const f = fixture();
  f.run('setLayoutEditing(true)');
  f.event(f.document, 'pointerdown', { target: f.button });
  f.event(f.widget, 'pointermove', { screenX: 145 });
  f.run('setLayoutEditing(false)');
  f.frame();
  assert.deepEqual(f.calls, [['start', 3, false], ['move', 45, 0, false], ['end', false]]);
  assert.equal(f.document.body.classList.contains('layout-editing'), false);
  assert.equal(f.event(f.document, 'click', { target: f.button }).stopped, true);
  f.event(f.document, 'pointerdown', { target: f.button });
  assert.equal(f.event(f.document, 'click', { target: f.button }).stopped, false);
});

test('lost pointer capture cancels movement and leaves no drag listeners behind', () => {
  const f = fixture();
  f.run('setLayoutEditing(true)');
  f.event(f.document, 'pointerdown');
  f.event(f.widget, 'pointermove', { screenX: 160 });
  f.event(f.widget, 'pointercancel');
  f.frame();
  assert.deepEqual(f.calls, [['start', 3, false], ['end', true]]);
  assert.equal(f.widget.count('pointermove'), 0);
  assert.equal(f.widget.hasPointerCapture(1), false);
});

test('resize requires Shift editing and stops when Shift is released', () => {
  const f = fixture();
  f.event(f.handle, 'pointerdown', { target: f.handle });
  assert.equal(f.handle.hasPointerCapture(1), false);
  f.run('setLayoutEditing(true)');
  f.event(f.handle, 'pointerdown', { target: f.handle });
  f.event(f.handle, 'pointermove', { screenX: 150, target: f.handle });
  assert.deepEqual(f.calls, [['resize', 360, 200, { manual: true, precise: false, commit: false }]]);
  f.run('setLayoutEditing(false)');
  f.event(f.handle, 'pointermove', { screenX: 200, target: f.handle });
  assert.deepEqual(f.calls, [
    ['resize', 360, 200, { manual: true, precise: false, commit: false }],
    ['resize', 360, 200, { manual: true, precise: false, commit: true }],
  ]);
  assert.equal(f.handle.hasPointerCapture(1), false);
  assert.equal(f.handle.count('pointermove'), 0);
});

test('corner resizing changes both axes and Alt temporarily preserves one-pixel dimensions', () => {
  const f = fixture('minimap');
  f.run('setLayoutEditing(true)');
  f.event(f.handle, 'pointerdown', { target: f.handle });
  f.event(f.handle, 'pointermove', { screenX: 123, screenY: 137, target: f.handle, altKey: true });
  assert.deepEqual(f.calls.at(-1), ['resize', 323, 237, { manual: true, precise: true, commit: false }]);
  f.event(f.handle, 'pointerup', { buttons: 0 });
  assert.deepEqual(f.calls.at(-1), ['resize', 323, 237, { manual: true, precise: true, commit: true }]);
  assert.equal(f.run('customWidth'), 323); assert.equal(f.run('customHeight'), 237);
  assert.equal(f.document.body.classList.contains('widget-manual-height'), true);
});

test('Precise resize preference uses one-pixel steps and cancellation commits only the last valid preview', () => {
  const f = fixture();
  f.run('config.widgetResizeMode="free"; setLayoutEditing(true)');
  f.event(f.handle, 'pointerdown', { target: f.handle });
  f.event(f.handle, 'pointermove', { screenX: 119, screenY: 127, target: f.handle });
  f.event(f.handle, 'pointercancel');
  assert.deepEqual(f.calls, [
    ['resize', 319, 227, { manual: true, precise: true, commit: false }],
    ['resize', 319, 227, { manual: true, precise: true, commit: true }],
  ]);
  assert.equal(f.handle.count('pointermove'), 0);
});

test('renderer Shift events provide layout mode on platforms without native tracking', () => {
  const f = fixture();
  f.run('nativeShiftTracking = false');
  f.event(f.document, 'keydown', { key: 'Shift', shiftKey: true });
  assert.equal(f.document.body.classList.contains('layout-editing'), true);
  assert.equal(f.event(f.document, 'keydown', { key: 'Enter', shiftKey: true }).stopped, true);
  f.event(f.document, 'keyup', { key: 'Shift', shiftKey: false });
  assert.equal(f.document.body.classList.contains('layout-editing'), false);
  assert.deepEqual(f.calls, [['editing', true], ['editing', false]]);
});

test('a failed native monitor switches Windows widgets to Shift key-up and blur cleanup', () => {
  const f = fixture();
  f.run('setLayoutEditing(true)');
  f.event(f.document, 'keyup', { key: 'Shift', shiftKey: false });
  assert.equal(f.document.body.classList.contains('layout-editing'), true,
    'healthy native tracking owns Shift release even if the renderer misses game focus');
  f.monitorStatus(false);
  f.event(f.document, 'keyup', { key: 'Shift', shiftKey: false });
  assert.equal(f.document.body.classList.contains('layout-editing'), false,
    'a monitor failure enables renderer key-up cleanup');
  f.event(f.document, 'keydown', { key: 'Shift', shiftKey: true });
  assert.equal(f.document.body.classList.contains('layout-editing'), true);
  f.event(f.window, 'blur');
  assert.equal(f.document.body.classList.contains('layout-editing'), false,
    'leaving the window cannot strand the edit grid after global tracking fails');
  assert.deepEqual(f.calls, [['editing', false], ['editing', true], ['editing', false]]);
});
