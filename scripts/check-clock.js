// npm run pack -- --skip-scanner, then node scripts/check-clock.js
// Real window/module lifecycle, offline fixture, packaged renderer files.
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 60000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', `clock-check-${Date.now()}`);
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(out, 'profile'));
const { WorldClock } = require('../src/modules/worldClock');
const cycle = require('../src/renderer/world-cycle');
const dawn = cycle.EPOCH - cycle.SHIFT + cycle.DAWN / cycle.RATE + 137800 * cycle.CYCLE;
const dayTime = dawn + cycle.DAY - 930;
let sharedClock, clockShift = 0;
function setTime(unixSeconds) {
  clockShift += unixSeconds * 1000 - sharedClock.time();
  sharedClock.emit('changed');
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/worldClock')) return { WorldClock: class extends WorldClock {
    constructor(options) {
      super({ ...options, now: () => dayTime * 1000, monotonic: () => performance.now() + clockShift,
        http: { get: async () => { throw new Error('Offline fixture'); } } });
      sharedClock = this;
    }
  } };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [] }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, deployScannerSync: () => false };
  if (request.endsWith('/modules/processDetector')) return { ProcessDetector: class { async waitForProcess() { return new Promise(() => {}); } startForegroundMonitor() {} stopForegroundMonitor() {} } };
  if (request.endsWith('/modules/logWatcher')) return { LogWatcher: class { start() {} } };
  if (request.endsWith('/modules/arenaWatcher')) return { ArenaWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/ancestorWatcher')) return { AncestorWatcher: class { start() {} stop() {} } };
  if (request.endsWith('/modules/groupFinderService')) return new Proxy({}, { get: (_target, key) => key === 'getState' ? () => ({ listings: [], requests: [] }) : () => Promise.resolve(false) });
  if (request === 'axios') return { get: async () => { throw new Error('Offline fixture'); }, create: () => ({ get: async () => { throw new Error('Offline fixture'); } }) };
  return originalLoad.call(this, request, parent, isMain);
};
const { ConfigStore } = require('../src/modules/config');
const config = new ConfigStore();
for (const [key, value] of Object.entries({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false, layoutMode: 'free', widgetVisibility: { clock: true }, backgroundOpacity: 95, language: 'en', worldClockCalibration: { anchor: 123, updatedAt: Date.now() } })) config.set(key, value);
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
const find = text => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes(text));
async function ready(text) {
  const win = await until(() => find(text), text);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), text + ' preload');
  return win;
}
async function capture(win, name) {
  win.showInactive(); win.webContents.invalidate();
  await pause(300); // Let native resize and dock FLIP animations settle.
  const image = await until(async () => { const result = await win.webContents.capturePage(); return result.isEmpty() ? null : result; }, 'paint ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
}
const clock = win => win.webContents.executeJavaScript(`({ text: document.querySelector('.clock-countdown')?.textContent,
  phase: document.querySelector('.clock-orbit')?.dataset.phase,
  controls: document.querySelectorAll('.clock-content button, .clock-content form, .clock-footer').length,
  sun: document.querySelector('.clock-mora')?.getAttribute('transform'), moon: document.querySelector('.clock-iridis')?.getAttribute('transform'),
  width: innerWidth, height: innerHeight, scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight })`);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html');
  const widget = await ready('widget-host.html?widget=clock');
  await until(async () => (await clock(widget)).text, 'clock starts offline');
  assert.equal((await clock(widget)).controls, 0, 'Clock has no manual alignment or footer');
  assert.equal(await widget.webContents.executeJavaScript('typeof window.api.alignWorldClock'), 'undefined');
  assert.equal((await clock(widget)).phase, 'day');
  assert.match((await clock(widget)).text, /^15:[23]\d$/);
  const before = await clock(widget);
  await until(async () => (await clock(widget)).text !== before.text, 'live countdown');
  assert.notEqual((await clock(widget)).sun, before.sun, 'Sun moves without state messages');
  await capture(widget, 'clock-day');
  let metrics = await clock(widget);
  assert.ok(metrics.scrollWidth <= metrics.width + 1 && metrics.scrollHeight <= metrics.height + 2);
  setTime(dawn + cycle.CYCLE - 480);
  await until(async () => (await clock(widget)).phase === 'night', 'night phase');
  assert.match((await clock(widget)).text, /^(8:00|7:5\d)$/);
  assert.ok((await clock(widget)).height < 225, 'Compact clock without footer');
  await capture(widget, 'clock-night');
  await widget.webContents.executeJavaScript("document.querySelector('.timer-widget[data-widget=clock] .widget-collapse-btn').click()");
  await until(() => widget.webContents.executeJavaScript("document.querySelector('.timer-widget[data-widget=clock]').classList.contains('collapsed')"), 'collapse clock');
  await until(async () => (await clock(widget)).height < 40, 'collapsed window height');
  await widget.webContents.executeJavaScript("document.querySelector('.timer-widget[data-widget=clock] .widget-collapse-btn').click()");
  await until(async () => (await clock(widget)).height > 150, 'expand clock height');
  await widget.webContents.executeJavaScript('window.api.windowResizeTo(400, 0)');
  await until(async () => (await clock(widget)).width === 400, 'widen clock');
  await widget.webContents.executeJavaScript('window.api.windowResizeTo(300, 0)');
  await until(async () => (await clock(widget)).width === 300, 'shrink clock width');
  // Exercise minified renderer assets inside the actual ASAR under CSP.
  const { createHeadersHandler } = require('../src/modules/guard');
  session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
  await widget.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'clock' } });
  await until(async () => (await clock(widget)).phase === 'night', 'packaged clock');
  assert.equal(await widget.webContents.executeJavaScript("document.querySelector('.clock-mora use').getBBox().width > 0"), true, 'Packaged local vector icons');
  await capture(widget, 'clock-packaged');
  const workArea = screen.getPrimaryDisplay().workArea;
  main.setPosition(workArea.x + 80, workArea.y + 80);
  await main.webContents.executeJavaScript("window.api.saveConfig({layoutMode:'grid'})");
  const dock = await ready('dock-window.html');
  const frame = await until(() => dock.webContents.mainFrame.framesInSubtree.find(item => /widget=clock/.test(item.url)), 'clock dock frame');
  await until(() => frame.executeJavaScript("!!document.querySelector('.clock-countdown')?.textContent"), 'docked clock');
  setTime(dawn + cycle.DAY - 300);
  await until(() => frame.executeJavaScript("document.querySelector('.clock-orbit').dataset.phase === 'day'"), 'docked clock sync notification');
  await main.webContents.executeJavaScript("window.api.saveConfig({theme:'ember'})");
  await until(() => frame.executeJavaScript("document.documentElement.dataset.theme === 'ember'"), 'clock theme');
  await main.webContents.executeJavaScript("window.api.saveConfig({theme:'dark-mint'})");
  await until(() => frame.executeJavaScript('document.body.scrollHeight <= innerHeight + 2'), 'clock dock fit');
  await capture(dock, 'clock-docked');
  await main.webContents.executeJavaScript('window.api.openWidgets()');
  const widgets = await ready('widgets-window.html');
  await until(() => widgets.webContents.executeJavaScript("!!document.querySelector('input[data-widget=clock]')"), 'clock toggle');
  await widgets.webContents.executeJavaScript("document.querySelector('input[data-widget=clock]').click()");
  await until(async () => !find('dock-window.html') || !(await dock.webContents.executeJavaScript("!!document.querySelector('iframe[data-widget=clock]')")), 'disable clock');
  await widgets.webContents.executeJavaScript("document.querySelector('input[data-widget=clock]').click()");
  await until(() => find('dock-window.html'), 're-enable clock');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, metrics, screenshots: out }, null, 2));
  app.exit(0);
}).catch(async error => {
  console.error(error.stack); console.error({ errors, output: out });
  const win = find('widget-host.html?widget=clock');
  if (win) console.error({ bounds: win.getBounds(), minimum: win.getMinimumSize(), dragging: win._isDragging,
    view: await win.webContents.executeJavaScript(`({ body: document.body.getBoundingClientRect().height,
      card: document.querySelector('.timer-widget[data-widget=clock]').getBoundingClientRect().height,
      dragging: isDragging,
      fit: fitWindowToContent.toString().includes('activeWidget') })`) });
  app.exit(1);
});
