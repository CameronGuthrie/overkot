'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getPlatformSupport } = require('../src/modules/platformSupport');

test('Windows keeps full game integration, Linux keeps its experimental scanner, macOS is companion-only', () => {
  const windows = getPlatformSupport('win32');
  assert.equal(windows.gameConnection, true);
  assert.equal(windows.gameFocusTracking, true);
  assert.equal(windows.experimental, false);
  const linux = getPlatformSupport('linux');
  assert.equal(linux.gameConnection, true);
  assert.equal(linux.gameFocusTracking, false);
  assert.equal(linux.experimental, true);
  const mac = getPlatformSupport('darwin');
  assert.equal(mac.gameConnection, false);
  assert.equal(mac.gameFocusTracking, false);
  assert.match(mac.inventoryUnavailableReason, /macOS companion/);
});

test('fresh native profiles retain platform input defaults and app updates are manual everywhere', () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/config.js'), 'utf8'), {
    module, process, console,
    require: name => name === './overlayShortcuts' ? require('../src/modules/overlayShortcuts') : name === './overlayDisplays' ? require('../src/modules/overlayDisplays') : name === './moonsteelAlertSettings' ? require('../src/modules/moonsteelAlertSettings') : name === './appPaths' ? {} : name === './fileEncryption' ? {} : name === './widgetSizing' ? require('../src/modules/widgetSizing') : name === './layouts' ? require('../src/modules/layouts') : name === './appearance' ? require('../src/modules/appearance') : name === './trackerPreferences' ? require('../src/modules/trackerPreferences') : name === './tutorials' ? require('../src/modules/tutorials') : name === './widgetMigration' ? require('../src/modules/widgetMigration') : require(name),
  });
  const { ConfigStore } = module.exports;
  for (const platform of ['linux', 'darwin']) {
    const config = ConfigStore.defaults(platform);
    assert.equal(config.clickThrough, false);
    assert.equal(config.hideWhenGameClosed, false);
    assert.equal(config.showOnlyWhenGameFocused, false);
    assert.equal(config.automaticUpdates, false);
  }
  const windows = ConfigStore.defaults('win32');
  assert.equal(windows.clickThrough, true);
  assert.equal(windows.hideWhenGameClosed, true);
  assert.equal(windows.automaticUpdates, false);
});
