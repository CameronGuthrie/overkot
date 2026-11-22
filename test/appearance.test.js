const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Appearance = require('../src/modules/appearance');

test('Classic starts fully opaque without replacing an explicit saved opacity choice', () => {
  for (const source of [{}, { appearance: Appearance.builtins.classic.appearance }]) {
    const values = Appearance.resolve(source);
    assert.equal(values.backgroundOpacity, 100);
    assert.equal(values.elementOpacity, 100);
    assert.equal(values.surfaceOpacity, 100);
  }
  for (const backgroundOpacity of [0, 60, 100]) {
    assert.equal(Appearance.resolve({ theme: 'classic', backgroundOpacity }).backgroundOpacity, backgroundOpacity);
    assert.equal(Appearance.resolve({ appearance: { base: 'classic', global: { backgroundOpacity } } }).backgroundOpacity, backgroundOpacity);
  }
  for (const [id, backgroundOpacity] of [['grove', 82], ['obsidian', 90], ['ember', 86]]) {
    assert.equal(Appearance.resolve({ appearance: Appearance.builtins[id].appearance }).backgroundOpacity, backgroundOpacity);
  }
});

test('background and element opacity inherit and round-trip independently for each widget', () => {
  const appearance = Appearance.normalize({ global: { backgroundOpacity: 0, elementOpacity: 100 },
    widgets: { clock: { backgroundOpacity: 100, elementOpacity: 0 }, minimap: { elementOpacity: 47 } } }, { strict: true });
  assert.equal(Appearance.resolve({ appearance }, 'clock').backgroundOpacity, 100);
  assert.equal(Appearance.resolve({ appearance }, 'clock').elementOpacity, 0);
  assert.equal(Appearance.resolve({ appearance }, 'minimap').backgroundOpacity, 0);
  assert.equal(Appearance.resolve({ appearance }, 'minimap').elementOpacity, 47);
  assert.equal(Appearance.resolve({ appearance }, 'boss').elementOpacity, 100);
  const imported = Appearance.validateImport(Appearance.exportPreset('Independent opacity', appearance));
  assert.equal(imported.ok, true); assert.deepEqual(imported.preset.appearance, appearance);
  delete appearance.widgets.clock.elementOpacity;
  assert.equal(Appearance.resolve({ appearance }, 'clock').elementOpacity, 100, 'Resetting just the elements field restores global inheritance');
  for (const invalid of [-1, 101, NaN, '50']) assert.throws(() => Appearance.normalize({ global: { elementOpacity: invalid } }, { strict: true }));
});

test('legacy themes and opacity choices migrate without losing explicit zeroes', () => {
  const saved = { theme: 'ember', backgroundOpacity: 0, fontOpacity: 64, barOpacity: 0, widgetOutlineOpacity: 0,
    accountId: 'private-account', screenshotDir: 'private-path' };
  const migrated = Appearance.extract(saved);
  assert.deepEqual(migrated, { version: 1, base: 'ember', global: { backgroundOpacity: 0, textOpacity: 64, barOpacity: 0, widgetOutlineOpacity: 0 }, widgets: {} });
  const values = Appearance.resolve({ appearance: migrated });
  assert.equal(values.textColor, Appearance.palettes.ember.text);
  assert.equal(values.backgroundOpacity, 0);
  assert.equal(values.barOpacity, 0);
  assert.equal(values.widgetOutlineOpacity, 0);
  assert.deepEqual(Appearance.extract({ appearance: migrated }), migrated);
  assert.equal(Appearance.resolve({ theme: 'missing' }).base, 'classic');
});

test('global and widget appearance inherit independently; deleting overrides restores parent values', () => {
  const appearance = Appearance.normalize({ base: 'dark-mint', global: { cornerShape: 'rounded', cornerRadius: 16, borderWidth: 2 },
    widgets: { boss: { cornerShape: 'sharp', cornerRadius: 0, borderWidth: 0 }, crafting: { borderColor: '#abcdef' } } });
  assert.equal(Appearance.resolve({ appearance }, 'boss').cornerRadius, 0);
  assert.equal(Appearance.resolve({ appearance }, 'boss').borderWidth, 0);
  assert.equal(Appearance.resolve({ appearance }, 'crafting').cornerRadius, 16);
  assert.equal(Appearance.resolve({ appearance }, 'crafting').borderColor, '#abcdef');
  delete appearance.widgets.boss.cornerRadius;
  assert.equal(Appearance.resolve({ appearance }, 'boss').cornerRadius, 16);
  delete appearance.widgets.boss;
  assert.equal(Appearance.resolve({ appearance }, 'boss').cornerShape, 'rounded');
  delete appearance.global.cornerRadius;
  assert.equal(Appearance.resolve({ appearance }, 'boss').cornerRadius, Appearance.defaults.cornerRadius);
});

test('every control has one validated default, and builtins demonstrate sharp, round and pill geometry', () => {
  for (const [key, field] of Object.entries(Appearance.fields)) {
    assert.equal(Appearance.validField(key, field.default), true, key);
    assert.ok(field.label && field.section, key);
    if (field.type === 'number') {
      assert.equal(Appearance.validField(key, field.min), true, key);
      assert.equal(Appearance.validField(key, field.max), true, key);
      assert.equal(Appearance.validField(key, field.min - 1), false, key);
      assert.equal(Appearance.validField(key, field.max + 1), false, key);
      assert.equal(Appearance.validField(key, String(field.default)), false, key);
      assert.equal(Appearance.validField(key, NaN), false, key);
    }
  }
  assert.deepEqual(new Set(Object.values(Appearance.builtins).map(preset => Appearance.resolve({ appearance: preset.appearance }).cornerShape)), new Set(['sharp', 'rounded', 'pill']));
  assert.equal(Appearance.resolve({ appearance: Appearance.builtins.obsidian.appearance }).cornerRadius, 0);
  assert.equal(Appearance.resolve({}).borderOpacity, 24, 'The slider describes the actual default border alpha');
  assert.equal(Appearance.resolve({ theme: 'high-contrast' }).borderOpacity, 100);
  assert.equal(Appearance.resolve({ appearance: { base: 'high-contrast', global: { borderOpacity: 0 } } }).borderOpacity, 0);
});

test('renamed starting styles retain their palette IDs and round-trip existing appearance data', () => {
  assert.deepEqual(Object.values(Appearance.builtins).map(preset => preset.name),
    ['Classic', 'Spirit', 'Grace', 'Courage', 'High Contrast']);
  for (const [id, base] of [['grove', 'dark-mint'], ['obsidian', 'midnight'], ['ember', 'ember']]) {
    const preset = Appearance.builtins[id];
    assert.equal(preset.appearance.base, base);
    const imported = Appearance.validateImport(Appearance.exportPreset(preset.name, preset.appearance));
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.preset.appearance, preset.appearance);
  }
});

test('appearance exports round-trip all global, widget, shape, border and motion values without private configuration', () => {
  const config = { theme: 'ember', accountId: 'PRIVATE-ACCOUNT', token: 'PRIVATE-TOKEN', screenshotDir: 'C:/PRIVATE-PATH' };
  const appearance = Appearance.extract(config);
  appearance.global = Object.fromEntries(Object.entries(Appearance.fields).map(([key, field]) => [key, field.default]));
  appearance.global.cornerRadius = 0;
  appearance.global.borderWidth = 0;
  appearance.global.cornerShape = 'sharp';
  appearance.global.motionLevel = 'off';
  appearance.widgets.boss = { cornerShape: 'pill', cornerRadius: 20, borderWidth: 2.5, borderOpacity: 0, barShape: 'pill' };
  const exported = Appearance.exportPreset('Personal style', appearance);
  assert.doesNotMatch(exported, /PRIVATE|accountId|token|screenshotDir|widgetBounds|layout/);
  const imported = Appearance.validateImport(exported);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.preset, { name: 'Personal style', appearance });
  assert.deepEqual(Appearance.resolve({ appearance }, 'boss'), Appearance.resolve({ appearance: imported.preset.appearance }, 'boss'));
  assert.equal(imported.summary.widgetCount, 1);
  assert.equal(imported.summary.motionLevel, 'off');
});

test('imports reject malformed, oversized, unsupported and out-of-range data without changing the source', () => {
  const valid = JSON.parse(Appearance.exportPreset('Test', Appearance.builtins.grove.appearance));
  const attempt = mutate => { const data = structuredClone(valid); mutate(data); return Appearance.validateImport(JSON.stringify(data)); };
  for (const result of [Appearance.validateImport('{'), Appearance.validateImport('x'.repeat(Appearance.MAX_FILE_BYTES + 1)),
    attempt(data => { data.version = 2; }), attempt(data => { data.appearance.version = 2; }),
    attempt(data => { data.appearance.base = 'unknown'; }), attempt(data => { data.appearance.global.borderWidth = -1; }),
    attempt(data => { data.appearance.global.cornerRadius = '0'; }), attempt(data => { data.appearance.global.accentColor = 'url(attack)'; }),
    attempt(data => { data.appearance.global.motionLevel = 'fast'; }), attempt(data => { data.appearance.widgets.boss = { ambientMotion: 'yes' }; }),
    attempt(data => { data.appearance.widgets = []; }), attempt(data => { data.name = ''; })]) {
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 10);
  }
  assert.equal(valid.appearance.global.cornerRadius, 12, 'Validation must never mutate the input');
});

test('unknown fields are ignored with useful warnings and cannot become executable styles or prototype keys', () => {
  const valid = JSON.parse(Appearance.exportPreset('Future file', { global: { cornerRadius: 0 } }));
  valid.futureRoot = 'ignored';
  valid.appearance.future = 'ignored';
  valid.appearance.global.customCSS = 'url(attack)';
  valid.appearance.widgets.futureWidget = { borderWidth: 1 };
  const imported = Appearance.validateImport(JSON.stringify(valid));
  assert.equal(imported.ok, true);
  assert.equal(imported.warnings.length, 4);
  assert.equal(imported.preset.appearance.global.cornerRadius, 0);
  assert.equal(Object.hasOwn(imported.preset.appearance.global, 'customCSS'), false);
  const malicious = Appearance.validateImport('{"format":"overkot-appearance","version":1,"name":"safe","appearance":{"global":{"__proto__":{"polluted":true}},"widgets":{"__proto__":{"borderWidth":4}}}}');
  assert.equal(malicious.ok, true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(malicious.preset.appearance.widgets, {});
});

test('named custom presets normalize, preserve independent values, and reject duplicate IDs', () => {
  const saved = [{ id: 'grove-copy', name: ' Grove copy ', appearance: Appearance.builtins.grove.appearance }];
  const checked = Appearance.normalizePresets(saved, { strict: true });
  assert.equal(checked[0].name, 'Grove copy');
  checked[0].appearance.global.cornerRadius = 0;
  assert.equal(saved[0].appearance.global.cornerRadius, 12);
  assert.throws(() => Appearance.normalizePresets([...saved, ...saved], { strict: true }), /unique/);
  assert.throws(() => Appearance.normalizePresets(Array.from({ length: 51 }, () => saved[0]), { strict: true }), /at most 50/);
  assert.deepEqual(Appearance.normalizePresets([{ id: '../bad', name: 'Bad' }, saved[0]]), Appearance.normalizePresets(saved));
});

test('same schema runs in a sandboxed renderer and broadcasts only allowlisted appearance data', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/appearance.js'), 'utf8'), { window, TextEncoder });
  assert.equal(window.OverkotAppearance.resolve({ theme: 'midnight' }).accentColor, Appearance.palettes.midnight.accent);
  const broadcast = Appearance.appearanceConfig({ accountId: 'private', token: 'secret', language: 'de', theme: 'ember',
    widgetOutlineOpacity: 0, appearancePresets: [{ secret: 'must not leave settings' }] });
  assert.equal(broadcast.theme, 'ember');
  assert.equal(broadcast.widgetOutlineOpacity, 0);
  assert.equal(broadcast.appearance.global.widgetOutlineOpacity, 0);
  assert.equal(Object.hasOwn(broadcast, 'accountId'), false);
  assert.equal(Object.hasOwn(broadcast, 'language'), false);
  assert.equal(Object.hasOwn(broadcast, 'appearancePresets'), false);
});
