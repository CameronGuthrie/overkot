// Real native-window integration check. All profiles and downloaded data stay
// under output; the game, authentication services and global input are mocked.
if (process.platform !== 'win32') {
  console.error('This native integration check requires Windows.');
  process.exit(1);
}
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: false, timeout: 70000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const electronRuntime = require('electron');
const { app, BrowserWindow, screen, session } = electronRuntime;
// Observe the real native policy calls while retaining their normal behavior.
const ignoredMouseEvents = new WeakMap();
const nativeSetIgnoreMouseEvents = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function(ignore, ...options) {
  const result = nativeSetIgnoreMouseEvents.call(this, ignore, ...options);
  ignoredMouseEvents.set(this, ignore);
  return result;
};
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', `edge-dock-smoke-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
app.setPath('userData', path.join(out, 'electron-profile'));
const feedRoot = path.join(root, 'output', 'data-feed');
assert.ok(fs.existsSync(path.join(feedRoot, 'manifest.json')), 'Build the local fixture feed with npm run data:build first.');
const manifest = JSON.parse(fs.readFileSync(path.join(feedRoot, 'manifest.json'), 'utf8'));
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
    requests.push(pathname);
    response.writeHead(200, { ETag: manifest.version }); response.end(bytes);
  });
});
server.listen(port, '127.0.0.1');
const shortcutCallbacks = new Map();
// Exercise the actual app's registered callbacks without taking shortcuts away
// from a running user profile or synthesizing keyboard input into the desktop.
let cursor = { x: 500, y: 300 }, layoutMonitor, releaseGameProcess;
let displayWorkAreaOverride = null;
let simulatedGamePresent = false, simulatedGameForeground = true;
let gameFocusTarget, gameFocusRequests = 0;
let dungeonState = { active: false, status: 'outside' }, dungeonChanged;
const dungeonTable = require('../test/fixtures/underCityCliffCave.json');
const dungeonFixture = {
  'dungeons/index.json': { sets: [{ key: 'underCityMidrath', set: dungeonTable.set, level_paths: [dungeonTable.level_path] }] },
  'dungeons/underCityMidrath/layouts.json': { layouts: [dungeonTable] },
  'dungeons/underCityMidrath/rooms.json': { rooms: [...dungeonTable.spawns, ...dungeonTable.components].map(entry => ({
    room: entry.room, outline: [{ closed: true, points: [[-8, -5], [8, -5], [8, 5], [-8, 5]] }],
  })) },
};
const shortcutFacade = {
  register: (key, callback) => { shortcutCallbacks.set(key, callback); return true; },
  unregister: key => shortcutCallbacks.delete(key), unregisterAll: () => shortcutCallbacks.clear(),
  isRegistered: key => shortcutCallbacks.has(key),
};
const screenFacade = new Proxy({}, { get: (_target, key) => {
  if (key === 'getCursorScreenPoint') return () => ({ ...cursor });
  if (['getPrimaryDisplay', 'getAllDisplays', 'getDisplayMatching', 'getDisplayNearestPoint'].includes(key)) {
    const patchDisplay = display => displayWorkAreaOverride?.id === display.id
      ? { ...display, workArea: { ...displayWorkAreaOverride.workArea } } : display;
    return (...args) => {
      const result = screen[key](...args);
      return Array.isArray(result) ? result.map(patchDisplay) : patchDisplay(result);
    };
  }
  const value = screen[key];
  return typeof value === 'function' ? value.bind(screen) : value;
} });
const electronFacade = new Proxy(electronRuntime, { get: (target, key) => {
  if (key === 'screen') return screenFacade;
  if (key === 'globalShortcut') return shortcutFacade;
  return target[key];
} });
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return electronFacade;
  if (request.endsWith('/modules/layoutKeyMonitor')) return {
    startLayoutKeyMonitor: callbacks => { layoutMonitor = callbacks; return { stop() {} }; },
  };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class {
    waitForProcess() { return new Promise(resolve => { releaseGameProcess = () => { simulatedGamePresent = true; resolve(4321); }; }); }
    findProcess() { return Promise.resolve(simulatedGamePresent ? 4321 : 0); }
    isProcessRunning() { return simulatedGamePresent; }
    startForegroundMonitor() { this._fgProc = {}; } stopForegroundMonitor() { this._fgProc = null; }
    isProcessForeground() { return Promise.resolve(simulatedGameForeground); }
    async focusGameWindow() {
      gameFocusRequests++;
      gameFocusTarget.show(); gameFocusTarget.focus();
      return true;
    }
  } };
  if (request.endsWith('/modules/memoryScanner')) return {
    MemoryScanner: class { scanForAccountAndNonce() { return Promise.resolve({ accountId: '', nonce: '' }); } }, scannerAvailableSync: () => false,
  };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class {
    start() {} stop() {} currentLogin() { return null; } extractDisplayName() { return ''; }
    consumeLoginSignal() { return false; } consumeLogoutSignal() { return false; } extractAccountId() { return ''; }
  } };
  if (request.endsWith('/modules/dungeonWatcher')) return { DungeonWatcher: class {
    constructor(options) { dungeonChanged = options.onChange; } start() {} stop() {} getState() { return dungeonState; }
  } };
  if (request.endsWith('/modules/dungeonMap')) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return { ...actual, DungeonMap: class extends actual.DungeonMap {
      constructor(options) { super({ ...options, dataManager: {
        ensureAsset: async () => {}, checkForUpdates: async () => {}, getInfo: () => ({ version: 'fixture' }),
        readJSON: key => dungeonFixture[key] || null,
      } }); }
    } };
  }
  for (const [module, exported] of [['arenaWatcher', 'ArenaWatcher'], ['ancestorWatcher', 'AncestorWatcher']]) {
    if (request.endsWith('/modules/' + module)) return { [exported]: class { start() {} stop() {} } };
  }
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, {
    get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false),
  });
  if (request.endsWith('/modules/inventoryPoller')) {
    const actual = originalLoad.call(this, request, parent, isMain);
    return { ...actual, loadCachedTimers: () => ({ timers: [
      { tag: 'CurlailSiege', expiryTime: Math.floor(Date.now() / 1000) + 900 },
      { tag: 'KearnholdSiege', expiryTime: Math.floor(Date.now() / 1000) + 1200 },
    ], factions: [], rawInventory: null }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const { TUTORIAL_IDS } = require('../src/modules/tutorials');
const fixtureConfig = new ConfigStore();
fixtureConfig.setMany({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  launchToTray: false, automaticUpdates: false, enableAlertSound: false, enableAlertPopup: false,
  theme: 'classic', backgroundOpacity: 88, dockEdge: 'bottom', dockAutoHide: false,
  widgetVisibility: { boss: true, wiki: true, clock: true }, widgetOpen: {}, widgetDocked: {},
  dockParadigmVersion: 1, startupLayoutPending: false,
  // Dedicated check-onboarding.js covers first-use tours. Keep these native
  // layout/focus checks independent of the extra tutorial windows.
  tutorialCompleted: Object.fromEntries(TUTORIAL_IDS.map(id => [id, true])),
});
const errors = [], failedLoads = [], checks = [], screenshots = [], geometry = {};
const visibilitySnapshots = [];
function recordVisibility(stage) {
  const snapshot = { stage, windows: BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).map(win => ({
    id: win.id, url: win.webContents.getURL(), visible: win.isVisible(), restore: win._visibleBeforeOverlayHide,
  })) };
  visibilitySnapshots.push(snapshot);
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) failedLoads.push({ code, description, url });
  });
});
require('../src/main');
const { railBounds, layoutDockedWidgets, snapWidgetToGrid, GRID_SIZE } = require('../src/modules/edgeDockGeometry');
const { getWindowBounds } = require('../src/modules/windowDrag');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const matchesPage = (win, file, widget) => {
  const url = new URL(win.webContents.getURL() || 'about:blank');
  return url.pathname.endsWith('/' + file) && (!widget || url.searchParams.get('widget') === widget);
};
const find = (file, widget) => BrowserWindow.getAllWindows().find(win => matchesPage(win, file, widget));
async function until(fn, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
async function ready(file, widget) {
  const win = await until(() => find(file, widget), file + (widget ? ':' + widget : ''));
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), file + ' preload');
  return win;
}
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
async function save(main, patch) { await evaluate(main, `window.api.saveConfig(${JSON.stringify(patch)})`); await pause(100); }
async function getState(main) { return evaluate(main, 'window.api.getState()'); }
async function capture(win, name) {
  await pause(120);
  const filename = path.join(out, name + '.png');
  fs.writeFileSync(filename, (await win.webContents.capturePage()).toPNG());
  screenshots.push(filename);
  return filename;
}

// Compose only the app's captured windows on a neutral screen-sized backdrop.
// This verifies the spatial paradigm without capturing private desktop content.
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type), crcBytes = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of crcBytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); typeBytes.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return output;
}
async function captureLayout(display, windows, name) {
  const width = display.bounds.width, height = display.bounds.height;
  const pixels = Buffer.alloc(width * height * 4);
  for (let p = 0; p < pixels.length; p += 4) { pixels[p] = 27; pixels[p + 1] = 33; pixels[p + 2] = 38; pixels[p + 3] = 255; }
  for (const win of windows) {
    if (!win || win.isDestroyed() || !win.isVisible()) continue;
    const bounds = getWindowBounds(win);
    const image = (await win.webContents.capturePage()).resize({ width: bounds.width, height: bounds.height });
    const source = image.toBitmap();
    for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
      const destX = bounds.x - display.bounds.x + x, destY = bounds.y - display.bounds.y + y;
      if (destX < 0 || destY < 0 || destX >= width || destY >= height) continue;
      const src = (y * bounds.width + x) * 4, dst = (destY * width + destX) * 4;
      const alpha = source[src + 3] / 255;
      for (let channel = 0; channel < 3; channel++) pixels[dst + channel] = Math.min(255, source[src + 2 - channel] + pixels[dst + channel] * (1 - alpha));
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const filename = path.join(out, name + '.png');
  fs.writeFileSync(filename, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]));
  screenshots.push(filename);
  return filename;
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(`http://127.0.0.1:${port}/`) });
  });
  const display = screen.getPrimaryDisplay();
  cursor = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 };
  const main = await ready('index.html');
  await until(() => main.isVisible() && layoutMonitor, 'visible bar and monitor');
  assert.equal(ignoredMouseEvents.get(main), true, 'The sidebar starts pass-through outside interaction mode');
  await until(async () => await evaluate(main, "document.querySelectorAll('.dock-widget-button').length === 3"), 'enabled widget icons');
  assert.equal(find('widget-host.html'), undefined, 'Enabling widgets must create launch icons without opening panels');
  assert.deepEqual(await evaluate(main, "[...document.querySelectorAll('.dock-widget-button')].map(button => button.getAttribute('aria-pressed'))"), ['false', 'false', 'false']);
  checks.push('enabled widgets appear as inactive launch icons');
  await evaluate(main, "document.querySelector('[data-widget=wiki]').click()");
  const wiki = await ready('widget-host.html', 'wiki');
  await until(() => wiki.isVisible(), 'wiki opened');
  await evaluate(wiki, "document.getElementById('wiki-search-input').value = 'retained input'");
  const wikiId = wiki.id;
  await evaluate(main, "document.querySelector('[data-widget=wiki]').click()");
  await until(() => !wiki.isVisible(), 'wiki hidden');
  assert.equal(wiki.isDestroyed(), false);
  await evaluate(main, "document.querySelector('[data-widget=wiki]').click()");
  await until(() => wiki.isVisible(), 'wiki reopened');
  assert.equal(find('widget-host.html', 'wiki').id, wikiId);
  assert.equal(await evaluate(wiki, "document.getElementById('wiki-search-input').value"), 'retained input');
  checks.push('widget toggles retain native window, renderer and form state');
  await evaluate(main, "document.querySelector('[data-widget=boss]').click(); document.querySelector('[data-widget=clock]').click()");
  const boss = await ready('widget-host.html', 'boss'), clock = await ready('widget-host.html', 'clock');
  await until(async () => await evaluate(boss, "document.querySelectorAll('.timer-entry').length === 2"), 'timer functionality');
  await pause(300);
  for (const edge of ['bottom', 'top', 'left', 'right']) {
    await save(main, { dockEdge: edge });
    const expected = railBounds(display.bounds, edge);
    assert.deepEqual(main.getBounds(), expected, `${edge} native bar bounds`);
    assert.equal(await evaluate(main, 'document.body.dataset.dockEdge'), edge);
    const items = [boss, wiki, clock].map(win => ({ id: win._widgetId, ...getWindowBounds(win) }));
    const expectedPanels = layoutDockedWidgets(items, display.workArea, edge, display.bounds);
    for (const win of [boss, wiki, clock]) {
      const { id, ...bounds } = expectedPanels.find(panel => panel.id === win._widgetId);
      assert.deepEqual(getWindowBounds(win), bounds, `${edge} attached ${id} panel`);
    }
    const overflow = await evaluate(main, '({ x: document.body.scrollWidth > innerWidth, y: document.body.scrollHeight > innerHeight })');
    assert.deepEqual(overflow, { x: false, y: false }, `${edge} bar must fit its viewport`);
    geometry[edge] = { bar: main.getBounds(), panels: [boss, wiki, clock].map(win => ({ id: win._widgetId, ...getWindowBounds(win) })) };
    await capture(main, `bar-${edge}`);
    await captureLayout(display, [boss, wiki, clock, main], `layout-${edge}`);
  }
  checks.push('four full-length 48 DIP screen edges and multiple attached panels');
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    await save(main, { dockEdge: edge });
    const expected = railBounds(display.bounds, edge);
    // Emulate a native taskbar/window-manager adjustment without changing the
    // real desktop. The app's remembered intended size remains full-length.
    const axis = ['left', 'right'].includes(edge) ? 'height' : 'width';
    main.setBounds({ ...expected, [axis]: expected[axis] - 40 });
    await until(() => ['x', 'y', 'width', 'height'].every(key => main.getBounds()[key] === expected[key]),
      `${edge} repairs native sidebar shortening without restart`);
    assert.equal(ignoredMouseEvents.get(main), true, 'Geometry repair retains sidebar click-through');
  }
  await save(main, { dockEdge: 'left' });
  for (const workArea of [
    { ...display.bounds, height: display.bounds.height - 40 },
    { ...display.bounds, y: display.bounds.y + 40, height: display.bounds.height - 40 },
  ]) {
    displayWorkAreaOverride = { id: display.id, workArea };
    screen.emit('display-metrics-changed', {}, { ...display, workArea }, ['workArea']);
    const expected = railBounds(display.bounds, 'left');
    await until(() => ['x', 'y', 'width', 'height'].every(key => main.getBounds()[key] === expected[key]),
      'taskbar work-area changes retain full display height');
    const expectedPanels = layoutDockedWidgets([boss, wiki, clock].map(win => ({ id: win._widgetId, ...getWindowBounds(win) })),
      workArea, 'left', display.bounds);
    await until(() => expectedPanels.every(({ id, ...bounds }) =>
      ['x', 'y', 'width', 'height'].every(key => getWindowBounds(find('widget-host.html', id))[key] === bounds[key])),
    'attached panels follow updated taskbar work area');
    assert.equal(main.isFocused(), false, 'Taskbar geometry repair does not activate the sidebar');
  }
  displayWorkAreaOverride = null;
  screen.emit('display-metrics-changed', {}, display, ['workArea']);
  checks.push('native sidebar shrink repairs itself on every edge; taskbar work-area changes preserve full rail height and relayout panels');
  await capture(boss, 'boss-widget'); await capture(wiki, 'wiki-widget'); await capture(clock, 'clock-widget');
  assert.equal(await evaluate(boss, "document.querySelector('.widget-collapse-btn, .widget-drag-region') === null"), true);
  await save(main, { dockEdge: 'bottom' });
  shortcutCallbacks.get('Shift+F1')();
  main.focus();
  const iconRects = await evaluate(main, "[...document.querySelectorAll('.dock-widget-button')].map(b=>{const r=b.getBoundingClientRect();return {id:b.dataset.widget,x:r.x+r.width/2,y:r.y+r.height/2}})");
  const firstIcon = iconRects[0], lastIcon = iconRects.at(-1);
  main.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(firstIcon.x), y: Math.round(firstIcon.y) });
  await pause(80);
  main.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: Math.round(lastIcon.x + 8), y: Math.round(lastIcon.y) });
  await pause(150);
  main.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(lastIcon.x + 8), y: Math.round(lastIcon.y) });
  await until(async () => (await getState(main)).config.dockWidgetOrder?.filter(id => iconRects.some(icon => icon.id === id)).at(-1) === firstIcon.id, 'native pointer drag saves icon order');
  assert.equal((await getState(main)).config.widgetOpen[firstIcon.id], true, 'Reordering must not toggle the dragged widget');
  await save(main, { dockWidgetOrder: [] });
  checks.push('real mouse drag reorders launcher icons persistently without toggling panels');
  // Shift held in the game or another application must not engage layout mode.
  const outside = new BrowserWindow({ width: 120, height: 80, show: false, frame: false, skipTaskbar: true });
  gameFocusTarget = outside;
  await outside.loadURL('about:blank');
  outside.show(); outside.focus();
  await until(() => outside.isFocused(), 'outside fixture receives focus');
  layoutMonitor.onShift(true);
  await pause(220);
  assert.equal((await getState(main)).layoutEditing, false);
  assert.equal(find('layout-grid.html'), undefined);
  layoutMonitor.onShift(false);
  shortcutCallbacks.get('Shift+F1')();
  await until(() => main.isFocused(), 'interaction shortcut focuses overlay');
  layoutMonitor.onShift(true);
  await until(async () => (await getState(main)).layoutEditing, 'Shift layout mode');
  const grid = await until(() => BrowserWindow.getAllWindows().find(win =>
    matchesPage(win, 'layout-grid.html') && win.isVisible() && screen.getDisplayMatching(win.getBounds()).id === display.id), 'primary layout grid visible');
  await until(async () => !grid.webContents.isLoading() && await evaluate(grid, "document.readyState === 'complete' && getComputedStyle(document.body).backgroundImage !== 'none'"), 'painted layout grid');
  await pause(120);
  for (const visibleGrid of BrowserWindow.getAllWindows().filter(win => matchesPage(win, 'layout-grid.html'))) {
    assert.deepEqual(visibleGrid.getBounds(), screen.getDisplayMatching(visibleGrid.getBounds()).bounds, 'The editing scrim must cover the entire native display');
  }
  assert.equal(await evaluate(boss, "document.body.classList.contains('layout-editing')"), true);
  await capture(grid, 'layout-grid');
  await captureLayout(display, [grid, boss, wiki, clock, main], 'layout-editing');
  const startBounds = getWindowBounds(boss);
  cursor = { x: display.bounds.x + 500, y: display.bounds.y + 300 };
  await evaluate(boss, 'window.api.windowDragStart(3, false)');
  await until(() => boss._isDragging, 'native drag started');
  cursor = { x: cursor.x + 43, y: cursor.y - 97 };
  await evaluate(boss, 'window.api.windowMoveBy(43, -97, false)');
  await until(() => getWindowBounds(boss).x === startBounds.x + 43 && getWindowBounds(boss).y === startBounds.y - 97, 'native cursor drag sample', 2000).catch(async error => {
    console.error(JSON.stringify({ startBounds, actual: getWindowBounds(boss), cursor: screenFacade.getCursorScreenPoint(), dragging: boss._isDragging,
      target: boss._dragTarget, origin: boss._layoutDragOrigin, state: (await getState(main)).dockState }));
    throw error;
  });
  await evaluate(boss, 'window.api.windowDragEnd(false)');
  await until(() => !boss._isDragging, 'native drag ended');
  const moved = getWindowBounds(boss);
  assert.equal(moved.x, startBounds.x + 43);
  assert.equal(moved.y, startBounds.y - 97);
  assert.equal((await getState(main)).config.widgetDocked.boss, false);
  assert.ok((moved.x - display.bounds.x) % GRID_SIZE || (moved.y - display.bounds.y) % GRID_SIZE, 'Movement during Shift must be free of grid snapping');
  layoutMonitor.onShift(false);
  await until(async () => !(await getState(main)).layoutEditing, 'Shift release');
  assert.equal(find('layout-grid.html'), undefined);
  assert.deepEqual(getWindowBounds(boss), snapWidgetToGrid(moved, display, 'bottom', true));
  const snapped = getWindowBounds(boss);
  await evaluate(boss, 'window.api.windowMoveBy(9, 9, false)'); await pause(60);
  assert.deepEqual(getWindowBounds(boss), snapped, 'Widgets must reject movement outside layout mode');
  checks.push('Shift scrim/grid lifecycle, free dragging, undocking, and grid alignment on release');
  await captureLayout(display, [boss, wiki, clock, main], 'layout-floating');
  layoutMonitor.onShift(true);
  await until(async () => (await getState(main)).layoutEditing, 'redock edit mode');
  const bar = main.getBounds();
  cursor = { x: snapped.x + 100, y: snapped.y + 20 };
  await evaluate(boss, 'window.api.windowDragStart(3, false)');
  await until(() => boss._isDragging, 'redock native drag started');
  cursor = { x: bar.x + 200, y: bar.y + 12 };
  await evaluate(boss, `window.api.windowMoveBy(${cursor.x - snapped.x - 100}, ${cursor.y - snapped.y - 20}, false)`);
  await until(async () => (await getState(main)).dockState.redockTarget, 'highlighted dock drop target');
  await evaluate(boss, 'window.api.windowDragEnd(false)');
  layoutMonitor.onShift(false);
  await until(async () => (await getState(main)).config.widgetDocked.boss === true && !(await getState(main)).layoutEditing, 'redocked widget');
  checks.push('dragging onto the bar highlights a drop target and reattaches the widget');
  // Losing overlay focus ends a held-Shift session without waiting for key-up.
  main.focus();
  layoutMonitor.onShift(true);
  await until(async () => (await getState(main)).layoutEditing, 'focused Shift mode');
  outside.show(); outside.focus();
  await until(() => outside.isFocused(), 'outside fixture takes focus during Shift');
  await until(async () => !(await getState(main)).layoutEditing && !find('layout-grid.html'), 'focus loss ends layout mode');
  layoutMonitor.onShift(false);
  outside.hide();
  checks.push('Shift does nothing outside overlay focus and focus loss immediately dismisses grid/editing');
  // Hiding the outside fixture does not reliably give a native Windows app
  // foreground ownership. Model the user's explicit interact chord before
  // invoking a launcher action, rather than relying on focus reassignment.
  if (!(await getState(main)).overlayInteractive) shortcutCallbacks.get('Shift+F1')();
  else main.focus();
  await until(() => main.isFocused() && ignoredMouseEvents.get(main) === false, 'explicit interaction before opening Settings');
  await evaluate(main, 'window.api.openSettings()');
  const settings = await ready('settings.html');
  await until(() => settings.isVisible(), 'settings shown before shortcut check');
  await until(async () => await evaluate(settings, 'initialized'), 'settings initialized');
  await evaluate(settings, "document.getElementById('tab-overlay').click()");
  assert.equal(await evaluate(settings, "document.getElementById('overlay-hotkey-capture').textContent.trim()"), 'Shift + F2');
  await capture(settings, 'settings-overlay');
  await evaluate(settings, "document.getElementById('tab-widgets').click()"); await capture(settings, 'settings-widgets');
  const overlayShortcut = shortcutCallbacks.get('Shift+F2');
  assert.equal(typeof overlayShortcut, 'function', 'The default visibility chord must be registered');
  recordVisibility('before-hide');
  overlayShortcut();
  await until(() => BrowserWindow.getAllWindows().every(win => !win.isVisible()), 'complete overlay hidden');
  recordVisibility('after-hide');
  await save(main, { backgroundOpacity: 86 });
  main.webContents.send('state-update', { timers: [], namesMap: {} }); await pause(150);
  assert.equal(BrowserWindow.getAllWindows().every(win => !win.isVisible()), true, 'Config and data updates must not revive a user-hidden overlay');
  recordVisibility('after-hidden-updates');
  overlayShortcut();
  recordVisibility('immediate-restore');
  await until(() => main.isVisible() && settings.isVisible() && [boss, wiki, clock].every(win => win.isVisible()), 'overlay restored');
  checks.push('Shift+F2 callback hides every overlay window, survives updates and restores prior visible windows');
  await evaluate(settings, 'window.api.windowClose()');
  await until(() => !find('settings.html'), 'settings close');
  await save(main, { dockAutoHide: true });
  cursor = { x: display.bounds.x + display.bounds.width - 100, y: display.bounds.y + 100 };
  outside.show(); outside.focus();
  await until(() => outside.isFocused(), 'game fixture focus before auto-hide');
  await until(async () => (await getState(main)).dockState.autoHidden, 'auto-hide after leaving bar and panels');
  assert.equal(main.isVisible(), false, 'Auto-hide must fully hide the native bar');
  const hiddenPanels = layoutDockedWidgets([boss, wiki, clock].map(win => ({ id: win._widgetId, ...getWindowBounds(win) })), display.workArea, 'bottom', display.bounds, true);
  for (const win of [boss, wiki, clock]) {
    const { id, ...bounds } = hiddenPanels.find(panel => panel.id === win._widgetId);
    assert.deepEqual(getWindowBounds(win), bounds, `${id} uses the released dock space`);
    assert.equal(win.isVisible(), true);
  }
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    cursor = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 };
    await save(main, { dockEdge: edge });
    await until(async () => (await getState(main)).dockState.autoHidden, `${edge} bar auto-hides outside overlay focus`);
    const reveal = railBounds(display.bounds, edge, true);
    cursor = { x: reveal.x + Math.floor(reveal.width / 2), y: reveal.y + Math.floor(reveal.height / 2) };
    await pause(180);
    assert.equal(main.isVisible(), false, `${edge} pointer movement cannot revive an unfocused collapsed bar`);
    assert.equal((await getState(main)).dockState.autoHidden, true);
    assert.equal(outside.isFocused(), true, 'Cursor monitoring does not take focus from the game');
  }
  checks.push('moving the game cursor to a collapsed sidebar edge cannot reveal it on any display edge');
  shortcutCallbacks.get('Shift+F1')();
  await until(() => main.isFocused() && main.isVisible() && ignoredMouseEvents.get(main) === false,
    'interaction shortcut explicitly reveals collapsed sidebar');
  wiki.focus();
  await until(() => wiki.isFocused(), 'attached widget retains overlay interaction focus');
  await evaluate(wiki, "document.getElementById('wiki-search-input').focus()");
  await wiki.webContents.insertText(' test');
  cursor = { x: display.bounds.x + display.bounds.width - 100, y: display.bounds.y + 100 };
  await pause(1050);
  assert.equal((await getState(main)).overlayInteractive, true);
  assert.equal(main.isVisible(), true, 'The sidebar stays visible while editing a widget away from its bounds');
  assert.equal(await evaluate(wiki, "document.getElementById('wiki-search-input').value.includes(' test')"), true);
  outside.show(); outside.focus();
  await until(() => outside.isFocused(), 'focus leaves the active widget for the game fixture');
  // Windows can reassign foreground again when the rail's native window hides.
  await until(async () => {
    const state = await getState(main);
    return !state.overlayInteractive && state.dockState.autoHidden && !main.isVisible();
  }, 'leaving active widget input collapses the sidebar');

  // A pointer-driven rail can auto-hide while the overlay is interactive.
  // Keep focus in an available panel as the launcher relinquishes it.
  shortcutCallbacks.get('Shift+F1')();
  await until(() => main.isFocused() && main.isVisible(), 'interaction reveals rail before edge check');
  main.once('hide', () => wiki.focus());
  await evaluate(main, 'window.api.setDockKeyboardActive(false)');
  await until(async () => wiki.isFocused() && (await getState(main)).dockState.autoHidden, 'idle rail yields focus to the open widget');
  const reveal = railBounds(display.bounds, 'bottom', true); cursor = { x: reveal.x + 100, y: reveal.y + 1 };
  await until(async () => !(await getState(main)).dockState.autoHidden, 'focused interaction permits edge reveal');
  assert.deepEqual(main.getBounds(), railBounds(display.bounds, 'bottom'));
  assert.equal(main.isVisible(), true);
  outside.focus();
  await until(() => outside.isFocused(), 'game focus returns with pointer still on sidebar');
  await until(async () => (await getState(main)).dockState.autoHidden, 'game cursor over visible sidebar cannot keep it open');
  checks.push('widget text input keeps the sidebar visible, outside focus collapses it, and active edge interaction reveals it');
  await save(main, { dockAutoHide: false });
  await evaluate(main, 'window.api.windowMinimize()');
  await until(() => BrowserWindow.getAllWindows().every(win => !win.isVisible()), 'minimize hides complete overlay');
  overlayShortcut();
  await until(() => main.isVisible() && [boss, wiki, clock].every(win => win.isVisible()), 'visibility shortcut restores minimized overlay');
  assert.equal(main.isMinimized(), false);
  checks.push('minimize and visibility shortcut use a single hide/restore state');
  await save(main, { widgetVisibility: { boss: true, wiki: true, clock: true, minimap: true }, widgetOpen: { boss: true, wiki: true, clock: true, minimap: true } });
  await evaluate(main, "window.api.toggleDockWidget('minimap')");
  const minimap = await ready('widget-host.html', 'minimap');
  const panels = [boss, wiki, clock, minimap];
  await save(main, { clickThrough: true,
    widgetDocked: { ...(await getState(main)).config.widgetDocked, boss: false, wiki: true, clock: true, minimap: true } });
  await until(() => panels.every(win => ignoredMouseEvents.get(win) === true), 'docked and floating panels restore click-through');
  assert.equal(ignoredMouseEvents.get(main), true, 'The sidebar restores click-through alongside the widgets');
  shortcutCallbacks.get('Shift+F1')();
  await until(() => main.isFocused() && ignoredMouseEvents.get(main) === false && panels.every(win => ignoredMouseEvents.get(win) === false), 'interaction enables sidebar and every widget panel');
  async function returnFocusOutside(windows, label) {
    // Suppress Windows handing focus between overlay windows during blur.
    for (const win of windows) { win.setFocusable(false); win.blur(); }
    outside.show(); outside.focus();
    await until(() => outside.isFocused(), label);
    await until(() => panels.every(win => ignoredMouseEvents.get(win) === true), label + ' restores widget click-through');
    for (const win of windows) if (!win.isDestroyed()) win.setFocusable(true);
  }
  await returnFocusOutside([main, ...panels], 'outside focus after widget interaction');
  assert.equal(ignoredMouseEvents.get(main), true, 'Returning game focus releases sidebar input');
  await save(main, { clickThrough: false });
  assert.ok(panels.every(win => ignoredMouseEvents.get(win) === false), 'Disabling click-through keeps docked and floating panels clickable');
  assert.equal(ignoredMouseEvents.get(main), true, 'Sidebar still requires interaction when widget click-through is disabled');
  await save(main, { clickThrough: true });
  assert.ok(panels.every(win => ignoredMouseEvents.get(win) === true), 'Enabling click-through immediately updates every panel');
  checks.push('sidebar requires interaction while docked and floating panels obey configured click-through after focus loss and configuration changes');
  dungeonState = { active: true, status: 'ready', name: 'Cliff Cave', set: dungeonTable.set,
    key: 'underCityMidrath', levelPath: dungeonTable.level_path, layoutCode: 'KhGCACHMpRNZ3fAghiCAAQjA', instanceId: 'edge-dock-fixture-dungeon-1' };
  dungeonChanged(dungeonState);
  await until(async () => await evaluate(minimap, "document.querySelector('.dungeon-map [data-action=expand]')?.getClientRects().length > 0"), 'dungeon expansion button');
  await evaluate(minimap, "document.querySelector('.dungeon-map [data-action=expand]').click()");
  const largeMap = await ready('dungeon-overlay.html');
  await until(() => largeMap.isVisible() && !minimap.isVisible(), 'expanded dungeon replaces minimap');
  assert.deepEqual(largeMap.getBounds(), display.bounds);
  assert.equal((await getState(main)).config.widgetOpen.minimap, true, 'Expansion preserves the minimap open preference');
  await until(async () => await evaluate(largeMap, "document.querySelector('.dungeon-map').dataset.status === 'placed' || document.querySelector('.dungeon-map').dataset.status === 'schematic'"), 'large dungeon fixture scene');
  assert.equal(await evaluate(largeMap, "getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' && document.querySelector('[data-action=labels]') === null"), true);
  await until(() => largeMap.isFocused() && ignoredMouseEvents.get(largeMap) === false, 'expanded dungeon is interactive');
  // The renderer deliberately hides undiscovered room geometry. Supply the
  // same public, verified-memory pose shape as the dedicated dungeon fixture
  // so this native pan test compares actual drawing instead of an empty canvas.
  // No memory reader or real game process is involved.
  const dungeonScene = await evaluate(largeMap, 'window.api.getDungeonMap()');
  assert.equal(dungeonScene.mode, 'placed', 'native pan fixture has placed room geometry');
  const roomTransform = dungeonScene.rooms[0].transform;
  largeMap.webContents.send('player-location', { status: 'found', source: 'memory', sampledAt: Date.now(),
    isOverworld: false, instanceId: dungeonState.instanceId, trackingSession: 'edge-dock-fixture', heading: 90,
    position: { x: roomTransform.x, y: 0, z: roomTransform.z },
    dungeon: { alignmentVerified: true, instanceId: dungeonState.instanceId, revision: dungeonScene.version,
      coordinateSpace: dungeonScene.coordinateSpace, scope: { fixture: 'edge-dock-native-pan' },
      position: { x: roomTransform.x, z: roomTransform.z } },
  });
  await until(() => evaluate(largeMap, "(()=>{const c=document.querySelector('canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=3;i<p.length;i+=4)if(p[i]>0)return true;return false;})()"), 'verified fixture paints dungeon canvas before native pan');
  // Let the truthful live marker expire before taking a pixel reference. The
  // explored outlines persist, so marker expiry cannot masquerade as panning.
  await until(() => evaluate(largeMap, "document.querySelector('.dungeon-map-footer').textContent.includes('waiting for live player position')"), 'pan fixture retains discovered outlines after its live pose expires');
  assert.equal(await evaluate(largeMap, "(()=>{const c=document.querySelector('canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=3;i<p.length;i+=4)if(p[i]>0)return true;return false;})()"), true, 'native pan reference contains discovered room pixels');
  const originalDrawing = await evaluate(largeMap, "document.querySelector('canvas').toDataURL()");
  await evaluate(largeMap, "document.querySelector('.dungeon-map-viewport').addEventListener('pointerdown',event=>window.__panPointerId=event.pointerId)");
  const viewport = await evaluate(largeMap, "(()=>{const r=document.querySelector('.dungeon-map-viewport').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  largeMap.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...viewport });
  await until(async () => await evaluate(largeMap, "document.querySelector('.dungeon-map-viewport').hasPointerCapture(window.__panPointerId)"), 'native dungeon pan captures pointer');
  largeMap.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: viewport.x + 35, y: viewport.y + 20 });
  await until(async () => await evaluate(largeMap, "document.querySelector('canvas').toDataURL()") !== originalDrawing, 'native dungeon pan changes drawing');
  const pannedDrawing = await evaluate(largeMap, "document.querySelector('canvas').toDataURL()");
  largeMap.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  largeMap.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(async () => gameFocusRequests === 1 && outside.isFocused() && !(await getState(main)).overlayInteractive
    && ignoredMouseEvents.get(main) === true && ignoredMouseEvents.get(largeMap) === true,
  'Escape returns input and native focus to the game fixture');
  assert.equal(largeMap.isVisible(), true);
  assert.equal(minimap.isVisible(), false);
  assert.equal(await evaluate(largeMap, "document.querySelector('canvas').toDataURL()"), pannedDrawing, 'Escape preserves map pan and zoom');
  assert.equal(await evaluate(largeMap, "document.querySelector('.dungeon-map-viewport').hasPointerCapture(window.__panPointerId)"), false);
  largeMap.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: viewport.x + 35, y: viewport.y + 20 });
  shortcutCallbacks.get('Shift+F1')();
  await until(() => largeMap.isFocused() && ignoredMouseEvents.get(largeMap) === false, 'shortcut resumes the preserved dungeon map');
  checks.push('Escape releases dungeon pan and returns focus to the game while preserving the visible map and its view');
  await capture(largeMap, 'large-dungeon-map');
  await returnFocusOutside([main, ...panels, largeMap], 'outside focus while dungeon is expanded');
  await until(async () => ignoredMouseEvents.get(largeMap) === true
    && await evaluate(largeMap, "document.getElementById('dungeon-overlay-hint').textContent === 'Shift + F1 to interact'"), 'expanded dungeon restores native click-through and hint');
  // Win32 foreground ownership wins even before a Chromium blur arrives.
  shortcutCallbacks.get('Shift+F1')();
  await until(() => largeMap.isFocused() && ignoredMouseEvents.get(largeMap) === false, 'dungeon reactivation before native foreground check');
  await pause(220);
  layoutMonitor.onForeground(process.pid + 1);
  await until(async () => !(await getState(main)).overlayInteractive && ignoredMouseEvents.get(largeMap) === true,
    'native foreground releases stale Chromium interaction');
  layoutMonitor.onForeground(process.pid);
  shortcutCallbacks.get('Shift+F1')();
  await until(async () => largeMap.isFocused() && ignoredMouseEvents.get(largeMap) === false
    && await evaluate(largeMap, "document.getElementById('dungeon-overlay-hint').textContent.includes('Drag to pan')"), 'shortcut reactivates expanded dungeon and its hint');
  await save(main, { interactionHotkey: 'Alt+F1' });
  await until(async () => ignoredMouseEvents.get(largeMap) === true && panels.every(win => ignoredMouseEvents.get(win) === true)
    && await evaluate(largeMap, "document.getElementById('dungeon-overlay-hint').textContent === 'Alt + F1 to interact'"), 'hotkey change resets expanded dungeon input and hint');
  shortcutCallbacks.get('Alt+F1')();
  await until(() => largeMap.isFocused() && ignoredMouseEvents.get(largeMap) === false, 'updated hotkey reactivates expanded dungeon');
  await save(main, { clickThrough: false });
  await until(() => ignoredMouseEvents.get(largeMap) === true && panels.every(win => ignoredMouseEvents.get(win) === false), 'expanded dungeon remains pass-through when widget click-through is disabled');
  await save(main, { clickThrough: true, interactionHotkey: 'Shift+F1' });
  await until(() => ignoredMouseEvents.get(largeMap) === true && panels.every(win => ignoredMouseEvents.get(win) === true), 'restored click-through cannot latch the full-screen map interactive');
  checks.push('expanded dungeon releases mouse input after focus loss and hotkey/config resets, with consistent hints and hotkey reactivation');
  await evaluate(largeMap, "document.querySelector('[data-action=close]').click()");
  await until(() => !find('dungeon-overlay.html') && minimap.isVisible(), 'closing large dungeon restores minimap');
  await evaluate(minimap, "document.querySelector('.dungeon-map [data-action=expand]').click()");
  const closeRestoreMap = await ready('dungeon-overlay.html');
  await until(() => closeRestoreMap.isFocused() && ignoredMouseEvents.get(closeRestoreMap) === false, 'expansion activates dungeon interaction');
  await evaluate(closeRestoreMap, "document.querySelector('[data-action=close]').click()");
  await until(() => !find('dungeon-overlay.html') && minimap.isVisible() && panels.every(win => ignoredMouseEvents.get(win) === true), 'closing implicitly activated dungeon restores widget click-through');
  await evaluate(minimap, "document.querySelector('.dungeon-map [data-action=expand]').click()");
  await ready('dungeon-overlay.html');
  dungeonState = { active: false, status: 'outside' }; dungeonChanged(dungeonState);
  await until(() => !find('dungeon-overlay.html') && minimap.isVisible(), 'leaving dungeon closes large map and restores minimap');
  await save(main, { widgetVisibility: { boss: true, wiki: true, clock: true } });
  checks.push('dungeon expansion opens a full-screen transparent map, retains Mini-Map preference and restores it on close or dungeon exit');
  checks.push('closing a dungeon map that enabled interaction restores panel click-through');
  outside.destroy();
  await save(main, { dockAutoHide: false, showOnlyWhenGameFocused: true });
  await until(() => typeof releaseGameProcess === 'function', 'controlled game detector');
  releaseGameProcess();
  await until(async () => (await getState(main)).status === 'connecting', 'controlled connecting game');
  // Windows can hand focus from one blurred overlay window to another. Keep
  // this controlled game-focus scenario independent of that native behavior.
  for (const win of [main, boss, wiki, clock]) { win.setFocusable(false); win.blur(); }
  layoutMonitor.onForeground(process.pid + 1);
  simulatedGameForeground = false;
  await until(() => !main.isVisible() && [boss, wiki, clock].every(win => !win.isVisible()), 'overlay hidden when game loses focus');
  overlayShortcut();
  simulatedGameForeground = true;
  await pause(650);
  assert.equal(main.isVisible(), false, 'Game focus changes must not revive a user-hidden overlay');
  overlayShortcut();
  await until(() => main.isVisible() && [boss, wiki, clock].every(win => win.isVisible()), 'user restore after focus-only hide');
  for (const win of [main, boss, wiki, clock]) win.setFocusable(true);
  checks.push('visibility chord recovers an overlay previously hidden by game focus without stale flags');
  assert.deepEqual(errors, []); assert.deepEqual(failedLoads, []);
  const summary = { ok: true, checks, geometry, errors, failedLoads, requests: requests.length, screenshots };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: true, checks, output: out, screenshots }));
  server.close(); app.exit(0);
}).catch(async error => {
  console.error(error.stack);
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed() && win.isVisible()) await Promise.race([capture(win, 'failure-window-' + win.id), pause(1500)]); } catch {}
  }
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, checks, errors, failedLoads, screenshots, visibilitySnapshots,
    windows: BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).map(win => ({ url: win.webContents.getURL(), bounds: getWindowBounds(win), visible: win.isVisible(), dragging: win._isDragging,
      focused: win.isFocused(), ignoresMouseEvents: ignoredMouseEvents.get(win) })) }, null, 2));
  server.close(); app.exit(1);
});
setTimeout(() => { console.error('Edge dock smoke timed out: ' + out); app.exit(1); }, 65000).unref();
