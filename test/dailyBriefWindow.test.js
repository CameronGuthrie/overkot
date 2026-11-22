'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { dailyBriefWindowBounds, createDailyBriefWindow, BOUNDS_KEY } = require('../src/modules/dailyBriefWindow');
const root = path.resolve(__dirname, '..');
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const screen = { getPrimaryDisplay: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ saved, focusAllowed = true, failLoad = false } = {}) {
  const created = [], tracked = [], closed = [], errors = [], data = { [BOUNDS_KEY]: saved };
  let allowed = focusAllowed;
  class Window extends EventEmitter {
    constructor(options) {
      super(); Object.assign(this, { options, bounds: { ...options }, minimized: false, destroyed: false, visible: false,
        shown: 0, inactive: 0, focused: 0, restored: 0 });
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.restored++; this.minimized = false; }
    show() { this.shown++; this.visible = true; }
    showInactive() { this.inactive++; this.visible = true; }
    focus() { this.focused++; }
    getBounds() { return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, this.bounds[key]])); }
    loadFile(file, options) { this.loaded = { file, options }; return failLoad ? Promise.reject(new Error('Fixture load failure')) : Promise.resolve(); }
    close() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  const controller = createDailyBriefWindow({ BrowserWindow: Window, screen,
    config: { get: key => data[key], set: (key, value) => { data[key] = value; } },
    rendererRoot: path.join(root, 'src/renderer'), preloadPath: path.join(root, 'src/preload.js'),
    canShow: () => allowed,
    trackBounds(win, key) {
      tracked.push(key);
      const save = () => { data[key] = win.getBounds(); };
      win.on('resize', save); win.on('move', save); win.on('close', save);
    }, onClosed: win => closed.push(win), onError: error => errors.push(error.message) });
  return { controller, created, data, tracked, closed, errors, allow(value) { allowed = value; } };
}

test('Daily Brief pop-out restores and clamps its own bounds, including removed or small displays', () => {
  assert.deepEqual(dailyBriefWindowBounds(null, screen), { x: 700, y: 180, width: 520, height: 680 });
  assert.deepEqual(dailyBriefWindowBounds({ x: 5000, y: -200, width: 2100, height: 2000 }, screen), { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(dailyBriefWindowBounds({ x: 10, y: 15, width: 20, height: 30 }, screen), { x: 10, y: 15, width: 360, height: 360 });
  assert.deepEqual(dailyBriefWindowBounds({ x: NaN, y: 0, width: 520, height: 680 }, screen), dailyBriefWindowBounds(null, screen));
  const small = { getPrimaryDisplay: () => ({ workArea: { x: -320, y: 40, width: 320, height: 240 } }) };
  assert.deepEqual(dailyBriefWindowBounds(null, small), { x: -320, y: 40, width: 320, height: 240 });
});

test('opening Daily Brief reuses a normal resizable window and persists independent placement on close', () => {
  const f = fixture();
  const first = f.controller.open();
  assert.equal(first.options.resizable, true); assert.equal(first.options.frame, false);
  assert.equal(first.options.show, false); assert.equal(first.options.webPreferences.contextIsolation, true);
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.equal(first.loaded.file, path.join(root, 'src/renderer/daily-brief-window.html'));
  assert.deepEqual(first.loaded.options.query, { widget: 'daily' });
  assert.deepEqual(f.tracked, ['dailyBriefBounds']);
  first.emit('ready-to-show');
  assert.equal(first.shown, 1); assert.equal(first.focused, 1);
  assert.equal(f.controller.open(), first); assert.equal(f.created.length, 1);
  first.bounds = { x: 200, y: 150, width: 720, height: 800 };
  f.controller.close();
  assert.deepEqual(f.data.dailyBriefBounds, first.bounds);
  assert.equal(f.controller.getWindow(), null); assert.deepEqual(f.closed, [first]);
  const reopened = f.controller.open();
  assert.notEqual(reopened, first); assert.equal(reopened.options.width, 720); assert.equal(reopened.options.height, 800);
});

test('automatic prompts never focus the game away, undo minimization or race hidden-app state', () => {
  const f = fixture();
  const win = f.controller.open({ focus: false });
  win.emit('ready-to-show');
  assert.equal(win.inactive, 1); assert.equal(win.focused, 0); assert.equal(win.shown, 0);
  win.minimized = true;
  f.controller.open({ focus: false });
  assert.equal(win.restored, 0); assert.equal(win.focused, 0);
  f.controller.open();
  assert.equal(win.restored, 1); assert.equal(win.focused, 1);
  const hidden = fixture();
  const waiting = hidden.controller.open({ focus: false });
  waiting._visibleBeforeOverlayHide = false;
  hidden.allow(false); waiting.emit('ready-to-show');
  assert.equal(waiting.visible, false);
  assert.equal(waiting._visibleBeforeOverlayHide, true, 'a hide pass before first paint must retain the pending brief');
  hidden.allow(true); hidden.controller.open({ focus: false });
  assert.equal(waiting.inactive, 1); assert.equal(waiting.focused, 0);
});

test('a manual open before first paint retains focus priority over later automatic prompts', () => {
  const f = fixture(), win = f.controller.open({ focus: false });
  f.controller.open(); f.controller.open({ focus: false }); win.emit('ready-to-show');
  assert.equal(win.focused, 1); assert.equal(win.inactive, 0); assert.equal(f.created.length, 1);
});

test('failed pop-out loads close cleanly and report an error instead of leaving an invisible duplicate', async () => {
  const f = fixture({ failLoad: true });
  f.controller.open(); await tick();
  assert.equal(f.controller.getWindow(), null);
  assert.deepEqual(f.errors, ['Fixture load failure']); assert.equal(f.closed.length, 1);
});

function rendererFixture() {
  let resolveState, configChanged, loaded, unloaded, minimized = 0, closed = 0, destroyed = 0;
  const initial = new Promise(resolve => { resolveState = resolve; });
  const controls = Object.fromEntries(['daily-minimize', 'daily-close', 'daily-brief-content'].map(id => [id, { handlers: {}, addEventListener(key, fn) { this.handlers[key] = fn; } }]));
  const themes = [], mounts = [], languages = [];
  const api = { getState: () => initial, onConfigChanged: fn => { configChanged = fn; },
    windowMinimize: () => minimized++, windowClose: () => closed++,
    fitWindowSize: () => { throw new Error('A pop-out must never auto-fit itself'); } };
  const document = { documentElement: {}, getElementById: id => controls[id], addEventListener: (_type, fn) => { loaded = fn; } };
  const window = { api, OverkotTheme: { apply: (config, options) => themes.push([config, options]) },
    DailyBriefWidget: { mount(element, options) { mounts.push({ element, options }); return { setLanguage: language => languages.push(language), destroy: () => destroyed++ }; } },
    addEventListener: (_type, fn) => { unloaded = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/renderer/daily-brief-window.js'), 'utf8'), { document, window });
  return { controls, document, themes, mounts, languages, start: () => loaded(), resolve: resolveState,
    config: value => configChanged(value), unload: () => unloaded(),
    metrics: () => ({ minimized, closed, destroyed }) };
}

test('pop-out boot mounts the shared Daily Brief, preserves a newer live language, and never auto-resizes', async () => {
  const f = rendererFixture(), boot = f.start();
  f.config({ language: 'fr', appearance: {} }); f.resolve({ config: { language: 'en' } }); await boot;
  assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].element, f.controls['daily-brief-content']);
  assert.equal(f.mounts[0].options.language, 'fr');
  assert.equal(f.mounts[0].options.onResize, undefined, 'content uses the default no-op resize callback');
  assert.equal(f.document.documentElement.lang, 'fr'); assert.equal(f.languages.at(-1), 'fr');
  assert.equal(f.themes.at(-1)[1].widgetId, 'daily');
  f.config({ language: 'de' }); assert.equal(f.languages.at(-1), 'de');
  f.controls['daily-minimize'].handlers.click(); f.controls['daily-close'].handlers.click();
  assert.deepEqual(f.metrics(), { minimized: 1, closed: 1, destroyed: 0 });
  f.unload(); assert.equal(f.metrics().destroyed, 1);
});

test('the dedicated page ships its reusable content, calendar, icons and image policy without a widget host', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/daily-brief-window.html'), 'utf8');
  for (const asset of ['daily-brief.js', 'calendar-widget.js', 'item-images.js', 'shared-constants.js', 'ui-icons.js', 'daily-brief-window.js']) {
    assert.ok(html.includes(`src="${asset}"`), asset);
  }
  assert.ok(html.indexOf('src="daily-brief.js"') < html.indexOf('src="daily-brief-window.js"'));
  assert.match(html, /img-src[^;]+overkot-map-tiles:[^;]+overkot-game-data:/);
  assert.doesNotMatch(html, /widget-host\.js|widget-resize-handle|timer-widget/);
});
