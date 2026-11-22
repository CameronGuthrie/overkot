// Source: node scripts/check-world-watch.js --source
// After packaging: node scripts/check-world-watch.js --packaged
// Offline Electron fixtures exercise real windows plus independent component lifecycles.
if (!process.versions.electron) {
  const args = process.argv.slice(2);
  let result;
  if (args.includes('--packaged')) {
    result = require('./run-packaged-check').runPackagedCheck(__filename, args, 120000);
  } else {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    result = require('node:child_process').spawnSync(require('electron'), [__filename, ...args], {
      env, stdio: 'inherit', windowsHide: true, timeout: 120000,
    });
  }
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, session, screen, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const out = path.join(root, 'output', `world-watch-check-${Date.now()}`);
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
fs.mkdirSync(out, { recursive: true });
process.env.LOCALAPPDATA = out;
process.env.OVERKOT_CALENDAR_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
process.env.OVERKOT_DATA_MANIFEST_URL = 'http://127.0.0.1:1/manifest.json';
app.setPath('userData', path.join(out, 'profile'));
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

const { WorldClock } = require('../src/modules/worldClock');
const { QUESTS, CalendarService } = require('../src/modules/calendar');
const cycle = require('../src/renderer/world-cycle');
const dawn = cycle.EPOCH - cycle.SHIFT + cycle.DAWN / cycle.RATE + 137800 * cycle.CYCLE;
const initialTime = (dawn + cycle.DAY - 930) * 1000;
const initialMono = performance.now();
const events = [
  { start: initialTime - 300000, end: initialTime + 120000, kind: 'rain' },
  { start: initialTime + 120000, end: initialTime + 840000, kind: 'thunder' },
  { start: initialTime + 840000, end: initialTime + 1320000, kind: 'overcast' },
  { start: initialTime + 1320000, end: initialTime + 1560000, kind: 'rain', rainbowChance: .2 },
];
const inventory = { Quests: Object.values(QUESTS).map(ItemType => ({ ItemType, Completed: true })) };
const meetingTag = 'UPGRADEGIVEN_GODANDGHOST', meetingDuration = 23 * 3600;
const fixtureTimers = [{ tag: meetingTag, expiryTime: Math.floor(Date.now() / 1000) + meetingDuration / 2 }];
let calendar, sharedWeather;
class FixtureWeather extends EventEmitter {
  constructor() { super(); this.shift = 0; this.status = 'ready'; sharedWeather = this; }
  time() { return initialTime + performance.now() - initialMono + this.shift; }
  async refresh() { return false; }
  snapshot() {
    return { time: this.time(), syncedAt: initialTime, fetchedAt: initialTime, status: this.status,
      current: this.status === 'unavailable' ? null : { ...events[0] },
      upcoming: this.status === 'unavailable' ? [] : events.slice(1).map(event => ({ ...event })) };
  }
  update(status, time = initialTime + 1000) { this.status = status; this.shift += time - this.time(); this.emit('changed'); }
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/modules/worldClock')) return { WorldClock: class extends WorldClock {
    constructor(options) { super({ ...options, now: () => initialTime, http: { get: async () => { throw new Error('Offline fixture'); } } }); }
  } };
  if (request.endsWith('/modules/weatherForecast')) return { WeatherForecast: FixtureWeather };
  if (request.endsWith('/modules/calendar')) return { CalendarService: class extends CalendarService {
    constructor(options) { super({ ...options, feed: { data: require('../src/data/calendar.json'), refresh: async () => false } }); calendar = this; }
  } };
  if (request.endsWith('/modules/inventoryPoller')) return { InventoryPoller: class {}, loadCachedTimers: () => ({ timers: fixtureTimers, rawInventory: inventory, accountId: 'world-watch-fixture' }) };
  if (request.endsWith('/modules/memoryScanner')) return { MemoryScanner: class {}, scannerAvailableSync: () => false };
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
  layoutMode: 'free', widgetVisibility: { 'world-watch': true }, backgroundOpacity: 95, language: 'en', calendarShowOfferings: true })) config.set(key, value);
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
  for (let attempt = 0; attempt < 200; attempt++) { const value = await fn(); if (value) return value; await pause(50); }
  throw new Error('Timed out: ' + label);
}
const find = text => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes(text));
async function ready(text) {
  const win = await until(() => find(text), text);
  await until(async () => !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!window.api'), text + ' preload');
  return win;
}
const execute = (target, source) => (target.webContents || target).executeJavaScript(source);
async function capture(win, name) {
  win.showInactive(); win.webContents.invalidate(); await pause(300);
  const image = await until(async () => { const value = await win.webContents.capturePage(); return value.isEmpty() ? null : value; }, 'paint ' + name);
  fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
}
const cardScript = `(() => {
  const root = document.querySelector('.world-watch');
  const visible = selector => { const el = root?.querySelector(selector); return !!el && el.getClientRects().length > 0 && !el.closest('[hidden]'); };
  return { view: root?.dataset.view, tabs: [...(root?.querySelectorAll('[role=tab]') || [])].map(x => ({ view:x.dataset.view, selected:x.getAttribute('aria-selected'), label:x.textContent })),
    phase: root?.querySelector('.clock-orbit')?.dataset.phase, countdown: root?.querySelector('.clock-countdown')?.textContent,
    kind: root?.querySelector('.world-watch-weather .weather-scene')?.dataset.kind,
    weatherStatus: root?.querySelector('.world-watch-weather .weather-forecast')?.dataset.status,
    summary: root?.querySelector('.world-watch-today')?.textContent,
    clockVisible: visible('.clock-orbit'), weatherVisible: visible('.world-watch-weather .weather-scene'),
    rootHeight: root?.getBoundingClientRect().height, width: innerWidth, height: innerHeight,
    scrollWidth: document.body?.scrollWidth, scrollHeight: document.body?.scrollHeight };
})()`;
const card = target => execute(target, cardScript);
function assertFits(value, label) {
  assert.ok(value.scrollWidth <= value.width + 1, `${label}: no horizontal overflow`);
  assert.ok(value.scrollHeight <= value.height + 2, `${label}: no outer vertical overflow`);
  assert.ok(value.rootHeight <= 280, `${label}: fixed compact body`);
  assert.ok(value.height <= 330, `${label}: compact window height`);
}
async function select(target, view) {
  await execute(target, `document.querySelector('.world-watch [role=tab][data-view=${view}]').click()`);
  await until(async () => (await card(target)).view === view, view + ' tab');
  await pause(100);
}
async function checkTabs(target, label) {
  const heights = [];
  for (const view of ['overview', 'forecast', 'calendar', 'overview', 'calendar', 'forecast', 'overview']) {
    await select(target, view);
    const value = await card(target);
    assert.equal(value.tabs.filter(tab => tab.selected === 'true').length, 1, `${label}: one selected tab`);
    assert.equal(value.tabs.find(tab => tab.selected === 'true').view, view);
    assertFits(value, label + ' ' + view); heights.push(value.height);
  }
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 2, `${label}: tab changes never grow the window`);
  await execute(target, `(() => {
    const tab = document.querySelector('.world-watch [data-view=overview]'); tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));
  })()`);
  assert.equal((await card(target)).view, 'forecast', `${label}: keyboard selects the next tab`);
  assert.equal(await execute(target, 'document.activeElement.dataset.view'), 'forecast');
  await execute(target, "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Home',bubbles:true}))");
  assert.equal((await card(target)).view, 'overview', `${label}: Home returns to the first tab`);
  return heights;
}

const meetingScript = `(() => {
  const button = document.querySelector('.world-watch-today'), fill = button.querySelector('.world-watch-meeting-fill');
  return {state:button.dataset.timerState, percent:button.querySelector('.world-watch-meeting-percent').textContent,
    countdown:button.querySelector('.world-watch-meeting-countdown').textContent,
    hidden:button.querySelector('.world-watch-meeting').hidden, fillHidden:fill.hidden, fill:parseFloat(fill.style.width),
    title:button.title, label:button.getAttribute('aria-label'), buttonHeight:button.getBoundingClientRect().height,
    overflow:button.scrollWidth > button.clientWidth + 1};
})()`;
const meeting = target => execute(target, meetingScript);
async function updateMeeting(main, remaining) {
  fixtureTimers.splice(0, fixtureTimers.length, ...(remaining === null ? [] : [{tag:meetingTag, expiryTime:Math.floor(Date.now()/1000)+remaining}]));
  // Refresh uses the real main-process state broadcast, including all dock frames.
  await execute(main, 'window.api.checkForDataUpdates()');
}
async function checkMeeting(target, main, screenshotWindow, label) {
  await select(target, 'overview');
  const baseline = await meeting(target), height = (await card(target)).height;
  async function fixedSize() {
    const timer = await meeting(target), current = await card(target);
    assert.equal(timer.buttonHeight, baseline.buttonHeight, `${label}: cooldown does not increase button height`);
    assert.equal(current.height, height, `${label}: cooldown does not increase widget height`);
    assert.equal(timer.overflow, false, `${label}: countdown fits beside ancestor`);
    assertFits(current, `${label} timer`);
  }
  await updateMeeting(main, meetingDuration);
  await until(async () => (await meeting(target)).percent === '0%', `${label}: new cooldown broadcast`);
  let value = await meeting(target);
  assert.equal(value.state, 'active'); assert.equal(value.fillHidden, false); assert.ok(value.fill < .1);
  assert.match(value.countdown, /^(23:00:00|22:59:\d{2})$/);
  assert.match(value.label, /Blessed Meeting/); await fixedSize();
  await capture(screenshotWindow, `world-watch-${label}-meeting-0`);
  await updateMeeting(main, meetingDuration / 2);
  await until(async () => (await meeting(target)).percent === '50%', `${label}: live halfway broadcast`);
  value = await meeting(target); assert.ok(Math.abs(value.fill - 50) < .1); await fixedSize();
  await capture(screenshotWindow, `world-watch-${label}-meeting-50`);
  await execute(target, "document.querySelector('.world-watch-ancestor').click()");
  await until(async () => (await card(target)).view === 'calendar', `${label}: ancestor still opens calendar`);
  await select(target, 'overview');
  await updateMeeting(main, 3);
  await until(async () => (await meeting(target)).countdown === '00:00:02', `${label}: local countdown ticks`);
  await until(async () => (await meeting(target)).state === 'ready', `${label}: local expiry`);
  value = await meeting(target); assert.equal(value.percent, '100%'); assert.equal(value.fill, 100); assert.equal(value.countdown, 'Ready');
  await fixedSize(); await capture(screenshotWindow, `world-watch-${label}-meeting-ready`);
  await updateMeeting(main, null);
  await until(async () => (await meeting(target)).state === 'missing', `${label}: removed timer broadcast`);
  value = await meeting(target); assert.equal(value.hidden, true); assert.equal(value.fillHidden, true);
  assert.equal(value.countdown, ''); assert.equal(value.percent, ''); await fixedSize();
  await capture(screenshotWindow, `world-watch-${label}-meeting-missing`);
  await updateMeeting(main, meetingDuration / 2);
  await until(async () => (await meeting(target)).percent === '50%', `${label}: renewed timer after removal`);
}

async function checkComponents(renderer) {
  const styles = ['styles.css', 'calendar-widget.css', 'clock-widget.css', 'weather-widget.css', 'world-watch.css', 'theme.css'];
  const scripts = ['theme.js', 'shared-constants.js', 'world-cycle.js', 'clock-widget.js', 'weather-widget.js', 'calendar-widget.js', 'world-watch.js'];
  const url = name => pathToFileURL(path.join(renderer, name)).href;
  const i18nFile = path.join(out, 'i18n-fixture.js');
  fs.writeFileSync(i18nFile, 'window.i18n = ' + JSON.stringify({ languages: [], translations: {
    en: JSON.parse(fs.readFileSync(path.join(root, 'langs/en.json'), 'utf8')),
    de: { ...JSON.parse(fs.readFileSync(path.join(root, 'langs/de.json'), 'utf8')),
      calendarToday: 'Heute (fixture)', weatherRain: 'Regen (fixture)', clockNightIn: 'Nacht (fixture)' },
  } }) + ';');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' file:; style-src 'self' file: 'unsafe-inline'; img-src 'self' file: data:">
    ${styles.map(name => `<link rel="stylesheet" href="${url(name)}">`).join('')}
    <style>body{margin:12px;display:flex;flex-direction:row;align-items:flex-start;gap:12px;overflow:auto;background:#121617}body>article{width:350px;flex:none}h1{font:14px sans-serif;color:white}.world-watch-content{width:350px}</style></head>
    <body><article><h1>Independent overview</h1><div id="one" class="world-watch-content"></div></article><article><h1>Independent calendar</h1><div id="two" class="world-watch-content"></div></article>
    <script src="${pathToFileURL(i18nFile).href}"></script>${scripts.map(name => `<script src="${url(name)}"></script>`).join('')}</body></html>`;
  const filename = path.join(out, 'component-fixture.html'); fs.writeFileSync(filename, html);
  const win = new BrowserWindow({ width: 750, height: 390, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(filename);
  const fixture = { clock: { time: initialTime }, weather: sharedWeather.snapshot(), day: calendar.getDay('2026-09-12') };
  await execute(win, `(() => {
    OverkotTheme.apply({theme:'classic',backgroundOpacity:95});
    const fixture = ${JSON.stringify(fixture)};
    const listeners = { clock: new Set(), weather: new Set(), calendar: new Set() };
    const intervals = new Set(), savedInterval = window.setInterval, savedClear = window.clearInterval;
    window.setInterval = (...args) => { const id = savedInterval(...args); intervals.add(id); return id; };
    window.clearInterval = id => { intervals.delete(id); savedClear(id); };
    const calls = { wiki: [], settings: 0, saves: [], resize: 0 };
    const subscribe = name => callback => { listeners[name].add(callback); return () => listeners[name].delete(callback); };
    const api = { getWorldClock: async () => fixture.clock, getWeatherForecast: async () => fixture.weather,
      getCalendarDay: async date => ({ ...fixture.day, date, today: date }),
      onWorldClockChanged: subscribe('clock'), onWeatherChanged: subscribe('weather'), onCalendarChanged: subscribe('calendar'),
      saveConfig: async value => { calls.saves.push(value); return true; }, openWikiSearch: value => calls.wiki.push(value), openCalendarSettings: () => calls.settings++ };
    const nodes = [document.querySelector('#one'), document.querySelector('#two')];
    const controllers = nodes.map((node, index) => WorldWatchWidget.mount(node, { api, language: 'en', showOfferings: index === 0, onResize: () => calls.resize++ }));
    window.fixture = { api, fixture, calls, listeners, intervals, nodes, controllers,
      stats: () => ({ listeners: Object.values(listeners).reduce((sum, set) => sum + set.size, 0), intervals: intervals.size, resize: calls.resize }),
      emit: name => [...listeners[name]].forEach(callback => callback()) };
  })()`);
  await until(() => execute(win, "document.querySelectorAll('.world-watch-clock .clock-orbit[data-phase=day]').length === 2"), 'two independent clocks');
  await execute(win, "document.querySelector('#one [data-view=forecast]').click(); document.querySelector('#one [data-view=overview]').click(); document.querySelector('#two [data-view=forecast]').click(); document.querySelector('#two [data-view=calendar]').click()");
  await until(() => execute(win, "!!document.querySelector('#two .calendar-ancestor')"), 'second component calendar');
  assert.deepEqual(await execute(win, "[...document.querySelectorAll('.world-watch')].map(x => x.dataset.view)"), ['overview', 'calendar']);
  assert.equal(await execute(win, "(() => { const ids = [...document.querySelectorAll('.world-watch [id]')].map(x => x.id); return new Set(ids).size === ids.length; })()"), true, 'Independent instances have unique artwork and accessibility IDs');
  assert.equal(await execute(win, "document.querySelector('#two .calendar-offers').hidden"), true);
  assert.equal(await execute(win, "document.querySelector('#two').getBoundingClientRect().right <= innerWidth && Math.abs(document.querySelector('#one').getBoundingClientRect().top - document.querySelector('#two').getBoundingClientRect().top) < 2"), true, 'Both preview instances are visible side by side');
  assert.equal(await execute(win, "document.body.scrollWidth <= document.body.clientWidth + 1 && document.querySelector('#two .world-watch-calendar').scrollWidth <= document.querySelector('#two .world-watch-calendar').clientWidth + 1"), true, 'Preview and calendar panel do not overflow horizontally');
  await capture(win, 'world-watch-two-instances');
  const english = await execute(win, "document.querySelector('#two .calendar-action').textContent");
  await execute(win, "fixture.controllers[1].setLanguage('de'); fixture.controllers[1].setShowOfferings(true)");
  await until(() => execute(win, `document.querySelector('#two .calendar-action').textContent !== ${JSON.stringify(english)}`), 'component language propagation');
  assert.equal(await execute(win, "document.querySelector('#two .weather-current-name').textContent"), 'Regen (fixture)');
  assert.equal(await execute(win, "document.querySelector('#two .clock-label').textContent"), 'Nacht (fixture)');
  assert.equal(await execute(win, "document.querySelector('#two .calendar-offers').hidden"), false);
  await execute(win, "document.querySelector('#two .calendar-offers-toggle').click()");
  assert.deepEqual(await execute(win, 'fixture.calls.saves.at(-1)'), { calendarShowOfferings: false });
  await execute(win, "fixture.api.getCalendarDay = async () => { throw new Error('Offline fixture'); }; fixture.emit('calendar')");
  await until(() => execute(win, "document.querySelector('#one .world-watch-today').dataset.status === 'unavailable' && !document.querySelector('#two .calendar-error').hidden"), 'calendar unavailable state');
  assert.equal(await execute(win, "document.querySelector('#one .clock-orbit').dataset.phase"), 'day', 'Calendar failure does not stop the clock');
  await capture(win, 'world-watch-calendar-offline');
  await execute(win, "fixture.api.getCalendarDay = async date => ({...fixture.fixture.day,date,today:date}); fixture.emit('calendar')");
  await until(() => execute(win, "document.querySelector('#one .world-watch-today').dataset.status === 'ready' && document.querySelector('#two .calendar-error').hidden"), 'calendar recovers');
  const unsafeName = '<img src=x onerror="window.injected=true">';
  await execute(win, `fixture.fixture.day.ancestor = ${JSON.stringify(unsafeName)}; fixture.emit('calendar')`);
  await until(() => execute(win, `document.querySelector('#two .calendar-ancestor').textContent === ${JSON.stringify(unsafeName)}`), 'calendar names stay text');
  assert.equal(await execute(win, "!!window.injected || !!document.querySelector('.world-watch img, .world-watch script, .world-watch a[href^=\"javascript:\"]')"), false);
  await execute(win, "document.querySelector('#two .calendar-ancestor').click(); document.querySelectorAll('#two .calendar-action')[1].click()");
  assert.deepEqual(await execute(win, 'fixture.calls.wiki'), [unsafeName], 'Wiki requests are delegated as text');
  assert.equal(await execute(win, 'fixture.calls.settings'), 1);

  // Destroy while lazy calendar data is in flight. A stale response must not remount or resize.
  await execute(win, `fixture.api.getCalendarDay = () => new Promise(resolve => { fixture.pending = resolve; }); document.querySelector('#one [data-view=calendar]').click()`);
  await until(() => execute(win, '!!fixture.pending'), 'in-flight calendar request');
  await execute(win, 'fixture.controllers.forEach(controller => { controller.destroy(); controller.destroy(); }); fixture.afterDestroy = fixture.stats(); fixture.pending(fixture.fixture.day)');
  await pause(100);
  const destroyed = await execute(win, 'fixture.stats()');
  assert.equal(destroyed.listeners, 0, 'Destroy removes every API subscription');
  assert.equal(destroyed.intervals, 0, 'Destroy stops periodic work');
  assert.equal(destroyed.resize, (await execute(win, 'fixture.afterDestroy')).resize, 'Late data cannot resize a destroyed instance');
  await execute(win, "fixture.api.getCalendarDay = async date => ({...fixture.fixture.day,date,today:date}); fixture.controllers = [WorldWatchWidget.mount(fixture.nodes[0], {api:fixture.api,language:'en',showOfferings:false})]; void 0");
  await until(() => execute(win, "document.querySelector('#one .clock-orbit')?.dataset.phase === 'day'"), 'destroyed component remounts');
  assert.equal(await execute(win, "document.querySelectorAll('#one .world-watch').length"), 1, 'Remount does not duplicate the component');
  await execute(win, 'fixture.controllers[0].destroy()');
  assert.equal((await execute(win, 'fixture.stats()')).listeners, 0);
  await checkMidnight(win);
  win.destroy();
}

async function checkMidnight(win) {
  await execute(win, `(() => {
    fixture.NativeDate = window.Date;
    fixture.midnightTime = Date.parse('2026-09-12T23:59:00Z');
    window.Date = class extends fixture.NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixture.midnightTime])); }
      static now() { return fixture.midnightTime; }
    };
    fixture.calendarRequests = []; fixture.midnightHistory = [];
    fixture.api.getCalendarDay = date => new Promise(resolve => fixture.calendarRequests.push({date, resolve}));
    fixture.midnightObserver = new MutationObserver(() => fixture.midnightHistory.push(fixture.nodes[0].textContent));
    fixture.midnightObserver.observe(fixture.nodes[0], {childList:true,subtree:true,characterData:true});
    fixture.midnightController = WorldWatchWidget.mount(fixture.nodes[0], {api:fixture.api,language:'en',showOfferings:true});
  })()`);
  try {
    await until(() => execute(win, 'fixture.calendarRequests.length > 0'), 'calendar request before UTC rollover');
    assert.equal(await execute(win, 'fixture.calendarRequests[0].date'), '2026-09-12');
    await execute(win, `fixture.midnightTime = Date.parse('2026-09-13T00:00:01Z');
      fixture.calendarRequests[0].resolve({...fixture.fixture.day,date:'2026-09-12',today:'2026-09-13',
        ancestor:'Yesterday fixture',offers:[{name:'Old offering fixture',price:1}]})`);
    await until(() => execute(win, "fixture.calendarRequests.some(request => request.date === '2026-09-13')"), 'rollover retries for the new UTC date');
    assert.equal(await execute(win, "fixture.nodes[0].textContent.includes('Yesterday fixture') || fixture.nodes[0].textContent.includes('Old offering fixture')"), false, 'Yesterday response is never shown as today');
    await execute(win, `fixture.calendarRequests.find(request => request.date === '2026-09-13').resolve({
      ...fixture.fixture.day,date:'2026-09-13',today:'2026-09-14',ancestor:'Today fixture',offers:[{name:'New offering fixture',price:2}]})`);
    await until(() => execute(win, "document.querySelector('#one .world-watch-ancestor').textContent === 'Today fixture'"), 'new UTC date renders');
    assert.equal(await execute(win, "document.querySelector('#one .world-watch-date').textContent"), 'Sep 13 · UTC', 'Summary labels the requested date, not response today metadata');
    assert.equal(await execute(win, "fixture.midnightHistory.some(text => text.includes('Yesterday fixture') || text.includes('Old offering fixture'))"), false, 'No transient stale content was rendered');
    await execute(win, `fixture.api.getCalendarDay = async () => ({...fixture.fixture.day,date:'2026-09-12',today:'2026-09-13',ancestor:'Rejected fixture'}); fixture.emit('calendar')`);
    await until(() => execute(win, "document.querySelector('#one .world-watch-today').dataset.status === 'unavailable'"), 'mismatched response date is rejected');
    assert.equal(await execute(win, "fixture.nodes[0].textContent.includes('Rejected fixture')"), false);
  } finally {
    await execute(win, 'fixture.midnightController.destroy(); fixture.midnightObserver.disconnect(); window.Date = fixture.NativeDate; void 0');
  }
  assert.equal((await execute(win, 'fixture.stats()')).listeners, 0, 'Rollover fixture releases subscriptions');
  assert.equal((await execute(win, 'fixture.stats()')).intervals, 0, 'Rollover fixture stops periodic work');
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const main = await ready('index.html');
  const widget = await ready('widget-host.html?widget=world-watch'); widget.showInactive();
  await execute(widget, 'window.api.windowResizeTo(350, 0)');
  await until(async () => { const value = await card(widget); return value.width === 350 && value.kind === 'rain' && value.phase === 'day' && value.summary; }, 'combined day/rain overview');
  await until(async () => { const value = await card(widget); return value.scrollHeight <= value.height + 2; }, 'initial automatic height');
  let value = await card(widget);
  assert.equal(value.clockVisible, true); assert.equal(value.weatherVisible, true); assertFits(value, 'overview');
  assert.equal((await meeting(widget)).percent, '50%', 'Cached account timer renders from initial getState');
  await until(async () => (await card(widget)).countdown !== value.countdown, 'clock runs between API broadcasts');
  await capture(widget, 'world-watch-overview');
  await execute(widget, 'window.api.windowResizeTo(300, 0)');
  await until(async () => (await card(widget)).width === 300, 'minimum supported width');
  assertFits(await card(widget), '300px overview'); await capture(widget, 'world-watch-300px');
  await execute(widget, 'window.api.windowResizeTo(350, 0)');
  await until(async () => (await card(widget)).width === 350, 'restore overview width');
  await checkMeeting(widget, main, widget, 'floating');
  widget.webContents.debugger.attach('1.3');
  await widget.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until(() => execute(widget, "document.querySelector('.world-watch-weather .weather-forecast').getAnimations({subtree:true}).some(x => x.playState === 'running')"), 'rain animation');
  await widget.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until(() => execute(widget, "document.querySelector('.world-watch-weather .weather-forecast').getAnimations({subtree:true}).every(x => x.playState !== 'running')"), 'reduced motion');
  await widget.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  widget.webContents.debugger.detach();
  const freeHeights = await checkTabs(widget, 'floating');
  await select(widget, 'forecast');
  await until(() => execute(widget, "document.querySelectorAll('.world-watch-forecast .weather-step').length === 3"), 'complete forecast');
  await capture(widget, 'world-watch-forecast');
  await select(widget, 'overview');
  await execute(widget, "document.querySelector('.world-watch-today').click()");
  await until(async () => (await card(widget)).view === 'calendar', 'today summary opens calendar');
  await until(() => execute(widget, "!!document.querySelector('.world-watch-calendar .calendar-ancestor')"), 'calendar loads');
  await capture(widget, 'world-watch-calendar');
  const calendarHeight = (await card(widget)).height;
  await main.webContents.executeJavaScript('window.api.saveConfig({calendarShowOfferings:false})');
  await until(() => execute(widget, "document.querySelector('.world-watch-calendar .calendar-offers').hidden"), 'configuration hides offerings');
  assert.equal((await card(widget)).height, calendarHeight, 'Offerings do not resize the outer widget');
  await main.webContents.executeJavaScript("window.api.saveConfig({calendarShowOfferings:true,language:'de'})");
  const germanDate = new Intl.DateTimeFormat('de', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date());
  await until(() => execute(widget, `!document.querySelector('.world-watch-calendar .calendar-offers').hidden && document.querySelector('.world-watch-date').textContent.startsWith(${JSON.stringify(germanDate)})`), 'configuration language and offerings');
  await until(async () => (await meeting(widget)).label.includes('Gesegnete Begegnung'), 'live localized timer name');
  await main.webContents.executeJavaScript("window.api.saveConfig({language:'en'})");
  await select(widget, 'overview');
  sharedWeather.update('cached');
  await until(async () => (await card(widget)).weatherStatus === 'cached', 'cached weather');
  await capture(widget, 'world-watch-cached');
  sharedWeather.update('unavailable', events.at(-1).end + 1000);
  await until(async () => (await card(widget)).weatherStatus === 'unavailable', 'expired offline weather');
  value = await card(widget); assert.equal(value.phase, 'day'); assert.ok(value.summary); assertFits(value, 'offline');
  await capture(widget, 'world-watch-offline');
  sharedWeather.update('ready');
  await until(async () => (await card(widget)).kind === 'rain', 'weather recovers');
  await execute(widget, "document.querySelector('.timer-widget[data-widget=world-watch] .widget-collapse-btn').click()");
  await until(async () => (await card(widget)).height < 40, 'collapsed world watch');
  await until(() => execute(widget, "document.querySelector('.world-watch-weather .weather-forecast').dataset.paused === 'true'"), 'collapse pauses animated weather');
  await execute(widget, "document.querySelector('.timer-widget[data-widget=world-watch] .widget-collapse-btn').click()");
  await until(async () => (await card(widget)).height > 200, 'reexpanded world watch');

  if (packaged) {
    const { createHeadersHandler } = require('../src/modules/guard');
    session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
    await widget.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: 'world-watch' } });
    await until(async () => (await card(widget)).kind === 'rain' && (await card(widget)).phase === 'day', 'packaged World Watch');
    assert.equal(await execute(widget, "document.querySelector('.clock-orbit').getBBox().width > 0 && document.querySelector('.weather-scene').getBBox().width > 0"), true, 'Packaged local artwork');
    await checkTabs(widget, 'packaged'); await capture(widget, 'world-watch-packaged');
    await checkMeeting(widget, main, widget, 'packaged');
  }
  await checkComponents(packaged ? path.join(archive, 'src/renderer') : path.join(root, 'src/renderer'));
  const workArea = screen.getPrimaryDisplay().workArea;
  main.setPosition(workArea.x + 80, workArea.y + 80);
  await main.webContents.executeJavaScript("window.api.saveConfig({layoutMode:'grid'})");
  const dock = await ready('dock-window.html');
  if (packaged) await dock.loadFile(path.join(archive, 'src/renderer/dock-window.html'));
  const frame = await until(() => dock.webContents.mainFrame.framesInSubtree.find(item => /widget=world-watch/.test(item.url)), 'World Watch dock frame');
  if (packaged) assert.match(frame.url, /app\.asar\//, 'Dock iframe uses the packaged renderer');
  await until(async () => (await card(frame)).kind === 'rain', 'docked World Watch');
  const dockHeights = await checkTabs(frame, 'docked');
  await checkMeeting(frame, main, dock, 'docked');
  sharedWeather.update('cached');
  await until(async () => (await card(frame)).weatherStatus === 'cached', 'forecast broadcast reaches dock');
  await main.webContents.executeJavaScript("window.api.saveConfig({theme:'ember'})");
  await until(() => execute(frame, "document.documentElement.dataset.theme === 'ember'"), 'docked theme update');
  await capture(dock, 'world-watch-docked');
  await main.webContents.executeJavaScript('window.api.openWidgets()');
  const widgets = await ready('widgets-window.html');
  await until(() => execute(widgets, "!!document.querySelector('input[data-widget=world-watch]')"), 'World Watch visibility toggle');
  await execute(widgets, "document.querySelector('input[data-widget=world-watch]').click()");
  await until(async () => !find('dock-window.html') || !(await execute(dock, "!!document.querySelector('iframe[data-widget=world-watch]')")), 'disable World Watch');
  await execute(widgets, "document.querySelector('input[data-widget=world-watch]').click()");
  const reopenedDock = await ready('dock-window.html');
  const reopened = await until(() => reopenedDock.webContents.mainFrame.framesInSubtree.find(item => /widget=world-watch/.test(item.url)), 'reopened World Watch frame');
  await until(async () => (await card(reopened)).kind === 'rain', 'reopened World Watch renders');
  assert.equal(new ConfigStore().get('widgetVisibility')['world-watch'], true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, packaged, freeHeights, dockHeights, screenshots: out }, null, 2));
  app.exit(0);
}).catch(async error => {
  console.error(error.stack); console.error({ errors, output: out });
  const widget = find('widget-host.html?widget=world-watch');
  if (widget && !widget.isDestroyed()) {
    try { console.error({ bounds: widget.getBounds(), card: await card(widget) }); } catch { /* Keep the original failure. */ }
  }
  app.exit(1);
});
