'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const encryption = require('../src/modules/fileEncryption');
const { dailyAffiliationProgress } = require('../src/modules/affiliationProgress');

test('daily affiliation and Ode caps scale with the inventory rank and retain separate balances', () => {
  const inventory = { PlayerLevel: 21, DailyAffiliation: 51000, DailyAffiliationOde: 12000, AccountId: 'private-account' };
  assert.deepEqual(dailyAffiliationProgress(inventory), { earned: 0, remaining: 51000, cap: 51000 });
  assert.deepEqual(dailyAffiliationProgress(inventory, 'DailyAffiliationOde'), { earned: 39000, remaining: 12000, cap: 51000 });
  assert.deepEqual(dailyAffiliationProgress({ PlayerLevel: 0, DailyAffiliation: 0 }), { earned: 30000, remaining: 0, cap: 30000 });
  assert.equal(dailyAffiliationProgress({ ...inventory, PlayerLevel: 22 }).cap, 52000);
  assert.doesNotMatch(JSON.stringify(dailyAffiliationProgress(inventory)), /private-account/);
});

test('missing rank or an inconsistent limit preserves exact remaining without inventing earned progress', () => {
  for (const PlayerLevel of [undefined, null, -1, 1.5, '21', Infinity, 65536]) {
    assert.deepEqual(dailyAffiliationProgress({ PlayerLevel, DailyAffiliation: 51000 }), { earned: null, remaining: 51000, cap: null });
  }
  assert.deepEqual(dailyAffiliationProgress({ PlayerLevel: 21, DailyAffiliation: 80000 }), { earned: null, remaining: 80000, cap: null });
  for (const DailyAffiliation of [undefined, null, -1, 0.5, '500', Infinity, NaN]) {
    assert.equal(dailyAffiliationProgress({ PlayerLevel: 21, DailyAffiliation }), null);
  }
  assert.equal(dailyAffiliationProgress(null), null);
  assert.equal(dailyAffiliationProgress({ DailyAffiliation: 5 }, 'AccountId'), null);
});

test('updated game coefficients change the cap, while unreadable rules preserve remaining alone', () => {
  const inventory = { PlayerLevel: 10, DailyAffiliation: 40000 };
  assert.deepEqual(dailyAffiliationProgress(inventory, 'DailyAffiliation', { schema: 1, base: 35000, perRank: 2000 }),
    { earned: 15000, remaining: 40000, cap: 55000 });
  for (const rules of [null, {}, { schema: 2, base: 35000, perRank: 2000 }, { schema: 1, base: 30000, perRank: '1000' }]) {
    assert.deepEqual(dailyAffiliationProgress(inventory, 'DailyAffiliation', rules), { earned: null, remaining: 40000, cap: null });
  }
});

function pollerFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-affiliation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'inventory-cache.json');
  const source = path.join(__dirname, '../src/modules/inventoryPoller.js');
  const realRequire = createRequire(source);
  const commonjs = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module: commonjs, console, Date, setTimeout, clearTimeout,
    require(name) {
      if (name === './appPaths') return { INVENTORY_CACHE_PATH: filename };
      if (name === './apiClient') return { ApiClient: class {} };
      return realRequire(name);
    },
  });
  return { ...commonjs.exports, filename };
}

test('live polling and startup/account cache restores recompute obsolete earned totals from raw balances', t => {
  const { InventoryPoller, loadCachedTimers, filename } = pollerFixture(t);
  const rawInventory = { PlayerLevel: 21, DailyAffiliation: 50000, DailyAffiliationOde: 51000 };
  fs.writeFileSync(filename, encryption.encryptData(JSON.stringify({ accountId: 'player-a', rawInventory,
    dailyAffiliation: 0, dailyAffiliationOde: 16000, savedAt: 12345 }), encryption.deriveCacheKey()));
  const startup = loadCachedTimers();
  assert.deepEqual(startup.dailyAffiliation, { earned: 1000, remaining: 50000, cap: 51000 });
  const restored = new InventoryPoller('player-a', 'fixture');
  assert.deepEqual(restored.getDailyAffiliation(), startup.dailyAffiliation);
  assert.deepEqual(restored.getDailyAffiliationOde(), { earned: 0, remaining: 51000, cap: 51000 });
  assert.equal(restored.getInventorySavedAt(), 12345);
  assert.equal(new InventoryPoller('player-b', 'fixture').getDailyAffiliation(), null);
  restored._processInventory({ ...rawInventory, PlayerLevel: 22, DailyAffiliation: 40000, DailyAffiliationOde: 0 });
  assert.deepEqual(restored.getDailyAffiliation(), { earned: 12000, remaining: 40000, cap: 52000 });
  assert.deepEqual(restored.getDailyAffiliationOde(), { earned: 52000, remaining: 0, cap: 52000 });
  assert.deepEqual(loadCachedTimers().dailyAffiliation, restored.getDailyAffiliation());
  restored._processInventory({ PlayerLevel: 22 });
  assert.equal(restored.getDailyAffiliation(), null);
  assert.equal(restored.getDailyAffiliationOde(), null);
});

test('legacy caches without raw balances cannot restore invented affiliation progress', t => {
  const { InventoryPoller, loadCachedTimers, filename } = pollerFixture(t);
  fs.writeFileSync(filename, encryption.encryptData(JSON.stringify({ accountId: 'player-a', dailyAffiliation: 15000,
    dailyAffiliationOde: 10000 }), encryption.deriveCacheKey()));
  assert.equal(loadCachedTimers().dailyAffiliation, null);
  assert.equal(new InventoryPoller('player-a', 'fixture').getDailyAffiliationOde(), null);
});

function rendererFixture() {
  const context = vm.createContext({ console, esc: value => String(value) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/widget-data.js'), 'utf8'), context);
  const classes = new Set();
  const content = { innerHTML: '' }, empty = { textContent: '', classList: { add: k => classes.add(k), remove: k => classes.delete(k) } };
  const mod = { querySelector: selector => selector === '.widget-empty' ? empty : content,
    classList: { add() {}, remove() {} } };
  return { context, content, classes, mod };
}

test('affiliation and Ode render the dynamic allowance and exact remaining balance', () => {
  const { context, content, classes, mod } = rendererFixture();
  const normal = dailyAffiliationProgress({ PlayerLevel: 21, DailyAffiliation: 25500 });
  context.renderAffiliationWidget(mod, normal, {}, null);
  assert.match(content.innerHTML, /25,500 \/ 51,000/);
  assert.match(content.innerHTML, /25,500 remaining/);
  assert.match(content.innerHTML, /50%/);
  assert.equal(classes.has('hidden'), true);
  context.renderOdeInfamyWidget(mod, [{ tag: 'OdeSyndicate', standing: 3000 }], {}, null, {},
    dailyAffiliationProgress({ PlayerLevel: 21, DailyAffiliationOde: 0 }, 'DailyAffiliationOde'));
  assert.match(content.innerHTML, /51,000 \/ 51,000/);
  assert.match(content.innerHTML, /0 remaining/);
  assert.match(content.innerHTML, /100%/);
  assert.doesNotMatch(content.innerHTML, /16,000/);
});

test('unknown caps show remaining without a fabricated bar, and absent progress clears the old display', () => {
  const { context, content, classes, mod } = rendererFixture();
  context.renderAffiliationWidget(mod, dailyAffiliationProgress({ DailyAffiliation: 80000 }), {}, null);
  assert.match(content.innerHTML, /80,000 remaining/);
  assert.match(content.innerHTML, /Daily cap unavailable/);
  assert.doesNotMatch(content.innerHTML, /timer-bar|NaN|100%/);
  context.renderAffiliationWidget(mod, dailyAffiliationProgress({ DailyAffiliation: 80000 }),
    { affiliationDailyCapUnavailable: 'Limite <inconnue>' }, null);
  assert.match(content.innerHTML, /Limite &lt;inconnue&gt;/);
  assert.doesNotMatch(content.innerHTML, /Daily cap unavailable/);
  context.renderAffiliationWidget(mod, null, {}, null);
  assert.equal(content.innerHTML, ''); assert.equal(classes.has('hidden'), false);
});

test('switching a widget language updates each timer and standing empty state, including English fallback', () => {
  const renderer = path.join(__dirname, '../src/renderer');
  const script = fs.readFileSync(path.join(renderer, 'widget-host.js'), 'utf8');
  const markup = fs.readFileSync(path.join(renderer, 'widget-host.html'), 'utf8');
  const en = require('../langs/en.json'), uk = require('../langs/uk.json');
  const keys = { boss: 'noBossTimers', crafting: 'noCraftingTimers', other: 'noOtherTimers',
    affiliation: 'noAffiliationData', factions: 'noFactionData', odeinfamy: 'noOdeInfamyData' };
  for (const [id, key] of Object.entries(keys)) {
    const section = markup.split('data-widget="' + id + '"')[1].split('data-widget="')[0];
    assert.ok(section.includes('data-i18n="' + key + '"'), id);
    const empty = { dataset: { i18n: key }, textContent: en[key] };
    const widget = { setAttribute() {}, querySelector: () => null, querySelectorAll: selector => selector === '[data-i18n]' ? [empty] : [] };
    const context = vm.createContext({ WIDGET_ID: id, TRANSLATIONS: { en }, t: uk, document: { querySelector: () => widget } });
    vm.runInContext(script.slice(script.indexOf('function applyTranslations()'), script.indexOf('function render()')), context);
    context.applyTranslations();
    assert.equal(empty.textContent, uk[key], id);
    context.t = {};
    context.applyTranslations();
    assert.equal(empty.textContent, en[key], id);
  }
});
