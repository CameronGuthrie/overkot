'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { configureOverlayWorkspace, configureOverlayPopout, refreshOverlayStack } = require('../src/modules/overlayWindowPolicy');

test('X11 and XWayland overlays follow fullscreen workspaces while remaining activatable by the chord', () => {
  for (const displayBackend of ['x11', 'xwayland']) {
    const calls = [];
    const win = { setVisibleOnAllWorkspaces: value => calls.push(['workspace', value]),
      getNativeWindowHandle: () => Buffer.from([0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0]),
      focus() { assert.fail('Configuring a passive overlay must not steal focus'); },
      show() { assert.fail('Configuring a hidden overlay must not show it'); },
      setFocusable() { assert.fail('Windows must remain activatable by the interaction chord'); } };
    const options = { helperPath: '/app/resources/bin/overkot-overlay-window',
      run: (file, args, settings) => calls.push(['hints', file, args, settings]),
      warn() { assert.fail('Hint configuration failed'); } };
    configureOverlayWorkspace(win, { platform: 'linux', displayBackend }, options);
    assert.deepEqual(calls, [['workspace', true], ['hints', options.helperPath, ['0x12345678'],
      { timeout: 1500, stdio: 'pipe', windowsHide: true }]]);
    configureOverlayWorkspace(win, { platform: 'linux', displayBackend }, options);
    assert.equal(calls.filter(call => call[0] === 'hints').length, 1, 'Repeated configuration does not relaunch the helper');
  }
});

test('a missing helper preserves workspace setup and reports the fallback without crashing startup', () => {
  let workspaces = 0, attempts = 0;
  const warnings = [];
  for (let i = 0; i < 2; i++) {
    const win = { setVisibleOnAllWorkspaces: () => workspaces++,
      getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]) };
    const options = { run() { attempts++; throw new Error('ENOENT'); }, warn: text => warnings.push(text) };
    assert.doesNotThrow(() => configureOverlayWorkspace(win, { platform: 'linux', displayBackend: 'x11' }, options));
  }
  assert.equal(workspaces, 2);
  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1, 'A missing build tool does not flood the log for every panel');
  assert.match(warnings[0], /fullscreen.*unavailable.*build:overlay:linux.*ENOENT/);
});

test('a not-yet-created native XID is retried before the first show, then cached only after success', () => {
  const calls = [];
  const win = Object.assign(new EventEmitter(), { setVisibleOnAllWorkspaces() {},
    getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]), isDestroyed: () => false });
  let attempts = 0;
  const support = { platform: 'linux', displayBackend: 'x11' };
  const options = { run() {
    attempts++;
    if (attempts === 1) throw new Error('BadWindow');
    calls.push('hints');
  }, warn() {} };
  configureOverlayWorkspace(win, support, options);
  win.once('ready-to-show', () => calls.push('show'));
  win.emit('ready-to-show');
  assert.deepEqual(calls, ['hints', 'show']);
  configureOverlayWorkspace(win, support, options);
  assert.equal(attempts, 2, 'A successful retry must not spawn another helper');
});

test('normal Linux popouts follow the rail layer while preserving native move/resize and hidden state', () => {
  const calls = [];
  let visible = false, parentVisible = true;
  const parent = { isDestroyed: () => false, isVisible: () => parentVisible, moveTop: () => calls.push('rail') };
  const win = Object.assign(new EventEmitter(), { setVisibleOnAllWorkspaces: value => calls.push(['workspace', value]),
    setParentWindow: value => calls.push(['parent', value]),
    isDestroyed: () => false, isVisible: () => visible, moveTop: () => calls.push('popout'),
    setResizable() { assert.fail('Popouts must keep their native resize behavior'); },
    show() { assert.fail('A hidden popout must remain hidden'); },
    focus() { assert.fail('Stacking configuration must not take focus'); } });
  configureOverlayPopout(win, parent, { platform: 'linux', displayBackend: 'xwayland' });
  assert.deepEqual(calls, [['workspace', true], ['parent', parent]]);
  calls.length = 0;
  win.emit('focus');
  assert.deepEqual(calls, [], 'A late focus event must not raise hidden windows');
  visible = true;
  win.emit('show');
  win.emit('focus');
  assert.deepEqual(calls, ['rail', 'popout', 'rail', 'popout'], 'The popout follows its raised parent above independent widgets');
  calls.length = 0;
  parentVisible = false;
  win.emit('focus');
  assert.deepEqual(calls, [], 'An auto-hidden rail stays hidden');

  const surface = { setVisibleOnAllWorkspaces() {}, getNativeWindowHandle: () => Buffer.from([2, 0, 0, 0]),
    setParentWindow() { assert.fail('The dungeon map and widgets must retain their independent layer order'); } };
  configureOverlayWorkspace(surface, { platform: 'linux', displayBackend: 'x11' }, { run() {} });
  configureOverlayPopout(surface, parent, { platform: 'linux', displayBackend: 'x11' });
  configureOverlayPopout(parent, parent, { platform: 'linux', displayBackend: 'x11' });
});

test('Windows and X11 stack refresh keeps the dungeon behind the menu and alerts above all content without activating windows', () => {
  for (const support of [{ platform: 'win32' }, { platform: 'linux', displayBackend: 'x11' },
    { platform: 'linux', displayBackend: 'xwayland' }]) {
    const calls = [];
    const window = (name, visible = true, destroyed = false, minimized = false) => ({
      isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => minimized,
      moveTop: () => calls.push(name),
      show() { assert.fail('Stack repair must not reveal hidden windows'); },
      restore() { assert.fail('Stack repair must not restore minimized windows'); },
      focus() { assert.fail('Stack repair must not steal game focus'); },
    });
    const legacyWindow = window('legacy');
    delete legacyWindow.isMinimized;
    refreshOverlayStack([window('dungeon'), null, window('hidden', false), window('destroyed', true, true),
      window('minimized', true, false, true), legacyWindow, window('widget'), window('rail'), window('popout'),
      window('alert')], support);
    assert.deepEqual(calls, ['dungeon', 'legacy', 'widget', 'rail', 'popout', 'alert'], support.platform);
  }
});

test('native Wayland and macOS do not receive unsupported positioning or stacking workarounds', () => {
  const unusable = { setVisibleOnAllWorkspaces() { assert.fail('Unsupported backend'); },
    isDestroyed() { assert.fail('Unsupported backend'); } };
  for (const support of [{ platform: 'linux', displayBackend: 'wayland' },
    { platform: 'linux', displayBackend: 'unknown' }, { platform: 'darwin' }]) {
    configureOverlayWorkspace(unusable, support);
    configureOverlayPopout(unusable, unusable, support);
    refreshOverlayStack([unusable], support);
  }
  configureOverlayWorkspace(unusable, { platform: 'win32' });
  configureOverlayPopout(unusable, unusable, { platform: 'win32' });
});
