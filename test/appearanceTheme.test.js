'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appearance = require('../src/modules/appearance');
const theme = require('../src/renderer/theme');

const config = (global = {}, widgets = {}) => ({ appearance: { version: 1, base: 'dark-mint', global, widgets } });

test('font stacks preserve typeface choices and select the right local CJK or Thai glyphs offline', () => {
  for (const [language, native, web] of [
    ['tc', 'Microsoft JhengHei', 'Noto Sans TC'], ['zh-Hans-CN', 'Microsoft YaHei', 'Noto Sans SC'],
    ['th', 'Leelawadee UI', 'Noto Sans Thai'], ['ja', 'Yu Gothic UI', 'Noto Sans JP'], ['ko', 'Malgun Gothic', 'Noto Sans KR'],
  ]) {
    const system = theme.variables({ language })['--font-ui'];
    assert.ok(system.indexOf(native) >= 0 && system.indexOf(native) < system.indexOf('system-ui'), language);
    assert.ok(system.indexOf(web) >= 0 && system.indexOf(web) < system.indexOf('sans-serif'), language);
    assert.match(theme.variables({ ...config({ fontFamily: 'serif' }), language })['--font-ui'], /^'Georgia'.*, serif$/);
    assert.match(theme.variables({ ...config({ fontFamily: 'mono' }), language })['--font-ui'], /^'Cascadia Code'.*, monospace$/);
  }
  assert.doesNotMatch(appearance.fontStack('system', 'zh-Hant-TW'), /YaHei|Sans SC|Sans JP/);
  assert.doesNotMatch(appearance.fontStack('system', 'zh-Hans-CN'), /JhengHei|Sans TC|Sans JP/);
});

test('every themed window updates its language and requests the matching font only when its own CSP permits it', () => {
  for (const networkFonts of [true, false]) {
    const links = [], root = { dataset: {}, style: { setProperty() {} } };
    const document = { documentElement: root, head: { appendChild: link => links.push(link.href) },
      querySelector: () => ({ content: networkFonts ? 'style-src https://fonts.googleapis.com; font-src https://fonts.gstatic.com' : "default-src 'self'" }),
      querySelectorAll: () => [], createElement: () => ({}), addEventListener() {} };
    let changeTheme;
    const window = { OverkotAppearance: appearance, location: { search: '' }, api: { onThemeChanged: cb => { changeTheme = cb; } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/theme.js'), 'utf8'), { window, document, URLSearchParams });
    for (const locale of ['zh-Hant-TW', 'zh-Hans-CN', 'th', 'zh-Hant-TW']) {
      changeTheme({ locale });
      assert.equal(root.lang, locale);
    }
    assert.deepEqual(links.map(link => new URL(link).searchParams.get('family').split(':')[0]),
      networkFonts ? ['Noto Sans TC', 'Noto Sans SC', 'Noto Sans Thai'] : []);
  }
});

test('Classic background100 paints an actually opaque card without a hidden alpha reduction', () => {
  const values = theme.variables({ appearance: appearance.builtins.classic.appearance });
  assert.equal(values['--widget-bg'], 'rgba(27,27,27,1)');
  assert.equal(values['--bg-base'], 'rgba(0,0,0,1)');
  assert.equal(values['--background-opacity'], '1');
  assert.equal(values['--elements-opacity'], '1');
});

test('background and foreground alpha remain independent and foreground fine controls multiply only once', () => {
  const backgroundHidden = theme.variables(config({ backgroundOpacity: 0, elementOpacity: 100 }));
  assert.equal(backgroundHidden['--widget-bg'], 'rgba(27,33,30,0)');
  assert.equal(backgroundHidden['--text-primary'], 'rgba(213,225,218,1)');
  assert.equal(backgroundHidden['--bar-color'], 'rgba(139,189,165,1)');
  const foregroundHidden = theme.variables(config({ backgroundOpacity: 100, elementOpacity: 0 }));
  assert.equal(foregroundHidden['--widget-bg'], 'rgba(27,33,30,1)');
  assert.equal(foregroundHidden['--text-primary'], 'rgba(213,225,218,0)');
  assert.equal(foregroundHidden['--bar-color'], 'rgba(139,189,165,0)');
  assert.equal(foregroundHidden['--icon-primary'], 'rgba(213,225,218,0)');
  assert.equal(foregroundHidden['--elements-opacity'], '0');
  const partly = theme.variables(config({ backgroundOpacity: 40, elementOpacity: 50, textOpacity: 60, barOpacity: 80 }));
  assert.equal(partly['--widget-bg'], 'rgba(27,33,30,0.4)');
  assert.equal(partly['--text-primary'], 'rgba(213,225,218,0.3)');
  assert.equal(partly['--icon-primary'], 'rgba(213,225,218,0.3)');
  assert.equal(partly['--bar-color'], 'rgba(139,189,165,0.4)');
  assert.equal(partly['--elements-opacity'], '0.5');
  assert.equal(partly['--text-elements-opacity'], '0.3');
  assert.equal(partly['--bar-elements-opacity'], '0.4');
});

test('transparent panel backgrounds remove their shadow, glow and tint while inner surfaces stay independent', () => {
  const values = theme.variables(config({ backgroundOpacity: 0, surfaceOpacity: 100, shadow: 100, glow: 100, backgroundTreatment: 'tint' }));
  assert.match(values['--surface-shadow'], /rgba\(0,0,0,0\)/);
  assert.match(values['--surface-glow'], /rgba\(139,189,165,0\)/);
  assert.match(values['--panel-surface-treatment'], /rgba\(139,189,165,0\)/);
  assert.match(values['--surface-treatment'], /rgba\(139,189,165,0\.07\)/);
  assert.equal(values['--text-primary'], 'rgba(213,225,218,1)');
});

test('progress milestones follow the same foreground alpha as their bar', () => {
  for (const global of [{ elementOpacity: 0 }, { barOpacity: 0 }]) {
    const values = theme.variables(config({ ...global, milestoneEmphasis: true }));
    assert.equal(values['--milestone-opacity'], '0');
  }
  const partly = theme.variables(config({ elementOpacity: 50, barOpacity: 80, milestoneEmphasis: true }));
  assert.ok(Math.abs(Number(partly['--milestone-opacity']) - .16) < 1e-12);
  assert.equal(theme.variables(config({ milestoneEmphasis: false }))['--milestone-opacity'], '0');
});

test('sharp and explicit zero corner settings resolve every nested shape to zero', () => {
  for (const global of [{ cornerShape: 'sharp', cornerRadius: 24 }, { cornerShape: 'rounded', cornerRadius: 0 }, { cornerShape: 'pill', cornerRadius: 0 }, { cornerShape: 'pill', cornerRadius: 0, barShape: 'pill' }]) {
    const values = theme.variables(config(global));
    for (const name of ['--radius-panel', '--radius-control', '--radius-inner', '--radius-bar']) assert.equal(values[name], '0px', name);
  }
});

test('rounded, pill and explicit bar shapes have consistent panel and control mappings', () => {
  const rounded = theme.variables(config({ cornerRadius: 14, borderWidth: 2, barHeight: 12 }));
  assert.equal(rounded['--radius-panel'], '14px'); assert.equal(rounded['--radius-inner'], '12px');
  assert.equal(rounded['--radius-control'], '12px'); assert.equal(rounded['--radius-bar'], '6px');
  const pill = theme.variables(config({ cornerShape: 'pill', cornerRadius: 32 }));
  assert.equal(pill['--radius-panel'], '18px'); assert.equal(pill['--radius-control'], '999px'); assert.equal(pill['--radius-bar'], '999px');
  assert.equal(theme.variables(config({ cornerShape: 'pill', barShape: 'sharp' }))['--radius-bar'], '0px');
});

test('widget overrides inherit and reset without substituting valid zero values', () => {
  const value = config({ cornerRadius: 14, borderWidth: 3 }, { boss: { cornerRadius: 0, borderWidth: 0 } });
  assert.equal(theme.variables(value, 'boss')['--radius-panel'], '0px');
  assert.equal(theme.variables(value, 'boss')['--border-width'], '0px');
  assert.equal(theme.variables(value, 'crafting')['--radius-panel'], '14px');
  delete value.appearance.widgets.boss;
  assert.equal(theme.variables(value, 'boss')['--border-width'], '3px');
});

test('appearance colors, transparency, typography and progress labels reach actual tokens', () => {
  const values = theme.variables(config({ backgroundOpacity: 0, textOpacity: 50, borderOpacity: 0, fontFamily: 'serif', fontSize: 18,
    textColor: '#ffffff', progressColor: '#123456', barLabels: 'below', barHeight: 10, numericStyle: 'proportional' }));
  assert.equal(values['--bg-base'], 'rgba(16,23,19,0)');
  assert.equal(values['--text-primary'], 'rgba(255,255,255,0.5)');
  assert.equal(values['--bar-color'], 'rgba(18,52,86,1)');
  assert.equal(values['--font-size'], '18px'); assert.match(values['--font-ui'], /Georgia/);
  assert.equal(values['--numeric-style'], 'proportional-nums');
  assert.equal(values['--bar-label-offset'], '12px'); assert.equal(values['--bar-overflow'], 'visible');
  assert.equal(values['--theme-border'], 'rgba(139,189,165,0)');
  assert.equal(theme.variables(config({ barLabels: 'hidden' }))['--bar-label-display'], 'none');
});

test('High Contrast keeps opaque readable colors while allowing sharp and zero decorative borders', () => {
  const values = theme.variables({ appearance: { version: 1, base: 'high-contrast', global: { backgroundOpacity: 0, elementOpacity: 0, textOpacity: 0, borderWidth: 0, cornerRadius: 0, textColor: '#000000' } } });
  assert.equal(values['--text-primary'], 'rgba(255,255,255,1)');
  assert.equal(values['--widget-bg'], 'rgba(0,0,0,1)');
  assert.equal(values['--elements-opacity'], '1');
  assert.equal(values['--border-width'], '0px'); assert.equal(values['--radius-panel'], '0px');
  const hiddenBorder = theme.variables({ appearance: { version: 1, base: 'high-contrast', global: { borderOpacity: 0, textOpacity: 0 } } });
  assert.equal(hiddenBorder['--theme-border'], 'rgba(255,255,255,0)');
  assert.equal(hiddenBorder['--focus-color'], 'rgba(255,255,0,1)');
  assert.equal(theme.variables(config({ textOpacity: 0 }))['--focus-color'], 'rgba(139,189,165,1)');
});

test('inside labels adapt to thin tracks or large text without changing the requested preset values', () => {
  const requested = config({ fontSize: 20, barHeight: 4, barLabels: 'inside' });
  const values = theme.variables(requested);
  assert.equal(values['--bar-height'], '4px'); assert.equal(values['--type-caption'], '17px');
  assert.equal(values['--bar-label-offset'], '6px'); assert.equal(values['--bar-overflow'], 'visible');
  assert.equal(values['--bar-label-space'], '24px');
  const imported = appearance.validateImport(appearance.exportPreset('Large type, thin track', requested.appearance));
  assert.equal(imported.preset.appearance.global.barLabels, 'inside');
  assert.deepEqual(theme.variables({ appearance: imported.preset.appearance }), values);
  assert.equal(theme.variables(config({ fontSize: 12, barHeight: 16, barLabels: 'inside' }))['--bar-label-offset'], '0px');
  assert.equal(theme.variables(config({ fontSize: 20, barHeight: 4, barLabels: 'hidden' }))['--bar-label-display'], 'none');
});

test('all built-in themes generate finite tokens and distinct shapes after export/import', () => {
  for (const preset of Object.values(appearance.builtins)) {
    const original = theme.variables({ appearance: preset.appearance }, 'boss');
    const imported = appearance.validateImport(appearance.exportPreset(preset.name, preset.appearance));
    assert.equal(imported.ok, true);
    assert.deepEqual(theme.variables({ appearance: imported.preset.appearance }, 'boss'), original);
    for (const [name, value] of Object.entries(original)) assert.doesNotMatch(value, /NaN|undefined|Infinity/, `${preset.name}: ${name}`);
  }
});

test('scoped previews use the renderer without replacing global or other widget appearance', () => {
  const element = () => ({ dataset: {}, style: { values: {}, setProperty(key, value) { this.values[key] = value; }, removeProperty(key) { delete this.values[key]; } } });
  const root = element(), body = element(), widget = element(), preview = element(); widget.dataset.widget = 'boss';
  const document = { documentElement: root, body, querySelectorAll: () => [widget], addEventListener() {} };
  const window = { OverkotAppearance: appearance, location: { search: '' }, api: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/theme.js'), 'utf8'), { window, document, URLSearchParams });
  window.OverkotTheme.apply(config({ cornerRadius: 12 }, { boss: { cornerRadius: 0 } }));
  assert.equal(root.style.values['--radius-panel'], '12px'); assert.equal(widget.style.values['--radius-panel'], '0px');
  window.OverkotTheme.apply(config({ cornerShape: 'pill', cornerRadius: 18 }), { root: preview, widgetId: 'crafting' });
  assert.equal(preview.style.values['--radius-control'], '999px');
  assert.equal(root.style.values['--radius-panel'], '12px'); assert.equal(widget.style.values['--radius-panel'], '0px');
});
