'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const theme = require('../src/renderer/theme');
const rendererRoot = path.join(__dirname, '../src/renderer');
const read = name => fs.readFileSync(path.join(rendererRoot, name), 'utf8');

test('artwork opacity remains on foreground leaves rather than card, SVG or content containers', () => {
  const css = read('theme.css');
  const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), match => ({ selector: match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: match[2] }));
  const foregroundRules = rules.filter(rule => /(?:^|;)\s*opacity\s*:[^;]*--(?:elements|text-elements|bar-elements)-opacity/.test(rule.body));
  assert.ok(foregroundRules.length > 0);
  for (const rule of foregroundRules) {
    assert.doesNotMatch(rule.selector, /(?:\.timer-widget|\.widget-body|\.widget-card|\.collection-row|\.clock-orbit|\.weather-scene|\.overkot-icon)\s*$/, rule.selector);
  }
  assert.doesNotMatch(css, /(?:^|[;{])\s*opacity\s*:[^;{}]*--(?:background|surface)-opacity/);
  const raster = foregroundRules.find(rule => rule.selector.endsWith(':is(img, canvas)'));
  assert.ok(raster, 'Opaque pixels in item images and map canvas need their own foreground leaf alpha');
  for (const surface of ['widget-host-body', 'daily-brief-window', 'dungeon-overlay-body', 'appearance-preview-surface', 'body:has(#map-container)']) {
    assert.ok(raster.selector.includes(surface), `${surface} uses the common artwork rule`);
  }
});

test('transparent progress labels cannot leave an opaque glyph-shaped shadow', () => {
  const css = read('theme.css');
  const barLabels = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).find(match => match[1].includes('.title-progress-count') && match[2].includes('text-shadow'));
  assert.ok(barLabels);
  assert.match(barLabels[2], /text-shadow:[^;]*--text-elements-opacity/);
});

test('the standalone map background and authored chrome use independent theme channels', () => {
  const css = read('theme.css');
  assert.match(css, /body:has\(#map-container\)\s*\{\s*background:\s*var\(--widget-bg\)/);
  assert.match(css, /:is\(\.map-coord-readout,\s*\.map-loading\)\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*background:\s*var\(--theme-control\)/);
  // The old map eye SVGs carry an inline raw colour; the semantic alpha must win.
  assert.match(css, /\.map-legend-eye svg\s*\{\s*color:\s*var\(--text-muted\)\s*!important/);
});

test('the large dungeon map resolves the Minimap appearance on load and live updates', async () => {
  const handlers = {}, calls = [], elements = new Map();
  const config = { appearance: { version: 1, base: 'classic', global: { elementOpacity: 100 }, widgets: { minimap: { elementOpacity: 25 } } } };
  let onConfigChanged;
  const api = { getState: async () => ({ config }), onConfigChanged: callback => { onConfigChanged = callback; } };
  const context = vm.createContext({
    window: { api, addEventListener() {} },
    document: { body: { dataset: {} }, addEventListener: (event, callback) => { handlers[event] = callback; },
      getElementById: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } },
    DungeonMapWidget: { mount: () => ({ destroy() {}, releaseInteraction() {} }) },
    OverkotTheme: { apply: (value, options) => { calls.push({ widgetId: options?.widgetId, values: theme.variables(value, options?.widgetId) }); } },
  });
  vm.runInContext(read('dungeon-overlay.js'), context);
  await handlers.DOMContentLoaded();
  assert.equal(calls[0].widgetId, 'minimap');
  assert.equal(calls[0].values['--elements-opacity'], '0.25');
  const next = structuredClone(config); next.appearance.widgets.minimap.elementOpacity = 70;
  onConfigChanged(next);
  assert.equal(calls[1].widgetId, 'minimap');
  assert.equal(calls[1].values['--elements-opacity'], '0.7');
  assert.equal(calls[1].values['--widget-bg'], calls[0].values['--widget-bg']);
});
