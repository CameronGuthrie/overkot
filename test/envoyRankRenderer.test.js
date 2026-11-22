'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rankProgress } = require('../src/modules/masteryTracker');

function renderer() {
  function element(tag) {
    let text = '';
    const node = { tag, className: '', value: '', children: [], attributes: {}, classList: { add() {} },
      append(...children) { this.children.push(...children); }, replaceChildren() { text = ''; this.children = []; },
      setAttribute(key, value) { this.attributes[key] = String(value); }, addEventListener() {},
      removeEventListener() {}, dataset: {},
    };
    Object.defineProperty(node, 'textContent', { get: () => text + node.children.map(child => child.textContent).join(''),
      set(value) { text = String(value); node.children = []; } });
    return node;
  }
  const body = element('div');
  let draw;
  const context = vm.createContext({ document: { createElement: element }, localStorage: { getItem: () => null },
    window: { InventoryWidgetUI: { mount(_element, options) { draw = options.render; return { repaint() {} }; } },
      ItemImages: { create: () => element('span') } } });
  const mount = context.window.InventoryWidgetUI.mount;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/inventory-widget-ui.js'), 'utf8'), context);
  context.window.InventoryWidgetUI.mount = mount;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/collection-tracker.js'), 'utf8'), context);
  context.window.CollectionTrackerWidget.mount(element('div'), { id: 'mastery-tracker' });
  return { body, render(snapshot) { body.replaceChildren(); draw(body, { rows: [], summary: {}, equipmentXP: 0, scope: 'known-discoveries',
    ...snapshot }, { number: value => Number(value).toLocaleString('en-GB'), button: () => element('button') }); },
    headline: () => body.children[0].children.find(child => child.className === 'collection-total').textContent };
}

test('inventory mastery determines the visible rank and raw reported levels never replace it', () => {
  const ui = renderer();
  ui.render({ currentRank:19, rankSource:'inventory-mastery', rankIsExact:true, reportedRank:21,
    totalXP:472000, computedRank:19, progress:rankProgress(472000) });
  assert.equal(ui.headline(), 'Envoy Rank 19');
  assert.match(ui.body.textContent, /472,000 mastery XP · Calculated from inventory/);
  assert.match(ui.body.textContent, /toward calculated ER 20/);
  assert.doesNotMatch(ui.body.textContent, /MAX|maximum|Envoy Rank 21/);
  ui.render({ currentRank:19, rankSource:'inventory-mastery', rankIsExact:true, reportedRank:0,
    totalXP:472000, computedRank:19, progress:rankProgress(472000) });
  assert.equal(ui.headline(), 'Envoy Rank 19');
});

test('inventory mastery continues naturally from rank 19 to rank 20 with the next goal beyond it', () => {
  const ui = renderer();
  ui.render({ currentRank:20, rankSource:'inventory-mastery', rankIsExact:true, reportedRank:1,
    totalXP:501000, computedRank:20, progress:rankProgress(501000) });
  assert.equal(ui.headline(), 'Envoy Rank 20');
  assert.match(ui.body.textContent, /501,000 mastery XP/);
  assert.match(ui.body.textContent, /toward calculated ER 21/);
  assert.doesNotMatch(ui.body.textContent, /MAX|maximum|Envoy Rank 1(?:\D|$)/);
});

test('partial inventory mastery is identified without inventing a complete total', () => {
  const ui = renderer();
  ui.render({ currentRank:19, rankSource:'inventory-mastery', rankIsExact:false, scope:'known-discoveries',
    totalXP:472000, progress:rankProgress(472000) });
  assert.equal(ui.headline(), 'Envoy Rank 19');
  assert.match(ui.body.textContent, /Calculated from known inventory mastery/);
  assert.match(ui.body.textContent, /Partial inventory mastery/);
  assert.match(ui.body.textContent, /calculated rank and total incomplete/);
});

test('unavailable inventory rank stays unavailable despite a reported or equipment-only diagnostic rank', () => {
  const ui = renderer();
  ui.render({ currentRank:null, rankIsExact:false, reportedRank:21, computedRank:19,
    totalXP:null, progress:rankProgress(472000) });
  assert.equal(ui.headline(), 'Envoy Rank unavailable');
  assert.match(ui.body.textContent, /Partial inventory mastery/);
  assert.doesNotMatch(ui.body.textContent, /Envoy Rank (?:19|21)|toward calculated ER/);
});
