'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const payload = (displays = [11, 22], selectedDisplayId = 11, extra = {}) => ({
  displays: displays.map((id, index) => ({ id, label: 'Monitor ' + id, primary: index === 0, bounds: { x: index * 1920, y: 0, width: 1920, height: 1080 } })),
  selectedDisplayId, ...extra,
});
function fixture({ save = async () => true, getDisplays, initial = { dockDisplayId: 11 } } = {}) {
  const nodes = new Map(), saves = [], listeners = {};
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', disabled: false, dataset: {},
      addEventListener(event, callback) { this[event] = callback; }, replaceChildren(...children) { this.options = children; } });
    return nodes.get(selector);
  };
  const context = vm.createContext({ console, initial,
    setTimeout, clearTimeout,
    document: { querySelector: node, querySelectorAll: () => [], createElement: () => ({}), addEventListener(event, callback) { listeners[event] = callback; } },
    window: { addEventListener() {}, api: {
      saveConfig(patch) { saves.push(JSON.parse(JSON.stringify(patch))); return save(patch); },
      ...(getDisplays ? { getOverlayDisplays: getDisplays } : {}),
    } },
  });
  vm.runInContext(source, context);
  vm.runInContext('renderStatus = loadTranslations = populateLanguageDropdown = () => {}; applyConfigToDOM = renderOverlayDisplays; initialized = true; confirmedConfig = initial; config = {...confirmedConfig}; bindEvents();', context);
  return { node, saves, listeners, run: code => vm.runInContext(code, context), receive(snapshot) { context.snapshot = snapshot; return vm.runInContext('receiveOverlayDisplays(snapshot)', context); } };
}

test('Overlay monitor changes save their native numeric ID through the normal config queue', async () => {
  const f = fixture(); f.receive(payload());
  assert.equal(f.node('#dock-display-select').value, '11');
  assert.equal(f.node('#dock-display-select').disabled, false);
  assert.equal(f.saves.length, 0);
  f.node('#dock-display-select').value = '22'; f.node('#dock-display-select').change(); await turn();
  assert.deepEqual(f.saves, [{ dockDisplayId: 22 }]);
  assert.equal(f.node('#dock-display-select').value, '22');
  assert.equal(f.run("changeOverlayDisplay('no-monitor')"), false);
  assert.equal(f.run("changeOverlayDisplay('33')"), false);
  assert.equal(f.run("changeOverlayDisplay('')"), false);
  assert.equal(f.saves.length, 1);
});

test('the Windows close-focus control saves the destination before Settings closes', async () => {
  let finishSave;
  const f = fixture({ save: () => new Promise(resolve => { finishSave = resolve; }) });
  const row = f.node('#window-close-focus-row');
  for (const platform of ['linux', 'darwin', 'win32']) {
    f.run(`platformSupport = {platform: '${platform}'}; renderPlatformSupport()`);
    assert.equal(row.hidden, platform !== 'win32');
  }
  f.run('let closed = false; window.api.windowClose = () => { closed = true; }');
  const select = f.node('#window-close-focus-select');
  select.value = 'desktop'; select.change();
  f.node('#close-btn').click();
  assert.deepEqual(f.saves, [{ windowCloseFocus: 'desktop' }]);
  assert.equal(f.run('closed'), false);
  finishSave(true); await turn();
  assert.equal(f.run('confirmedConfig.windowCloseFocus'), 'desktop');
  assert.equal(f.run('closed'), true);
});

test('a failed monitor save restores the confirmed selection', async () => {
  const f = fixture({ save: async () => false }); f.receive(payload());
  f.node('#dock-display-select').value = '22'; f.node('#dock-display-select').change(); await turn();
  assert.equal(f.node('#dock-display-select').value, '11');
  assert.equal(f.run('saveFailed'), true);
});

test('hotplug fallbacks do not overwrite the saved monitor and reconnect restores its selection', () => {
  const f = fixture({ initial: { dockDisplayId: 22 } });
  f.receive(payload([11], 11, { preferredDisplayId: 22, usingFallback: true }));
  assert.equal(f.node('#dock-display-select').value, '11');
  assert.match(f.node('#dock-display-hint').textContent, /disconnected/);
  assert.deepEqual(f.saves, []);
  assert.equal(f.run('config.dockDisplayId'), 22);
  f.receive(payload([11, 22], 22, { preferredDisplayId: 22, usingFallback: false }));
  assert.equal(f.node('#dock-display-select').value, '22');
  assert.doesNotMatch(f.node('#dock-display-hint').textContent, /saved monitor is disconnected/);
  assert.deepEqual(f.saves, []);
});

test('hotplug refresh preserves a pending monitor edit and a stale initial display request cannot win', async () => {
  let finishSave, finishLoad;
  const f = fixture({ save: () => new Promise(resolve => { finishSave = resolve; }), getDisplays: () => new Promise(resolve => { finishLoad = resolve; }) });
  const load = f.run('loadOverlayDisplays()');
  f.receive(payload());
  f.node('#dock-display-select').value = '22'; f.node('#dock-display-select').change();
  f.receive(payload([11, 22], 11));
  assert.equal(f.node('#dock-display-select').value, '22');
  finishLoad(payload([11], 11)); await load;
  assert.equal(f.node('#dock-display-select').options.length, 2);
  assert.equal(f.node('#dock-display-select').value, '22');
  finishSave(true); await turn();
  assert.equal(f.node('#dock-display-select').value, '22');
});

test('Settings removes the automatic-update toggle and explains the manual update policy', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.html'), 'utf8');
  assert.doesNotMatch(html, /id="chk-automatic-updates"/);
  assert.doesNotMatch(source, /'chk-automatic-updates'/);
  assert.match(html, /checks for updates on startup\. Download and install when you choose/);
  assert.match(html, /for="dock-display-select"/);
});
