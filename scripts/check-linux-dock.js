'use strict';

// Native QA in an isolated Linux Xvfb/Openbox desktop. Run with a packaged
// runtime via OVERKOT_PACKAGED_DIRECTORY; --app-root=/path/to/app.asar also
// exercises its bundled main process, preload and renderer. The profile,
// cursor and shortcuts are isolated and all remote requests are blocked.
if (process.platform !== 'linux') {
  console.error('This check requires an isolated Linux X11 desktop.');
  process.exit(1);
}
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 90000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const runtime = require('electron');
const { app, BrowserWindow, screen, session } = runtime;
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', `linux-dock-check-${Date.now()}`);
const restartArg = process.argv.find(arg => arg.startsWith('--restart-from='));
const profileRoot = restartArg ? path.resolve(restartArg.slice('--restart-from='.length)) : out;
const appRootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = appRootArg ? path.resolve(appRootArg.slice('--app-root='.length)) : root;
app.setAppPath(appRoot);
assert.equal(app.getAppPath(), appRoot);
const packageMetadata = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
fs.mkdirSync(out, { recursive: true });
process.env.XDG_DATA_HOME = path.join(profileRoot, 'data');
process.env.XDG_CONFIG_HOME = path.join(profileRoot, 'config');
process.env.OVERKOT_BUILD_CHANNEL = 'stable';
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/calendar.json';
app.setPath('userData', path.join(profileRoot, 'profile'));

// The real window manager controls all bounds. Only global input is synthetic,
// so the check cannot register hotkeys or inject keys into a user's desktop.
let cursor = { x: 500, y: 300 };
const shortcuts = new Map();
const screenFacade = new Proxy(screen, { get(target, key) {
  if (key === 'getCursorScreenPoint') return () => ({ ...cursor });
  const value = target[key];
  return typeof value === 'function' ? value.bind(target) : value;
} });
const shortcutFacade = {
  register: (key, handler) => { shortcuts.set(key, handler); return true; },
  unregister: key => shortcuts.delete(key), unregisterAll: () => shortcuts.clear(),
  isRegistered: key => shortcuts.has(key),
};
const electronFacade = new Proxy(runtime, { get(target, key) {
  if (key === 'screen') return screenFacade;
  if (key === 'globalShortcut') return shortcutFacade;
  return target[key];
} });
const offline = async () => { throw new Error('Remote requests disabled in Linux dock QA'); };
global.fetch = offline;
// Redirect Node HTTP clients (including bundled axios) to a closed loopback
// port. No credentials, headers or destination from the original request pass
// through. This covers source modules and the actual production main bundle.
const closedRequest = (...args) => http.request({ hostname: '127.0.0.1', port: 1, path: '/', method: 'GET', agent: false },
  typeof args.at(-1) === 'function' ? args.at(-1) : undefined);
const networkFacade = actual => new Proxy(actual, { get(target, key) {
  if (key === 'request') return closedRequest;
  if (key === 'get') return (...args) => { const request = closedRequest(...args); request.end(); return request; };
  return target[key];
} });
const fsFacade = new Proxy(fs, { get(target, key) {
  // Prevent discovery or inspection of any real game process, even if a game
  // happens to be running on the host of a future check.
  if (key === 'readdirSync') return (directory, ...args) => directory === '/proc' ? [] : fs.readdirSync(directory, ...args);
  return target[key];
} });
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return electronFacade;
  if (request === 'http' || request === 'node:http') return networkFacade(http);
  if (request === 'https' || request === 'node:https') return networkFacade(https);
  if (request === 'fs' || request === 'node:fs') return fsFacade;
  return originalLoad.call(this, request, parent, isMain);
};

const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
const restartSettings = restartArg ? config.getAll() : null;
if (restartArg) assert.equal(config.isFirstRun, false, 'Restart uses an existing saved profile');
else config.setMany({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  launchToTray: false, automaticUpdates: false, dockAutoHide: false, dockEdge: 'bottom',
  widgetVisibility: { boss: true, wiki: true }, widgetOpen: { boss: true, wiki: true },
  widgetDocked: { boss: true, wiki: true }, language: 'en', startupLayoutChoice: 'native-qa' });
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) errors.push(`Renderer load failed (${code}): ${description}`);
  });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
});
require(path.join(appRoot, 'src', 'main.js'));

const { railBounds, layoutDockedWidgets, snapWidgetToGrid, GRID_SIZE } = require('../src/modules/edgeDockGeometry');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await pause(40);
  }
  throw new Error('Timed out: ' + label);
}
async function ready(file, widget) {
  const win = await until(() => BrowserWindow.getAllWindows().find(candidate => {
    const url = new URL(candidate.webContents.getURL() || 'about:blank');
    return url.pathname.endsWith('/' + file) && (!widget || url.searchParams.get('widget') === widget);
  }), `window ${file}:${widget || ''}`);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), file + ' preload');
  return win;
}
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
const state = win => evaluate(win, 'window.api.getState()');
const save = (win, patch) => evaluate(win, `window.api.saveConfig(${JSON.stringify(patch)})`);
function near(actual, expected) {
  return ['x', 'y', 'width', 'height'].every(key => Math.abs(actual[key] - expected[key]) <= 1);
}
const xid = win => '0x' + win.getNativeWindowHandle().readUInt32LE(0).toString(16);
async function screenshot(win, name) {
  win.webContents.invalidate();
  await pause(100);
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

function finishCheck(boss, checks, initial, extra = {}) {
  assert.deepEqual(errors, []);
  const rendererPid = boss.webContents.getOSProcessId();
  const processStatus = fs.readFileSync(`/proc/${rendererPid}/status`, 'utf8');
  const rendererSandbox = { pid: rendererPid,
    uid: Number(processStatus.match(/^Uid:\s+(\d+)/m)?.[1]),
    noNewPrivileges: Number(processStatus.match(/^NoNewPrivs:\s+(\d+)/m)?.[1]),
    seccomp: Number(processStatus.match(/^Seccomp:\s+(\d+)/m)?.[1]),
    enabled: !app.commandLine.hasSwitch('no-sandbox') };
  if (rendererSandbox.enabled) {
    assert.equal(rendererSandbox.uid, process.getuid());
    assert.equal(rendererSandbox.noNewPrivileges, 1, 'Sandboxed renderer cannot acquire new privileges');
    assert.equal(rendererSandbox.seccomp, 2, 'Chromium renderer syscall filter is active');
    checks.push('ordinary-user renderer retains Chromium sandbox');
  }
  const result = { ok: true, checks, displayBackend: initial.platformSupport.displayBackend,
    appRoot, packageVersion: packageMetadata.version, runtime: process.versions.electron, rendererSandbox,
    profileRoot, ...extra, screenshots: out };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  app.exit(0);
}

app.whenReady().then(async () => {
  const main = await ready('index.html');
  const boss = await ready('widget-host.html', 'boss');
  const wiki = await ready('widget-host.html', 'wiki');
  await until(() => main.isVisible() && boss.isVisible() && wiki.isVisible(), 'visible rail and widgets').catch(async error => {
    console.error(JSON.stringify({ windows: [main, boss, wiki].map(win => ({ url: win.webContents.getURL(),
      visible: win.isVisible(), bounds: win.getBounds() })), state: await state(main) }));
    throw error;
  });
  const initial = await state(main);
  const updateState = await evaluate(main, 'window.api.getUpdateState()');
  assert.equal(updateState.currentVersion, packageMetadata.version, 'The actual main bundle reports its package version');
  assert.ok(['x11', 'xwayland'].includes(initial.platformSupport.displayBackend));
  assert.equal(await evaluate(main, 'window.i18n.titleTrackerEnabled'), true, 'Title Tracker is available in normal Linux builds');
  const dockProperty = execFileSync('xprop', ['-id', xid(main), '_NET_WM_WINDOW_TYPE'], { encoding: 'utf8' });
  assert.match(dockProperty, /_NET_WM_WINDOW_TYPE_DOCK/, 'Native X11 window exposes the compositor dock hint');
  const display = screen.getDisplayMatching(main.getBounds());
  const checks = ['native X11 dock window type and Title Tracker availability'];
  const panels = [{ id: 'boss', win: boss }, { id: 'wiki', win: wiki }];
  if (restartSettings) {
    assert.equal(restartSettings.dockEdge, 'top', 'The saved edge differs from the default');
    assert.equal(restartSettings.widgetDocked.boss, true);
    assert.equal(restartSettings.widgetDocked.wiki, false, 'A floating widget differs from the default');
    for (const key of ['dockEdge', 'widgetDocked', 'widgetOpen', 'widgetVisibility']) {
      assert.deepEqual(initial.config[key], restartSettings[key], key + ' survives restart');
    }
    await until(() => near(main.getBounds(), railBounds(display.bounds, restartSettings.dockEdge)), 'persisted rail edge restored');
    for (const { id, win } of panels) {
      const expected = restartSettings['widgetBounds_' + id];
      assert.ok(expected, id + ' has saved placement');
      await until(() => near(win.getBounds(), expected), id + ' placement restored without resetting the profile');
      await screenshot(win, 'restart-' + id);
    }
    await screenshot(main, 'restart-rail');
    checks.push('same profile restores a non-default edge, attached and floating widget modes, open panels and native positions');
    return finishCheck(boss, checks, initial, { restartFrom: profileRoot,
      restoredPlacement: { dockEdge: restartSettings.dockEdge, widgetDocked: restartSettings.widgetDocked,
        boss: boss.getBounds(), wiki: wiki.getBounds() } });
  }
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    await save(main, { dockEdge: edge, widgetDocked: { boss: true, wiki: true } });
    const expected = railBounds(display.bounds, edge);
    await until(() => near(main.getBounds(), expected), edge + ' rail placement');
    await pause(300); // Let auto-fit content dimensions and X11 configure events settle.
    const layout = layoutDockedWidgets(panels.map(({ id, win }) => ({ id, ...win.getBounds() })),
      display.workArea, edge, display.bounds);
    for (const desired of layout) {
      const win = panels.find(item => item.id === desired.id).win;
      await until(() => near(win.getBounds(), desired), `${edge} docked ${desired.id}`);
    }
    // Ask X11 to move the actual native window, without using the app's intended
    // geometry cache. It must repair the compositor move on its native event.
    const centered = { x: display.bounds.x + Math.round((display.bounds.width - expected.width) / 2),
      y: display.bounds.y + Math.round((display.bounds.height - expected.height) / 2) };
    let sawNativeMove = false;
    const observe = () => { if (!near(main.getBounds(), expected)) sawNativeMove = true; };
    main.on('move', observe);
    execFileSync('xdotool', ['windowmove', xid(main), String(centered.x), String(centered.y)]);
    await until(() => sawNativeMove, edge + ' compositor move observed');
    await until(() => near(main.getBounds(), expected), edge + ' compositor move repaired');
    main.removeListener('move', observe);
    // Native hide/show is another configure path implicated in placement bugs.
    main.hide(); main.showInactive();
    await until(() => near(main.getBounds(), expected), edge + ' restored rail placement');
    await screenshot(main, 'rail-' + edge);
  }
  checks.push('all four screen edges, docked widgets, native compositor move repair and hide/show');

  await save(main, { dockEdge: 'bottom', widgetDocked: { boss: true, wiki: true } });
  await pause(120);
  const attached = boss.getBounds();
  let movedByCompositor = false;
  const observeWidgetMove = () => { if (!near(boss.getBounds(), attached)) movedByCompositor = true; };
  boss.on('move', observeWidgetMove);
  execFileSync('xdotool', ['windowmove', xid(boss), String(attached.x + 41), String(attached.y - 35)]);
  await until(() => movedByCompositor, 'native attached widget move observed');
  await until(() => near(boss.getBounds(), attached), 'native attached widget returns to shelf');
  boss.removeListener('move', observeWidgetMove);
  boss.focus();
  await until(() => boss.isFocused(), 'widget native keyboard focus');
  await evaluate(boss, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',shiftKey:true,bubbles:true}))");
  await until(async () => (await state(main)).layoutEditing, 'renderer Shift enters layout mode');
  const editingMove = { ...attached, x: attached.x + 27, y: attached.y - 31 };
  execFileSync('xdotool', ['windowmove', xid(boss), String(editingMove.x), String(editingMove.y)]);
  await until(() => near(boss.getBounds(), editingMove), 'native widget movement permitted while editing');
  await pause(150);
  assert.ok(near(boss.getBounds(), editingMove), 'Attached widget is freely movable during Shift editing');
  boss.setBounds(attached);
  await until(() => near(boss.getBounds(), attached), 'restore app drag origin');
  const origin = boss.getBounds();
  cursor = { x: origin.x + 30, y: origin.y + 20 };
  await evaluate(boss, 'window.api.windowDragStart(3, false)');
  await until(() => boss._isDragging, 'app drag started');
  cursor = { x: cursor.x + 43, y: cursor.y - 97 };
  await evaluate(boss, 'window.api.windowMoveBy(43, -97, false)');
  await until(() => near(boss.getBounds(), { ...origin, x: origin.x + 43, y: origin.y - 97 }), 'native cursor drag sample');
  await evaluate(boss, 'window.api.windowDragEnd(false)');
  await until(() => !boss._isDragging, 'app drag ended');
  const moved = boss.getBounds();
  assert.equal((await state(main)).config.widgetDocked.boss, false, 'Dragging away detaches the panel');
  assert.ok((moved.x - display.bounds.x) % GRID_SIZE || (moved.y - display.bounds.y) % GRID_SIZE,
    'Shift permits free movement before release');
  await evaluate(boss, "document.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift',shiftKey:false,bubbles:true}))");
  await until(async () => !(await state(main)).layoutEditing, 'renderer Shift release exits layout mode');
  const snapped = snapWidgetToGrid(moved, display, 'bottom', true);
  await until(() => near(boss.getBounds(), snapped), 'Shift release grid alignment');
  await evaluate(boss, 'window.api.windowDragStart(3, false); window.api.windowMoveBy(30, 30, false)');
  await pause(120);
  assert.ok(near(boss.getBounds(), snapped), 'Widget movement stays locked outside layout editing');
  await save(main, { widgetDocked: { boss: true, wiki: true } });
  await until(async () => (await state(main)).config.widgetDocked.boss === true, 'widget redocked');
  boss.focus();
  await until(() => boss.isFocused(), 'fast-release widget focus');
  await evaluate(boss, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',shiftKey:true,bubbles:true}))");
  await until(async () => (await state(main)).layoutEditing, 'fast-release Shift mode');
  const quickOrigin = boss.getBounds();
  cursor = { x: quickOrigin.x + 30, y: quickOrigin.y + 20 };
  await evaluate(boss, 'window.api.windowDragStart(3, false)');
  await until(() => boss._isDragging, 'fast-release drag started');
  cursor = { x: cursor.x + 17, y: cursor.y - 29 };
  // Release the pointer and Shift together, without waiting for a polling tick
  // or any native configure reply. The controller must flush and align its
  // requested final placement rather than the window manager's older bounds.
  await evaluate(boss, "window.api.windowDragEnd(false);document.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift',shiftKey:false,bubbles:true}))");
  const quickSnap = snapWidgetToGrid({ ...quickOrigin, x: quickOrigin.x + 17, y: quickOrigin.y - 29 }, display, 'bottom', true);
  await until(() => near(boss.getBounds(), quickSnap), 'fast pointer and Shift release alignment');
  assert.equal((await state(main)).config.widgetDocked.boss, false);
  await save(main, { widgetDocked: { boss: true, wiki: true } });
  await screenshot(boss, 'widget-redocked');
  checks.push('native attached widget move repair, real keyboard focus, Shift dragging, undocking, grid snapping, fast release and locked normal mode');
  // Leave a deliberate non-default layout for the separate same-profile restart.
  await save(main, { dockEdge: 'top', widgetDocked: { boss: true, wiki: false } });
  await pause(250);
  wiki.focus();
  await until(() => wiki.isFocused(), 'persistence fixture widget focus');
  await evaluate(wiki, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',shiftKey:true,bubbles:true}))");
  await until(async () => (await state(main)).layoutEditing, 'persistence fixture editing');
  const floatingOrigin = wiki.getBounds();
  const floatingTarget = { ...floatingOrigin, x: display.bounds.x + 483, y: display.bounds.y + 377 };
  cursor = { x: floatingOrigin.x + 30, y: floatingOrigin.y + 20 };
  await evaluate(wiki, 'window.api.windowDragStart(3, false)');
  await until(() => wiki._isDragging, 'persistence fixture drag');
  cursor = { x: floatingTarget.x + 30, y: floatingTarget.y + 20 };
  await evaluate(wiki, "window.api.windowDragEnd(false);document.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift',shiftKey:false,bubbles:true}))");
  const floatingSnap = snapWidgetToGrid(floatingTarget, display, 'top', true);
  await until(() => near(wiki.getBounds(), floatingSnap), 'non-default floating placement saved');
  await until(() => {
    const disk = new ConfigStore().getAll();
    return disk.dockEdge === 'top' && disk.widgetDocked.boss === true && disk.widgetDocked.wiki === false
      && near(disk.widgetBounds_boss || {}, boss.getBounds()) && near(disk.widgetBounds_wiki || {}, wiki.getBounds());
  }, 'non-default layout reaches the encrypted configuration file');
  const persisted = new ConfigStore().getAll();
  checks.push('non-default edge and floating widget placement reach disk before exit');
  finishCheck(boss, checks, initial, { savedPlacement: { dockEdge: persisted.dockEdge,
    widgetDocked: persisted.widgetDocked, boss: persisted.widgetBounds_boss, wiki: persisted.widgetBounds_wiki } });
}).catch(error => {
  console.error(error.stack);
  console.error(JSON.stringify({ errors, output: out }));
  app.exit(1);
});
