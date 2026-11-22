'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/widgets-window.js'), 'utf8');
const english = require('../langs/en.json');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ beta = false, config = {}, translations = {}, save = async () => true } = {}) {
  const nodes = new Map(), events = new Map(), writes = [];
  let onConfig;
  const document = { title: '', documentElement: {}, activeElement: null };
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.events = new Map();
      this.value = ''; this.textContent = ''; this.hidden = false; this.moveCount = 0;
    }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    appendChild(child) {
      if (child.parent) {
        child.parent.children.splice(child.parent.children.indexOf(child), 1);
        if (child.contains(document.activeElement)) document.activeElement = null;
      }
      child.parent = this; this.children.push(child); this.moveCount++;
      return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, callback) { this.events.set(event, callback); }
    focus() { document.activeElement = this; }
    select() {}
    trigger(event) { this.events.get(event)?.({ target: this }); }
  }
  document.querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  document.createElement = tagName => new Element(tagName);
  document.addEventListener = (event, callback) => events.set(event, callback);
  const window = { i18n: { titleTrackerEnabled: beta }, WidgetIcons: { create: () => new Element('svg') }, api: {
    getState: async () => ({ config }), windowClose() {},
    onConfigChanged: callback => { onConfig = callback; },
    saveConfig: async patch => { writes.push(JSON.parse(JSON.stringify(patch))); return save(patch); },
  } };
  const context = vm.createContext({ window, document, TRANSLATIONS: { en: english, ...translations } });
  vm.runInContext(renderer, context);
  events.get('DOMContentLoaded')();
  const groups = () => document.querySelector('#widgets-body').children;
  const cards = group => group.children[1].children;
  const allCards = () => groups().flatMap(cards);
  return { context, document, writes, nodes, groups, cards, allCards,
    definitions: () => Array.from(vm.runInContext('WIDGET_DEFS', context)),
    config: next => onConfig(next),
    search(query) { const input = nodes.get('#widgets-search'); input.value = query; input.trigger('input'); },
    checkbox(id) { return allCards().find(card => card.dataset.widget === id).children.find(child => child.tagName === 'input'); },
  };
}

test('stable and beta pickers group every available widget exactly once with accessible headings', async () => {
  for (const beta of [false, true]) {
    const f = fixture({ beta });
    await tick();
    const definitions = f.definitions();
    const cards = f.allCards();
    assert.equal(f.groups().length, 6);
    assert.equal(cards.length, definitions.length);
    assert.deepEqual(cards.map(card => card.dataset.widget).sort(), definitions.map(def => def.id).sort());
    assert.equal(new Set(cards.map(card => card.dataset.widget)).size, cards.length);
    assert.equal(cards.some(card => card.dataset.widget === 'title-tracker'), beta);
    for (const group of f.groups()) {
      assert.equal(group.attributes['aria-labelledby'], group.children[0].id);
      assert.ok(group.children[0].textContent);
      for (const card of f.cards(group)) {
        const checkbox = f.checkbox(card.dataset.widget);
        assert.ok(checkbox.attributes['aria-labelledby']);
        assert.ok(checkbox.attributes['aria-describedby']);
        assert.equal(checkbox.disabled, false);
      }
    }
  }
});

test('widgets sort alphabetically by their translated display titles within each category', async () => {
  const f = fixture({ config: { language: 'sv' }, translations: { sv: {
    bossTimers: 'Ögon', craftingTimers: 'Ånga', otherTimers: 'Äpple', widgetsCategoryTimers: 'Klockor',
  } } });
  await tick();
  const timers = f.groups().find(group => group.dataset.category === 'timers');
  assert.equal(timers.children[0].textContent, 'Klockor');
  assert.deepEqual(f.cards(timers).map(card => card.dataset.widget), ['crafting', 'other', 'boss']);
  const collator = new Intl.Collator('sv', { sensitivity: 'base', numeric: true });
  for (const group of f.groups()) {
    const titles = f.cards(group).map(card => card.children[1].textContent);
    assert.deepEqual(titles, [...titles].sort((a, b) => collator.compare(a, b)));
  }
});

test('search matches localized titles, descriptions, keywords and categories while hiding empty groups', async () => {
  const f = fixture({ config: { language: 'sv', widgetVisibility: { minimap: true, boss: true } },
    translations: { sv: { widgetsCategoryTimers: 'Klockor', bossTimers: 'Ögon' } } });
  await tick();
  f.search('klockor');
  assert.deepEqual(f.groups().filter(group => !group.hidden).map(group => group.dataset.category), ['timers']);
  assert.equal(f.allCards().filter(card => !card.hidden).length, 3);
  f.search('ögon');
  assert.deepEqual(f.allCards().filter(card => !card.hidden).map(card => card.dataset.widget), ['boss']);
  f.search('transparent overlay rooms');
  assert.deepEqual(f.allCards().filter(card => !card.hidden).map(card => card.dataset.widget), ['minimap']);
  f.search('no such widget for this search');
  assert.equal(f.groups().every(group => group.hidden), true);
  assert.equal(f.nodes.get('#widgets-empty').hidden, false);
  f.search('');
  assert.equal(f.groups().every(group => !group.hidden), true);
  assert.match(f.nodes.get('#widgets-count').textContent, /^2 \/ 30 selected$/);
});

test('selection saves preserve hidden choices and future widget IDs without moving keyboard focus', async () => {
  const f = fixture({ config: { widgetVisibility: { minimap: true, future: true } } });
  await tick();
  f.search('boss');
  const checkbox = f.checkbox('boss');
  checkbox.focus(); checkbox.checked = true; checkbox.trigger('change');
  await tick();
  assert.deepEqual(f.writes, [{ widgetVisibility: { minimap: true, future: true, boss: true } }]);
  assert.equal(f.document.activeElement, checkbox, 'Saving must not remove a keyboard-focused checkbox');
  assert.equal(f.checkbox('minimap').checked, true);
  f.search('');
  assert.equal(f.checkbox('boss').checked, true);
});

test('changing language reorders the same cards and retains checkbox focus and selection', async () => {
  const f = fixture({ translations: { sv: { bossTimers: 'Ögon', craftingTimers: 'Ånga', otherTimers: 'Äpple' } } });
  await tick();
  const checkbox = f.checkbox('boss');
  checkbox.focus();
  f.config({ language: 'sv', widgetVisibility: { boss: true } });
  const timers = f.groups().find(group => group.dataset.category === 'timers');
  assert.deepEqual(f.cards(timers).map(card => card.dataset.widget), ['crafting', 'other', 'boss']);
  assert.equal(f.checkbox('boss'), checkbox);
  assert.equal(f.document.activeElement, checkbox);
  assert.equal(checkbox.checked, true);
});
