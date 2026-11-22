'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ui = require('../src/renderer/ui-icons');
const { generate, parseSvg } = require('../scripts/build-ui-icons');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

function documentFixture() {
  const make = (tag, classes = []) => ({ tagName: tag, nodeType: 1, attributes: {}, children: [],
    classList: { contains: value => classes.includes(value), add: value => { if (!classes.includes(value)) classes.push(value); } },
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    querySelector(selector) { return selector === '[data-ui-icon]' ? this.children.find(child => child.attributes['data-ui-icon']) || null : null; },
    querySelectorAll() { return []; }, matches() { return classes.some(name => name.startsWith('icon-') && name !== 'icon-hydrated'); },
  });
  const icons = [make('span', ['icon-settings']), make('span', ['icon-search'])], events = {}, observers = [], refreshed = [];
  const document = { readyState: 'loading', documentElement: make('html'), querySelectorAll: () => icons,
    createElementNS: (_namespace, tag) => make(tag), addEventListener: (name, callback) => { events[name] = callback; },
    defaultView: { addEventListener: (name, callback) => { events[name] = callback; },
      OverkotTheme: { refreshIcons: root => refreshed.push(root) },
      MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); }
        observe(root, options) { this.root = root; this.options = options; } disconnect() { this.disconnected = true; } },
    },
  };
  return { document, icons, make, events, observers, refreshed };
}

test('generic controls hydrate into local semantic SVG parts, including dynamically added controls without duplication', () => {
  const f = documentFixture();
  ui.mount(f.document);
  assert.equal(f.icons[0].children.length, 0);
  f.events.DOMContentLoaded();
  for (const icon of f.icons) {
    assert.equal(icon.children.length, 1);
    const svg = icon.children[0];
    assert.equal(svg.attributes.class, 'overkot-icon');
    assert.equal(svg.attributes['aria-hidden'], 'true');
    assert.equal(svg.attributes.focusable, 'false');
    const id = svg.attributes['data-ui-icon'];
    assert.deepEqual(svg.children.map(group => group.attributes['data-icon-layer']), ui.catalogue[id].parts.map(part => part.channel));
    for (const group of svg.children) assert.ok(group.children.length > 0, 'Each semantic part contains original native shapes');
    assert.ok(icon.classList.contains('icon-hydrated'));
  }
  const next = f.make('span', ['icon-palette']);
  f.observers[0].callback([{ type: 'childList', addedNodes: [next] }]);
  assert.equal(f.refreshed.at(-1), next, 'Newly inserted widget symbols inherit the current per-widget appearance');
  assert.equal(next.children[0].attributes['data-ui-icon'], 'palette');
  f.observers[0].callback([{ type: 'attributes', target: next }]);
  assert.equal(next.children.length, 1, 'Repaints and class changes cannot duplicate icon nodes');
  f.events.unload();
  assert.equal(f.observers[0].disconnected, true);
});

test('widget symbols added after theme application receive current per-widget colours and motion while previews retain their scope', () => {
  const element = () => ({ dataset: {}, style: { values: {}, setProperty(key, value) { this.values[key] = value; }, removeProperty() {} } });
  const html = element(), motionScopes = [];
  const document = { documentElement: html, body: element(), querySelectorAll: () => [] };
  const context = vm.createContext({ module: { exports: {} }, URLSearchParams,
    require: () => require('../src/modules/appearance'), document,
    window: { location: { search: '' }, OverkotMotion: { configure: (values, scope) => motionScopes.push([values, scope]) } },
  });
  vm.runInContext(read('src/renderer/theme.js'), context);
  const theme = context.module.exports;
  theme.apply({ appearance: { global: { iconMotion: 'hover' }, widgets: { boss: {
    iconMotion: 'loop', iconPalette: 'custom', iconPrimaryColor: '#123456', iconSecondaryColor: '#abcdef', iconDetailColor: '#fedcba', iconSpeed: 150,
  } } } });
  const wrapper = element();
  const svg = { parentElement: wrapper, getAttribute: () => 'boss', matches: () => true, closest: () => null, querySelectorAll: () => [] };
  theme.refreshIcons(svg);
  assert.equal(wrapper.dataset.iconMotion, 'loop');
  assert.equal(wrapper.dataset.iconPalette, 'custom');
  assert.equal(wrapper.style.values['--icon-primary'], 'rgba(18,52,86,1)');
  assert.equal(wrapper.style.values['--icon-secondary'], 'rgba(171,205,239,1)');
  assert.equal(wrapper.style.values['--icon-detail'], 'rgba(254,220,186,1)');
  assert.equal(wrapper.style.values['--icon-duration'], '600ms');
  assert.equal(motionScopes.at(-1)[1], wrapper);
  const preview = element();
  theme.refreshIcons({ ...svg, parentElement: preview, closest: () => ({ dataset: { appearancePreview: true } }) });
  assert.deepEqual(preview.style.values, {});
  assert.deepEqual(preview.dataset, {});
});

test('editor status refreshes keep theme icon colours locked and enable all three channels only in Custom mode', () => {
  const source = read('src/renderer/appearance-editor.js');
  const A = require('../src/modules/appearance');
  for (const [palette, base, disabled] of [['theme', 'classic', true], ['custom', 'classic', false], ['custom', 'high-contrast', true]]) {
    const controls = new Map(['iconPrimaryColor', 'iconSecondaryColor', 'iconDetailColor'].map(key =>
      [key, { input: { disabled: !disabled }, field: A.fields[key] }]));
    const nodes = new Map();
    const context = vm.createContext({ A, controls, tr: (_key, fallback) => fallback, source: {}, scope: '', draft: A.normalize({ base, global: { iconPalette: palette } }),
      initialized: true, busy: false, dirty: () => false, message: '', messageError: false, undo: [], redo: [], library: [], selectedPreset: '',
      host: { querySelectorAll: () => [], setAttribute() {} },
      $: id => { if (!nodes.has(id)) nodes.set(id, { dataset: {} }); return nodes.get(id); },
    });
    vm.runInContext(source.slice(source.indexOf('  const contrastLocked ='), source.indexOf('  function target()')), context);
    vm.runInContext(source.slice(source.indexOf('  function renderStatus()'), source.indexOf('  function renderPreview()')), context);
    vm.runInContext('renderStatus()', context);
    for (const { input } of controls.values()) assert.equal(input.disabled, disabled, `${palette}/${base}`);
  }
});

test('the generated catalogues are reproducible from pinned SVG sources with both required licence notices', () => {
  const output = generate();
  assert.equal(read('src/renderer/widget-icons.js'), output.widget);
  assert.equal(read('src/renderer/ui-icons.js'), output.ui);
  assert.equal(read('src/renderer/icons.css'), output.css);
  const manifest = JSON.parse(read('assets/icons/lucide/manifest.json'));
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    const source = read(`assets/icons/lucide/${file}`);
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), expected, file);
    if (file.endsWith('.svg')) assert.doesNotMatch(source, /<script|<foreignObject|href=|https?:\/\/(?!www\.w3\.org)/i, file);
  }
  const license = read('assets/icons/lucide/LICENSE');
  assert.match(license, /ISC License[\s\S]*Lucide Icons and Contributors/);
  assert.match(license, /The MIT License[\s\S]*Cole Bemis/);
  const about = read('src/renderer/settings.html');
  assert.match(about, /id="tab-about"/);
  assert.match(about, /id="icon-license-notices"/);
  assert.ok(about.includes(license.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
});

test('all generic mask fallbacks resolve to bundled assets and local icon pages load the SVG runtime', () => {
  const css = read('src/renderer/icons.css');
  assert.doesNotMatch(css, /url\(['"]?https?:/);
  for (const [, relative] of css.matchAll(/url\(['"]([^'"]+)['"]\)/g)) {
    assert.equal(fs.existsSync(path.resolve(root, 'src/renderer', relative)), true, relative);
  }
  for (const filename of fs.readdirSync(path.join(root, 'src/renderer')).filter(name => name.endsWith('.html'))) {
    const html = read(`src/renderer/${filename}`);
    if (html.includes('href="icons.css"')) assert.match(html, /<script[^>]+src="ui-icons\.js"[^>]*><\/script>/, filename);
  }
  assert.match(css, /data-motion-level='off'[\s\S]*animation: none !important/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /data-motion-paused='true'/);
});

test('SVG parsing preserves independent relative paths and primitive attributes without conversion', () => {
  assert.deepEqual(parseSvg('<svg><path d="M2 3h8"/><path d="m1 2 4 5"/></svg>'), [
    { tag: 'path', attributes: { d: 'M2 3h8' } }, { tag: 'path', attributes: { d: 'm1 2 4 5' } },
  ]);
  assert.deepEqual(parseSvg('<svg><circle cx="12" cy="12" r="10"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>'), [
    { tag: 'circle', attributes: { cx: '12', cy: '12', r: '10' } },
    { tag: 'rect', attributes: { x: '3', y: '3', width: '18', height: '18', rx: '2' } },
  ]);
  assert.throws(() => parseSvg('<svg></svg>'), /vector geometry/);
});
