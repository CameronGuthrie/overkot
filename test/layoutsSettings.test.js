'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../src/renderer/layouts-settings.js'), 'utf8');
const sample = (id = 'exploring', name = 'Exploring') => ({ id, name, layout: { dockEdge: 'left',
  widgetVisibility: { minimap: true, clock: true, wiki: false }, widgetOpen: { minimap: true },
  widgetDocked: { minimap: false }, widgetBounds: { minimap: { x: 40, y: 60, width: 200, height: 300 } } } });
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(api = {}, options = {}) {
  class Element {
    constructor() { this.value = ''; this.textContent = ''; this.children = []; this.dataset = {}; this.handlers = new Map(); this.hidden = false; }
    set innerHTML(_value) { assert.fail('Layout names and messages must be rendered as text'); }
    setAttribute(key, value) { this[key] = value; }
    append(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, callback) { this.handlers.set(event, callback); }
    removeEventListener(event, callback) { if (this.handlers.get(event) === callback) this.handlers.delete(event); }
    querySelectorAll() { return []; }
    focus() { this.focused = true; }
    trigger(event) { this.handlers.get(event)?.({ target: this }); }
  }
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const calls = [];
  const services = { layoutsList: async () => ({ ok: true, layouts: [] }), ...api };
  for (const action of ['Save', 'Apply', 'Rename', 'Delete', 'Import', 'Export']) {
    services['layouts' + action] ||= async value => { calls.push([action, clone(value ?? null)]); return { ok: true }; };
  }
  const context = vm.createContext({ window: { i18n: { translations: { en: {} } } },
    document: { getElementById: node, createElement: () => new Element() } });
  vm.runInContext(script, context);
  const controller = context.window.LayoutsSettings.mount({ api: services, ...options });
  return { controller, node, calls, context,
    select(id) { node('layout-select').value = id; node('layout-select').trigger('change'); },
    name(value) { node('layout-name').value = value; node('layout-name').trigger('input'); },
    click(action) { node('layout-' + action).trigger('click'); } };
}

test('an empty library explains saving and disables actions requiring a selection', async () => {
  const f = fixture();
  await tick();
  assert.equal(f.node('layout-empty').hidden, false);
  assert.equal(f.node('layout-select').disabled, true);
  for (const action of ['apply', 'update', 'rename', 'delete', 'export']) assert.equal(f.node('layout-' + action).disabled, true);
  assert.equal(f.node('layout-save').disabled, true);
  assert.equal(f.node('layout-startup').disabled, false, 'Last used arrangement remains an available startup choice');
  assert.equal(f.node('layout-startup').value, '');
  f.name('  Exploring  ');
  assert.equal(f.node('layout-save').disabled, false);
  f.name('x'.repeat(81));
  assert.equal(f.node('layout-save').disabled, true);
});

test('startup choice saves independently of the selected layout and never applies it now', async () => {
  const first = sample(), second = sample('trading', 'Trading'), calls = [];
  const f = fixture({ layoutsList: async () => ({ ok: true, layouts: [first, second], startupLayoutId: first.id }),
    layoutsSetStartup: async id => { calls.push(id); return { ok: true, layouts: [first, second], startupLayoutId: id }; } });
  await tick();f.select(first.id);
  assert.equal(f.node('layout-startup').value, first.id);
  f.node('layout-startup').value = second.id;f.node('layout-startup').trigger('change');await tick();
  assert.deepEqual(calls, [second.id]);assert.equal(f.node('layout-startup').value, second.id);
  assert.equal(f.node('layout-select').value, first.id, 'Startup is separate from the Apply/action selection');
  assert.match(f.node('layout-status').textContent, /Startup will use “Trading”/);
  assert.deepEqual(f.calls, [], 'Startup does not invoke Apply');
  f.node('layout-startup').value = '';f.node('layout-startup').trigger('change');await tick();
  assert.deepEqual(calls, [second.id, null]);assert.equal(f.node('layout-startup').value, '');
  assert.match(f.node('layout-status').textContent, /last used arrangement/);
});

test('failed startup saves restore the current choice and broadcasts update its safe text labels', async () => {
  const layout = sample(), f = fixture({ layoutsList: async () => ({ ok: true, layouts: [layout], startupLayoutId: layout.id }),
    layoutsSetStartup: async () => ({ ok: false, message: 'Disk unavailable.' }) });
  await tick();f.node('layout-startup').value = '';f.node('layout-startup').trigger('change');await tick();
  assert.equal(f.node('layout-startup').value, layout.id);assert.equal(f.node('layout-status').textContent, 'Disk unavailable.');
  const renamed = sample(layout.id, '<img src=x>');
  f.controller.receiveConfig({ savedLayouts: [renamed], startupLayoutId: layout.id });
  assert.equal(f.node('layout-startup').children[1].textContent, renamed.name);
  f.controller.receiveConfig({ savedLayouts: [], startupLayoutId: null });
  assert.equal(f.node('layout-startup').value, '');assert.equal(f.node('layout-startup').children.length, 1);
});

test('saving waits for ordinary settings writes and disables duplicate actions until complete', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const calls = [];
  const saved = sample();
  const f = fixture({ layoutsSave: async value => { calls.push(clone(value)); return { ok: true, layouts: [saved], id: saved.id }; } },
    { flushPending: () => waiting });
  await tick();
  f.name('  Exploring  ');
  f.click('save');
  f.click('save');
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(f.node('layout-name').disabled, true);
  release(true);
  await tick();
  assert.deepEqual(calls, [{ name: 'Exploring' }]);
  assert.equal(f.node('layout-select').value, saved.id);
  assert.equal(f.node('layout-name').value, saved.name);
  assert.match(f.node('layout-status').textContent, /Saved “Exploring”/);
  assert.equal(f.node('layout-apply').disabled, false);
});

test('selected layout actions send only the selected ID and requested name', async () => {
  const layout = sample(), calls = [];
  const f = fixture({
    layoutsList: async () => ({ ok: true, layouts: [layout] }),
    layoutsApply: async id => { calls.push(['apply', id]); return { ok: true }; },
    layoutsRename: async value => { calls.push(['rename', clone(value)]); return { ok: true, layouts: [sample(layout.id, value.name)] }; },
    layoutsSave: async value => { calls.push(['update', clone(value)]); return { ok: true, layouts: [sample(layout.id, value.name)] }; },
    layoutsExport: async id => { calls.push(['export', id]); return { ok: true }; },
  });
  await tick();
  f.select(layout.id);
  assert.match(f.node('layout-summary').textContent, /Widgets: 2 · Open panels: 1 · Bar: left/);
  f.click('apply'); await tick();
  assert.match(f.node('layout-status').textContent, /Applied “Exploring”/);
  f.name('Trading');
  f.click('rename'); await tick();
  f.click('update'); await tick();
  f.click('export'); await tick();
  assert.deepEqual(calls, [['apply', 'exploring'], ['rename', { id: 'exploring', name: 'Trading' }],
    ['update', { id: 'exploring', name: 'Trading' }], ['export', 'exploring']]);
});

test('import selects a saved layout without applying and renders arbitrary names safely', async () => {
  const layout = sample('imported', '<img src=x onerror=alert(1)>');
  const f = fixture({ layoutsImport: async () => ({ ok: true, layouts: [layout], id: layout.id }) });
  await tick();
  f.click('import'); await tick();
  assert.deepEqual(f.calls, [], 'Import never invokes the apply endpoint');
  assert.equal(f.node('layout-name').value, layout.name);
  assert.equal(f.node('layout-select').children[1].textContent, layout.name);
  assert.equal(f.node('layout-status').textContent, `Imported “${layout.name}”. Choose Apply to use it.`);
});

test('deleting requires inline confirmation and leaves the current arrangement alone', async () => {
  const layout = sample(), calls = [];
  const f = fixture({ layoutsList: async () => ({ ok: true, layouts: [layout] }),
    layoutsDelete: async id => { calls.push(id); return { ok: true, layouts: [] }; } });
  await tick();
  f.select(layout.id); f.click('delete');
  assert.deepEqual(calls, []);
  assert.equal(f.node('layout-delete-prompt').hidden, false);
  assert.equal(f.node('layout-delete-confirm').focused, true);
  assert.match(f.node('layout-delete-question').textContent, /Exploring/);
  f.click('delete-cancel');
  assert.equal(f.node('layout-delete-prompt').hidden, true);
  f.click('delete'); f.click('delete-confirm'); await tick();
  assert.deepEqual(calls, [layout.id]);
  assert.equal(f.node('layout-select').value, '');
  assert.match(f.node('layout-status').textContent, /current arrangement is unchanged/);
});

test('failed writes keep the library and draft name available, and canceled dialogs do not report success', async () => {
  const layout = sample();
  const f = fixture({ layoutsList: async () => ({ ok: true, layouts: [layout] }),
    layoutsRename: async () => ({ ok: false, message: 'Names must be unique.' }),
    layoutsImport: async () => ({ ok: true, canceled: true }) });
  await tick(); f.select(layout.id); f.name('Duplicate');
  f.click('rename'); await tick();
  assert.equal(f.node('layout-name').value, 'Duplicate');
  assert.equal(f.node('layout-select').children[1].textContent, 'Exploring');
  assert.equal(f.node('layout-status').textContent, 'Names must be unique.');
  assert.equal(f.node('layout-status').dataset.error, 'true');
  f.click('import'); await tick();
  assert.equal(f.node('layout-status').textContent, '');
  assert.equal(f.node('layout-import').disabled, false);
});

test('pending-setting failure prevents applying or capturing a layout', async () => {
  const layout = sample();
  const f = fixture({ layoutsList: async () => ({ ok: true, layouts: [layout] }) }, { flushPending: async () => false });
  await tick(); f.select(layout.id);
  f.click('apply'); await tick();
  assert.deepEqual(f.calls, []);
  assert.match(f.node('layout-status').textContent, /Save your other settings/);
  f.click('save'); await tick();
  assert.deepEqual(f.calls, []);
});

test('a late initial read cannot replace a newer configuration, while edits survive unrelated broadcasts', async () => {
  let resolveList;
  const f = fixture({ layoutsList: () => new Promise(resolve => { resolveList = resolve; }) });
  f.controller.receiveConfig({ savedLayouts: [sample()], language: 'en' });
  resolveList({ ok: true, layouts: [sample('old', 'Old result')] });
  await tick();
  assert.equal(f.node('layout-select').children[1].textContent, 'Exploring');
  f.select('exploring'); f.name('New name draft');
  f.controller.receiveConfig({ savedLayouts: [sample()], dockEdge: 'right' });
  assert.equal(f.node('layout-name').value, 'New name draft');
  f.controller.receiveConfig({ savedLayouts: [] });
  assert.equal(f.node('layout-apply').disabled, true);
  assert.equal(f.node('layout-delete-prompt').hidden, true);
});

test('load errors offer retry and disposal ignores late responses and removes listeners', async () => {
  let attempts = 0;
  const f = fixture({ layoutsList: async () => ++attempts === 1 ? { ok: false, message: 'Read failed.' } : { ok: true, layouts: [] } });
  await tick();
  assert.equal(f.node('layout-retry').hidden, false);
  assert.equal(f.node('layout-save').disabled, true);
  f.click('retry'); await tick();
  assert.equal(f.node('layout-retry').hidden, true);
  f.controller.dispose();
  assert.equal(f.node('layout-save').handlers.size, 0);
  f.controller.receiveConfig({ savedLayouts: [sample()] });
  assert.equal(f.node('layout-select').children.length, 1);
});
