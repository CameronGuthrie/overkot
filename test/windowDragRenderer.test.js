'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  function surface() {
    const listeners = new Map();
    return {
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatch(type, event = {}) { for (const fn of [...(listeners.get(type) || [])]) fn(event); },
      count(type) { return listeners.get(type)?.size || 0; },
    };
  }
  const region = surface(), window = surface(), document = surface();
  const calls = [], frames = new Set(), captures = new Set();
  region.style = {};
  region.setPointerCapture = id => captures.add(id);
  region.hasPointerCapture = id => captures.has(id);
  region.releasePointerCapture = id => { captures.delete(id); region.dispatch('lostpointercapture', { pointerId: id }); };
  window.api = {
    windowDragStart: (...args) => calls.push(['start', ...args]),
    windowMoveBy: (...args) => calls.push(['move', ...args]),
    windowDragEnd: (...args) => calls.push(['end', ...args]),
  };
  const context = vm.createContext({ window, document, region,
    hooks: { onStart: () => calls.push(['started']), onEnd: () => calls.push(['ended']), onClick: () => calls.push(['click']) },
    requestAnimationFrame: fn => { frames.add(fn); return fn; }, cancelAnimationFrame: fn => frames.delete(fn),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/window-drag.js'), 'utf8'), context);
  vm.runInContext('bindWindowDrag(region, hooks)', context);
  return { region, window, document, calls, captures, frames,
    event: (type, overrides = {}) => region.dispatch(type, { pointerId: 1, button: 0, buttons: 1, isPrimary: true,
      screenX: 100, screenY: 100, shiftKey: false, preventDefault() {}, target: { closest: () => null }, ...overrides }),
    frame() { const pending = [...frames]; frames.clear(); for (const fn of pending) fn(); },
  };
}

test('pointer capture keeps an out-of-header release paired with the original drag and flushes the last move', () => {
  const f = fixture();
  f.event('pointerdown');
  assert.ok(f.captures.has(1));
  f.event('pointermove', { screenX: 140, screenY: 120 });
  f.event('pointermove', { screenX: 160, screenY: 150, shiftKey: true });
  assert.equal(f.frames.size, 1);
  f.event('pointerup', { buttons: 0, screenX: 160, screenY: 150 });
  assert.deepEqual(f.calls, [['started'], ['start', 3, false], ['move', 60, 50, true], ['end', false], ['ended']]);
  assert.equal(f.captures.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.region.count('pointermove'), 0);
  assert.equal(f.document.count('keyup'), 0);
  assert.equal(f.window.count('blur'), 0);
});

test('a lost pointer, released button, or blur cancels pending movement without a spurious click', () => {
  for (const event of ['pointercancel', 'lostpointercapture', 'pointermove', 'blur']) {
    const f = fixture();
    f.event('pointerdown');
    f.event('pointermove', { screenX: 130 });
    if (event === 'blur') f.window.dispatch('blur');
    else f.event(event, { buttons: 0 });
    f.frame();
    assert.deepEqual(f.calls, [['started'], ['start', 3, false], ['end', true], ['ended']], event);
    assert.equal(f.captures.size, 0, event);
  }
});

test('click thresholds, excluded controls and unrelated pointers do not trigger window movement', () => {
  const f = fixture();
  f.event('pointerdown', { target: { closest: () => ({}) } });
  assert.deepEqual(f.calls, []);
  f.event('pointerdown');
  f.event('pointermove', { pointerId: 2, screenX: 500 });
  f.event('pointerup', { pointerId: 2 });
  assert.ok(f.captures.has(1));
  f.event('pointermove', { screenX: 102, screenY: 103 });
  f.event('pointerup');
  assert.deepEqual(f.calls, [['started'], ['start', 3, false], ['move', 0, 0, false], ['end', false], ['ended'], ['click']]);
});

test('Shift changes are forwarded even while the pointer remains stationary', () => {
  const f = fixture();
  f.event('pointerdown');
  f.event('pointermove', { screenX: 130 });
  f.frame();
  f.document.dispatch('keydown', { shiftKey: true });
  f.frame();
  assert.deepEqual(f.calls.at(-1), ['move', 0, 0, true]);
  f.document.dispatch('keyup', { shiftKey: false });
  f.frame();
  assert.deepEqual(f.calls.at(-1), ['move', 0, 0, false]);
  f.event('pointerup');
});
