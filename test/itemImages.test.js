'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IMAGE_ORIGIN, imageUrl, create } = require('../src/renderer/item-images');

function documentFixture() {
  function element(tagName) {
    const classes = new Set(), listeners = new Map();
    return { tagName, attributes: {}, children: [], hidden: false, className: '',
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      emit(type) { listeners.get(type)?.(); },
    };
  }
  return { createElement: element, createElementNS: (_namespace, tagName) => element(tagName) };
}

test('item art accepts source paths and exact owned CDN URLs, including dotted asset names', () => {
  for (const path of ['/SF/Interface/Graphics/StoreItems/Weapons/Sword.png', '/SF/Interface/Graphics/StoreItems/Parts/Blade.v2.webp']) {
    assert.equal(imageUrl(path), IMAGE_ORIGIN + path);
    assert.equal(imageUrl(path.slice(1)), IMAGE_ORIGIN + path);
    assert.equal(imageUrl(IMAGE_ORIGIN + path), IMAGE_ORIGIN + path);
  }
});

test('untrusted hosts, traversal and non-image references never become image requests', () => {
  for (const value of [null, {}, '', 'data:image/png;base64,AAAA', 'javascript:alert(1)',
    'https://example.com/SF/Interface/Graphics/Art.png', IMAGE_ORIGIN + '.evil.test/SF/Interface/Graphics/Art.png',
    'https://dap1x6lmnonv6.cloudfront.net@evil.test/SF/Interface/Graphics/Art.png',
    '/SF/Interface/Graphics/../Art.png', '/SF/Interface/Graphics/./Art.png', '/SF/Interface/Graphics/%2e%2e/Art.png',
    '/SF/Interface/Graphics/Art.svg', '/SF/Interface/Graphics/Art.png?token=private', '/SF/Secrets/Art.png']) {
    assert.equal(imageUrl(value), null, String(value));
  }
});

test('successful art replaces a decorative fallback while using lazy asynchronous image decoding', () => {
  const document = documentFixture(), wrapper = create('/SF/Interface/Graphics/StoreItems/Weapons/Sword.png', { document, className: 'equipment-image', category: 'Weapon' });
  assert.equal(wrapper.attributes['aria-hidden'], 'true');
  assert.match(wrapper.className, /item-thumbnail.*equipment-image/);
  assert.equal(wrapper.children[0].tagName, 'svg');
  const image = wrapper.children.find(child => child.tagName === 'img');
  assert.equal(image.loading, 'lazy'); assert.equal(image.decoding, 'async'); assert.equal(image.alt, '');
  assert.equal(image.referrerPolicy, 'no-referrer');
  assert.equal(wrapper.classList.contains('is-loaded'), false);
  image.emit('load'); assert.equal(wrapper.classList.contains('is-loaded'), true);
});

test('missing and failed images retain their fallback and thumbnail geometry', () => {
  const document = documentFixture(), missing = create(null, { document, category: 'Resource' });
  assert.equal(missing.children.length, 1); assert.equal(missing.children[0].tagName, 'svg');
  assert.equal(missing.classList.contains('is-missing'), true);
  const failed = create('/SF/Interface/Graphics/Art.png', { document, category: 'Armor' });
  const image = failed.children.find(child => child.tagName === 'img'); image.emit('load'); image.emit('error');
  assert.equal(image.hidden, true); assert.equal(failed.children[0].tagName, 'svg');
  assert.equal(failed.classList.contains('is-loaded'), false); assert.equal(failed.classList.contains('is-missing'), true);
  assert.match(failed.className, /item-thumbnail/);
});

test('discovery and palette slots use explicit category artwork when their item has no image', () => {
  const document = documentFixture();
  for (const [category, asset] of [['World Tree', 'WaypointMarkers/Tree.png'], ['Discovery', 'WaypointMarkers/MapLocation.png'],
    ['Color Palette', 'ColourCustomization/PaletteSwatchRaggedClean.png']]) {
    const thumbnail = create(null, { document, category }), image = thumbnail.children.find(child => child.tagName === 'img');
    assert.ok(image, category); assert.equal(image.src, `${IMAGE_ORIGIN}/SF/Interface/Graphics/${asset}`);
  }
});
