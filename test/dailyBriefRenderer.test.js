'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const START = Date.parse('2026-11-11T12:00:00Z');

function snapshot(now = START) {
  const date = new Date(now).toISOString().slice(0, 10);
  return { date, resetAt: Date.parse(`${date}T00:00:00Z`) + 86400000, status: 'live', allowanceStatus: 'live',
    updatedAt: now, allowances: { affiliation: 1200, trades: 3 }, playtime: { seconds: 7500, status: 'live', updatedAt: now },
    upcoming: { tuvalkane: { date: '2026-11-12', days: 1, status: 'ready' }, zenith: { date: '2026-11-14', days: 3, status: 'ready' } },
    settings: { autoLogin: true, autoReset: true },
    calendar: { ancestor: 'Bromius', encounterAvailable: true, inventoryReady: true, offers: [{ name: 'Bell blade', price: 25 }] },
    vendors: { stockStatus: 'live', catalogStatus: 'ready', avakot: { items: [
      { name: 'Wandering blade', itemType: '/SF/Weapons/Melee/WanderingBlade', icon: '/SF/Interface/Graphics/Weapons/WanderingBlade.png', price: 100, currency: 'Dracs', expiresAt: now + 60000 },
      { name: 'Old trinket', itemType: '/SF/Items/OldTrinket', price: 2, currency: 'Arcs', expiresAt: now - 1 },
      { name: 'Forever favor', itemType: '/SF/Items/ForeverFavor', price: null, currency: 'Dracs', expiresAt: null },
    ] }, factions: [{ id: 'champions', name: 'Champions', items: [
      { name: 'Champion sword', itemType: '/SF/Weapons/Melee/ChampionSword', price: 500, currency: 'Standing',
        isWeapon: true, quality: 'Noble', requiredRank: 2, eligible: false, rollDate: date, tempers: [{ name: 'Steady guard', icon: 'Braced.webp', count: 2 }], expiresAt: null },
      { name: 'Champion token', itemType: '/SF/Items/ChampionToken', price: 5, currency: 'Standing', isWeapon: false, expiresAt: null },
    ] }] } };
}

function fixture({ value = snapshot(), deferInitial = false, get, refresh, save, translations = {} } = {}) {
  let time = START, identity = 0, resized = 0, unsubscribed = 0, clears = 0, gets = 0, refreshes = 0;
  const timers = new Map(), snapshots = new Set(), saves = [], toggles = [], dismissals = [], initial = deferred(), calendars = [];
  const document = { activeElement: null };
  function createElement(tagName) {
    const handlers = new Map(); let ownText = '';
    const element = { tagName, className: '', dataset: {}, attributes: {}, children: [], hidden: false, disabled: false,
      checked: false, value: '', open: false, scrollTop: 0, tabIndex: 0,
      append(...children) { element.children.push(...children); },
      appendChild(child) { element.children.push(child); return child; },
      replaceChildren(...children) { ownText = ''; element.children = [...children]; },
      setAttribute(name, value) { element.attributes[name] = String(value); },
      addEventListener(type, callback) { handlers.set(type, [...handlers.get(type) || [], callback]); },
      dispatch(type, options = {}) { const event = { target: element, prevented: false, preventDefault() { this.prevented = true; }, ...options };
        for (const handler of handlers.get(type) || []) handler(event); return event; },
      click() { if (!element.disabled) return element.dispatch('click'); },
      focus() { document.activeElement = element; },
      querySelectorAll(selector) {
        const all = element.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return selector === '*' ? all : all.filter(child => selector.startsWith('.') ? child.className.split(/\s+/).includes(selector.slice(1))
          : selector === '[data-countdown]' ? child.dataset.countdown !== undefined : child.tagName === selector);
      },
      querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
    };
    Object.defineProperty(element, 'textContent', { get: () => ownText + element.children.map(child => child.textContent).join(''),
      set(value) { ownText = String(value); element.children = []; } });
    element.classList = { add(name) { element.className += ` ${name}`; },
      remove(name) { element.className = element.className.split(/\s+/).filter(value => value !== name).join(' '); } };
    return element;
  }
  document.createElement = createElement;
  document.createElementNS = (_namespace, tag) => createElement(tag);
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const api = {
    getDailyBrief() { gets++; return deferInitial ? initial.promise : get ? get() : Promise.resolve(copy(value)); },
    refreshDailyBrief() { refreshes++; return refresh ? refresh() : Promise.resolve(copy(value)); },
    onDailyBriefChanged(callback) { snapshots.add(callback); return () => { snapshots.delete(callback); unsubscribed++; }; },
    toggleDockWidget(id) { toggles.push(id); return Promise.resolve(true); },
    dismissDailyBrief() { dismissals.push(true); return Promise.resolve(true); },
    openCalendarSettings() {},
    saveConfig(patch) { saves.push(copy(patch)); return save ? save(patch) : Promise.resolve(true); },
  };
  const window = { CalendarWidget: { mount(element, options) {
    const record = { element, options, destroyed: 0, languages: [] }; calendars.push(record);
    return { destroy() { record.destroyed++; }, setLanguage(locale) { record.languages.push(locale); } };
  } } };
  const context = vm.createContext({ window, document, Date: ClockDate, Intl, TRANSLATIONS: translations, crypto: { randomUUID: () => `daily-fixture-${++identity}` },
    setInterval(callback) { const id = timers.size; timers.set(id, callback); return id; },
    clearInterval(id) { clears++; timers.delete(id); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/modules/gameDataImages.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/item-images.js'), 'utf8'), context);
  window.GameDataImages = context.GameDataImages;
  window.ItemImages = context.ItemImages;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/daily-brief.js'), 'utf8'), context);
  const element = createElement('div');
  const handle = window.DailyBriefWidget.mount(element, { api, onResize() { resized++; } });
  const find = selector => element.querySelector(selector), all = selector => element.querySelectorAll(selector);
  const choice = index => find('.daily-preferences').querySelectorAll('input')[index];
  return { element, handle, document, timers, snapshots, initial, saves, toggles, dismissals, calendars, find, all, choice,
    emit(next) { for (const callback of [...snapshots]) callback(copy(next)); },
    select(id) { all('.daily-tab').find(tab => tab.attributes['aria-controls'].endsWith(`-${id}`)).click(); },
    search(text) { const input = find('.daily-search'); input.value = text; input.dispatch('input'); },
    setChoice(index, checked) { const input = choice(index); input.checked = checked; input.dispatch('change'); },
    advance(milliseconds) { time += milliseconds; for (const callback of [...timers.values()]) callback(); },
    amounts: () => all('.daily-budget').map(card => card.children[1].textContent),
    get resized() { return resized; }, get gets() { return gets; }, get refreshes() { return refreshes; },
    get unsubscribed() { return unsubscribed; }, get clears() { return clears; },
  };
}

test('a newer pushed daily snapshot wins over the first getter response', async () => {
  const f = fixture({ deferInitial: true });
  const newer = snapshot(); newer.allowances.trades = 9; f.emit(newer);
  f.initial.resolve(snapshot()); await tick();
  assert.deepEqual(f.amounts(), ['1,200', '2h 5m', '9']);
  assert.equal(f.find('.daily-error').hidden, true); f.handle.destroy();
});

test('failed initial data can be retried through Refresh', async () => {
  const f = fixture({ get: () => Promise.reject(new Error('Offline')) }); await tick();
  assert.match(f.find('.daily-today-content').textContent, /could not be loaded/);
  assert.equal(f.find('.daily-error').hidden, false);
  f.find('.daily-refresh').click(); await tick();
  assert.equal(f.refreshes, 1); assert.deepEqual(f.amounts(), ['1,200', '2h 5m', '3']);
  assert.equal(f.find('.daily-error').hidden, true); f.handle.destroy();
});

test('vendor updates preserve selected tab, search focus, scroll and expanded groups', async () => {
  const f = fixture(); await tick(); f.select('vendors'); f.search('sword');
  const search = f.find('.daily-search'); search.focus(); f.find('.daily-vendor-list').scrollTop = 47;
  const faction = f.all('.daily-vendor-group')[1]; faction.open = true; faction.dispatch('toggle');
  const updated = snapshot(); updated.vendors.factions[0].items[0].price = 700; f.emit(updated);
  assert.equal(f.find('.daily-search'), search); assert.equal(search.value, 'sword'); assert.equal(f.document.activeElement, search);
  assert.equal(f.find('.daily-vendor-list').scrollTop, 47); assert.equal(f.all('.daily-vendor-group')[1].open, true);
  assert.equal(f.find('.daily-vendors').hidden, false); assert.equal(f.find('.daily-today').hidden, true);
  assert.match(f.find('.daily-vendor-list').textContent, /700 Standing/);
  f.handle.destroy();
});

test('allowances distinguish real zero from omitted values and stale inventory', async () => {
  const value = snapshot(); value.allowances = { affiliation: null }; value.playtime.seconds = 0;
  const f = fixture({ value }); await tick(); assert.deepEqual(f.amounts(), ['—', '0h 0m', '—']);
  const stale = snapshot(); stale.allowanceStatus = 'stale'; f.emit(stale);
  assert.deepEqual(f.amounts(), ['—', '2h 5m', '—']);
  assert.match(f.find('.daily-today-content').textContent, /today’s inventory/);
  const absent = snapshot(); delete absent.allowances; delete absent.playtime; f.emit(absent);
  assert.deepEqual(f.amounts(), ['—', '—', '—']); assert.doesNotMatch(f.element.textContent, /NaN/);
  f.handle.destroy();
});

test('Today prominently names the ancestor, shows future visits and keeps Avakot only in Vendors', async () => {
  const f = fixture(); await tick();
  assert.equal(f.find('.daily-ancestor').textContent, 'Bromius');
  assert.match(f.find('.daily-today-content').textContent, /Total played time/);
  assert.doesNotMatch(f.find('.daily-today-content').textContent, /Ode infamy|Avakot/);
  assert.deepEqual(f.all('.daily-next-encounter').map(row => row.textContent), ['Next TuvalkaneTomorrow', 'Next ZenithIn 3 days']);
  const next = snapshot(); next.upcoming.tuvalkane = { status: 'locked', days: null }; next.upcoming.zenith = { status: 'unavailable' };
  f.emit(next);
  assert.deepEqual(f.all('.daily-next-encounter').map(row => row.textContent), ['Next TuvalkaneNot unlocked', 'Next ZenithUnavailable']);
  f.select('vendors'); assert.match(f.find('.daily-vendor-list').textContent, /Avakot’s Gots/);
  f.handle.destroy();
});

test('Vendors renders real item art and Temper logos beside the corresponding names', async () => {
  const f = fixture(); await tick(); f.select('vendors');
  const item = f.find('.daily-item-icon').querySelector('img');
  assert.equal(item.src, 'overkot-game-data://images/SF/Interface/Graphics/Weapons/WanderingBlade.png');
  const temper = f.find('.daily-temper');
  assert.match(temper.textContent, /Steady guard ×2/);
  assert.equal(temper.querySelector('img'), null, 'legacy renderer input keeps its text placeholder');
  const streamed = snapshot(); streamed.vendors.factions[0].items[0].tempers[0].icon = 'temper-icons/' + 'a'.repeat(64) + '.png';
  f.emit(streamed);
  assert.equal(f.find('.daily-temper').querySelector('img').src, 'overkot-map-tiles://data/temper-icons/' + 'a'.repeat(64) + '.png');
  const unsafe = snapshot(); unsafe.vendors.factions[0].items[0].tempers[0].icon = 'https://untrusted.example/logo.png';
  unsafe.vendors.avakot.items[0].icon = 'https://untrusted.example/item.png'; f.emit(unsafe);
  assert.equal(f.find('.daily-temper').querySelector('img'), null);
  assert.equal(f.find('.daily-item-icon').querySelector('img'), null);
  assert.match(f.find('.daily-temper').textContent, /Steady guard/);
  f.handle.destroy();
});

test('factions show weapons by default and can include other favors or search tempers', async () => {
  const f = fixture(); await tick(); f.select('vendors');
  assert.match(f.find('.daily-vendor-list').textContent, /Champion sword/);
  assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Champion token/);
  assert.match(f.find('.daily-vendor-list').textContent, /Steady guard ×2/);
  const include = f.find('.daily-vendor-controls').querySelectorAll('input')[1]; include.checked = true; include.dispatch('change');
  assert.match(f.find('.daily-vendor-list').textContent, /Champion token/);
  f.search('Steady');
  assert.match(f.find('.daily-vendor-list').textContent, /Champion sword/);
  assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Champion token/);
  f.handle.destroy();
});

test('expired Avakot stock is excluded immediately and removed when its countdown ends', async () => {
  const f = fixture(); await tick(); f.select('vendors');
  assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Old trinket/);
  assert.match(f.find('.daily-vendor-list').textContent, /Wandering blade/);
  assert.match(f.find('.daily-vendor-list').textContent, /Forever favor/);
  assert.equal(f.find('.daily-open-vendors'), null, 'Avakot offers belong only to Vendors');
  f.advance(61000);
  assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Wandering blade/);
  assert.match(f.find('.daily-vendor-group').children[0].textContent, /1/);
  assert.equal(f.refreshes, 0, 'Expiry is a local display update'); f.handle.destroy();
});

test('only weapon rolls for the current UTC day can appear as today’s tempers', async () => {
  const value = snapshot(); value.vendors.factions[0].items[0].rollDate = '2026-11-10';
  const f = fixture({ value }); await tick(); f.select('vendors');
  assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Steady guard/);
  assert.match(f.find('.daily-vendor-list').textContent, /Today’s tempers are unavailable/);
  const previous = snapshot(); previous.date = '2026-11-10'; previous.vendors.factions[0].items[0].rollDate = previous.date;
  f.emit(previous); assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Steady guard/);
  assert.match(f.find('.daily-today-content').textContent, /Updating for the new day/); f.handle.destroy();
});

test('UTC rollover withholds old allowances and rolls, refreshes once, and preserves controls', async () => {
  const loading = deferred(), f = fixture({ refresh: () => loading.promise }); await tick(); f.select('vendors'); f.search('sword');
  const search = f.find('.daily-search'); search.focus();
  f.advance(12 * 3600000);
  assert.equal(f.refreshes, 1); assert.equal(f.find('.daily-search'), search); assert.equal(search.value, 'sword');
  assert.equal(f.document.activeElement, search); assert.deepEqual(f.amounts(), []);
  assert.match(f.find('.daily-date').textContent, /2026-11-12/);
  assert.match(f.find('.daily-reset').textContent, /Updating/);
  assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Steady guard/);
  f.advance(1000); assert.equal(f.refreshes, 1);
  loading.resolve(snapshot(START + 12 * 3600000)); await tick();
  assert.match(f.find('.daily-vendor-list').textContent, /Steady guard/); assert.deepEqual(f.amounts(), ['1,200', '2h 5m', '3']);
  f.handle.destroy();
});

test('Done closes the daily panel through its dedicated dismissal action', async () => {
  const f = fixture(); await tick(); f.find('.daily-done').click();
  assert.deepEqual(f.dismissals, [true]); assert.deepEqual(f.toggles, []); f.handle.destroy();
});

test('changing language updates existing Daily Brief controls, data labels and substitution order', async () => {
  const translations = { 'zh-Hant-TW': {
    dailyVendors: '商人', dailySearchVendor: '搜尋商品', dailyBromius: '布羅米斯',
    dailyInDays: '{days} 天後', dailyPrice: '{currency}：{price}', calendarArcs: '弧幣',
  } };
  const f = fixture({ translations }); await tick();
  f.select('vendors'); f.search('sword');
  const search = f.find('.daily-search'); search.focus();
  f.handle.setLanguage('zh-Hant-TW');
  assert.equal(f.find('.daily-search'), search);
  assert.equal(search.placeholder, '搜尋商品');
  assert.equal(search.attributes['aria-label'], search.placeholder);
  assert.equal(search.value, 'sword');
  assert.equal(f.document.activeElement, search);
  assert.equal(f.all('.daily-tab')[1].textContent, '商人');
  assert.equal(f.find('.daily-ancestor').textContent, '布羅米斯');
  assert.match(f.find('.daily-today-content').textContent, /3 天後/);
  assert.match(f.find('.daily-offer').textContent, /弧幣：25/);
  f.handle.setLanguage('en');
  assert.equal(search.placeholder, 'Search vendor items');
  f.handle.destroy();
});

test('cached vendor catalogues are labelled and waiting stock is distinguished from no connection', async () => {
  const value = snapshot(); value.vendors.catalogStatus = 'cached'; value.vendors.stockStatus = 'waiting'; value.vendors.avakot.items = [];
  const f = fixture({ value }); await tick(); f.select('vendors');
  assert.match(f.find('.daily-vendor-list').textContent, /Saved vendor catalogue/);
  assert.match(f.find('.daily-vendor-list').textContent, /Loading current stock…/);
  assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Connect to Soulframe/);
  value.vendors.stockStatus = 'connect'; f.emit(value);
  assert.match(f.find('.daily-vendor-list').textContent, /Connect to Soulframe/);
  assert.doesNotMatch(f.find('.daily-vendor-list').textContent, /Loading current stock/);
  f.handle.destroy();
});

test('automatic opening changes serialize and preserve false and the newest intent', async () => {
  const first = deferred(), second = deferred(); let calls = 0, concurrent = 0, maxConcurrent = 0;
  const f = fixture({ save: async () => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    const result = await (++calls === 1 ? first.promise : second.promise); concurrent--; return result; } });
  await tick(); f.setChoice(0, false); f.setChoice(1, false); f.setChoice(0, true);
  assert.deepEqual(f.saves, [{ dailyAutoLogin: false }]);
  first.resolve(true); await tick();
  assert.deepEqual(f.saves, [{ dailyAutoLogin: false }, { dailyAutoLogin: true, dailyAutoReset: false }]);
  second.resolve(true); await tick(); assert.equal(maxConcurrent, 1);
  assert.equal(f.choice(0).checked, true); assert.equal(f.choice(1).checked, false); f.handle.destroy();
});

test('a rejected preference save retains intent and its warning through later snapshots', async () => {
  let failed = true;
  const f = fixture({ save: async () => failed ? false : true }); await tick(); f.setChoice(0, false); await tick();
  assert.equal(f.find('.daily-error').hidden, false); assert.match(f.find('.daily-error').textContent, /Could not save/);
  f.emit(snapshot()); assert.equal(f.choice(0).checked, false); assert.match(f.find('.daily-error').textContent, /Could not save/);
  failed = false; f.setChoice(1, false); await tick();
  assert.deepEqual(f.saves.at(-1), { dailyAutoLogin: false, dailyAutoReset: false });
  assert.equal(f.find('.daily-error').hidden, true); f.handle.destroy();
});

test('calendar mounts once, tab keyboard navigation works, and cleanup is idempotent', async () => {
  const f = fixture(); await tick();
  const tabs = f.all('.daily-tab'); assert.equal(tabs[0].dispatch('keydown', { key: 'ArrowLeft' }).prevented, true);
  assert.equal(f.find('.daily-calendar').hidden, false); assert.equal(f.document.activeElement, tabs[2]); assert.equal(f.calendars.length, 1);
  f.select('today'); f.select('calendar'); assert.equal(f.calendars.length, 1);
  f.handle.setLanguage('fr'); assert.deepEqual(f.calendars[0].languages, ['fr']);
  const late = [...f.snapshots][0], oldText = f.element.textContent;
  f.handle.destroy(); f.handle.destroy(); f.handle.setLanguage('de'); late(snapshot()); f.advance(1000);
  assert.equal(f.calendars[0].destroyed, 1); assert.deepEqual(f.calendars[0].languages, ['fr']);
  assert.equal(f.unsubscribed, 1); assert.equal(f.clears, 1); assert.equal(f.timers.size, 0); assert.equal(f.snapshots.size, 0);
  assert.equal(f.element.textContent, oldText);
});

test('destruction ignores a late getter and does not start another refresh', async () => {
  const f = fixture({ deferInitial: true }), oldText = f.element.textContent;
  f.handle.destroy(); f.initial.resolve(snapshot()); await tick();
  f.find('.daily-refresh').click();
  assert.equal(f.gets, 1); assert.equal(f.refreshes, 0); assert.equal(f.element.textContent, oldText);
});
