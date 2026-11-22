// npm run pack -- --skip-scanner, then node scripts/check-weather.js
// Real Electron lifecycle, isolated forecast fixture, packaged renderer under CSP.
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 90000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', `weather-check-${Date.now()}`);
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(out, 'profile'));

const initialTime = Date.now();
const initialMono = performance.now();
const rainEnds = initialTime + 45000;
const events = [
  { start: initialTime - 300000, end: rainEnds, kind: 'rain' },
  { start: rainEnds, end: rainEnds + 720000, kind: 'thunder' },
  { start: rainEnds + 720000, end: rainEnds + 1200000, kind: 'overcast' },
  { start: rainEnds + 1200000, end: rainEnds + 1440000, kind: 'rain', rainbowChance: .2 },
  { start: rainEnds + 1440000, end: rainEnds + 2040000, kind: 'wind' },
];
let sharedWeather;
class FixtureWeather extends EventEmitter {
  constructor() { super(); this.shift = 0; this.status = 'ready'; sharedWeather = this; }
  time() { return initialTime + performance.now() - initialMono + this.shift; }
  async refresh() { return false; }
  snapshot() {
    return { time: this.time(), syncedAt: this.status === 'estimated' ? null : initialTime, fetchedAt: initialTime, status: this.status,
      current: this.status === 'unavailable' ? null : { ...events[0] },
      upcoming: this.status === 'unavailable' ? [] : events.slice(1).map(event => ({ ...event })) };
  }
  setTime(time) { this.shift += time - this.time(); this.emit('changed'); }
  setStatus(status) { this.status = status; this.emit('changed'); }
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/weatherForecast')) return { WeatherForecast: FixtureWeather };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: [] }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, deployScannerSync: () => false, scannerAvailableSync: () => false };
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
for (const [key, value] of Object.entries({ clickThrough: false, hideWhenGameClosed: false, showOnlyWhenGameFocused: false,
  layoutMode: 'free', widgetVisibility: { weather: true }, backgroundOpacity: 95, language: 'en' })) config.set(key, value);
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
});
require('../src/main');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await fn();
    if (value) return value;
    await pause(50);
  }
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
  await pause(300);
  const image = await until(async () => {
    const result = await win.webContents.capturePage();
    return result.isEmpty() ? null : result;
  }, 'paint ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
}
const cardScript = `({
  current: document.querySelector('.weather-current-name')?.textContent,
  next: document.querySelector('.weather-next-name')?.textContent,
  countdown: document.querySelector('.weather-countdown')?.textContent,
  kind: document.querySelector('.weather-scene')?.dataset.kind,
  status: document.querySelector('.weather-forecast')?.dataset.status,
  paused: document.querySelector('.weather-forecast')?.dataset.paused,
  steps: [...document.querySelectorAll('.weather-step')].map(step => step.dataset.kind),
  width: innerWidth, height: innerHeight,
  scrollWidth: document.body.scrollWidth, scrollHeight: document.body.scrollHeight,
  contentWidth: document.querySelector('.weather-content')?.clientWidth,
  contentScrollWidth: document.querySelector('.weather-content')?.scrollWidth
})`;
const card = win => win.webContents.executeJavaScript(cardScript);
function assertFits(value, label) {
  assert.ok(value.scrollWidth <= value.width + 1, `${label}: no horizontal window overflow`);
  assert.ok(value.scrollHeight <= value.height + 2, `${label}: content fits automatic height`);
  assert.ok(value.contentScrollWidth <= value.contentWidth + 1, `${label}: forecast fits its card`);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html');
  const widget = await ready('widget-host.html?widget=weather');
  widget.showInactive();
  await until(async () => (await card(widget)).kind === 'rain', 'current weather');
  let value = await card(widget);
  assert.match(value.current, /rain/i);
  assert.match(value.next, /thunder/i);
  assert.deepEqual(value.steps, ['thunder', 'overcast', 'rain'], 'Ordered upcoming forecast');
  assert.match(await widget.webContents.executeJavaScript("document.querySelector('.weather-step[data-rainbow-chance=true] .weather-step-name').textContent"), /rainbow chance/i);
  assert.equal(value.status, 'ready');
  assert.match(value.countdown, /^\d+:\d{2}(?::\d{2})?$/);
  await until(async () => (await card(widget)).countdown !== value.countdown, 'live countdown between broadcasts');
  await capture(widget, 'weather-rain');

  // Emulate the OS accessibility preference and inspect actual running CSS animations.
  widget.webContents.debugger.attach('1.3');
  await widget.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until(() => widget.webContents.executeJavaScript("document.querySelector('.weather-forecast').getAnimations({subtree:true}).some(animation => animation.playState === 'running')"), 'animated weather');
  await widget.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => widget.webContents.executeJavaScript("document.querySelector('.weather-forecast').getAnimations({subtree:true}).every(animation => animation.playState !== 'running')"), 'reduced motion disables weather animation');
  await widget.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  widget.webContents.debugger.detach();

  const sizes = [];
  for (const width of [200, 300, 400]) {
    await widget.webContents.executeJavaScript(`window.api.windowResizeTo(${width}, 0)`);
    await until(async () => (await card(widget)).width === width, `${width}px weather window`);
    await until(async () => { const result = await card(widget); return result.scrollHeight <= result.height + 2; }, 'weather auto height');
    await capture(widget, `weather-${width}px`);
    value = await card(widget); assertFits(value, `${width}px weather`); sizes.push(value);
  }
  await widget.webContents.executeJavaScript('window.api.windowResizeTo(300, 0)');
  await until(async () => (await card(widget)).width === 300, 'restore weather width');

  // The renderer must advance the existing forecast when a segment expires,
  // without waiting for another fetch or changed notification.
  sharedWeather.setTime(rainEnds - 1500);
  await until(async () => /^0:0[12]$/.test((await card(widget)).countdown), 'countdown approaches transition');
  await until(async () => (await card(widget)).kind === 'thunder', 'automatic next-weather transition');
  assert.match((await card(widget)).next, /overcast|fog/i);
  await capture(widget, 'weather-thunder');

  sharedWeather.setStatus('cached');
  await until(async () => (await card(widget)).status === 'cached', 'cached forecast notification');
  assert.equal((await card(widget)).kind, 'thunder', 'A cached forecast remains usable');
  await capture(widget, 'weather-cached');
  sharedWeather.setStatus('unavailable');
  await until(async () => (await card(widget)).status === 'cached', 'unavailable response preserves a valid cached forecast');
  assert.equal((await card(widget)).kind, 'thunder');
  // A clock correction must also expire a previously valid cached period.
  sharedWeather.setTime(events.at(-1).end + 1000);
  await until(async () => (await card(widget)).status === 'unavailable', 'expired forecast cannot remain current');
  assert.deepEqual((await card(widget)).steps, [], 'Unavailable forecasts do not invent upcoming weather');
  await capture(widget, 'weather-unavailable');
  sharedWeather.setStatus('estimated');
  sharedWeather.setTime(events[4].start + 1000);
  await until(async () => (await card(widget)).kind === 'wind' && (await card(widget)).status === 'estimated', 'device-time forecast');
  assert.match((await card(widget)).current, /wind/i);
  assert.match(await widget.webContents.executeJavaScript("document.querySelector('.weather-status').textContent"), /device time/i);
  await capture(widget, 'weather-wind-estimated');
  sharedWeather.setStatus('ready');
  sharedWeather.setTime(events[3].start + 1000);
  await until(async () => (await card(widget)).kind === 'rainbow', 'rainbow opportunity');
  assert.equal((await card(widget)).current, 'Rain', 'A rainbow opportunity retains the physical weather name');
  assert.match(await widget.webContents.executeJavaScript("document.querySelector('.weather-chance').textContent"), /20% rainbow chance/i);
  await capture(widget, 'weather-rainbow');
  sharedWeather.setTime(rainEnds + 1000);
  await until(async () => (await card(widget)).kind === 'thunder' && (await card(widget)).status === 'ready', 'forecast recovers');

  await widget.webContents.executeJavaScript("document.querySelector('.timer-widget[data-widget=weather] .widget-collapse-btn').click()");
  await until(async () => (await card(widget)).height < 40, 'collapsed weather height');
  await until(async () => (await card(widget)).paused === 'true', 'collapsed animation pauses');
  await widget.webContents.executeJavaScript("document.querySelector('.timer-widget[data-widget=weather] .widget-collapse-btn').click()");
  await until(async () => (await card(widget)).height > 150 && (await card(widget)).paused === 'false', 'expanded weather resumes');

  const { createHeadersHandler } = require('../src/modules/guard');
  session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
  await widget.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'weather' } });
  await until(async () => (await card(widget)).kind === 'thunder', 'packaged weather renderer');
  assert.equal(await widget.webContents.executeJavaScript("document.querySelector('.weather-scene').getBBox().width > 0"), true, 'Packaged weather artwork');
  await capture(widget, 'weather-packaged');
  assertFits(await card(widget), 'packaged weather');

  const workArea = screen.getPrimaryDisplay().workArea;
  main.setPosition(workArea.x + 80, workArea.y + 80);
  await main.webContents.executeJavaScript("window.api.saveConfig({layoutMode:'grid'})");
  const dock = await ready('dock-window.html');
  const frame = await until(() => dock.webContents.mainFrame.framesInSubtree.find(item => /widget=weather/.test(item.url)), 'weather dock frame');
  await until(() => frame.executeJavaScript("document.querySelector('.weather-scene')?.dataset.kind === 'thunder'"), 'docked forecast');
  sharedWeather.setTime(events[2].start + 1000);
  await until(() => frame.executeJavaScript("document.querySelector('.weather-scene')?.dataset.kind === 'overcast'"), 'forecast changed broadcast reaches dock child');
  assert.match(await frame.executeJavaScript("document.querySelector('.weather-next-name').textContent"), /rain.*rainbow chance/i);
  await main.webContents.executeJavaScript("window.api.saveConfig({theme:'ember'})");
  await until(() => frame.executeJavaScript("document.documentElement.dataset.theme === 'ember'"), 'weather theme follows configuration');
  await main.webContents.executeJavaScript("window.api.saveConfig({theme:'dark-mint'})");
  await until(() => frame.executeJavaScript('document.body.scrollHeight <= innerHeight + 2'), 'docked forecast fits');
  assertFits(await frame.executeJavaScript(cardScript), 'docked weather');
  await capture(dock, 'weather-docked');
  await main.webContents.executeJavaScript('window.api.openWidgets()');
  const widgets = await ready('widgets-window.html');
  await until(() => widgets.webContents.executeJavaScript("!!document.querySelector('input[data-widget=weather]')"), 'weather widget toggle');
  await widgets.webContents.executeJavaScript("document.querySelector('input[data-widget=weather]').click()");
  await until(async () => !find('dock-window.html') || !(await dock.webContents.executeJavaScript("!!document.querySelector('iframe[data-widget=weather]')")), 'disable weather widget');
  await widgets.webContents.executeJavaScript("document.querySelector('input[data-widget=weather]').click()");
  const enabledDock = await ready('dock-window.html');
  await until(() => enabledDock.webContents.executeJavaScript("!!document.querySelector('iframe[data-widget=weather]')"), 're-enable weather widget');
  const enabledFrame = await until(() => enabledDock.webContents.mainFrame.framesInSubtree.find(item => /widget=weather/.test(item.url)), 're-enabled weather frame');
  await until(() => enabledFrame.executeJavaScript("document.querySelector('.weather-scene')?.dataset.kind === 'overcast'"), 're-enabled forecast renders');
  assert.equal(new ConfigStore().get('widgetVisibility').weather, true, 'Weather visibility is saved');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, sizes, screenshots: out }, null, 2));
  app.exit(0);
}).catch(async error => {
  console.error(error.stack); console.error({ errors, output: out });
  const win = find('widget-host.html?widget=weather');
  if (win && !win.webContents.isDestroyed()) {
    try { console.error({ bounds: win.getBounds(), minimum: win.getMinimumSize(), view: await card(win) }); }
    catch { /* Preserve the original renderer failure. */ }
  }
  app.exit(1);
});
