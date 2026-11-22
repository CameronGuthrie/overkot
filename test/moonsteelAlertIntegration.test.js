'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { PlayerTracking } = require('../src/modules/playerTracking');
const { createMoonsteelAlerts } = require('../src/modules/moonsteelAlerts');
const Settings = require('../src/modules/moonsteelAlertSettings');
const mainPath = path.resolve(__dirname, '../src/main.js');

test('the actual main listener alerts from the player reader with every map widget absent', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overkot-moonsteel-integration-'));
  let now = 10000;
  const reader = new EventEmitter();
  reader.getState = () => ({ status: 'tracking', trackingSession: 'fixture-session' });
  reader.start = () => {};
  reader.stop = () => {};
  const tracking = new PlayerTracking({ directory, reader, now: () => now,
    getState: () => ({ active: false, instanceId: 'fixture-entry', levelPath: '/SF/Levels/Procs/MidrathProc' }),
    getAccountId: () => 'fixture-account', getVersion: () => 'fixture', getLayoutSnapshot: async () => null, getScene: async () => null });
  t.after(async () => {
    tracking.stop(); await tracking.flush();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const alerts = [], broadcasts = [];
  const detector = createMoonsteelAlerts({ now: () => now, onAlert: data => alerts.push(data) });
  const main = await fs.readFile(mainPath, 'utf8');
  const context = vm.createContext({ playerTracking: tracking, moonsteelAlerts: detector,
    broadcastMapEvent: (...args) => broadcasts.push(args) });
  vm.runInContext(main.slice(main.indexOf("playerTracking.on('location',"), main.indexOf("playerTracking.on('status',")), context);
  tracking.start(123);
  reader.emit('status', reader.getState());
  reader.emit('pose', { source: 'memory', sampledAt: now, trackingSession: 'fixture-session', position: { x: 10, y: 0, z: 20 }, heading: 0 });
  const drop = { id: 'confirmed-fixture', itemType: '/SF/Weapons/Melee/OneHand/MockeryStultion/MockeryStultionMeleeWeapon', shiny: true, position: { x: 12, y: 0, z: 21 } };
  const emitDrops = () => reader.emit('world-drops', { type: 'world-drops', source: 'memory', status: 'available', sampledAt: now,
    trackingSession: 'fixture-session', items: [drop] });
  emitDrops();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].items[0].name, 'Stultin');
  now += 200; emitDrops();
  assert.equal(alerts.length, 1, 'Frequent telemetry does not repeat the alert');
  assert.ok(broadcasts.some(([channel, data]) => channel === 'player-location' && data.worldDrops?.items.length === 1));
});

test('only the Settings main frame can preview an alert and preview does not require automatic alerts', async () => {
  const main = await fs.readFile(mainPath, 'utf8'), handlers = {}, shown = [];
  const frame = {}, sender = { mainFrame: frame };
  const context = vm.createContext({ MoonsteelAlertSettings: Settings, marketShutdownStarted: false,
    settingsWindow: { isDestroyed: () => false, webContents: sender },
    moonsteelAlertWindow: { show: data => { shown.push(data); return true; } },
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, log() {} });
  vm.runInContext(main.slice(main.indexOf("ipcMain.handle('moonsteel-alert:preview'"), main.indexOf("ipcMain.handle('save-config'")), context);
  const preview = handlers['moonsteel-alert:preview'];
  assert.equal(preview({ sender: {}, senderFrame: frame }, {}), false);
  assert.equal(preview({ sender, senderFrame: {} }, {}), false);
  assert.equal(preview({ sender, senderFrame: frame }, { volume: 2 }), false);
  assert.equal(preview({ sender, senderFrame: frame }, { flashEnabled: false, soundEnabled: false }), false);
  assert.equal(preview({ sender, senderFrame: frame }, { enabled: false, color: '#DA75FF', volume: 0 }), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].settings.enabled, true);
  assert.equal(shown[0].settings.color, '#da75ff');
  assert.equal(shown[0].settings.volume, 0);
  assert.equal(shown[0].preview, true);
});
