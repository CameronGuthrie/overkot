'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowDragController, rememberWindowSize, getWindowBounds, setWindowBounds } = require('../src/modules/windowDrag');

function fixture({ nativeCursor = true, bounds = { x: 100, y: 100, width: 300, height: 200 }, other = [] } = {}) {
  const win = new EventEmitter();
  const writes = [], timers = new Set();
  let cursor = { x: bounds.x + 20, y: bounds.y + 10 }, destroyed = false;
  Object.assign(win, {
    webContents: new EventEmitter(),
    isDestroyed: () => destroyed,
    // Deliberately stale until the window manager processes its configure queue.
    getBounds: () => ({ ...bounds }),
    setPosition: () => { throw new Error('setPosition re-reads the rounded live size'); },
    setBounds: next => writes.push(next),
  });
  const controller = createWindowDragController({ nativeCursor, now: () => 1000,
    screen: {
      getCursorScreenPoint: () => cursor,
      getDisplayMatching: target => ({ workArea: { x: target.x < 0 ? -1200 : 0, y: 0, width: 1200, height: 900 } }),
    },
    getOtherWindows: () => other,
    schedule: callback => { timers.add(callback); return callback; }, cancel: callback => timers.delete(callback),
  });
  return { win, writes, controller, timers,
    cursor: (x, y) => { cursor = { x, y }; },
    tick: () => { for (const callback of timers) callback(); },
    destroy: () => { destroyed = true; win.emit('closed'); },
  };
}

test('Linux drag follows the desktop pointer while renderer coordinates and WM bounds lag', () => {
  const f = fixture();
  f.controller.start(f.win);
  f.cursor(170, 160);
  f.controller.moveBy(f.win, -500, 600, false);
  f.tick();
  assert.deepEqual(f.writes, [{ x: 150, y: 150, width: 300, height: 200 }]);
  f.cursor(270, 210);
  f.tick();
  assert.deepEqual(f.writes.at(-1), { x: 250, y: 200, width: 300, height: 200 });
  for (let i = 0; i < 20; i++) {
    f.controller.moveBy(f.win, 20, -10, false);
    f.tick();
  }
  assert.equal(f.writes.length, 2, 'A stationary cursor never feeds configure-induced events back into movement');
  assert.equal(f.win._dragTarget.width, 300);
  f.controller.end(f.win);
});

test('Linux releases flush the final desktop pointer and stop further movement', () => {
  const f = fixture();
  f.controller.start(f.win);
  f.cursor(180, 130);
  const final = f.controller.end(f.win);
  assert.deepEqual(f.writes, [{ x: 160, y: 120, width: 300, height: 200 }]);
  assert.deepEqual(f.win.getBounds(), { x: 100, y: 100, width: 300, height: 200 }, 'The native reply remains stale');
  assert.deepEqual(final, { x: 160, y: 120, width: 300, height: 200 });
  assert.equal(f.win._isDragging, false);
  assert.equal(f.win._dragMoveActiveUntil, 1180, 'Resizes wait for the final X11 configure event');
  assert.equal(f.timers.size, 0);
  f.cursor(500, 500);
  f.tick();
  assert.equal(f.writes.length, 1);
});

test('pointer threshold leaves clicks stationary and permits dragging across a negative-origin monitor', () => {
  const f = fixture();
  f.controller.start(f.win, { threshold: 5 });
  f.cursor(124, 114);
  f.tick();
  assert.deepEqual(f.writes, []);
  f.cursor(-180, 140);
  f.tick();
  assert.deepEqual(f.writes, [{ x: -300, y: 130, width: 300, height: 200 }]);
  f.cursor(-480, 150);
  f.tick();
  assert.deepEqual(f.writes.at(-1), { x: -500, y: 140, width: 300, height: 200 });
  f.controller.end(f.win);
});

test('snap uses the unclamped pointer origin and can be released without moving the pointer', () => {
  const f = fixture();
  f.controller.start(f.win, { snap: true });
  f.cursor(27, 110);
  f.tick();
  assert.deepEqual(f.writes.at(-1), { x: 5, y: 100, width: 300, height: 200 });
  f.controller.moveBy(f.win, 0, 0, false);
  f.tick();
  assert.deepEqual(f.writes.at(-1), { x: 7, y: 100, width: 300, height: 200 });
  f.cursor(60, 110);
  f.tick();
  assert.deepEqual(f.writes.at(-1), { x: 40, y: 100, width: 300, height: 200 });
  f.controller.end(f.win);
});

test('blur, renderer failure, cancellation and close all stop native polling without applying late movement', () => {
  for (const cause of ['blur', 'crash', 'cancel', 'close', 'dispose']) {
    const f = fixture();
    f.controller.start(f.win);
    f.cursor(900, 700);
    if (cause === 'blur') f.win.emit('blur');
    if (cause === 'crash') f.win.webContents.emit('render-process-gone');
    if (cause === 'cancel') f.controller.end(f.win, false);
    if (cause === 'close') f.destroy();
    if (cause === 'dispose') f.controller.dispose();
    f.tick();
    assert.deepEqual(f.writes, [], cause);
    assert.equal(f.timers.size, 0, cause);
    assert.equal(f.win._isDragging, false, cause);
    assert.equal(f.win.listenerCount('blur'), 0, cause);
    assert.equal(f.win.webContents.listenerCount('render-process-gone'), 0, cause);
  }
});

test('restarting a drag disposes its earlier timer and captures a fresh origin', () => {
  const f = fixture();
  f.controller.start(f.win);
  f.cursor(220, 210);
  f.controller.start(f.win);
  assert.equal(f.timers.size, 1);
  assert.equal(f.win.listenerCount('blur'), 1);
  f.cursor(230, 220);
  f.tick();
  assert.deepEqual(f.writes, [{ x: 110, y: 110, width: 300, height: 200 }]);
  f.controller.dispose();
});

test('Windows delta dragging retains fractional geometry and stable dimensions with lagging native bounds', () => {
  const f = fixture({ nativeCursor: false });
  f.controller.start(f.win);
  for (let i = 0; i < 20; i++) f.controller.moveBy(f.win, 0.5, 0.25);
  assert.deepEqual(f.writes.at(-1), { x: 110, y: 105, width: 300, height: 200 });
  assert.equal(f.timers.size, 0);
  f.controller.end(f.win);
  f.controller.moveBy(f.win, 100, 100);
  assert.deepEqual(f.writes.at(-1), { x: 110, y: 105, width: 300, height: 200 });
});

test('X11 size rounding cannot grow the intended dimensions during or between repeated gestures', () => {
  const f = fixture();
  let nativeBounds = { x: 100, y: 100, width: 278, height: 77 };
  f.win.getBounds = () => ({ ...nativeBounds });
  f.win.setBounds = next => {
    f.writes.push({ ...next });
    // Simulate the enclosing DIP rectangle reported for fractional physical pixels.
    nativeBounds = { ...next, width: next.width + 1, height: next.height + 1 };
  };
  rememberWindowSize(f.win, { width: 277, height: 76 });
  for (let gesture = 0; gesture < 10; gesture++) {
    f.cursor(120, 110);
    f.controller.start(f.win);
    for (let sample = 0; sample < 105; sample++) {
      f.cursor(120 + sample % 40, 110 + sample % 25);
      f.tick();
    }
    f.controller.end(f.win);
    assert.deepEqual(getWindowBounds(f.win), { ...nativeBounds, width: 277, height: 76 });
  }
  assert.ok(f.writes.length > 1000);
  assert.ok(f.writes.every(({ width, height }) => width === 277 && height === 76));

  // Manual resize, reset, content fitting and collapse/expand update the intent
  // explicitly; their dimensions must survive subsequent drags too.
  for (const size of [{ width: 40, height: 40 }, { width: 277, height: 76 }, { width: 410, height: 230 }]) {
    setWindowBounds(f.win, { x: 100, y: 100, ...size });
    f.cursor(120, 110);
    f.controller.start(f.win);
    f.cursor(180, 140);
    f.tick();
    f.controller.end(f.win);
    assert.deepEqual(f.writes.at(-1), { x: 160, y: 130, ...size });
  }
});
