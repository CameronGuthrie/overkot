'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settingsSource = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
const widgetSource = fs.readFileSync(path.join(__dirname, '../src/renderer/widget-host.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));

function timers() {
  const pending = new Map(), cleared = [];
  let nextId = 1;
  return { pending, cleared,
    setTimeout(callback) { const id = nextId++; pending.set(id, callback); return id; },
    clearTimeout(id) { cleared.push(id); pending.delete(id); },
    run() { for (const [id, callback] of [...pending]) { pending.delete(id); callback(); } },
  };
}

function settings(save = async () => true) {
  const saves = [], clock = timers();
  const context = vm.createContext({ URLSearchParams,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    document: { addEventListener() {} },
    window: { api: { saveConfig: patch => { saves.push(plain(patch)); return save(patch); } } },
  });
  vm.runInContext(settingsSource, context);
  vm.runInContext('renderStatus = loadTranslations = populateLanguageDropdown = applyConfigToDOM = () => {}; initialized = true; confirmedConfig = {dockEdge:"bottom", dockAutoHide:false}; config = {...confirmedConfig};', context);
  return { context, saves, clock, run: code => vm.runInContext(code, context) };
}

test('layout operations can flush unchanged settings without writes and cannot flush an uninitialised hub', async () => {
  const f = settings();
  assert.equal(await f.run('flushPendingSettings()'), true);
  assert.equal(f.saves.length, 0);
  f.run('initialized = false');
  assert.equal(await f.run('flushPendingSettings()'), false);
  assert.equal(f.saves.length, 0);
});

test('layout flush cancels slider debounce timers and persists their deferred edits before succeeding', async () => {
  const f = settings();
  f.run('queueConfig({dockAutoHide:true, dungeonMapBackgroundOpacity:73}, true); sliderTimers.set("dungeonMapBackgroundOpacity", setTimeout(() => { void saveConfig(); }, 30));');
  assert.equal(f.saves.length, 0);
  assert.equal(f.clock.pending.size, 1);
  assert.equal(await f.run('flushPendingSettings()'), true);
  assert.deepEqual(f.saves, [{ dockAutoHide: true, dungeonMapBackgroundOpacity: 73 }]);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.clock.cleared.length, 1);
  assert.equal(f.run('sliderTimers.size'), 0);
  assert.equal(f.run('pendingConfig.size'), 0);
  assert.equal(f.run('confirmedConfig.dockAutoHide'), true);
});

test('layout flush waits for an active save and for deferred edits queued during that save', async () => {
  const completions = [];
  const f = settings(() => new Promise(resolve => completions.push(resolve)));
  f.run('queueConfig({dockEdge:"left"})');
  assert.deepEqual(f.saves, [{ dockEdge: 'left' }]);
  f.run('queueConfig({dockAutoHide:true}, true)');
  let finished = false;
  const pending = f.run('flushPendingSettings()').then(value => { finished = true; return value; });
  await turn();
  assert.equal(finished, false, 'An in-flight write must finish before layout capture/apply can proceed');
  completions.shift()(true);
  await turn();
  assert.deepEqual(f.saves, [{ dockEdge: 'left' }, { dockAutoHide: true }]);
  assert.equal(finished, false, 'The edit queued during the first write must also persist');
  completions.shift()(true);
  assert.equal(await pending, true);
  assert.equal(f.run('pendingConfig.size'), 0);
  assert.equal(f.run('saving'), false);
  assert.equal(f.run('configSaveWaiters.size'), 0);
});

test('simultaneous layout flush callers all wait for the same active write', async () => {
  let complete;
  const f = settings(() => new Promise(resolve => { complete = resolve; }));
  f.run('queueConfig({dockEdge:"right"})');
  const first = f.run('flushPendingSettings()'), second = f.run('flushPendingSettings()');
  await turn();
  assert.equal(f.run('configSaveWaiters.size'), 2);
  complete(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.saves.length, 1);
  assert.equal(f.run('configSaveWaiters.size'), 0);
});

test('failed writes make layout flush fail and restore confirmed settings, including an already-active failure', async () => {
  for (const mode of ['false', 'reject', 'active']) {
    let complete;
    const f = settings(mode === 'false' ? async () => false : mode === 'reject'
      ? async () => { throw new Error('Settings unavailable'); }
      : () => new Promise(resolve => { complete = resolve; }));
    f.run(`queueConfig({dockEdge:"left"}, ${mode !== 'active'})`);
    const pending = f.run('flushPendingSettings()');
    if (mode === 'active') { await turn(); complete(false); }
    assert.equal(await pending, false, mode);
    assert.equal(f.run('config.dockEdge'), 'bottom');
    assert.equal(f.run('confirmedConfig.dockEdge'), 'bottom');
    assert.equal(f.run('pendingConfig.size'), 0);
    assert.equal(f.run('saveFailed'), true);
    assert.equal(f.run('saving'), false);
    assert.equal(f.run('configSaveWaiters.size'), 0);
  }
});

function widget(id = 'boss', embedded = false) {
  const clock = timers(), frames = [], fitted = [], handle = { style: {} };
  const classes = new Set();
  const body = { style: { maxWidth: '' }, scrollWidth: 1300, clientWidth: 900, scrollHeight: 900,
    classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) } };
  const card = { getBoundingClientRect: () => ({ width: parseFloat(body.style.maxWidth) || 900,
    height: 176.4, right: parseFloat(body.style.maxWidth) || 900, bottom: 176.4 }) };
  const context = vm.createContext({ URLSearchParams,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: callback => frames.push(callback),
    document: { body, addEventListener() {}, getElementById: name => name === 'resize-handle' ? handle : null,
      querySelector: selector => selector.startsWith('.timer-widget') ? card : null },
    window: { location: { search: `?widget=${id}${embedded ? '&embed=1' : ''}` }, outerWidth: 900, innerWidth: 900,
      innerHeight: 600, api: { fitWindowSize: (...size) => fitted.push(size) } },
  });
  vm.runInContext(widgetSource, context);
  return { context, clock, frames, fitted, handle, body,
    run: code => vm.runInContext(code, context),
    restore(bounds) { context.bounds = bounds; vm.runInContext('restoreWidgetLayout(bounds)', context); },
    frame() { frames.shift()?.(); },
    drain() { clock.run(); while (frames.length) frames.shift()(); } };
}

test('applying a layout to a live widget replaces its width cap and survives old and future auto-fit callbacks', () => {
  const f = widget();
  f.run('customWidth = 850; document.body.style.maxWidth = "850px"; fitWindowToContent()');
  f.clock.run();
  assert.equal(f.frames.length, 1, 'An old measurement is already waiting for a paint');
  f.restore({ x: 200, y: 100, width: 420, height: 300 });
  assert.equal(f.run('customWidth'), 420);
  assert.equal(f.body.style.maxWidth, '420px');
  f.drain();
  assert.ok(f.fitted.length >= 2, 'Both old and replacement fit callbacks have run');
  assert.ok(f.fitted.every(([width, height]) => width === 420 && height === 177),
    'Neither a stale measurement nor overflow can restore the previous width');
  f.body.scrollWidth = 2400;
  f.run('fitWindowToContent()');
  f.drain();
  assert.deepEqual(f.fitted.at(-1), [420, 177]);
  assert.equal(f.handle.style.right, '480px');
});

test('successive layout restores cancel stale debounce work and retain only the most recent chosen width', () => {
  const f = widget('world-watch');
  f.restore({ width: 450, height: 300 });
  assert.equal(f.clock.pending.size, 1);
  f.restore({ width: 600, height: 340 });
  assert.equal(f.clock.pending.size, 1);
  f.drain();
  assert.deepEqual(f.fitted, [[600, 177]]);
  assert.equal(f.body.style.maxWidth, '600px');
});

test('minimap and data layouts preserve their native viewport size without requesting content-based resizing', () => {
  for (const id of ['minimap', 'data-inventory', 'data-ee-log']) {
    const f = widget(id);
    f.restore({ width: 640, height: 480 });
    assert.equal(f.run('customWidth'), 640, id);
    assert.equal(f.body.style.maxWidth, '', id);
    assert.equal(f.clock.pending.size, 0, id);
    assert.deepEqual(f.fitted, [], id);
    assert.equal(f.handle.style.right, '0px', id);
    f.run('fitWindowToContent()');
    f.drain();
    assert.deepEqual(f.fitted, [], id);
  }
});

test('embedded cells ignore layout bounds and invalid widths leave live widget sizing unchanged', () => {
  const embedded = widget('boss', true);
  embedded.run('customWidth = 320; document.body.style.maxWidth = "320px"');
  embedded.restore({ width: 800, height: 600 });
  assert.equal(embedded.run('customWidth'), 320);
  assert.equal(embedded.body.style.maxWidth, '320px');
  assert.equal(embedded.clock.cleared.length, 0);
  assert.deepEqual(embedded.fitted, []);
  for (const width of [undefined, null, 0, -1, NaN, Infinity, '420']) {
    const f = widget();
    f.run('customWidth = 320; document.body.style.maxWidth = "320px"');
    f.restore({ width });
    assert.equal(f.run('customWidth'), 320);
    assert.equal(f.body.style.maxWidth, '320px');
    assert.equal(f.clock.pending.size, 0);
    assert.deepEqual(f.fitted, []);
  }
});

test('chosen panel height survives dynamic content and layout restoration, while automatic height follows content', () => {
  const f = widget();
  f.run('config = {widgetSizes:{boss:{width:420,height:301}}}; applyWidgetSizePreferences(); fitWindowToContent()');
  f.drain();
  assert.deepEqual(f.fitted.at(-1), [420, 301]);
  assert.equal(f.body.classList.contains('widget-manual-height'), true);
  f.body.scrollHeight = 4000;
  f.run('fitWindowToContent()'); f.drain();
  assert.deepEqual(f.fitted.at(-1), [420, 301], 'New rows cannot overwrite the fixed height');
  f.restore({width:420,height:301}); f.drain();
  assert.deepEqual(f.fitted.at(-1), [420, 301], 'Restoring a layout keeps its manual axis intent');
  f.run('config = {widgetSizes:{boss:{width:420,height:null}}}; applyWidgetSizePreferences(); fitWindowToContent()');
  f.drain();
  assert.deepEqual(f.fitted.at(-1), [420, 177]);
  assert.equal(f.body.classList.contains('widget-manual-height'), false);
});

test('removing one widget size preference clears its width cap and height without touching unrelated config', () => {
  const f = widget();
  f.run('config = {widgetSizes:{boss:{width:600,height:401}},hideBars:true}; applyWidgetSizePreferences()');
  assert.equal(f.run('customWidth'), 600); assert.equal(f.run('customHeight'), 401);
  f.run('config = {widgetSizes:{},hideBars:true}; applyWidgetSizePreferences()');
  assert.equal(f.run('customWidth'), 0); assert.equal(f.run('customHeight'), 0);
  assert.equal(f.body.style.maxWidth, '');
  assert.equal(f.body.classList.contains('widget-manual-height'), false);
  assert.equal(f.run('config.hideBars'), true);
});
