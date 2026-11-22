'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_LAYOUT, offerStartupLayout, restoreStartupSavedLayout } = require('../src/modules/startupLayout');

const preset = { id: 'test-layout', description: 'World Watch and minimap together.',
  config: { layoutMode: 'grid', widgetVisibility: { 'world-watch': true, minimap: true },
    gridLayout: { columns: [{ widgets: ['world-watch', 'minimap'] }] } } };
function fixture(values = {}, isFirstRun = true, response = 0) {
  const state = { ...values }, calls = [];
  return { state, calls,
    options: { preset, config: { isFirstRun, get: (key, fallback) => state[key] ?? fallback,
      getAll: () => ({ ...state }), set: (key, value) => { state[key] = value; }, setMany: values => Object.assign(state, values) },
      dialog: { showMessageBox: async options => { calls.push(options); return { response }; } },
      onApply: () => calls.push('apply'), onCustomize: () => calls.push('custom') } };
}

test('the undecided default preset leaves profiles and startup untouched', async () => {
  assert.equal(DEFAULT_LAYOUT, null);
  const f = fixture(); delete f.options.preset;
  assert.equal(await offerStartupLayout(f.options), 'unconfigured');
  assert.deepEqual(f.state, {}); assert.deepEqual(f.calls, []);
});

test('a configured first-open choice applies the complete preset only after accepting', async () => {
  const f = fixture({ language: 'de', backgroundOpacity: 80 });
  assert.equal(await offerStartupLayout(f.options), 'applied');
  assert.deepEqual(f.state.widgetVisibility, preset.config.widgetVisibility);
  assert.deepEqual(f.state.gridLayout, preset.config.gridLayout);
  assert.equal(f.state.language, 'de'); assert.equal(f.state.backgroundOpacity, 80);
  assert.equal(f.state.startupLayoutPending, false); assert.equal(f.state.startupLayoutChoice, preset.id);
  assert.equal(f.calls[1], 'apply'); assert.equal(f.calls[0].cancelId, 2);
  assert.equal(await offerStartupLayout(f.options), 'skipped'); assert.equal(f.calls.length, 2);
});

test('choosing widgets opens the picker without applying a default layout', async () => {
  const f = fixture({}, true, 1);
  assert.equal(await offerStartupLayout(f.options), 'custom');
  assert.deepEqual(f.state, { startupLayoutPending: false, startupLayoutChoice: 'custom' });
  assert.equal(f.calls[1], 'custom');
});

test('dismissal defers the choice to a later launch without changing the layout', async () => {
  const f = fixture({}, true, 2);
  assert.equal(await offerStartupLayout(f.options), 'deferred');
  assert.deepEqual(f.state, { startupLayoutPending: true });
  const reopened = fixture(f.state, false, 0);
  assert.equal(await offerStartupLayout(reopened.options), 'applied');
});

test('existing profiles and layouts selected while the dialog was open are preserved', async () => {
  for (const [values, firstRun] of [[{ widgetVisibility: {} }, true], [{ layoutMode: 'free' }, true], [{ widgetBounds_minimap: {} }, true], [{ language: 'en' }, false]]) {
    const f = fixture(values, firstRun);
    assert.equal(await offerStartupLayout(f.options), 'skipped');
    assert.deepEqual(f.state, values); assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.options.dialog.showMessageBox = async () => { f.state.widgetVisibility = { weather: true }; return { response: 0 }; };
  assert.equal(await offerStartupLayout(f.options), 'skipped');
  assert.deepEqual(f.state.widgetVisibility, { weather: true });
  assert.equal(f.calls.length, 0);
});

test('startup keeps the last arrangement unless a named layout was explicitly chosen', async () => {
  const f = fixture({ widgetVisibility: { clock: true }, widgetBounds_clock: { x: 50, y: 60, width: 300, height: 90 } });
  const before = structuredClone(f.state);
  assert.equal(await restoreStartupSavedLayout(f.options), 'last-used');
  assert.deepEqual(f.state, before); assert.deepEqual(f.calls, []);
});

test('a chosen saved layout restores once from validated arrangement data without prompting', async () => {
  const f = fixture({ startupLayoutId: 'exploring', savedLayouts: [{ id: 'exploring', name: 'Exploring',
    layout: { dockEdge: 'top', widgetVisibility: { minimap: true }, widgetSizes: { minimap: { width: 432, height: 408 } } } }] });
  const applied = [];
  f.options.onApply = layout => { applied.push(layout); return true; };
  assert.equal(await restoreStartupSavedLayout(f.options), 'restored');
  assert.equal(applied.length, 1); assert.equal(applied[0].dockEdge, 'top');
  assert.deepEqual(applied[0].widgetSizes.minimap, { width: 432, height: 408 });
  assert.deepEqual(f.calls, [], 'The legacy first-open dialog is never involved');
});

test('stale selections, invalid saved records and failed restores retain the persisted space', async () => {
  for (const savedLayouts of [[], [{ id: 'exploring', name: 'Bad', layout: { widgetBounds: { minimap: { width: -1 } } } }]]) {
    const f = fixture({ startupLayoutId: 'exploring', savedLayouts });
    const before = structuredClone(f.state);
    assert.equal(await restoreStartupSavedLayout(f.options), 'missing');
    assert.deepEqual(f.state, before); assert.deepEqual(f.calls, []);
  }
  for (const result of [false, { ok: false }, Promise.reject(new Error('Unavailable display'))]) {
    const f = fixture({ startupLayoutId: 'exploring', savedLayouts: [{ id: 'exploring', name: 'Exploring', layout: {} }] });
    const before = structuredClone(f.state);
    f.options.onApply = () => result;
    assert.equal(await restoreStartupSavedLayout(f.options), 'failed');
    assert.deepEqual(f.state, before);
  }
});
