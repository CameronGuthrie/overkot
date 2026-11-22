'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderer() {
  function element() {
    let text = '';
    const node = { children: [], classList: { add() {} }, style: {}, dataset: {},
      append(...children) { this.children.push(...children); }, setAttribute() {} };
    Object.defineProperty(node, 'textContent', { get: () => text + node.children.map(child => child.textContent).join(''),
      set(value) { text = String(value); node.children = []; } });
    return node;
  }
  let draw;
  const context = vm.createContext({ document: { createElement: element }, window: {
    localStorage: { getItem: () => 'all' }, InventoryWidgetUI: { mount(_element, options) { draw = options.render; return {}; } },
  } });
  const mount = context.window.InventoryWidgetUI.mount;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/inventory-widget-ui.js'), 'utf8'), context);
  context.window.InventoryWidgetUI.mount = mount;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/mastery-sessions.js'), 'utf8'), context);
  context.window.MasterySessionsWidget.mount(element());
  return snapshot => {
    const body = element(); draw(body, snapshot, { number: value => Number(value).toLocaleString('en-GB'), language: 'en-GB', now: 7200000 });
    return body.textContent;
  };
}

test('legacy XP observations remain visible without presenting old account-reported rank endpoints or invented zero increases', () => {
  const render = renderer();
  const text = render({ sessions: [{ start: 1000000, end: 4600000, elapsedHours: 1, isCurrent: false,
    basis: 'total', scope: 'complete', rankBasis: 'unavailable', rankFrom: null, rankTo: null, rankUps: null,
    gained: 50000, net: 50000, perHour: 50000, samples: [{ at: 1000000, xp: 0 }, { at: 4600000, xp: 50000 }] }] });
  assert.match(text, /Mastery gained50,000/);
  assert.match(text, /ER increases—/);
  assert.match(text, /Inventory ER unavailable for this session/);
  assert.doesNotMatch(text, /Reported ER|ER 19|ER 21|ER increases0/);
});

test('new inventory-derived rank history can show rank 20 and a genuine observed rank increase', () => {
  const render = renderer();
  const text = render({ sessions: [{ start: 1000000, end: 4600000, elapsedHours: 1, isCurrent: false,
    basis: 'total', scope: 'complete', rankBasis: 'inventory', rankFrom: 19, rankTo: 20, rankUps: 1,
    gained: 29000, net: 29000, perHour: 29000, samples: [{ at: 1000000, xp: 0 }, { at: 4600000, xp: 29000 }] }] });
  assert.match(text, /Inventory ER 19 → 20/);
  assert.match(text, /ER increases1/);
});
