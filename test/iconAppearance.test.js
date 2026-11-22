'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Appearance = require('../src/modules/appearance');
const Theme = require('../src/renderer/theme');
const Motion = require('../src/renderer/motion');
const { createAppearanceSession } = require('../src/modules/appearanceIpc');

const iconValues = {
  iconMotion: 'loop', iconPalette: 'custom', iconPrimaryColor: '#123456',
  iconSecondaryColor: '#abcdef', iconDetailColor: '#fedcba', iconSpeed: 125,
};
const appearance = () => Appearance.normalize({ base: 'dark-mint', global: iconValues,
  widgets: { clock: { iconMotion: 'off', iconPrimaryColor: '#ff0000', iconSpeed: 200 },
    weather: { iconPalette: 'theme', iconMotion: 'hover' } } }, { strict: true });

test('icon controls validate motion choices, palette channels and speed at global and widget scopes', () => {
  for (const key of Object.keys(iconValues)) assert.equal(Appearance.fields[key].section, 'icons');
  const defaults = Appearance.resolve({});
  assert.equal(defaults.iconMotion, 'hover');
  assert.equal(defaults.iconPalette, 'theme');
  assert.equal(defaults.iconSpeed, 100);
  for (const iconMotion of ['hover', 'loop', 'off']) for (const iconPalette of ['theme', 'custom']) {
    const checked = Appearance.normalize({ global: { ...iconValues, iconMotion, iconPalette } }, { strict: true });
    assert.equal(checked.global.iconMotion, iconMotion);
    assert.equal(checked.global.iconPalette, iconPalette);
  }
  for (const speed of [50, 100, 200]) {
    assert.equal(Appearance.normalize({ widgets: { clock: { iconSpeed: speed } } }, { strict: true }).widgets.clock.iconSpeed, speed);
  }
  for (const invalid of [{ iconMotion: 'bounce' }, { iconPalette: 'url' }, { iconSpeed: 49 }, { iconSpeed: 201 },
    { iconSpeed: '100' }, { iconSpeed: NaN }, { iconPrimaryColor: 'red' },
    { iconSecondaryColor: '#fff' }, { iconDetailColor: 'url(https://example.com/a.svg)' }]) {
    assert.throws(() => Appearance.normalize({ global: invalid }, { strict: true }));
    assert.throws(() => Appearance.normalize({ widgets: { clock: invalid } }, { strict: true }));
  }
});

test('icon overrides inherit independently and survive preset import/export with their motion settings', () => {
  const value = appearance();
  assert.equal(Appearance.resolve({ appearance: value }, 'clock').iconMotion, 'off');
  assert.equal(Appearance.resolve({ appearance: value }, 'clock').iconSecondaryColor, iconValues.iconSecondaryColor);
  assert.equal(Appearance.resolve({ appearance: value }, 'weather').iconPalette, 'theme');
  assert.equal(Appearance.resolve({ appearance: value }, 'weather').iconSpeed, 125);
  const exported = Appearance.exportPreset('Animated three-colour icons', value);
  const imported = Appearance.validateImport(exported);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.preset.appearance, value);
  for (const id of [undefined, 'clock', 'weather', 'boss']) {
    assert.deepEqual(Theme.variables({ appearance: imported.preset.appearance }, id), Theme.variables({ appearance: value }, id));
  }
  delete value.widgets.clock.iconMotion;
  assert.equal(Appearance.resolve({ appearance: value }, 'clock').iconMotion, 'loop');
  delete value.widgets.clock;
  assert.equal(Appearance.resolve({ appearance: value }, 'clock').iconPrimaryColor, iconValues.iconPrimaryColor);
});

test('icon previews cancel without saving, while Apply persists valid icon settings and retains unrelated preferences', () => {
  const original = Appearance.normalize({ base: 'classic' });
  const data = { appearance: original, appearancePresets: [], language: 'en', dockEdge: 'left', accountId: 'private' };
  const writes = [], broadcasts = [];
  let writable = true;
  const config = { getAll: () => ({ ...data }), setMany(patch) {
    if (!writable) return false;
    writes.push(structuredClone(patch)); Object.assign(data, patch); return true;
  } };
  const session = createAppearanceSession({ config, broadcast: value => broadcasts.push(value) });
  const value = appearance();
  assert.equal(session.preview(value).ok, true);
  assert.equal(Appearance.resolve(session.effectiveConfig()).iconMotion, 'loop');
  assert.equal(Appearance.resolve(session.effectiveConfig(), 'clock').iconSpeed, 200);
  assert.equal(writes.length, 0);
  assert.deepEqual(data.appearance, original);
  data.language = 'fr';
  session.cancel();
  assert.deepEqual(session.effectiveConfig().appearance, original);
  assert.equal(session.effectiveConfig().language, 'fr');

  session.preview(value);
  writable = false;
  assert.equal(session.apply({ appearance: value }).ok, false);
  assert.deepEqual(data.appearance, original);
  assert.equal(session.isPreviewing(), true);
  writable = true;
  const presets = [{ id: 'animated', name: 'Animated', appearance: value }];
  assert.equal(session.apply({ appearance: value, presets, accountId: 'discard-this' }).ok, true);
  assert.deepEqual(Object.keys(writes.at(-1)), ['appearance', 'appearancePresets']);
  assert.deepEqual(data.appearance, value);
  assert.deepEqual(data.appearancePresets, presets);
  assert.equal(data.language, 'fr');
  assert.equal(data.accountId, 'private');
  assert.equal(data.dockEdge, 'left');
  assert.equal(session.isPreviewing(), false);
  const reopened = createAppearanceSession({ config });
  assert.deepEqual(reopened.effectiveConfig().appearance, value);
  assert.equal(broadcasts.at(-1).appearance.widgets.clock.iconMotion, 'off');
});

test('theme tokens expose three custom colours and icon speed while theme mode follows the selected palette', () => {
  const value = appearance();
  value.global.textOpacity = 50;
  const tokens = Theme.variables({ appearance: value });
  assert.equal(tokens['--icon-primary'], 'rgba(18,52,86,0.5)');
  assert.equal(tokens['--icon-secondary'], 'rgba(171,205,239,0.5)');
  assert.equal(tokens['--icon-detail'], 'rgba(254,220,186,0.5)');
  assert.equal(tokens['--icon-duration'], '720ms');
  assert.equal(Theme.variables({ appearance: value }, 'clock')['--icon-primary'], 'rgba(255,0,0,0.5)');
  assert.equal(Theme.variables({ appearance: value }, 'clock')['--icon-duration'], '450ms');
  value.global.iconSpeed = 50;
  assert.equal(Theme.variables({ appearance: value })['--icon-duration'], '1800ms');
  value.global.iconSpeed = 200; value.global.motionSpeed = 200;
  assert.equal(Theme.variables({ appearance: value })['--icon-duration'], '225ms');
  const themed = Theme.variables({ appearance: value }, 'weather');
  const palette = Appearance.palettes['dark-mint'];
  const rgba = color => `rgba(${[1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)).join(',')},0.5)`;
  assert.equal(themed['--icon-primary'], rgba(palette.text));
  assert.equal(themed['--icon-secondary'], rgba(palette.accent));
  assert.equal(themed['--icon-detail'], rgba(palette.secondary));
});

test('High Contrast forces distinct opaque accessible icon channels even when custom colours or zero opacity are saved', () => {
  const value = Appearance.normalize({ base: 'high-contrast', global: {
    ...iconValues, textOpacity: 0, iconPrimaryColor: '#000000', iconSecondaryColor: '#000000', iconDetailColor: '#000000',
  }, widgets: { clock: { iconPalette: 'custom', iconPrimaryColor: '#010101' } } });
  for (const id of [undefined, 'clock']) {
    const tokens = Theme.variables({ appearance: value }, id);
    assert.equal(tokens['--icon-primary'], 'rgba(255,255,255,1)');
    assert.equal(tokens['--icon-secondary'], 'rgba(255,255,0,1)');
    assert.equal(tokens['--icon-detail'], 'rgba(0,255,255,1)');
  }
  assert.equal(value.global.iconPrimaryColor, '#000000', 'The saved custom palette remains available after leaving High Contrast');
});

test('theme application scopes icon variables and motion datasets to cards and previews and honours system reduced motion', () => {
  const element = () => ({ dataset: {}, style: { values: {}, setProperty(key, value) { this.values[key] = value; },
    removeProperty(key) { delete this.values[key]; } } });
  const root = element(), body = element(), clock = element(), weather = element(), preview = element();
  clock.dataset.widget = 'clock'; weather.dataset.widget = 'weather';
  const events = new Map(), media = { matches: true, addEventListener() {}, removeEventListener() {} };
  const document = { documentElement: root, body, hidden: false,
    querySelectorAll: selector => selector === '[data-motion-requested]' ? [root, clock, weather] : [clock, weather],
    addEventListener: (event, callback) => events.set(event, callback), removeEventListener() {} };
  const window = { OverkotAppearance: Appearance, location: { search: '' }, api: {},
    matchMedia: () => media, addEventListener() {}, removeEventListener() {} };
  window.OverkotMotion = Motion.create({ document, window });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/theme.js'), 'utf8'), { window, document, URLSearchParams });
  const value = appearance();
  window.OverkotTheme.apply({ appearance: value });
  assert.equal(root.dataset.iconMotion, 'loop');
  assert.equal(root.dataset.iconPalette, 'custom');
  assert.equal(clock.dataset.iconMotion, 'off');
  assert.equal(weather.dataset.iconMotion, 'hover');
  assert.equal(weather.dataset.iconPalette, 'theme');
  assert.equal(root.style.values['--icon-primary'], 'rgba(18,52,86,1)');
  assert.equal(clock.style.values['--icon-primary'], 'rgba(255,0,0,1)');
  assert.equal(root.dataset.motionLevel, 'off', 'Respect system reduced motion despite the requested icon loop');
  assert.equal(clock.dataset.motionLevel, 'off');
  window.OverkotTheme.apply({ appearance: value }, { root: preview, widgetId: 'clock' });
  assert.equal(preview.dataset.iconMotion, 'off');
  assert.equal(preview.style.values['--icon-primary'], 'rgba(255,0,0,1)');
  assert.equal(root.style.values['--icon-primary'], 'rgba(18,52,86,1)', 'Scoped preview cannot replace the global icon palette');
  value.global.respectReducedMotion = false;
  window.OverkotTheme.apply({ appearance: value });
  assert.equal(root.dataset.motionLevel, 'standard');
  document.hidden = true;
  events.get('visibilitychange')();
  assert.equal(root.dataset.motionPaused, 'true');
  window.OverkotMotion.destroy();
});
