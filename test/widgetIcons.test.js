'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const icons = require('../src/renderer/widget-icons');

const expected = ['boss', 'crafting', 'other', 'affiliation', 'factions', 'odeinfamy', 'wiki',
  'groupfinder', 'market', 'minimap', 'arena', 'world-watch', 'calendar', 'clock', 'weather',
  'build-exporter', 'temper-tracker', 'wolf-training', 'data-inventory', 'data-ee-log',
  'title-tracker', 'player', 'daily', 'collection-log', 'cosmetics', 'mastery-tracker', 'resources', 'enhancements', 'crafting-planner', 'activity', 'crafting-log', 'session-analysis'];

function documentFixture() {
  return { createElementNS(namespace, tagName) {
    return { namespace, tagName, attributes: {}, children: [],
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); } };
  } };
}

const shapes = node => node.children.flatMap(child => child.tagName === 'g' ? shapes(child) : [{ tag: child.tagName, attributes: child.attributes }]);

test('every supported widget has one distinct native SVG symbol', () => {
  assert.deepEqual([...icons.ids].sort(), [...expected].sort());
  const normalized = icons.ids.map(id => JSON.stringify(shapes(icons.create(id, documentFixture()))));
  assert.equal(new Set(normalized).size, icons.ids.length, 'No widget can share a symbol');
  for (const id of icons.ids) {
    assert.ok(icons.catalogue[id].parts.length > 0, id);
    assert.ok(normalized[icons.ids.indexOf(id)].length >= 30, id);
    assert.doesNotMatch(normalized[icons.ids.indexOf(id)], /NaN|undefined|Infinity/, id);
  }
  for (const id of ['storage-capacity', 'account-wallet', 'active-boons', 'equipment-progress', 'session-gains']) {
    assert.equal(Object.hasOwn(icons.catalogue, id), false, 'Retired standalone widget symbols do not become new picker entries');
  }
});

test('shared icon construction emits a decorative outline SVG with widget identity', () => {
  const document = documentFixture();
  for (const id of icons.ids) {
    const svg = icons.create(id, document);
    assert.equal(svg.tagName, 'svg');
    assert.equal(svg.namespace, 'http://www.w3.org/2000/svg');
    assert.equal(svg.attributes.viewBox, '0 0 24 24');
    assert.equal(svg.attributes.fill, 'none');
    assert.equal(svg.attributes.stroke, 'currentColor');
    assert.equal(svg.attributes['aria-hidden'], 'true');
    assert.equal(svg.attributes.focusable, 'false');
    assert.equal(svg.attributes['data-widget-icon'], id);
    assert.equal(svg.attributes['stroke-width'], '2');
    assert.equal(svg.attributes.class, 'overkot-icon');
    assert.equal(svg.attributes['data-icon-motion-kind'], icons.catalogue[id].parts.find(part => part.motion !== 'none').motion);
    const groups = icons.catalogue[id].fit === 1 ? svg.children : svg.children[0].children;
    assert.equal(groups.length, icons.catalogue[id].parts.length);
    for (const [index, group] of groups.entries()) {
      const part = icons.catalogue[id].parts[index];
      assert.equal(group.tagName, 'g');
      assert.equal(group.attributes['data-icon-part'], part.name);
      assert.equal(group.attributes['data-icon-layer'], part.channel);
      assert.equal(group.children.length, part.nodes.length);
    }
  }
});

test('unknown icon IDs fail explicitly instead of silently sharing a fallback symbol', () => {
  const document = documentFixture();
  for (const id of ['missing', '__proto__', 'toString', undefined, null]) {
    assert.throws(() => icons.create(id, document), /Unknown widget icon/);
  }
  assert.throws(() => icons.create('player', null), /DOM document/);
  assert.equal(Object.isFrozen(icons), true);
  assert.equal(Object.isFrozen(icons.catalogue), true);
  assert.equal(Object.isFrozen(icons.catalogue.player.parts), true);
  assert.equal(Object.isFrozen(icons.catalogue.player.parts[0].nodes[0].attributes), true);
  assert.equal(Object.isFrozen(icons.ids), true);
});

test('browser script and CommonJS consumers receive the same catalogue', () => {
  const document = documentFixture();
  const context = vm.createContext({ document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/widget-icons.js'), 'utf8'), context);
  const browser = context.WidgetIcons;
  assert.ok(browser);
  assert.deepEqual([...browser.ids], [...icons.ids]);
  const svg = browser.create('daily');
  assert.equal(svg.attributes['data-widget-icon'], 'daily');
  assert.equal(JSON.stringify(shapes(svg)), JSON.stringify(shapes(icons.create('daily', document))));
});
