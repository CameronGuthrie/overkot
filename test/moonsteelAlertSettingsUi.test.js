'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/modules/moonsteelAlertSettings');
const script = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture({ save = async () => true, preview = async () => true, initial = {} } = {}) {
  const nodes = new Map(), saves = [], previews = [], timers = new Map();
  let timerId = 0;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', checked: false, textContent: '', hidden: false, disabled: false, dataset: {},
      addEventListener(name, callback) { this[name] = callback; } });
    return nodes.get(selector);
  };
  const context = vm.createContext({ console, initial: model.normalize(initial),
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    document: { querySelector: node, querySelectorAll: selector => selector.startsWith('.moonsteel-') ? [] : [], addEventListener() {} },
    window: { MoonsteelAlertSettings: model, addEventListener() {}, api: {
      saveConfig(patch) { saves.push(plain(patch)); return save(patch); },
      previewMoonsteelAlert(settings) { previews.push(plain(settings)); return preview(settings); },
    } },
  });
  vm.runInContext(script, context);
  vm.runInContext('renderStatus = loadTranslations = populateLanguageDropdown = () => {}; applyConfigToDOM = renderMoonsteelAlertControls; initialized = true; confirmedConfig = {moonsteelAlert:initial}; config = {...confirmedConfig}; bindEvents(); renderMoonsteelAlertControls();', context);
  return { node, saves, previews, timers, run: code => vm.runInContext(code, context), flushTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}

test('Moonsteel controls save complete nested preferences without depending on an open minimap', async () => {
  const f = fixture({ initial: { color: '#123456', monitor: 'all', sound: 'soft' } });
  assert.equal(f.node('#color-moonsteel-alert').value, '#123456');
  assert.match(f.node('#moonsteel-detection-hint').textContent, /minimap closed/);
  f.node('#chk-moonsteel-flash').checked = false; f.node('#chk-moonsteel-flash').change(); await turn();
  assert.deepEqual(f.saves, [{ moonsteelAlert: { ...model.normalize({ color: '#123456', monitor: 'all', sound: 'soft' }), flashEnabled: false } }]);
  assert.equal(f.node('#chk-moonsteel-flash').checked, false);
  assert.equal(f.node('#moonsteel-sound-select').value, 'soft');
});

test('debounced sliders preserve an explicit zero and flush their latest combined settings', async () => {
  const f = fixture();
  f.node('#slider-moonsteel-opacity').value = '0'; f.node('#slider-moonsteel-opacity').input();
  f.node('#slider-moonsteel-volume').value = '0'; f.node('#slider-moonsteel-volume').input();
  assert.equal(f.node('#moonsteel-opacity-value').textContent, '0%');
  assert.equal(f.node('#moonsteel-volume-value').textContent, '0%');
  assert.equal(f.node('#btn-test-moonsteel-alert').disabled, true, 'Zero intensity and zero volume have no output to preview');
  assert.equal(f.saves.length, 0); assert.equal(f.timers.size, 1);
  f.flushTimers(); await turn();
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].moonsteelAlert.opacity, 0);
  assert.equal(f.saves[0].moonsteelAlert.volume, 0);
});

test('Moonsteel edits queued during an in-flight save retain both changes', async () => {
  const finishes = [], f = fixture({ save: () => new Promise(resolve => finishes.push(resolve)) });
  f.node('#chk-moonsteel-flash').checked = false; f.node('#chk-moonsteel-flash').change();
  f.node('#color-moonsteel-alert').value = '#aabbcc'; f.node('#color-moonsteel-alert').change();
  assert.equal(f.saves.length, 1);
  finishes.shift()(true); await turn();
  assert.equal(f.saves.length, 2);
  assert.equal(f.saves[1].moonsteelAlert.flashEnabled, false);
  assert.equal(f.saves[1].moonsteelAlert.color, '#aabbcc');
  finishes.shift()(true); await turn();
  assert.equal(f.node('#color-moonsteel-alert').value, '#aabbcc');
  assert.equal(f.node('#chk-moonsteel-flash').checked, false);
});

test('failed Moonsteel saves return controls to the confirmed preferences and external updates render', async () => {
  const f = fixture({ save: async () => false });
  f.node('#color-moonsteel-alert').value = '#112233'; f.node('#color-moonsteel-alert').change(); await turn();
  assert.equal(f.node('#color-moonsteel-alert').value, '#da75ff');
  assert.equal(f.run('saveFailed'), true);
  f.run('receiveConfig({moonsteelAlert:{color:"#abcdef",volume:0,monitor:"cursor"}})');
  assert.equal(f.node('#color-moonsteel-alert').value, '#abcdef');
  assert.equal(f.node('#moonsteel-volume-value').textContent, '0%');
  assert.equal(f.node('#moonsteel-monitor-select').value, 'cursor');
});

test('Moonsteel preview is explicit, supports automatic alerts being off, and reports failure', async () => {
  let finish;
  const f = fixture({ initial: { enabled: false, color: '#abcdef' }, preview: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(f.previews.length, 0);
  const work = f.run('previewMoonsteelAlert()');
  assert.equal(f.previews.length, 1); assert.equal(f.previews[0].enabled, false);
  assert.equal(f.node('#btn-test-moonsteel-alert').disabled, true);
  assert.equal(f.saves.length, 0, 'Trying the alert never changes the automatic alert preference');
  finish(false); await work;
  assert.equal(f.node('#moonsteel-alert-status').dataset.error, 'true');
  assert.equal(f.node('#btn-test-moonsteel-alert').disabled, false);
});

test('test alert requires a visible flash or audible sound, regardless of the automatic master switch', () => {
  for (const initial of [{ opacity: 0, soundEnabled: false }, { flashEnabled: false, volume: 0 }, { flashEnabled: false, soundEnabled: false }]) {
    const f = fixture({ initial });
    assert.equal(f.node('#btn-test-moonsteel-alert').disabled, true);
    assert.match(f.node('#btn-test-moonsteel-alert').title, /visible flash or audible sound/);
  }
  const f = fixture({ initial: { enabled: false, opacity: 0, volume: 0.5 } });
  assert.equal(f.node('#btn-test-moonsteel-alert').disabled, false);
});
