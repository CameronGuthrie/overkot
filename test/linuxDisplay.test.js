'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configureLinuxDisplay } = require('../src/modules/linuxDisplay');

function setup(env = {}, switches = {}, platform = 'linux') {
  const values = new Map(Object.entries(switches));
  const writes = [];
  const result = configureLinuxDisplay({ platform, env, commandLine: {
    getSwitchValue: name => values.get(name) || '',
    hasSwitch: name => values.has(name),
    appendSwitch: (name, value) => { values.set(name, value); writes.push([name, value]); },
  } });
  return { result, values, writes };
}

test('Linux selects X11 or XWayland for the overlay when an X display exists', () => {
  const x11 = setup({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' });
  assert.equal(x11.result.displayBackend, 'x11');
  assert.equal(x11.values.get('ozone-platform'), 'x11');
  const wayland = setup({ DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0' });
  assert.equal(wayland.result.displayBackend, 'xwayland');
  assert.equal(wayland.values.get('ozone-platform'), 'x11');
  assert.equal(wayland.values.has('enable-features'), false);
});

test('explicit native Wayland overrides X11 preference and enables the Electron 40 shortcut portal', () => {
  const f = setup({ DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0' }, {
    'ozone-platform': 'wayland', 'enable-features': 'ExistingFeature',
  });
  assert.equal(f.result.displayBackend, 'wayland');
  assert.equal(f.result.displaySelection, 'explicit');
  assert.equal(f.values.get('ozone-platform'), 'wayland');
  assert.equal(f.values.get('enable-features'), 'ExistingFeature,GlobalShortcutsPortal');
});

test('Wayland without XWayland starts with accurately limited support', () => {
  const f = setup({ WAYLAND_DISPLAY: 'wayland-0' });
  assert.equal(f.result.displayBackend, 'wayland');
  assert.equal(f.values.get('ozone-platform'), 'wayland');
});

test('desktop-wide obsolete hints cannot select native Wayland when XWayland is available', () => {
  for (const hint of ['auto', 'wayland', 'x11']) {
    const f = setup({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', ELECTRON_OZONE_PLATFORM_HINT: hint });
    assert.equal(f.result.displayBackend, 'xwayland');
    assert.equal(f.result.displaySelection, 'automatic');
    assert.equal(f.values.get('ozone-platform'), 'x11');
    assert.equal(f.values.has('enable-features'), false);
  }
});

test('automatic values reaching the display selector resolve to the positioning-capable backend', () => {
  const auto = setup({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, { 'ozone-platform': 'auto' });
  assert.equal(auto.result.displayBackend, 'xwayland');
  assert.equal(auto.result.displaySelection, 'automatic');
  assert.equal(auto.values.get('ozone-platform'), 'x11');
  const hint = setup({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, { 'ozone-platform-hint': 'auto' });
  assert.equal(hint.result.displayBackend, 'xwayland');
  assert.equal(hint.values.get('ozone-platform'), 'x11');
  const native = setup({ WAYLAND_DISPLAY: 'wayland-0' }, { 'ozone-platform': 'auto' });
  assert.equal(native.result.displayBackend, 'wayland');
  assert.equal(native.values.get('ozone-platform'), 'wayland');
  assert.equal(setup({}, { 'ozone-platform': 'auto' }).result.displayBackend, 'auto');
});

test('deliberate command-line backend overrides are retained', () => {
  assert.equal(setup({ DISPLAY: ':0' }, { 'ozone-platform-hint': 'x11' }).result.displaySelection, 'explicit');
  const wayland = setup({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, { 'ozone-platform-hint': 'wayland' });
  assert.equal(wayland.result.displayBackend, 'wayland');
  assert.equal(wayland.values.get('ozone-platform'), 'wayland');
  const x11 = setup({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, { 'ozone-platform': 'x11' });
  assert.equal(x11.result.displayBackend, 'xwayland');
  assert.equal(x11.result.displaySelection, 'explicit');
  assert.equal(x11.values.has('enable-features'), false);
});

test('portal setup preserves existing flags, avoids duplication, and respects an explicit disable', () => {
  const enabled = setup({ WAYLAND_DISPLAY: 'wayland-0' }, { 'enable-features': 'GlobalShortcutsPortal,ExistingFeature' });
  assert.equal(enabled.values.get('enable-features'), 'GlobalShortcutsPortal,ExistingFeature');
  const disabled = setup({ WAYLAND_DISPLAY: 'wayland-0' }, { 'disable-features': 'GlobalShortcutsPortal' });
  assert.equal(disabled.values.has('enable-features'), false);
});

test('Windows and macOS display choices remain untouched; missing Linux environment is not claimed as X11', () => {
  for (const platform of ['win32', 'darwin']) {
    const f = setup({ DISPLAY: ':0' }, {}, platform);
    assert.deepEqual(f.result, {});
    assert.deepEqual(f.writes, []);
  }
  assert.equal(setup().result.displayBackend, 'unknown');
});
