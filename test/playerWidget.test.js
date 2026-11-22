'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ initialTab, language = 'en' } = {}) {
  const document = { activeElement: null };
  function createElement(tag) {
    const handlers = new Map();
    const element = { tagName: tag, className: '', dataset: {}, attributes: {}, children: [], hidden: false,
      textContent: '', value: '', scrollTop: 0, tabIndex: 0,
      append(...children) { element.children.push(...children); },
      replaceChildren(...children) { element.children = [...children]; },
      setAttribute(key, value) { element.attributes[key] = String(value); },
      addEventListener(type, callback) { handlers.set(type, [...(handlers.get(type) || []), callback]); },
      dispatch(type, details = {}) {
        const event = { target: element, prevented: false, preventDefault() { this.prevented = true; }, ...details };
        for (const listener of handlers.get(type) || []) listener(event);
        return event;
      },
      click() { return element.dispatch('click'); },
      focus() { document.activeElement = element; },
      querySelectorAll(selector) {
        const all = element.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return selector === '*' ? all : selector === '[data-player-heading]'
          ? all.filter(child => child.dataset.playerHeading !== undefined) : [];
      },
    };
    return element;
  }
  document.createElement = createElement;
  const calls = [], mounted = new Map(), api = { marker: 'shared bridge' };
  let resizes = 0, identity = 0;
  const window = {};
  for (const [globalName, id] of [['AccountWalletWidget', 'wallet'], ['StorageCapacityWidget', 'storage'],
    ['EquipmentProgressWidget', 'equipment'], ['SessionGainsWidget', 'session'], ['ActiveBoonsWidget', 'boons']]) {
    window[globalName] = { mount(element, options) {
      calls.push(id);
      assert.equal(options.api, api);
      const input = createElement('input'); element.append(input);
      const record = { element, input, options, language: options.language, destroyed: 0 };
      mounted.set(id, record);
      options.onResize();
      return { setLanguage(locale) { record.language = locale; options.onResize(); }, destroy() { record.destroyed++; } };
    } };
  }
  const context = { window, document, crypto: { randomUUID: () => `identity-${++identity}` },
    TRANSLATIONS: { en: {}, fr: { playerOverview: 'Aperçu', playerEquipment: 'Équipement', playerWallet: 'Bourse' } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/player-widget.js'), 'utf8'), context);
  const element = createElement('div');
  const handle = window.PlayerWidget.mount(element, { api, language, initialTab, onResize() { resizes++; } });
  const root = element.children[0], tabs = root.children[0].children, panels = root.children[1].children;
  return { handle, root, tabs, panels, calls, mounted, document, get resizes() { return resizes; },
    select(id) { tabs.find(tab => tab.attributes['aria-controls'].endsWith(`-${id}-panel`)).click(); },
    mountAgain() { return window.PlayerWidget.mount(createElement('div'), { api }); } };
}

test('Player opens one overview containing wallet and storage without loading other tabs', () => {
  const f = fixture();
  assert.deepEqual(f.calls, ['wallet', 'storage']);
  assert.equal(f.root.dataset.tab, 'overview');
  assert.deepEqual(f.panels.map(panel => panel.hidden), [false, true, true, true]);
  assert.deepEqual(f.tabs.map(tab => tab.attributes['aria-selected']), ['true', 'false', 'false', 'false']);
  assert.deepEqual(f.tabs.map(tab => tab.tabIndex), [0, -1, -1, -1]);
  for (let i = 0; i < f.tabs.length; i++) {
    assert.equal(f.tabs[i].attributes.role, 'tab');
    assert.equal(f.tabs[i].attributes['aria-controls'], f.panels[i].id);
    assert.equal(f.panels[i].attributes['aria-labelledby'], f.tabs[i].id);
  }
  f.handle.destroy();
});

test('tab changes mount once and keep the same controls, search and scroll state', () => {
  const f = fixture(); f.select('equipment');
  const equipment = f.mounted.get('equipment');
  equipment.input.value = 'sword'; equipment.input.focus(); equipment.element.scrollTop = 62;
  f.select('session'); f.select('equipment');
  assert.deepEqual(f.calls, ['wallet', 'storage', 'equipment', 'session']);
  assert.equal(f.mounted.get('equipment'), equipment);
  assert.equal(equipment.input.value, 'sword');
  assert.equal(equipment.element.scrollTop, 62);
  assert.equal(f.document.activeElement, equipment.input);
  assert.equal(f.mounted.get('session').destroyed, 0);
  f.handle.destroy();
});

test('keyboard navigation wraps and Home/End select and focus the correct tab', () => {
  const f = fixture();
  assert.equal(f.tabs[0].dispatch('keydown', { key: 'ArrowLeft' }).prevented, true);
  assert.equal(f.root.dataset.tab, 'boons'); assert.equal(f.document.activeElement, f.tabs[3]);
  f.tabs[3].dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(f.root.dataset.tab, 'overview'); assert.equal(f.document.activeElement, f.tabs[0]);
  f.tabs[0].dispatch('keydown', { key: 'End' }); assert.equal(f.root.dataset.tab, 'boons');
  f.tabs[3].dispatch('keydown', { key: 'Home' }); assert.equal(f.root.dataset.tab, 'overview');
  assert.equal(f.tabs[0].dispatch('keydown', { key: 'a' }).prevented, false);
  f.handle.destroy();
});

test('hidden child updates do not resize the active panel', () => {
  const f = fixture(); f.select('boons');
  const before = f.resizes;
  f.mounted.get('wallet').options.onResize(); f.mounted.get('storage').options.onResize();
  assert.equal(f.resizes, before);
  f.mounted.get('boons').options.onResize(); assert.equal(f.resizes, before + 1);
  f.handle.destroy();
});

test('language updates mounted children and controls, then applies to later tabs', () => {
  const f = fixture(); f.handle.setLanguage('fr');
  assert.equal(f.tabs[0].textContent, 'Aperçu'); assert.equal(f.tabs[1].textContent, 'Équipement');
  assert.equal(f.mounted.get('wallet').language, 'fr'); assert.equal(f.mounted.get('storage').language, 'fr');
  assert.deepEqual(f.calls, ['wallet', 'storage']);
  f.select('equipment'); assert.equal(f.mounted.get('equipment').language, 'fr');
  assert.equal(f.panels[0].querySelectorAll('[data-player-heading]')[0].textContent, 'Bourse');
  f.handle.destroy();
});

test('initial tab selection is validated and destruction is complete and idempotent', () => {
  const equipmentFirst = fixture({ initialTab: 'equipment' });
  assert.deepEqual(equipmentFirst.calls, ['equipment']);
  equipmentFirst.select('session'); equipmentFirst.select('boons');
  equipmentFirst.handle.destroy(); equipmentFirst.handle.destroy();
  for (const record of equipmentFirst.mounted.values()) assert.equal(record.destroyed, 1);
  const before = equipmentFirst.resizes;
  equipmentFirst.mounted.get('boons').options.onResize(); equipmentFirst.select('overview'); equipmentFirst.handle.setLanguage('fr');
  assert.equal(equipmentFirst.resizes, before); assert.deepEqual(equipmentFirst.calls, ['equipment', 'session', 'boons']);
  const fallback = fixture({ initialTab: 'unknown' }); assert.equal(fallback.root.dataset.tab, 'overview'); fallback.handle.destroy();
});
