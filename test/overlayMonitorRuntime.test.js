'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const main = fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8');

test('the bar keeps its chosen monitor through disconnect and reconnect', () => {
  const primary = { id: 101, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const secondary = { id: 202, bounds: { x: -1920, y: -100, width: 1920, height: 1080 } };
  let displays = [primary, secondary], layoutCalls = 0;
  const values = { dockDisplayId: 202, dockEdge: 'bottom' };
  const rail = { bounds: { x: 0, y: 1032, width: 1920, height: 48 }, isDestroyed: () => false, getBounds() { return this.bounds; } };
  const context = vm.createContext({ ...require('../src/modules/overlayDisplays'), ...require('../src/modules/edgeDockGeometry'),
    mainWindow: rail, dungeonOverlayWindow: null, settingsWindow: null, platformSupport: { platform: 'win32' },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => primary },
    config: { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } },
    setWindowBounds: (win, bounds) => { win.bounds = bounds; }, applyOverlayMousePolicy() {},
    layoutDockedPanels: () => { layoutCalls++; }, pushDockState() {} });
  vm.runInContext(main.slice(main.indexOf('function dockDisplay()'), main.indexOf('function dockState()')), context);
  vm.runInContext(main.slice(main.indexOf('function applyDockGeometry()'), main.indexOf('function layoutDockedPanels()')), context);
  const apply = () => vm.runInContext('applyDockGeometry(); overlayDisplaysSnapshot()', context);
  assert.equal(apply().selectedDisplayId, 202);
  assert.equal(rail.bounds.x, -1920);
  displays = [primary];
  const fallback = apply();
  assert.equal(fallback.selectedDisplayId, 101);
  assert.equal(fallback.usingFallback, true);
  assert.equal(values.dockDisplayId, 202, 'Temporary fallback never replaces the saved choice');
  displays = [primary, secondary];
  assert.equal(apply().selectedDisplayId, 202);
  assert.equal(rail.bounds.x, -1920);
  assert.equal(layoutCalls, 3, 'Attached panels are laid out on every monitor change');
});

test('startup checks once and announces the available version without downloading', () => {
  let checks = 0, options;
  const notifications = [];
  class FakeUpdater extends EventEmitter {
    constructor(input) { super(); options = input; }
    check() { checks++; return Promise.resolve(); }
    sessionEnding() {}
  }
  const context = vm.createContext({ path, Updater: FakeUpdater, updater: null, IS_BETA: false, services: { releases: 'https://updates.example' },
    app: { isPackaged: true, on() {} }, process: { platform: 'win32', env: {}, resourcesPath: 'fixture' },
    require: () => ({ existsSync: () => true }), log() {}, updateWindow: null,
    config: { get: () => true }, BrowserWindow: { getAllWindows: () => [] },
    createUpdateWindow: focus => notifications.push(focus),
    setInterval: () => { throw new Error('Startup must not schedule periodic automatic app updates'); } });
  vm.runInContext(main.slice(main.indexOf('function startAppUpdates()'), main.indexOf('function createUpdateWindow(')), context);
  vm.runInContext('startAppUpdates()', context);
  assert.equal(options.supported, true);
  assert.equal(Object.hasOwn(options, 'automatic'), false, 'A legacy automatic preference is never passed to the engine');
  assert.equal(checks, 1);
  vm.runInContext("updater.emit('changed', {phase:'available',version:'9.8.7'}); updater.emit('changed', {phase:'ready',version:'9.8.7'})", context);
  assert.deepEqual(notifications, [false], 'The update notice opens once without taking focus');
});
