'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderer(filename, clickThrough) {
  const keys = [], elements = new Map();
  const element = () => ({ dataset: {}, classList: { toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, appendChild() {} });
  const document = { body: element(), createElement: element,
    addEventListener: (event, callback) => { if (event === 'keydown') keys.push(callback); },
    querySelector: selector => {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    } };
  let exits = 0, interaction;
  const context = vm.createContext({ document, URLSearchParams, TRANSLATIONS: { en: {} },
    window: { location: { search: '?widget=wiki' }, addEventListener() {},
      api: { exitInteractiveMode: () => { exits++; }, onOverlayInteraction: callback => { interaction = callback; } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer', filename), 'utf8'), context);
  vm.runInContext(`config = { clickThrough: ${clickThrough} }; ${filename === 'renderer.js' ? 'bindEvents()' : 'setupOverlayInteractionListeners()'}`, context);
  return {
    active(value) { if (interaction) interaction(value); else vm.runInContext(`overlayInteractive = ${value}`, context); },
    press(key) { for (const callback of keys) callback({ key }); },
    exits: () => exits,
  };
}

test('Escape releases focused dock and widget interaction with either click-through preference', () => {
  for (const filename of ['renderer.js', 'widget-host.js']) {
    for (const preference of [false, true]) {
      const ui = renderer(filename, preference);
      ui.press('Escape');
      assert.equal(ui.exits(), 0, `${filename} stays passive until interaction is enabled`);
      ui.active(true);
      ui.press('Enter');
      assert.equal(ui.exits(), 0);
      ui.press('Escape');
      assert.equal(ui.exits(), 1, `${filename} must release with click-through ${preference}`);
      ui.active(false);
      ui.press('Escape');
      assert.equal(ui.exits(), 1);
    }
  }
});
