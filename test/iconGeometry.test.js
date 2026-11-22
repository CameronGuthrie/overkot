'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WidgetIcons = require('../src/renderer/widget-icons');
const UIIcons = require('../src/renderer/ui-icons');
const assetRoot = path.join(__dirname, '../assets/icons');
const manifest = require('../assets/icons/lucide/manifest.json');
const shapeTags = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const geometryAttributes = new Set(['d', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r',
  'x1', 'x2', 'y1', 'y2', 'points', 'transform']);
const sourceFor = name => fs.readFileSync(name === 'overkot-market-sack'
  ? path.join(assetRoot, 'market-sack.svg') : path.join(assetRoot, 'lucide', name + '.svg'), 'utf8');

function sourceShapes(source) {
  return [...source.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*?)\/?\s*>/gs)].map(([, tag, text]) => ({
    tag, attributes: Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])),
  }));
}

function documentFixture() {
  return { createElementNS(namespace, tagName) {
    return { namespace, tagName, attributes: {}, children: [],
      style: { values: {}, setProperty(key, value) { this.values[key] = String(value); } },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); } };
  } };
}

function emittedShapes(root) {
  return root.children.flatMap(node => shapeTags.has(node.tagName)
    ? [{ tag: node.tagName, attributes: node.attributes }] : emittedShapes(node));
}

function canonical(shape) {
  const attributes = Object.entries(shape.attributes).filter(([key]) => geometryAttributes.has(key))
    .map(([key, value]) => [key, String(value).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([shape.tag, attributes]);
}

const surfaces = [
  ['widget', WidgetIcons, { ...manifest.widgets, market: 'overkot-market-sack' }],
  ['action', UIIcons, { ...manifest.actions, market: 'overkot-market-sack' }],
];

test('every widget and action retains each original SVG primitive exactly once, including relative paths', () => {
  for (const [surface, icons, sources] of surfaces) {
    assert.deepEqual([...icons.ids].sort(), Object.keys(sources).sort(), `${surface} catalogue is complete`);
    for (const [id, source] of Object.entries(sources)) {
      const original = sourceShapes(sourceFor(source));
      const svg = icons.create(id, documentFixture());
      const generated = emittedShapes(svg);
      assert.equal(svg.attributes.viewBox, '0 0 24 24', `${surface}:${id} keeps its coordinate system`);
      assert.equal(generated.length, original.length, `${surface}:${id} cannot duplicate or drop an outline to manufacture colour layers`);
      assert.deepEqual(generated.map(canonical).sort(), original.map(canonical).sort(),
        `${surface}:${id} must preserve each native primitive instead of concatenating independent relative paths`);
    }
  }
});

test('colour channels follow natural components, and single-shape symbols use one primary part', () => {
  for (const [surface, icons, sources] of surfaces) for (const [id, source] of Object.entries(sources)) {
    const definition = icons.catalogue[id];
    assert.ok(Array.isArray(definition.parts) && definition.parts.length > 0, `${surface}:${id} has authored parts`);
    const original = sourceShapes(sourceFor(source));
    const channels = new Set(definition.parts.map(part => part.channel));
    assert.ok(channels.size >= 1 && channels.size <= Math.min(3, original.length), `${surface}:${id} only uses available natural colour roles`);
    for (const channel of channels) assert.ok(['primary', 'secondary', 'detail'].includes(channel), `${surface}:${id} uses known colours`);
    const authoredNodes = definition.parts.flatMap(part => part.nodes);
    assert.deepEqual(authoredNodes.map(canonical).sort(), original.map(canonical).sort(), `${surface}:${id} metadata and rendered geometry agree`);
    if (original.length === 1) {
      assert.equal(definition.parts.length, 1, `${surface}:${id} stays a single coherent symbol`);
      assert.deepEqual([...channels], ['primary']);
    }
    for (const part of definition.parts) {
      assert.ok(part.nodes.length > 0, `${surface}:${id} has no synthetic empty accent layers`);
      assert.equal(Object.hasOwn(part, 'traceSecondary'), false);
      assert.equal(Object.hasOwn(part, 'traceDetail'), false);
    }
  }
});

test('all icons describe deliberate component motion with bounded origins instead of a generic three-layer fallback', () => {
  for (const [surface, icons] of surfaces) for (const id of icons.ids) {
    const definition = icons.catalogue[id];
    assert.ok(typeof definition.description === 'string' && definition.description.trim().length >= 6,
      `${surface}:${id} explains its visual meaning`);
    assert.ok(definition.parts.some(part => typeof part.motion === 'string' && part.motion !== 'none'),
      `${surface}:${id} has an authored animated component`);
    const names = new Set();
    for (const part of definition.parts) {
      assert.ok(typeof part.name === 'string' && part.name.length > 0, `${surface}:${id} identifies its moving component`);
      assert.equal(names.has(part.name), false, `${surface}:${id} component names are unique`);
      names.add(part.name);
      assert.ok(typeof part.motion === 'string' && part.motion.length > 0, `${surface}:${id}:${part.name} declares movement or a stationary outline`);
      const origin = /^(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px$/.exec(part.origin);
      assert.ok(origin, `${surface}:${id}:${part.name} has a measured SVG pivot`);
      assert.ok(origin.slice(1).every(value => Number(value) >= -2 && Number(value) <= 26), `${surface}:${id}:${part.name} pivot belongs to its glyph`);
    }
    if (definition.fit !== undefined) assert.ok(definition.fit > 0 && definition.fit <= 1, `${surface}:${id} explicit motion fit never enlarges a glyph`);
  }
});

test('clock and stopwatch hands rotate around their actual centres while their faces stay still', () => {
  const clock = WidgetIcons.catalogue.clock;
  const clockHand = clock.parts.find(part => part.nodes.some(node => node.tag === 'path' && node.attributes.d === 'M12 6v6h4'));
  assert.ok(clockHand, 'The clock hand stays separate from its face');
  assert.equal(clockHand.origin, '12px 12px');
  assert.notEqual(clockHand.motion, 'none');
  assert.equal(clock.parts.find(part => part.nodes.some(node => node.tag === 'circle')).motion, 'none');

  const stopwatch = WidgetIcons.catalogue.other;
  const timerHand = stopwatch.parts.find(part => part.nodes.some(node => node.tag === 'line'
    && String(node.attributes.x1) === '12' && String(node.attributes.y1) === '14'
    && String(node.attributes.x2) === '15' && String(node.attributes.y2) === '11'));
  assert.ok(timerHand, 'The stopwatch hand stays separate from its button and face');
  assert.equal(timerHand.origin, '12px 14px', 'The stopwatch dial centre differs from the canvas centre');
  assert.notEqual(timerHand.motion, 'none');
  assert.equal(stopwatch.parts.find(part => part.nodes.some(node => node.tag === 'circle')).motion, 'none');
});

test('weather keeps the occluded solar arc and cloud fixed while rays and rain animate separately', () => {
  const weather = WidgetIcons.catalogue.weather;
  const original = sourceShapes(sourceFor(manifest.widgets.weather));
  const partFor = index => weather.parts.find(part => part.nodes.some(node => canonical(node) === canonical(original[index])));
  const rays = partFor(0), solarArc = partFor(4), cloud = partFor(5), rain = partFor(6);
  assert.ok(rays && solarArc && cloud && rain);
  for (const index of [0, 1, 2, 3]) assert.equal(partFor(index), rays, 'All solar rays share their own measured movement');
  assert.equal(rays.motion, 'sun-ray-turn');
  assert.equal(rays.origin, '12px 12px');
  assert.equal(solarArc.motion, 'none', 'Rotating the partially occluded arc creates a misleading second cloud');
  assert.equal(cloud.motion, 'none');
  assert.notEqual(rays, solarArc);
  assert.notEqual(rays, cloud);
  assert.equal(partFor(7), rain);
  assert.equal(rain.motion, 'rain-fall');
});
