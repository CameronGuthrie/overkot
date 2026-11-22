'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('../src/renderer/theme');

const opacity = color => Number(color.match(/,([\d.]+)\)$/)?.[1]);

test('normal widget outlines follow opacity in every palette without changing control borders', () => {
  for (const selected of Object.keys(theme.presets)) {
    const defaultVars = theme.variables({ theme: selected });
    const hiddenVars = theme.variables({ theme: selected, widgetOutlineOpacity: 0 });
    const halfVars = theme.variables({ theme: selected, widgetOutlineOpacity: 50 });
    assert.equal(opacity(hiddenVars['--widget-outline-color']), 0, selected);
    assert.equal(opacity(halfVars['--widget-outline-color']), opacity(defaultVars['--widget-outline-color']) / 2, selected);
    for (const key of ['--theme-border', '--theme-control', '--theme-accent', '--text-primary']) {
      assert.equal(hiddenVars[key], defaultVars[key], `${selected}: ${key} remains legible when card outlines are hidden`);
    }
  }
});

test('invalid outline preferences recover to visible defaults and finite values remain bounded', () => {
  const defaults = theme.variables();
  assert.equal(theme.variables({ widgetOutlineOpacity: '0' })['--widget-outline-color'], defaults['--widget-outline-color']);
  assert.equal(theme.variables({ widgetOutlineOpacity: NaN })['--widget-outline-color'], defaults['--widget-outline-color']);
  assert.equal(theme.variables({ widgetOutlineOpacity: 400 })['--widget-outline-color'], defaults['--widget-outline-color']);
  assert.equal(opacity(theme.variables({ widgetOutlineOpacity: -5 })['--widget-outline-color']), 0);
});
