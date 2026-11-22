'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function fixture(values = {}, preferences = {}) {
  const windows = [], calls = [], data = { enableAlertPopup: true, ...preferences };
  class AlertWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = options.show !== false;
      this.destroyed = false;
      this.position = [options.x, options.y];
      this.webContents = Object.assign(new EventEmitter(), {
        send: (...args) => calls.push(['send', this, ...args]),
        mainFrame: {}, isDestroyed: () => this.destroyed,
      });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    setAlwaysOnTop(...args) { this.top = args; }
    loadFile(file) { this.file = file; }
    setPosition(...position) { this.position = position; }
    hide() { this.visible = false; calls.push(['hide', this]); }
    showInactive() { this.visible = true; calls.push(['showInactive', this]); this.emit('show'); }
    moveTop() { calls.push(['raise', this]); }
    show() { assert.fail('Alerts must never activate a window'); }
    focus() { assert.fail('Alerts must never take keyboard focus'); }
    close() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    destroy() { this.close(); }
  }
  AlertWindow.fromWebContents = sender => windows.find(win => win.webContents === sender) || null;
  const launcher = { visible: true, minimized: false, destroyed: false,
    isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    isDestroyed() { return this.destroyed; } };
  const context = vm.createContext({ BrowserWindow: AlertWindow, path, __dirname: path.join(__dirname, '../src'),
    platformSupport: { platform: 'win32' }, configureOverlayWorkspace() {}, log() {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: -1920, y: 40, width: 1920, height: 1040 } }) },
    mainWindow: launcher, alertWindows: new Set(), marketShutdownStarted: false,
    overlayHiddenByUser: false, gameHiddenActive: false, mainHiddenForFocus: false, dockAutoHidden: false,
    config: { get: (key, fallback) => data[key] ?? fallback }, ...values,
  });
  vm.runInContext(main.slice(main.indexOf('function raiseAlertWindows()'), main.indexOf('function refreshOverlayWindowStack()')), context);
  vm.runInContext(main.slice(main.indexOf('function canShowAlerts()'), main.indexOf('// ─── Widgets window')), context);
  return { context, launcher, windows, calls, data, run: code => vm.runInContext(code, context),
    create(name = 'Completed timer') {
      context.payload = { name, duration: 120 };
      vm.runInContext('createAlertWindow(payload)', context);
      return windows.at(-1);
    } };
}

test('a timer alert waits for its first frame, receives its payload, then raises without focus', () => {
  const f = fixture();
  const alert = f.create();
  assert.equal(alert.options.show, false);
  assert.equal(alert.options.focusable, false);
  assert.equal(alert.options.skipTaskbar, true);
  assert.equal(alert.options.webPreferences.backgroundThrottling, false);
  assert.equal(alert.visible, false);
  assert.deepEqual(f.calls, []);
  alert.webContents.emit('did-finish-load');
  assert.deepEqual(f.calls, [['send', alert, 'alert-data', f.context.payload]]);
  f.calls.length = 0;
  alert.emit('ready-to-show');
  assert.equal(alert.visible, true);
  assert.deepEqual(f.calls, [['showInactive', alert], ['raise', alert]]);
  assert.deepEqual(alert.top, [true, 'screen-saver', 5]);
});

test('hidden and minimised overlays suppress new alerts by default', () => {
  for (const change of [
    f => { f.context.overlayHiddenByUser = true; },
    f => { f.context.gameHiddenActive = true; },
    f => { f.context.mainHiddenForFocus = true; },
    f => { f.launcher.minimized = true; },
    f => { f.launcher.visible = false; },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(f.run('canShowAlerts()'), false);
    f.create();
    assert.equal(f.windows.length, 0);
  }
});

test('the hidden-alert preference allows popups through every running hidden state', () => {
  const f = fixture({ overlayHiddenByUser: true, gameHiddenActive: true, mainHiddenForFocus: true },
    { showAlertsWhenHidden: true });
  f.launcher.visible = false;
  f.launcher.minimized = true;
  assert.equal(f.run('canShowAlerts()'), true);
  const alert = f.create();
  alert.emit('ready-to-show');
  assert.equal(alert.visible, true);
  assert.deepEqual(f.calls, [['showInactive', alert], ['raise', alert]]);
  assert.equal(f.context.overlayHiddenByUser, true);
  assert.equal(f.launcher.visible, false, 'Showing an alert must leave the overlay hidden');
});

test('closed or quitting apps and disabled popups suppress alerts even with the override enabled', () => {
  for (const change of [
    f => { f.context.mainWindow = null; },
    f => { f.launcher.destroyed = true; },
    f => { f.context.marketShutdownStarted = true; },
    f => { f.data.enableAlertPopup = false; },
  ]) {
    const f = fixture({}, { showAlertsWhenHidden: true });
    change(f);
    assert.equal(f.run('canShowAlerts()'), false);
    f.create();
    assert.equal(f.windows.length, 0);
  }
});

test('an auto-hidden dock still permits alerts while manual hiding takes precedence', () => {
  const f = fixture({ dockAutoHidden: true });
  f.launcher.visible = false;
  assert.equal(f.run('canShowAlerts()'), true);
  const alert = f.create();
  alert.emit('ready-to-show');
  assert.equal(alert.visible, true);
  f.context.overlayHiddenByUser = true;
  f.run('syncAlertVisibility()');
  assert.equal(alert.visible, false);
});

test('hiding while an alert loads cannot flash it, and changing the preference updates only ready alerts', () => {
  const f = fixture();
  const ready = f.create('Ready');
  f.context.overlayHiddenByUser = true;
  ready.emit('ready-to-show');
  assert.equal(ready.visible, false);
  assert.equal(f.calls.some(([method]) => method === 'showInactive'), false);

  f.data.showAlertsWhenHidden = true;
  const loading = f.create('Loading');
  f.calls.length = 0;
  f.run('syncAlertVisibility()');
  assert.equal(ready.visible, true);
  assert.equal(loading.visible, false);
  assert.deepEqual(f.calls, [['showInactive', ready], ['raise', ready]]);

  f.data.showAlertsWhenHidden = false;
  f.run('syncAlertVisibility()');
  assert.equal(ready.visible, false);
  assert.equal(loading.visible, false);
  loading.emit('ready-to-show');
  assert.equal(loading.visible, false);

  f.data.showAlertsWhenHidden = true;
  f.run('syncAlertVisibility()');
  assert.equal(ready.visible, true);
  assert.equal(loading.visible, true);
  f.data.enableAlertPopup = false;
  f.run('syncAlertVisibility()');
  assert.equal(ready.visible, false);
  assert.equal(loading.visible, false);
});

test('closing the app or alert before ready never maps a late popup', () => {
  for (const close of [f => { f.context.mainWindow = null; },
    f => { f.context.marketShutdownStarted = true; },
    (_f, alert) => alert.close()]) {
    const f = fixture({}, { showAlertsWhenHidden: true });
    const alert = f.create();
    close(f, alert);
    alert.emit('ready-to-show');
    assert.equal(alert.visible, false);
    assert.equal(f.calls.some(([method]) => method === 'showInactive'), false);
  }
});

test('dismissing an alert closes its stack gap without exposing hidden alerts', () => {
  const f = fixture();
  const first = f.create('First'), second = f.create('Second');
  assert.deepEqual(first.position, [-332, 996]);
  assert.deepEqual(second.position, [-332, 912]);
  first.close();
  assert.equal(f.context.alertWindows.has(first), false);
  assert.equal(f.context.alertWindows.has(second), true);
  assert.deepEqual(second.position, [-332, 996]);
  assert.equal(second.visible, false);
  assert.deepEqual(f.calls, []);
});

test('the X dismisses its own passive alert immediately and closes the stack gap without focus changes', () => {
  const f = fixture({ overlayInteractive: false }, { clickThrough: true });
  const first = f.create('First'), second = f.create('Second');
  first.emit('ready-to-show'); second.emit('ready-to-show'); f.calls.length = 0;
  f.context.event = { sender: first.webContents, senderFrame: first.webContents.mainFrame };
  assert.equal(f.run('dismissAlertWindow(event)'), true);
  assert.equal(first.destroyed, true);
  assert.equal(f.context.alertWindows.has(first), false);
  assert.equal(second.visible, true);
  assert.deepEqual(second.position, [-332, 996]);
  assert.equal(f.context.overlayInteractive, false);
  assert.deepEqual(f.calls, [], 'Dismissal does not activate or remap another window');
  assert.equal(f.run('dismissAlertWindow(event)'), false, 'Repeated close events are harmless');
});

test('dismiss IPC rejects child frames and windows outside the alert set', () => {
  const f = fixture(), alert = f.create();
  const unrelated = new f.context.BrowserWindow({ show: false, x: 0, y: 0 });
  for (const event of [
    { sender: alert.webContents, senderFrame: {} },
    { sender: unrelated.webContents, senderFrame: unrelated.webContents.mainFrame },
    { sender: { isDestroyed: () => false, mainFrame: {} }, senderFrame: {} },
    {},
  ]) {
    f.context.event = event;
    assert.equal(f.run('dismissAlertWindow(event)'), false);
    assert.equal(alert.destroyed, false);
    assert.equal(unrelated.destroyed, false);
  }
});
