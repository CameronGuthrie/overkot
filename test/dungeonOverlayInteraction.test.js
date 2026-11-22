'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function fixture(detector) {
  const calls = [], handlers = new Map();
  const map = { isDestroyed: () => false, isFocused: () => false, close: () => calls.push('close') };
  const context = vm.createContext({ dungeonOverlayWindow: map, overlayInteractive: true, gameFocusRequest: null, AbortController,
    detector, log: (...args) => calls.push(['log', ...args]),
    toggleOverlayInteraction(forceOff) { calls.push(['interaction', forceOff]); context.overlayInteractive = false; },
    BrowserWindow: { fromWebContents: sender => sender.window },
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) },
  });
  vm.runInContext(main.slice(main.indexOf('async function exitDungeonOverlayInteraction()'), main.indexOf('function createDungeonOverlay()')), context);
  vm.runInContext(main.slice(main.indexOf("ipcMain.on('exit-dungeon-overlay-interaction'"), main.indexOf('// Only explicit feature actions')), context);
  return { context, map, calls, send: window => handlers.get('exit-dungeon-overlay-interaction')({ sender: { window } }),
    exit: () => vm.runInContext('exitDungeonOverlayInteraction()', context) };
}

test('returning to the game releases overlay input before restoring focus and keeps the map open', async () => {
  let f;
  f = fixture({ async focusGameWindow() {
    assert.equal(f.context.overlayInteractive, false);
    f.calls.push('game-focus');
    return true;
  } });
  f.send(f.map);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, [['interaction', true], 'game-focus']);
  assert.equal(f.context.dungeonOverlayWindow, f.map);
});

test('only the current interactive dungeon popout can request game focus', async () => {
  let focused = 0;
  const f = fixture({ async focusGameWindow() { focused++; } });
  f.send({ isDestroyed: () => false });
  assert.deepEqual(f.calls, []);
  f.context.overlayInteractive = false;
  f.send(f.map);
  f.context.overlayInteractive = true;
  f.context.dungeonOverlayWindow = null;
  f.send(null);
  f.context.dungeonOverlayWindow = { isDestroyed: () => true };
  f.send(f.context.dungeonOverlayWindow);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(focused, 0);
  assert.deepEqual(f.calls, []);
});

test('game focus unavailability cannot keep the fullscreen map capturing input', async () => {
  for (const detector of [null, { async focusGameWindow() { return false; } },
    { async focusGameWindow() { throw new Error('Game exited'); } }]) {
    const f = fixture(detector);
    await f.exit();
    assert.equal(f.context.overlayInteractive, false);
    assert.deepEqual(f.calls[0], ['interaction', true]);
    assert.equal(f.calls.includes('close'), false);
  }
});

test('re-entering overlay interaction cancels an older Escape focus request', async () => {
  let signal;
  const f = fixture({ focusGameWindow(options) {
    signal = options.signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }));
  } });
  Object.assign(f.context, { mainWindow: { isDestroyed: () => false, isFocused: () => false },
    settingsWindow: null, tutorialWindow: null, changelogWindow: null, widgetsWindow: null, groupFinderWindow: null,
    marketWindow: null, dailyBriefWindow: null, wikiWindow: null, mapWindow: null, calendarSettingsWindow: null, updateWindow: null,
    dockWindow: null, widgetWindows: new Map(), isCollapsed: false, overlayHiddenByUser: false,
    clearTimeout() {}, shiftStartTimer: null, setLayoutEditing() {}, applyOverlayMousePolicy() {},
    focusOverlay: () => f.calls.push('overlay-focus'),
  });
  vm.runInContext(main.slice(main.indexOf('function toggleOverlayInteraction('), main.indexOf('// ─── App lifecycle')), f.context);
  const pending = f.exit();
  assert.equal(signal.aborted, false);
  vm.runInContext('toggleOverlayInteraction()', f.context);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(f.context.overlayInteractive, true);
  assert.ok(f.calls.includes('overlay-focus'));
  assert.equal(f.context.gameFocusRequest, null);
});
