'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Layouts = require('../src/modules/layouts');

const rectangle = { x: -1920, y: -240, width: 360, height: 240 };
const arrangement = () => ({ dockEdge: 'left', dockAutoHide: true, dockWidgetOrder: ['minimap', 'boss'],
  widgetVisibility: { boss: true, minimap: true, 'title-tracker': true },
  widgetOpen: { boss: true, minimap: false }, widgetDocked: { boss: false },
  widgetBounds: { boss: rectangle }, display: { x: -1920, y: -240, width: 1920, height: 1080 } });

test('layout capture includes complete arrangements and prefers live bounds without copying private config', () => {
  const config = { ...arrangement(), widgetBounds_boss: rectangle, widgetBounds_minimap: { ...rectangle, x: -1400 },
    accountId: 'private-account', eeLogPath: 'C:/private/EE.log', interactionHotkey: 'Alt+F1',
    screenshotDir: 'C:/private/pictures', appearance: { base: 'midnight' }, savedTimers: ['private-timer'],
    savedLayouts: [{ id: 'recursive' }], unrelatedWidgetOption: true };
  const snapshot = JSON.stringify(config);
  const captured = Layouts.captureLayout(config, { display: arrangement().display,
    widgetBounds: { boss: { ...rectangle, x: -1300 }, unknown: rectangle } });
  assert.equal(captured.dockEdge, 'left');
  assert.equal(captured.dockAutoHide, true);
  assert.deepEqual(captured.dockWidgetOrder.slice(0, 2), ['minimap', 'boss']);
  assert.equal(captured.dockWidgetOrder.length, Layouts.WIDGET_IDS.length);
  assert.equal(captured.widgetVisibility.boss, true);
  assert.equal(captured.widgetVisibility.weather, false);
  assert.equal(captured.widgetVisibility['title-tracker'], true, 'Beta selections remain shareable');
  assert.equal(captured.widgetOpen.boss, true);
  assert.equal(captured.widgetOpen.weather, false);
  assert.equal(captured.widgetDocked.boss, false);
  assert.equal(captured.widgetDocked.weather, true);
  assert.deepEqual(captured.widgetBounds.boss, { ...rectangle, x: -1300 });
  assert.deepEqual(captured.widgetBounds.minimap, { ...rectangle, x: -1400 });
  assert.deepEqual(captured.display, arrangement().display);
  assert.equal(JSON.stringify(config), snapshot, 'Capturing cannot edit the live configuration');
  for (const secret of ['accountId', 'eeLogPath', 'interactionHotkey', 'screenshotDir', 'appearance', 'savedTimers', 'savedLayouts']) {
    assert.equal(Object.hasOwn(captured, secret), false, secret);
  }
  assert.equal(Object.hasOwn(captured.widgetBounds, 'unknown'), false);
});

test('size intent and fine resize mode round-trip with independent automatic axes', () => {
  const original = { ...arrangement(), widgetSizes: { boss: { width: 427, height: null },
    resources: { width: null, height: 491 } }, widgetResizeMode: 'free' };
  const normalized = Layouts.normalizeLayout(original, { strict: true });
  assert.deepEqual(normalized.widgetSizes, original.widgetSizes);
  assert.equal(normalized.widgetResizeMode, 'free');
  const imported = Layouts.validateImport(Layouts.exportLayout('Precise sizes', original));
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.layout.widgetSizes, original.widgetSizes);
  assert.equal(imported.layout.widgetResizeMode, 'free');
  const automatic = Layouts.normalizeLayout({ ...original, widgetSizes: {} });
  assert.deepEqual(automatic.widgetSizes, {}, 'Explicit Auto does not infer a fixed size from saved native bounds');
  for (const value of [{ widgetSizes: [] }, { widgetSizes: { daily: { width: 500 } } },
    { widgetSizes: { boss: { width: NaN } } }, { widgetResizeMode: 'wild' }]) {
    assert.throws(() => Layouts.normalizeLayout(value, { strict: true }), /widget/i);
  }
});

test('older layouts infer their original width-only or map/data size behaviour', () => {
  const legacy = Layouts.normalizeLayout({ widgetBounds: { boss: { ...rectangle, width: 427, height: 191 },
    minimap: { ...rectangle, width: 477, height: 399 }, daily: { ...rectangle, width: 700, height: 500 } } });
  assert.deepEqual(legacy.widgetSizes, { boss: { width: 427, height: null }, minimap: { width: 477, height: 399 } });
  assert.equal(legacy.widgetResizeMode, 'grid');
  assert.deepEqual(Layouts.normalizeLayout(legacy), legacy);
});

test('layout widget IDs cover all supported dock widgets and the market and beta entries', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const declared = [...['COLLECTION_WIDGET_IDS', 'ALL_WIDGET_IDS'].flatMap(name =>
    [...main.match(new RegExp(`const ${name} = \\[([^;]+)\\];`))[1].matchAll(/'([^']+)'/g)].map(match => match[1])), 'market', 'daily', 'title-tracker'];
  assert.deepEqual(new Set(Layouts.WIDGET_IDS), new Set(declared));
});

test('normalization is idempotent, detaches values, and recovers corrupt persisted fields', () => {
  const original = arrangement();
  const normalized = Layouts.normalizeLayout(original);
  assert.deepEqual(Layouts.normalizeLayout(normalized), normalized);
  normalized.widgetBounds.boss.x = 50;
  assert.equal(original.widgetBounds.boss.x, -1920);
  const recovered = Layouts.normalizeLayout({ dockEdge: 'diagonal', dockAutoHide: 'yes', dockWidgetOrder: ['boss', 'boss', 'unknown'],
    widgetVisibility: { boss: 'yes', minimap: true }, widgetOpen: [], widgetDocked: null,
    widgetBounds: { boss: { x: Infinity, y: 0, width: 400, height: 300 } }, display: { x: 0 } });
  assert.equal(recovered.dockEdge, 'bottom');
  assert.equal(recovered.dockAutoHide, false);
  assert.equal(recovered.widgetVisibility.boss, false);
  assert.equal(recovered.widgetVisibility.minimap, true);
  assert.equal(recovered.widgetOpen.boss, false);
  assert.equal(recovered.widgetDocked.boss, true);
  assert.deepEqual(recovered.widgetBounds, {});
  assert.equal(Object.hasOwn(recovered, 'display'), false);
  assert.equal(recovered.dockWidgetOrder.filter(id => id === 'boss').length, 1);
});

test('strict layout validation rejects malformed choices and unsafe geometry with useful errors', () => {
  for (const invalid of [null, [], { dockEdge: 'diagonal' }, { dockAutoHide: 1 }, { dockWidgetOrder: {} },
    { widgetVisibility: [] }, { widgetOpen: { boss: 'true' } }, { widgetDocked: { boss: null } },
    { widgetBounds: [] }, { display: {} }, { widgetBounds: { boss: { ...rectangle, width: 0 } } },
    { widgetBounds: { boss: { ...rectangle, height: 32769 } } }, { widgetBounds: { boss: { ...rectangle, x: 1_000_001 } } },
    { widgetBounds: { boss: { ...rectangle, y: NaN } } }, { widgetBounds: { boss: { ...rectangle, width: '400' } } }]) {
    assert.throws(() => Layouts.normalizeLayout(invalid, { strict: true }), /layout|widget|position|display/i);
  }
  assert.deepEqual(Layouts.normalizeLayout({ widgetBounds: { boss: rectangle } }, { strict: true }).widgetBounds.boss, rectangle);
});

test('custom names support Unicode, trim spaces and reject empty, oversized or multiline names', () => {
  assert.equal(Layouts.layoutName('  夜の森 🌙  '), '夜の森 🌙');
  assert.equal(Layouts.layoutName('x'.repeat(80)).length, 80);
  for (const name of [undefined, null, 42, '', '   ', 'x'.repeat(81), 'a\nb', 'a\rb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b']) {
    assert.throws(() => Layouts.layoutName(name), /name between 1 and 80/);
  }
});

test('saved layouts retain names and choices while corrupt entries and duplicate IDs recover safely', () => {
  const valid = { id: 'forest-layout_1', name: '  Forest  ', layout: arrangement(), private: 'ignored' };
  const values = [null, { id: '__proto__', name: 'Bad', layout: {} }, valid,
    { ...valid, name: 'Duplicate' }, { id: 'broken', name: 'Broken', layout: null },
    { id: 'second', name: '第二', layout: { dockEdge: 'right' } }];
  const normalized = Layouts.normalizeSavedLayouts(values);
  assert.deepEqual(normalized.map(value => [value.id, value.name]), [['forest-layout_1', 'Forest'], ['second', '第二']]);
  assert.equal(Object.hasOwn(normalized[0], 'private'), false);
  assert.equal(normalized[0].layout.widgetVisibility['title-tracker'], true);
  assert.deepEqual(Layouts.normalizeSavedLayouts(normalized), normalized);
  assert.deepEqual(Layouts.normalizeSavedLayouts('broken'), []);
  assert.deepEqual(Layouts.normalizeSavedLayouts(), []);
});

test('strict saved collection validation rejects invalid or duplicate identifiers and enforces its cap', () => {
  const item = { id: 'layout-1', name: 'One', layout: arrangement() };
  assert.throws(() => Layouts.normalizeSavedLayouts([item, item], { strict: true }), /identifiers.*unique/);
  assert.throws(() => Layouts.normalizeSavedLayouts([{ ...item, id: '../private' }], { strict: true }), /identifiers/);
  assert.throws(() => Layouts.normalizeSavedLayouts([{ ...item, layout: null }], { strict: true }), /arrangement/);
  assert.throws(() => Layouts.normalizeSavedLayouts([{ ...item, layout: { dockEdge: 'bad' } }], { strict: true }), /edge/);
  const many = Array.from({ length: Layouts.MAX_LAYOUTS + 1 }, (_, index) => ({ ...item, id: `layout-${index}` }));
  assert.throws(() => Layouts.normalizeSavedLayouts(many, { strict: true }), /at most 50/);
  assert.equal(Layouts.normalizeSavedLayouts(many).length, Layouts.MAX_LAYOUTS);
});

test('export and import round-trip a versioned arrangement with no live config or internal identifier', () => {
  const exported = Layouts.exportLayout(' Dungeon 🌿 ', { ...arrangement(), accountId: 'private', eeLogPath: 'private', savedLayouts: [] });
  const file = JSON.parse(exported);
  assert.deepEqual(Object.keys(file), ['format', 'version', 'name', 'layout']);
  assert.equal(file.format, 'overkot-layout');
  assert.equal(file.version, 1);
  assert.equal(file.name, 'Dungeon 🌿');
  assert.equal(Object.hasOwn(file.layout, 'accountId'), false);
  const imported = Layouts.validateImport(exported);
  assert.equal(imported.ok, true);
  assert.equal(imported.name, 'Dungeon 🌿');
  assert.deepEqual(imported.layout, Layouts.normalizeLayout(arrangement()));
  assert.equal(Layouts.validateImport('\uFEFF' + exported).ok, true, 'JSON saved with a Windows BOM remains readable');
});

test('import rejects incompatible files, malformed layouts and oversized UTF-8 content', () => {
  const file = JSON.parse(Layouts.exportLayout('One', arrangement()));
  for (const input of [null, 'not JSON', '[]', '{}', JSON.stringify({ ...file, format: 'overkot-appearance' }),
    JSON.stringify({ ...file, version: 2 }), JSON.stringify({ ...file, version: '1' }),
    JSON.stringify({ ...file, layout: null }), JSON.stringify({ ...file, name: '' }),
    JSON.stringify({ ...file, layout: { widgetBounds: { boss: { ...rectangle, height: -1 } } } })]) {
    const result = Layouts.validateImport(input);
    assert.equal(result.ok, false, String(input));
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 10);
  }
  const oversized = JSON.stringify({ ...file, unrelated: 'é'.repeat(Layouts.MAX_FILE_BYTES / 2) });
  assert.match(Layouts.validateImport(oversized).message, /256 KB/);
});

test('unknown fields and prototype keys never escape the validated arrangement', () => {
  const text = '{"format":"overkot-layout","version":1,"name":"Shared","__proto__":{"polluted":true},"accountId":"private","layout":{"dockEdge":"top","accountId":"private","appearance":{"base":"midnight"},"widgetVisibility":{"boss":true,"unknown":true,"__proto__":{"polluted":true}},"widgetBounds":{"boss":{"x":1,"y":2,"width":300,"height":200,"eeLogPath":"private"},"__proto__":{"polluted":true}}}}';
  const result = Layouts.validateImport(text);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ['layout', 'name', 'ok']);
  assert.equal(result.layout.widgetVisibility.boss, true);
  assert.deepEqual(result.layout.widgetBounds.boss, { x: 1, y: 2, width: 300, height: 200 });
  for (const object of [result, result.layout, result.layout.widgetVisibility, result.layout.widgetBounds, result.layout.widgetBounds.boss]) {
    assert.equal(Object.hasOwn(object, '__proto__'), false);
    assert.equal(Object.hasOwn(object, 'accountId'), false);
  }
  assert.equal({}.polluted, undefined);
});
