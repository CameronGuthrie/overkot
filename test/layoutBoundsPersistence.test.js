'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createLayoutRuntime } = require('../src/modules/layoutRuntime');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const previous = { x: 35, y: 40, width: 350, height: 350 };
const imported = { x: 600, y: 200, width: 420, height: 420 };

function fixture({ destroyOnApply = false, failSave = false } = {}) {
  const timers = new Map(), writes = [];
  let nextTimer = 0;
  const data = { widgetBounds_minimap: { ...previous, x: 5 } };
  const config = {
    get: (key, fallback) => data[key] ?? fallback, getAll: () => ({ ...data }),
    set(key, value) { writes.push([key, value]); data[key] = value; return true; },
    setMany(patch) { if (failSave) return false; writes.push(['transaction']); Object.assign(data, patch); return true; },
  };
  const win = Object.assign(new EventEmitter(), { destroyed: false, bounds: { ...previous },
    isDestroyed() { return this.destroyed; }, getBounds() { return { ...this.bounds }; } });
  const context = vm.createContext({ config,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(main.slice(main.indexOf('function trackWindowBounds('), main.indexOf('// Tutorials begin only after')), context);
  context.trackWindowBounds(win, 'widgetBounds_minimap');
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const runtime = createLayoutRuntime({ config,
    screen: { getAllDisplays: () => [display], getDisplayMatching: () => display }, getDockDisplay: () => display,
    widgetWindows: new Map([['minimap', win]]), widgetIds: ['minimap'],
    widgetDimensions: () => ({ width: 350, height: 350, minWidth: 150, minHeight: 150 }),
    getBounds: () => win.getBounds(),
    // A compositor can acknowledge the requested geometry on a later turn.
    // Events during the apply may therefore still report the old rectangle.
    setBounds() { win.emit('move'); win.emit('resize'); },
    onApplied() {
      win.emit('move');
      if (destroyOnApply) { win.destroyed = true; win.emit('closed'); }
    },
  });
  return { win, data, writes, timers, runtime,
    apply: () => runtime.apply({ widgetVisibility: { minimap: !destroyOnApply }, widgetBounds: { minimap: imported } }),
    flush() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
  };
}

test('a disabled widget closing before native geometry settles cannot overwrite its imported bounds', () => {
  const f = fixture({ destroyOnApply: true });
  f.win.emit('move');
  assert.equal(f.timers.size, 1, 'A previous user move has an outstanding debounced save');
  assert.equal(f.apply(), true);
  assert.equal(f.win.destroyed, true);
  assert.deepEqual(f.data.widgetBounds_minimap, imported);
  f.flush();
  assert.deepEqual(f.data.widgetBounds_minimap, imported, 'Old pending or close-event saves cannot replace the layout');
  assert.deepEqual(f.writes, [['transaction']]);
});

test('layout application discards stale native events and resumes tracking subsequent user moves', () => {
  const f = fixture();
  f.win.emit('move');
  assert.equal(f.apply(), true);
  f.flush();
  assert.deepEqual(f.data.widgetBounds_minimap, imported);
  assert.deepEqual(f.writes, [['transaction']]);
  // The native acknowledgement arrives, followed by a new user gesture.
  f.win.bounds = { ...imported, x: 650, y: 260 };
  f.win.emit('move');
  assert.equal(f.timers.size, 1);
  f.flush();
  assert.deepEqual(f.data.widgetBounds_minimap, f.win.bounds);
  assert.deepEqual(f.writes, [['transaction'], ['widgetBounds_minimap', f.win.bounds]]);
});

test('failed layout persistence preserves outstanding saves for the unchanged live arrangement', () => {
  const f = fixture({ failSave: true });
  f.win.emit('move');
  assert.equal(f.apply(), false);
  assert.equal(f.timers.size, 1, 'A failed apply must not discard an earlier user movement');
  assert.deepEqual(f.win.bounds, previous);
  assert.equal(f.data.widgetBounds_minimap.x, 5);
  f.flush();
  assert.deepEqual(f.data.widgetBounds_minimap, previous);
  assert.deepEqual(f.writes, [['widgetBounds_minimap', previous]]);
});
