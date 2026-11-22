'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerWidgetSizingIpc } = require('../src/modules/widgetSizingIpc');

function fixture({ constrainSize } = {}) {
  const handlers = new Map(), calls = [], data = { widgetSizes: { clock: { width: 411, height: null }, resources: { width: 441, height: 511 } },
    widgetResizeMode: 'grid', widgetBounds_clock: { x: 10, y: 20, width: 411, height: 80 }, language: 'fr' };
  let writable = true;
  const root = path.resolve(__dirname, '../src/renderer');
  const frame = { url: pathToFileURL(path.join(root, 'settings.html')).href };
  const event = { sender: { mainFrame: frame, isDestroyed: () => false }, senderFrame: frame };
  registerWidgetSizingIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, rendererRoot: root,
    config: { get: (key, fallback) => data[key] ?? fallback, setMany(patch) { calls.push(['persist', patch]); if (!writable) return false; Object.assign(data, patch); return true; } },
    widgetIds: ['clock', 'resources', 'daily', 'market'], getCurrentSize: id => id === 'clock' ? { x: 10, y: 20, width: 411, height: 83 } : null,
    constrainSize, onApply: (id, size) => calls.push(['apply', id, size]), onChanged: () => calls.push(['changed']),
  });
  return { data, calls, event, invoke: (name, value, sender = event) => handlers.get('widget-sizing:' + name)(sender, value), fail: () => { writable = false; } };
}

test('Settings receives dimensions and current sizes without unrelated config or pop-out windows', () => {
  const f = fixture(), state = f.invoke('get');
  assert.equal(state.ok, true); assert.equal(state.mode, 'grid');
  assert.deepEqual(state.widgets.map(item => item.id), ['clock', 'resources']);
  assert.equal(state.widgets[0].currentHeight, 83);
  assert.equal(Object.hasOwn(state.widgets[0], 'x'), false);
  assert.equal(JSON.stringify(state).includes('language'), false);
  assert.deepEqual(f.calls, []);
});

test('per-widget changes persist before applying and preserve closed widget preferences', () => {
  const f = fixture();
  const state = f.invoke('set', { id: 'clock', width: 437, height: 173 });
  assert.equal(state.ok, true);
  assert.deepEqual(state.sizes.clock, { width: 437, height: 173 });
  assert.deepEqual(state.sizes.resources, { width: 441, height: 511 });
  assert.deepEqual(f.calls.map(call => call[0]), ['persist', 'apply', 'changed']);
  assert.deepEqual(f.calls[1], ['apply', 'clock', { width: 437, height: 173 }]);
  assert.deepEqual(f.data.widgetBounds_clock, { x: 10, y: 20, width: 411, height: 80 }, 'the size endpoint itself does not move windows');
});

test('screen constraints are resolved before one size transaction and preserve automatic axes', () => {
  const constrained = [];
  const f = fixture({ constrainSize: (id, size) => {
    constrained.push([id, size]);
    return { width: size.width === null ? null : Math.min(800, size.width), height: size.height };
  } });
  const state = f.invoke('set', { id: 'clock', width: 32768, height: null });
  assert.equal(state.ok, true);
  assert.deepEqual(constrained, [['clock', { width: 32768, height: null }]]);
  assert.deepEqual(state.sizes.clock, { width: 800, height: null });
  assert.deepEqual(f.data.widgetSizes.clock, { width: 800, height: null });
  assert.equal(f.calls.filter(call => call[0] === 'persist').length, 1);
  assert.deepEqual(f.calls[1], ['apply', 'clock', { width: 800, height: null }]);
});

test('per-widget and all-widget reset remove size intent while leaving other settings alone', () => {
  const f = fixture();
  assert.equal(f.invoke('reset', { id: 'clock' }).ok, true);
  assert.equal(Object.hasOwn(f.data.widgetSizes, 'clock'), false);
  assert.equal(f.data.widgetSizes.resources.width, 441);
  assert.deepEqual(f.calls[1], ['apply', 'clock', null]);
  f.calls.length = 0;
  assert.equal(f.invoke('reset-all').ok, true);
  assert.deepEqual(f.data.widgetSizes, {});
  assert.deepEqual(f.calls.map(call => call[0]), ['persist', 'apply', 'apply', 'changed']);
  assert.equal(f.data.language, 'fr');
  assert.equal(f.invoke('mode', 'free').mode, 'free');
});

test('editing or resetting one widget preserves known sizes hidden by the current build', () => {
  const f = fixture();
  f.data.widgetSizes['title-tracker'] = { width: 419, height: 287 };
  assert.equal(Object.hasOwn(f.invoke('get').sizes, 'title-tracker'), false, 'unsupported controls stay hidden');
  assert.equal(f.invoke('set', { id: 'clock', width: 437, height: null }).ok, true);
  assert.deepEqual(f.data.widgetSizes['title-tracker'], { width: 419, height: 287 });
  assert.equal(f.invoke('reset', { id: 'clock' }).ok, true);
  assert.deepEqual(f.data.widgetSizes['title-tracker'], { width: 419, height: 287 });
  assert.equal(f.invoke('reset-all').ok, true);
  assert.deepEqual(f.data.widgetSizes, {}, 'Reset all deliberately clears hidden sizes too');
});

test('failed writes, unsupported IDs and invalid dimensions never touch native windows', () => {
  const f = fixture();
  for (const request of [{ id: 'daily', width: 500 }, { id: '__proto__', width: 500 }, { id: 'clock', width: NaN },
    { id: 'clock', width: 0 }, { id: 'clock', height: '300' }, null]) assert.equal(f.invoke('set', request).ok, false);
  assert.equal(f.invoke('mode', 'pixels').ok, false);
  assert.deepEqual(f.calls, []);
  const before = structuredClone(f.data); f.fail();
  assert.equal(f.invoke('set', { id: 'clock', width: 477, height: null }).ok, false);
  assert.equal(f.invoke('reset-all').ok, false);
  assert.deepEqual(f.data, before);
  assert.equal(f.calls.some(call => call[0] === 'apply' || call[0] === 'changed'), false);
});

test('only the main Settings frame can read or change widget sizes', () => {
  const f = fixture();
  const fake = url => { const frame = { url }; return { sender: { mainFrame: frame, isDestroyed: () => false }, senderFrame: frame }; };
  for (const event of [fake('https://example.com/settings.html'), fake('file:///other/settings.html'),
    fake(pathToFileURL(path.resolve(__dirname, '../src/renderer/widget-host.html')).href),
    { ...f.event, senderFrame: { ...f.event.senderFrame } },
    { ...f.event, sender: { ...f.event.sender, isDestroyed: () => true } }]) {
    assert.equal(f.invoke('get', undefined, event).ok, false);
    assert.equal(f.invoke('set', { id: 'clock', width: 477 }, event).ok, false);
  }
  assert.deepEqual(f.calls, []);
});
