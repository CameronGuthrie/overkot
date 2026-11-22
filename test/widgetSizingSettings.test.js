'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sizing = require('../src/modules/widgetSizing');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/widget-sizing-settings.js'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  function element(id = '') {
    const listeners = new Map();
    return { id, value: '', type: id.includes('auto-') ? 'checkbox' : 'number', checked: false,
      children: [], dataset: {}, disabled: false, hidden: false,
      append(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      setAttribute(key, value) { this[key] = value; },
      addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
      dispatch(type) { for (const callback of listeners.get(type) || []) callback({ preventDefault() {} }); },
    };
  }
  const ids = ['widget-sizing', 'widget-size-select', 'widget-size-width', 'widget-size-height',
    'widget-size-auto-width', 'widget-size-auto-height', 'widget-resize-mode', 'widget-size-status',
    'widget-size-apply', 'widget-size-reset', 'widget-size-retry', 'widget-size-height-label',
    'widget-size-limits', 'widget-size-current', 'widget-size-form'];
  const nodes = Object.fromEntries(ids.map(id => [id, element(id)]));
  const state = { sizes: { clock: { width: 421, height: 223 } }, mode: 'grid', widgets: [
    { id: 'clock', ...sizing.widgetDimensions('clock'), currentWidth: 421, currentHeight: 223 },
    { id: 'boss', ...sizing.widgetDimensions('boss'), currentWidth: 300, currentHeight: 78 },
    { id: 'daily', width: 900, height: 700 }, { id: 'market', width: 900, height: 700 },
  ] };
  const calls = [];
  let failure = false;
  const response = () => plain({ ok: true, ...state });
  const mutate = async (method, payload) => {
    calls.push([method, plain(payload)]);
    if (failure) return { ok: false, message: 'Fixture cannot save sizes.' };
    if (method === 'set') {
      if (payload.width === null && payload.height === null) delete state.sizes[payload.id];
      else state.sizes[payload.id] = { width: payload.width, height: payload.height };
    }
    if (method === 'reset') delete state.sizes[payload.id];
    if (method === 'mode') state.mode = payload;
    return response();
  };
  const context = vm.createContext({ document: { getElementById: id => nodes[id], createElement: () => element() },
    window: { OverkotAppearance: { widgetNames: { boss: 'Boss timers', clock: 'Clock' } } } });
  vm.runInContext(source, context);
  const controller = context.window.WidgetSizingSettings.mount({ api: {
    widgetSizesGet: async () => response(), widgetSizesSet: value => mutate('set', value),
    widgetSizesReset: value => mutate('reset', value), widgetSizesMode: value => mutate('mode', value),
  } });
  return { nodes, state, calls, controller, fail: () => { failure = true; },
    edit(id, value) { const node = nodes[id]; if (node.type === 'checkbox') node.checked = value; else node.value = value;
      node.dispatch(node.type === 'checkbox' ? 'change' : 'input'); },
    select(id) { nodes['widget-size-select'].value = id; nodes['widget-size-select'].dispatch('change'); },
  };
}

test('size controls sort widgets, exclude standalone pop-outs and keep automatic axes readable', async () => {
  const f = fixture(); await turn();
  assert.deepEqual(f.nodes['widget-size-select'].children.map(option => option.value), ['boss', 'clock']);
  assert.equal(f.nodes['widget-size-select'].value, 'boss');
  assert.equal(f.nodes['widget-size-width'].disabled, true);
  assert.equal(f.nodes['widget-size-height'].disabled, true);
  assert.match(f.nodes['widget-size-current'].textContent, /300 × 78/);
  assert.equal(f.nodes['widget-size-apply'].disabled, true);
  f.select('clock');
  assert.equal(f.nodes['widget-size-width'].value, '421');
  assert.equal(f.nodes['widget-size-height'].value, '223');
  assert.equal(f.nodes['widget-size-height'].disabled, false);
});

test('numeric controls apply exact one-pixel dimensions independently of the grid drag preference', async () => {
  const f = fixture(); await turn();
  f.edit('widget-size-auto-width', false); f.edit('widget-size-auto-height', false);
  f.edit('widget-size-width', '437'); f.edit('widget-size-height', '301');
  assert.equal(f.nodes['widget-size-apply'].disabled, false);
  f.nodes['widget-size-form'].dispatch('submit'); await turn();
  assert.deepEqual(f.calls, [['set', { id: 'boss', width: 437, height: 301 }]]);
  assert.equal(f.state.mode, 'grid');
  assert.equal(f.nodes['widget-size-apply'].disabled, true);
  assert.equal(f.nodes['widget-size-status'].textContent, 'Widget size saved.');
});

test('per-widget reset keeps other widgets and automatic axes are sent as null', async () => {
  const f = fixture(); await turn(); f.select('clock');
  f.edit('widget-size-auto-height', true);
  f.nodes['widget-size-form'].dispatch('submit'); await turn();
  assert.deepEqual(f.calls.at(-1), ['set', { id: 'clock', width: 421, height: null }]);
  f.select('boss'); f.edit('widget-size-auto-width', false); f.edit('widget-size-width', '401');
  f.nodes['widget-size-form'].dispatch('submit'); await turn();
  f.nodes['widget-size-reset'].dispatch('click'); await turn();
  assert.deepEqual(f.calls.at(-1), ['reset', { id: 'boss' }]);
  assert.deepEqual(f.state.sizes, { clock: { width: 421, height: null } });
  assert.equal(f.nodes['widget-size-auto-width'].checked, true);
  assert.equal(f.nodes['widget-size-auto-height'].checked, true);
});

test('invalid dimensions and failed persistence preserve the draft instead of silently rounding or resetting it', async () => {
  const f = fixture(); await turn(); f.edit('widget-size-auto-width', false);
  for (const value of ['', '199', '301.5', 'Infinity', '32769']) {
    f.edit('widget-size-width', value); f.nodes['widget-size-form'].dispatch('submit'); await turn();
    assert.equal(f.calls.length, 0); assert.equal(f.nodes['widget-size-status'].dataset.error, 'true');
  }
  f.edit('widget-size-width', '411'); f.fail(); f.nodes['widget-size-form'].dispatch('submit'); await turn();
  assert.equal(f.nodes['widget-size-width'].value, '411');
  assert.equal(f.nodes['widget-size-apply'].disabled, false);
  assert.match(f.nodes['widget-size-status'].textContent, /cannot save/);
});

test('external changes update saved sizes without overwriting a dirty draft, and the precise preference persists separately', async () => {
  const f = fixture(); await turn(); f.select('clock');
  f.edit('widget-size-width', '451');
  f.controller.receiveConfig({ widgetSizes: { clock: { width: 500, height: 320 } }, widgetResizeMode: 'grid' });
  assert.equal(f.nodes['widget-size-width'].value, '451');
  f.nodes['widget-resize-mode'].value = 'free'; f.nodes['widget-resize-mode'].dispatch('change'); await turn();
  assert.deepEqual(f.calls, [['mode', 'free']]);
  assert.equal(f.nodes['widget-size-width'].value, '451');
  assert.equal(f.nodes['widget-resize-mode'].value, 'free');
  f.controller.dispose(); f.nodes['widget-size-reset'].dispatch('click'); await turn();
  assert.equal(f.calls.length, 1);
});
