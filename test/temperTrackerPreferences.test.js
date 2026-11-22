'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeTemperTrackerPreferences: normalize } = require('../src/modules/trackerPreferences');

const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const snapshot = { status: 'live', weaponCount: 1, unreadableWeapons: 0, unreadableTempers: 0, rows: [
  { id: 'first', name: 'Fortified', description: 'Defence', origin: 'Grace', icon: '', unlockCount: 10, unlockTarget: 10, unlocked: true, copies: 1, weaponCount: 1,
    sources: [{ name: 'Vetch', count: 1, stacks: 1 }] },
  { id: 'second', name: 'Swift Strike', description: 'Attack speed', origin: 'Spirit', icon: '', unlockCount: 2, unlockTarget: 10, unlocked: false, copies: 0, weaponCount: 0, sources: [] },
] };

function fixture({ preferences, state, save } = {}) {
  const saves = [], load = deferred(), listeners = new Map();
  let change, unsubscribed = 0;
  const document = { activeElement: null };
  function node(tag) {
    const handlers = new Map();
    const element = { tagName: tag, className: '', dataset: {}, children: [], attributes: {}, value: '', textContent: '', scrollTop: 0,
      classList: { contains(name) { return element.className.split(' ').includes(name); }, add(name) { element.className += ' ' + name; } },
      append(...children) { element.children.push(...children); },
      replaceChildren(...children) { element.children = children; },
      setAttribute(name, value) { element.attributes[name] = value; },
      addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
      dispatch(type) { for (const handler of handlers.get(type) || []) handler({ target: element }); },
      click() { element.dispatch('click'); }, focus() { document.activeElement = element; },
      querySelectorAll(selector) {
        const matches = item => selector.startsWith('.') ? item.classList.contains(selector.slice(1))
          : selector === '[data-temper-id]' ? item.dataset.temperId !== undefined : item.dataset.groupId !== undefined;
        const descendants = element.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return selector === '*' ? descendants : descendants.filter(matches);
      },
      querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
    };
    Object.defineProperty(element, 'options', { get: () => element.children });
    return element;
  }
  document.createElement = node;
  const window = { addEventListener(type, handler) { listeners.set(type, handler); }, removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); } };
  window.GameDataImages = require('../src/modules/gameDataImages');
  window.api = { getState: () => state ? Promise.resolve(state) : load.promise,
    getTemperTracker: () => Promise.resolve(snapshot), onTemperTrackerChanged: callback => { change = callback; return () => { unsubscribed++; }; },
    saveConfig: patch => { saves.push(copy(patch)); return save ? save(patch) : Promise.resolve(true); } };
  const context = vm.createContext({ window, document, TRANSLATIONS: { en: require('../langs/en.json') }, console });
  for (const filename of ['src/modules/trackerPreferences.js', 'src/renderer/temper-tracker.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
  const element = node('div');
  const widget = window.TemperTrackerWidget.mount(element, { api: window.api, preferences });
  const find = cls => element.querySelector('.' + cls);
  const choose = (cls, value, event = 'change') => { const control = find(cls); control.value = value; control.dispatch(event); };
  const visibility = status => element.querySelectorAll('.temper-filter').find(button => button.dataset.hide === status);
  const filter = value => element.querySelectorAll('.temper-filter').find(button => button.dataset.filter === value);
  return { widget, element, saves, load, find, choose, visibility, filter, change: value => change(value), listeners, get unsubscribed() { return unsubscribed; } };
}

test('mount restores persisted view, both grouping choices, visibility, search and collapsed groups', async () => {
  const preferences = normalize({ view: 'weapons', filter: 'all', groupings: { blacksmith: 'origin', weapons: 'name' },
    hiddenStatuses: ['unlocked'], collapsed: ['origin:Spirit'], search: 'Swift' });
  const f = fixture({ state: { config: { temperTrackerPreferences: preferences } } });
  await tick();
  assert.equal(f.find('temper-view-select').value, 'weapons');
  assert.equal(f.find('temper-group-select').value, 'name');
  assert.equal(f.find('temper-search').value, 'Swift');
  assert.equal(f.filter('all').attributes['aria-pressed'], 'true');
  assert.equal(f.visibility('unlocked').attributes['aria-pressed'], 'true');
  f.choose('temper-view-select', 'blacksmith');
  assert.equal(f.find('temper-group-select').value, 'origin');
  assert.equal(f.find('temper-group-head').attributes['aria-expanded'], 'false');
  await tick();
  assert.deepEqual(f.saves.at(-1).temperTrackerPreferences, { ...preferences, view: 'blacksmith' });
  f.widget.destroy();
});

test('each interaction saves preferences and remount restores them without another change', async () => {
  const f = fixture({ preferences: normalize() }); await tick();
  f.visibility('unlocked').click(); await tick();
  f.choose('temper-group-select', 'origin'); await tick();
  f.find('temper-group-head').click(); await tick();
  f.choose('temper-view-select', 'weapons'); await tick();
  f.filter('missing').click(); await tick();
  f.choose('temper-group-select', 'name'); await tick();
  f.choose('temper-search', 'Swift', 'input'); await tick();
  const saved = f.saves.at(-1).temperTrackerPreferences;
  assert.equal(saved.view, 'weapons'); assert.equal(saved.filter, 'missing');
  assert.deepEqual(saved.groupings, { blacksmith: 'origin', weapons: 'name' });
  assert.deepEqual(saved.hiddenStatuses, ['unlocked']); assert.deepEqual(saved.collapsed, ['origin:Spirit']);
  assert.equal(saved.search, 'Swift');
  f.widget.destroy();
  const restored = fixture({ preferences: saved }); await tick();
  assert.equal(restored.find('temper-view-select').value, 'weapons');
  assert.equal(restored.find('temper-group-select').value, 'name');
  assert.equal(restored.find('temper-search').value, 'Swift');
  assert.equal(restored.filter('missing').attributes['aria-pressed'], 'true');
  assert.equal(restored.saves.length, 0);
  restored.widget.destroy();
});

test('late hydration merges early edits without replacing stored fields the user has not changed', async () => {
  const f = fixture(); await tick();
  f.choose('temper-view-select', 'weapons');
  f.choose('temper-group-select', 'weapon');
  f.choose('temper-search', 'Vetch', 'input');
  assert.equal(f.saves.length, 0);
  f.load.resolve({ config: { temperTrackerPreferences: normalize({ view: 'blacksmith', filter: 'all', groupings: { blacksmith: 'name', weapons: 'origin' }, hiddenStatuses: ['incomplete'], collapsed: ['status:unlocked'] }) } });
  await tick();
  assert.deepEqual(f.saves[0].temperTrackerPreferences, { view: 'weapons', filter: 'all', groupings: { blacksmith: 'name', weapons: 'weapon' },
    hiddenStatuses: ['incomplete'], collapsed: ['status:unlocked'], search: 'Vetch' });
  assert.equal(f.find('temper-group-select').value, 'weapon');
  f.widget.destroy();
});

test('pending writes are serialized and coalesced, and stale config echoes do not revert controls', async () => {
  const writes = [], f = fixture({ preferences: normalize(), save: () => { const write = deferred(); writes.push(write); return write.promise; } });
  await tick(); f.visibility('unlocked').click();
  f.choose('temper-view-select', 'weapons'); f.filter('all').click(); f.choose('temper-search', 'Swift', 'input');
  f.widget.setPreferences(normalize());
  assert.equal(f.find('temper-view-select').value, 'weapons');
  assert.equal(f.saves.length, 1);
  writes[0].resolve(true); await tick();
  assert.equal(f.saves.length, 2);
  assert.equal(f.saves[1].temperTrackerPreferences.search, 'Swift');
  assert.equal(f.saves[1].temperTrackerPreferences.filter, 'all');
  writes[1].resolve(true); await tick();
  f.widget.setPreferences(f.saves[1].temperTrackerPreferences); await tick();
  assert.equal(f.saves.length, 2, 'Config echoes do not save again');
  f.widget.destroy();
});

test('destroy removes listeners and ignores late hydration; malformed settings use safe defaults', async () => {
  const f = fixture(); f.widget.destroy(); f.widget.destroy();
  f.load.resolve({ config: { temperTrackerPreferences: { view: 'weapons' } } }); await tick();
  assert.equal(f.unsubscribed, 1); assert.equal(f.listeners.has('unload'), false);
  assert.equal(f.find('temper-view-select').value, 'blacksmith'); assert.equal(f.saves.length, 0);
  const malformed = fixture({ preferences: { view: {}, filter: 'wrong', groupings: 'all', hiddenStatuses: true, collapsed: null, search: [] } });
  await tick(); assert.equal(malformed.find('temper-view-select').value, 'blacksmith');
  assert.equal(malformed.find('temper-group-select').value, 'status'); assert.equal(malformed.find('temper-search').value, '');
  malformed.widget.destroy();
});

test('inventory updates keep settings and do not write configuration', async () => {
  const f = fixture({ preferences: normalize({ search: 'Swift', hiddenStatuses: ['unlocked'], groupings: { blacksmith: 'name' } }) }); await tick();
  f.change({ ...snapshot, status: 'cached', rows: snapshot.rows.map(row => ({ ...row, unlockCount: row.unlockCount + 1 })) });
  assert.equal(f.find('temper-search').value, 'Swift'); assert.equal(f.find('temper-group-select').value, 'name');
  assert.equal(f.visibility('unlocked').attributes['aria-pressed'], 'true'); assert.equal(f.saves.length, 0);
  f.widget.destroy();
});
