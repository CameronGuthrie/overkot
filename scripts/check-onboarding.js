'use strict';

// Native Windows smoke using real main/preload/renderers, isolated app data,
// a loopback fixture feed, and mocked game/global input. Two fresh processes
// share the fixture profile to verify that tours persist but launch hints do not.
if (process.platform !== 'win32') {
  console.error('This native integration check requires Windows.');
  process.exit(1);
}
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const fs = require('node:fs');
  const out = path.resolve(__dirname, '..', 'output', `onboarding-smoke-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  for (const phase of ['first', 'restart']) {
    const env = { ...process.env, OVERKOT_SMOKE_PROFILE: out, OVERKOT_SMOKE_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename], {
      // Hidden process startup overrides Windows' first normal ShowWindow call
      // and makes real popouts invisible. This check needs native mapping.
      env, stdio: 'inherit', windowsHide: false, timeout: 45000,
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log(JSON.stringify({ ok: true, output: out }));
  process.exit(0);
}

const electronRuntime = require('electron');
const { app, BrowserWindow, session, screen } = electronRuntime;
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.OVERKOT_SMOKE_PROFILE;
const phase = process.env.OVERKOT_SMOKE_PHASE;
assert.ok(out && ['first', 'restart'].includes(phase), 'Start with node scripts/check-onboarding.js');
process.env.LOCALAPPDATA = out;
app.setPath('userData', path.join(out, 'electron-profile'));
// Avoid opening or resolving a private source-tree key during this check.
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/calendar.json';
const feedRoot = path.join(root, 'output', 'data-feed');
assert.ok(fs.existsSync(path.join(feedRoot, 'manifest.json')), 'Prepare output/data-feed with npm run data:build first.');
const port = 32000 + process.pid % 10000;
process.env.OVERKOT_DATA_MANIFEST_URL = `http://127.0.0.1:${port}/manifest.json`;
const requests = [];
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname !== '/manifest.json' && !/^\/objects\/[a-f0-9]{64}\.(?:webp|json\.br|png)$/.test(pathname)) {
    response.writeHead(404); response.end(); return;
  }
  fs.readFile(path.join(feedRoot, ...pathname.split('/').filter(Boolean)), (error, bytes) => {
    if (error) { response.writeHead(404); response.end(); return; }
    requests.push(pathname); response.writeHead(200); response.end(bytes);
  });
});
server.listen(port, '127.0.0.1');

// Electron has no ignore-mouse getter. Observe its real policy calls without
// replacing their behavior, and use its native focusability getter below.
const mousePolicy = new WeakMap();
const windowLifecycle = [];
for (const method of ['show', 'showInactive', 'hide', 'focus', 'setFocusable', 'setSkipTaskbar']) {
  const nativeMethod = BrowserWindow.prototype[method];
  BrowserWindow.prototype[method] = function(...args) {
    const result = nativeMethod.apply(this, args);
    windowLifecycle.push({ id: this.id, method, args, visible: this.isVisible(), focused: this.isFocused(),
      url: this.webContents.getURL(), at: Date.now(), caller: new Error().stack.split('\n').slice(2, 5).join('\n') });
    return result;
  };
}
const nativeIgnore = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function(ignore, ...options) {
  const result = nativeIgnore.call(this, ignore, ...options);
  mousePolicy.set(this, ignore);
  return result;
};
const shortcuts = new Map();
let layoutMonitor, releaseGameProcess, gamePresent = false;
const shortcutFacade = {
  register: (key, callback) => { shortcuts.set(key, callback); return true; },
  unregister: key => shortcuts.delete(key), unregisterAll: () => shortcuts.clear(),
  isRegistered: key => shortcuts.has(key),
};
const electronFacade = new Proxy(electronRuntime, {
  get: (target, key) => key === 'globalShortcut' ? shortcutFacade : target[key],
});
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return electronFacade;
  if (request.endsWith('/modules/marketConfig')) return { readMarketApiKey: () => '' };
  if (request.endsWith('/modules/layoutKeyMonitor')) return {
    startLayoutKeyMonitor: callbacks => { layoutMonitor = callbacks; return { stop() {} }; },
  };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class {
    waitForProcess() { return new Promise(resolve => { releaseGameProcess = () => { gamePresent = true; resolve(4321); }; }); }
    findProcess() { return Promise.resolve(gamePresent ? 4321 : 0); }
    isProcessRunning() { return gamePresent; }
    startForegroundMonitor() { this._fgProc = {}; }
    stopForegroundMonitor() { this._fgProc = null; }
    isProcessForeground() { return Promise.resolve(true); }
    focusGameWindow() { return Promise.resolve(false); }
  } };
  if (request.endsWith('/modules/memoryScanner')) return {
    MemoryScanner: class { scanForAccountAndNonce() { return Promise.resolve({ accountId: '', nonce: '' }); } },
    scannerAvailableSync: () => false,
  };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class {
    start() {} stop() {} extractDisplayName() { return ''; }
    consumeLoginSignal() { return false; } consumeLogoutSignal() { return false; } extractAccountId() { return ''; }
  } };
  if (request.endsWith('/modules/dungeonWatcher')) return { DungeonWatcher: class {
    start() {} stop() {} getState() { return { active: false, status: 'outside' }; }
  } };
  for (const [module, exported] of [['arenaWatcher', 'ArenaWatcher'], ['ancestorWatcher', 'AncestorWatcher']]) {
    if (request.endsWith('/modules/' + module)) return { [exported]: class { start() {} stop() {} } };
  }
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, {
    get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false),
  });
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
if (phase === 'first') {
  const fixture = new ConfigStore();
  fixture.setMany({ clickThrough: true, hideWhenGameClosed: true, showOnlyWhenGameFocused: false,
    launchToTray: false, automaticUpdates: false, enableAlertSound: false, enableAlertPopup: false,
    interactionHotkey: 'Alt+F1', dockEdge: 'bottom', dockAutoHide: false,
    widgetVisibility: { clock: true }, widgetOpen: {}, widgetDocked: {},
    tutorialCompleted: {}, dockParadigmVersion: 1, startupLayoutPending: false,
  });
}
const errors = [], failedLoads = [], checks = [], screenshots = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) failedLoads.push({ code, description, url });
  });
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function find(file, parameter, value) {
  return BrowserWindow.getAllWindows().find(win => {
    const url = new URL(win.webContents.getURL() || 'about:blank');
    return url.pathname.endsWith('/' + file) && (!parameter || url.searchParams.get(parameter) === value);
  });
}
async function until(fn, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await fn(); if (result) return result; await pause(40);
  }
  throw new Error('Timed out: ' + label);
}
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
async function ready(file, parameter, value) {
  const win = await until(() => find(file, parameter, value), file + ':' + (value || ''));
  await until(async () => !win.webContents.isLoading() && await evaluate(win, "document.readyState === 'complete'"), file + ' renderer');
  if (file === 'tutorial.html') {
    await until(async () => await evaluate(win, "!document.getElementById('tutorial-next').disabled"), 'tutorial initial state');
  } else if (file === 'focus-reminder.html') {
    await until(async () => await evaluate(win, "!!document.getElementById('focus-hotkey')"), 'reminder initial state');
  }
  return win;
}
const state = main => evaluate(main, 'window.api.getState()');
async function capture(win, name) {
  await pause(100);
  const filename = path.join(out, phase + '-' + name + '.png');
  fs.writeFileSync(filename, (await win.webContents.capturePage()).toPNG());
  screenshots.push(filename);
}
async function finishTour(tour) {
  const stepTitles = [];
  for (let index = 0; index < 15 && !tour.isDestroyed(); index++) {
    const fit = await evaluate(tour, `({
      horizontal: document.documentElement.scrollWidth <= innerWidth,
      navigation: [...document.querySelectorAll('.tutorial-navigation button')].every(button => {
        const rect = button.getBoundingClientRect();
        return rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight;
      }),
    })`);
    assert.deepEqual(fit, { horizontal: true, navigation: true }, 'Every tour step retains reachable navigation without horizontal clipping');
    stepTitles.push(await evaluate(tour, "document.getElementById('tutorial-step-title').textContent"));
    if (stepTitles.at(-1) === 'Hide or show the overlay') {
      assert.match(await evaluate(tour, "document.getElementById('tutorial-body').textContent"), /Alt\s*\+\s*F2/,
        'An open tour receives saved shortcut changes');
    }
    await evaluate(tour, "document.getElementById('tutorial-next').click()");
    await pause(100);
  }
  await until(() => tour.isDestroyed(), 'tour finishes and closes');
  assert.ok(new Set(stepTitles).size > 1, 'A tour advances through actual feature steps');
  return stepTitles;
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(`http://127.0.0.1:${port}/`) });
  });
  const main = await ready('index.html');
  await until(() => main.isVisible() && layoutMonitor && shortcuts.has('Alt+F1'), 'app ready without input hooks');
  assert.equal(mousePolicy.get(main), true, 'The launcher is pass-through before the focus chord');
  assert.equal(main.isFocusable(), false, 'A passive launcher cannot acquire native Windows focus');
  assert.equal(find('tutorial.html'), undefined, 'Opening the app does not steal game focus for onboarding');
  const hint = await ready('focus-reminder.html');
  await until(() => hint.isVisible(), 'startup focus reminder visible');
  assert.equal(hint.isFocusable(), false, 'The reminder cannot acquire native focus');
  assert.equal(mousePolicy.get(hint), true, 'The reminder passes mouse input through');
  assert.match(await evaluate(hint, "document.getElementById('focus-hotkey').textContent"), /Alt\s*\+\s*F1/);
  const bounds = hint.getBounds(), display = screen.getDisplayMatching(bounds);
  assert.ok(bounds.x >= display.bounds.x && bounds.y >= display.bounds.y
    && bounds.x + bounds.width <= display.bounds.x + display.bounds.width
    && bounds.y + bounds.height <= display.bounds.y + display.bounds.height, 'The entire reminder fits on its display');
  await capture(hint, 'focus-reminder');
  checks.push('startup reminder shows the configured chord and is native nonfocusable/click-through');
  if (phase === 'first') {
    assert.equal((await state(main)).status, 'waiting', 'The launch hint remains visible while waiting for the game');
    await evaluate(main, 'window.api.saveConfig({ hideWhenGameClosed: false })');
  }
  shortcuts.get('Alt+F1')();
  await until(() => hint.isDestroyed() && main.isFocusable() && mousePolicy.get(main) === false, 'focus chord activates overlay and dismisses launch hint');
  layoutMonitor.onForeground(process.pid);
  if (phase === 'first') {
    const appTour = await ready('tutorial.html', 'tour', 'app');
    await until(() => appTour.isVisible() && appTour.isFocused(), 'first-use app tutorial focused');
    assert.equal(BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().includes('/tutorial.html')).length, 1);
    await capture(appTour, 'app-tour');
    await evaluate(appTour, "document.getElementById('tutorial-next').click()");
    assert.equal(await evaluate(appTour, "document.getElementById('tutorial-progress').textContent"), '2 / 6');
    assert.match(await evaluate(appTour, "document.getElementById('tutorial-body').textContent"), /Alt\s*\+\s*F1/);
    await capture(appTour, 'focus-tour-step');
    shortcuts.get('Alt+F1')();
    await until(() => mousePolicy.get(main) === true, 'second chord releases tour interaction');
    shortcuts.get('Alt+F1')();
    await until(() => appTour.isFocused() && main.isFocusable(), 'third chord returns to the existing tour');
    assert.equal(find('tutorial.html', 'tour', 'app').id, appTour.id, 'Resuming a tour keeps the same native window');
    assert.equal(await evaluate(appTour, "document.getElementById('tutorial-progress').textContent"), '2 / 6', 'Resuming retains the current step');
    assert.equal(BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().includes('/tutorial.html')).length, 1,
      'Hotkey resume cannot create duplicate tours');
    await evaluate(main, "window.api.saveConfig({ overlayVisibilityHotkey: 'Alt+F2' })");
    await evaluate(appTour, "document.getElementById('tutorial-back').click()");
    assert.equal(await evaluate(appTour, "document.getElementById('tutorial-progress').textContent"), '1 / 6', 'Back returns to the previous tour step');
    const appSteps = await finishTour(appTour);
    await until(async () => (await state(main)).config.tutorialCompleted.app, 'app tutorial persisted');
    checks.push('first-run tour starts after intentional focus, advances, completes and persists');
    await evaluate(main, "document.querySelector('[data-widget=clock]').click()");
    const clock = await ready('widget-host.html', 'widget', 'clock');
    const clockTour = await ready('tutorial.html', 'tour', 'clock');
    await until(() => clockTour.isVisible(), 'first widget tutorial visible');
    assert.equal(clock.isVisible(), true, 'The tutorial opens alongside the actual widget');
    await capture(clockTour, 'clock-tour');
    const widgetSteps = await finishTour(clockTour);
    await until(async () => (await state(main)).config.tutorialCompleted.clock, 'widget tutorial persisted');
    await evaluate(main, "document.querySelector('[data-widget=clock]').click()");
    await until(() => !clock.isVisible(), 'clock hidden');
    await evaluate(main, "document.querySelector('[data-widget=clock]').click()");
    await until(() => clock.isVisible(), 'clock reopens');
    await pause(220);
    assert.equal(find('tutorial.html'), undefined, 'A completed widget tutorial does not repeat on reopen');
    checks.push('first widget open gets its own tour; finishing suppresses later opens');
    await evaluate(main, "window.api.openTutorial('clock')");
    const optOut = await ready('tutorial.html', 'tour', 'clock');
    await until(() => optOut.isVisible(), 'widget replay opens before global opt-out');
    await capture(optOut, 'turn-off-all-tours');
    await evaluate(optOut, "document.getElementById('tutorial-disable-all').click()");
    await until(() => optOut.isDestroyed(), 'global tutorial opt-out closes the tour');
    const disabled = (await state(main)).config;
    assert.equal(disabled.tutorialsEnabled, false);
    assert.ok(disabled.tutorialCompleted.app && disabled.tutorialCompleted.clock, 'global off preserves completion history');
    await evaluate(main, 'window.api.saveConfig({ tutorialsEnabled: true, widgetVisibility: { clock: true, other: true } })');
    assert.equal((await state(main)).config.tutorialsEnabled, false, 'older generic settings snapshots cannot re-enable tours');
    await evaluate(main, "document.querySelector('[data-widget=other]').click()");
    const other = await ready('widget-host.html', 'widget', 'other');
    await until(() => other.isVisible(), 'incomplete widget opens with tutorials off');
    await pause(250);
    assert.equal(find('tutorial.html'), undefined, 'global off suppresses first-use tours for incomplete widgets');
    checks.push('Turn off all tours persists globally, preserves completion and suppresses incomplete widget tours');
    fs.writeFileSync(path.join(out, 'tour-steps.json'), JSON.stringify({ app: appSteps, clock: widgetSteps }, null, 2));
  } else {
    const restored = (await state(main)).config;
    assert.ok(restored.tutorialCompleted.app && restored.tutorialCompleted.clock, 'Completion survives a full process restart');
    assert.equal(restored.tutorialsEnabled, false, 'global tutorial opt-out survives a full process restart');
    await pause(250);
    assert.equal(find('tutorial.html'), undefined, 'Restart and focus do not repeat completed app onboarding');
    const clock = await ready('widget-host.html', 'widget', 'clock');
    await until(() => clock.isVisible(), 'saved open clock restored');
    assert.equal(find('tutorial.html'), undefined, 'Restoring a completed widget does not repeat onboarding');
    checks.push('fresh process gets a fresh hint while app and widget tutorial completion persist');
    await evaluate(main, 'window.api.openSettings()');
    const settings = await ready('settings.html');
    await until(async () => await evaluate(settings, "!!document.getElementById('btn-replay-tutorial')"), 'settings tutorial replay');
    assert.equal(await evaluate(settings, "document.getElementById('chk-tutorials-enabled').checked"), false, 'Settings reflects the saved global opt-out');
    await evaluate(settings, "document.getElementById('btn-replay-tutorial').click()");
    const replay = await ready('tutorial.html', 'tour', 'app');
    await until(() => replay.isVisible(), 'app tutorial replay');
    await evaluate(replay, "document.getElementById('tutorial-skip').click()");
    await until(() => replay.isDestroyed(), 'tutorial skip closes replay');
    assert.ok((await state(main)).config.tutorialCompleted.app);
    assert.equal((await state(main)).config.tutorialsEnabled, false, 'explicit replay does not re-enable automatic tours');
    await evaluate(settings, "document.getElementById('chk-tutorials-enabled').click()");
    await until(async () => (await state(main)).config.tutorialsEnabled === true, 'Settings enables all automatic tutorials');
    const other = await ready('widget-host.html', 'widget', 'other');
    await evaluate(main, "document.querySelector('[data-widget=other]').click()");
    await until(() => !other.isVisible(), 'incomplete widget hides');
    await evaluate(main, "document.querySelector('[data-widget=other]').click()");
    const resumed = await ready('tutorial.html', 'tour', 'other');
    await until(() => resumed.isVisible(), 'enabling tours restores incomplete widget onboarding');
    await finishTour(resumed);
    checks.push('Settings can replay while off, preserve completion and resume incomplete automatic tours when enabled');
    settings.close();
  }

  // Exercise the native foreground report independently of Chromium's focus
  // flag. Legacy false click-through must not expose clickable game overlays.
  const clock = await ready('widget-host.html', 'widget', 'clock');
  await evaluate(main, 'window.api.saveConfig({ clickThrough: false })');
  await until(() => typeof releaseGameProcess === 'function', 'controlled game detector');
  releaseGameProcess();
  await until(async () => (await state(main)).status !== 'waiting', 'simulated running game');
  await pause(250);
  layoutMonitor.onForeground(4321);
  await until(() => mousePolicy.get(main) === true && mousePolicy.get(clock) === true
    && !main.isFocusable() && !clock.isFocusable(), 'legacy click-through disabled still releases input during gameplay');
  assert.equal(find('focus-reminder.html'), undefined, 'Losing focus does not restart the launch reminder');
  shortcuts.get('Alt+F1')();
  await until(() => main.isFocusable() && clock.isFocusable() && mousePolicy.get(clock) === false, 'focus chord restores widget input');
  layoutMonitor.onForeground(process.pid);
  shortcuts.get('Alt+F1')();
  await pause(250);
  layoutMonitor.onForeground(4321);
  await until(() => mousePolicy.get(clock) === true && !clock.isFocusable(), 'second chord releases gameplay input');
  checks.push('passive Windows rail and widgets reject clicks/focus during gameplay, including saved click-through:false; chord enables and releases input');
  assert.deepEqual(errors, []);
  assert.deepEqual(failedLoads, []);
  const summary = { ok: true, phase, checks, errors, failedLoads, requests: requests.length, screenshots, windowLifecycle };
  fs.writeFileSync(path.join(out, phase + '-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: true, phase, checks, output: out }));
  server.close(); app.exit(0);
}).catch(async error => {
  console.error(error.stack);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { if (win.isVisible()) await capture(win, 'failure-' + win.id); } catch {}
  }
  fs.writeFileSync(path.join(out, phase + '-failure.json'), JSON.stringify({ message: error.message, checks, errors, failedLoads, screenshots, windowLifecycle,
    windows: BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).map(win => ({
      url: win.webContents.getURL(), visible: win.isVisible(), focused: win.isFocused(),
      focusable: win.isFocusable(), ignoresMouse: mousePolicy.get(win), bounds: win.getBounds(),
    })),
  }, null, 2));
  server.close(); app.exit(1);
});
setTimeout(() => { console.error('Onboarding smoke timed out: ' + out); app.exit(1); }, 40000).unref();
