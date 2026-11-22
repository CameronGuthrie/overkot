'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const icons = require('../src/renderer/widget-icons');
const rendererRoot = path.join(__dirname, '../src/renderer');
const read = name => fs.readFileSync(path.join(rendererRoot, name), 'utf8');

function rendererFixture(name) {
  function element(tagName = 'span') {
    return { tagName, attributes: {}, children: [], className: '',
      classList: { add() {} }, setAttribute(key, value) { this.attributes[key] = value; },
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); } };
  }
  const window = { i18n: { titleTrackerEnabled: true, languages: [], translations: { en: {} } } };
  const document = { addEventListener() {}, createElement: element, createElementNS: (_namespace, tagName) => element(tagName) };
  const context = vm.createContext({ window, document, console: { error() {} } });
  vm.runInContext(read('shared-constants.js'), context);
  vm.runInContext(read('widget-icons.js'), context);
  window.WidgetIcons = context.WidgetIcons;
  vm.runInContext(read(name), context);
  return { context, window, run: code => vm.runInContext(code, context) };
}

test('dock and picker load the shared icon source before their renderers', () => {
  for (const [html, renderer] of [['index.html', 'renderer.js'], ['widgets-window.html', 'widgets-window.js']]) {
    const source = read(html);
    const shared = source.indexOf('<script src="widget-icons.js"');
    assert.ok(shared >= 0, `${html} loads shared symbols`);
    assert.ok(shared < source.indexOf(`<script src="${renderer}"`), `${html} loads symbols before use`);
  }
});

test('all registered dock and picker entries resolve one distinct shared icon', () => {
  const dock = rendererFixture('renderer.js');
  const picker = rendererFixture('widgets-window.js');
  const registered = [...dock.window.ALL_WIDGET_IDS, 'market'].sort();
  const dockIds = Array.from(dock.run('Object.keys(WIDGET_CATALOG)')).sort();
  const pickerIds = Array.from(picker.run('WIDGET_DEFS.map(definition => definition.id)')).sort();
  assert.deepEqual(dockIds, registered, 'Every active widget is represented in the dock catalogue');
  assert.deepEqual(pickerIds, registered, 'Every active widget is represented in the picker catalogue');
  assert.equal(new Set(pickerIds).size, pickerIds.length, 'No repeated picker entries');
  const paths = [];
  for (const id of registered) {
    dock.context.requestedId = id;
    picker.context.requestedId = id;
    const dockIcon = dock.run('makeWidgetIcon(requestedId)');
    const pickerIcon = picker.run('makeIcon(requestedId)');
    const dockSvg = dockIcon.children.find(child => child.tagName === 'svg');
    const pickerSvg = pickerIcon.children.find(child => child.tagName === 'svg');
    assert.ok(dockSvg, `${id} dock SVG`); assert.ok(pickerSvg, `${id} picker SVG`);
    assert.equal(dockSvg.attributes['data-widget-icon'], id);
    assert.equal(pickerSvg.attributes['data-widget-icon'], id);
    const groups = icons.catalogue[id].fit === 1 ? dockSvg.children : dockSvg.children[0].children;
    assert.equal(groups.length, icons.catalogue[id].parts.length);
    const signature = svg => JSON.stringify(svg.children, (key, value) => typeof value === 'function' ? undefined : value);
    assert.equal(signature(dockSvg), signature(pickerSvg), 'Dock and picker use the same native shapes and semantic parts');
    paths.push(signature(dockSvg));
  }
  assert.equal(new Set(paths).size, registered.length, 'No two active widgets share an icon');
});

test('both surfaces construct icons by widget ID without an independent fallback catalogue', () => {
  for (const name of ['renderer.js', 'widgets-window.js']) {
    const source = read(name);
    assert.doesNotMatch(source, /const\s+WIDGET_ICON_PATHS\s*=/, `${name} must not maintain another symbol map`);
    assert.match(source, /WidgetIcons\.create\(/, `${name} uses shared construction`);
  }
  assert.match(read('renderer.js'), /makeWidgetIcon\(id\)/);
  assert.match(read('widgets-window.js'), /makeIcon\(def\.id\)/);
});

test('every registered panel has exactly one host template and its modular assets exist', () => {
  const dock = rendererFixture('renderer.js'), html = read('widget-host.html');
  for (const id of dock.window.ALL_WIDGET_IDS) {
    const matches = html.match(new RegExp(`data-widget="${id}"`, 'g')) || [];
    assert.equal(matches.length, 1, `${id} has a mountable host template`);
  }
  for (const filename of ['player-widget.js', 'player-widget.css', 'daily-brief.js', 'daily-brief.css']) {
    assert.ok(html.includes(`"${filename}"`), `${filename} is loaded by the host`);
    assert.ok(fs.existsSync(path.join(rendererRoot, filename)), `${filename} exists`);
  }
});
