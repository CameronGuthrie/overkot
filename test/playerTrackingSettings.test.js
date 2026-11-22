'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function settings(api = {}) {
  const nodes = new Map(), documentEvents = {}, windowEvents = {}, saves = [];
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', checked: false, dataset: {},
      addEventListener(name, callback) { this[name] = callback; } });
    return nodes.get(selector);
  };
  const context = vm.createContext({ console, URLSearchParams, setTimeout, clearTimeout,
    document: { querySelector: node, addEventListener(name, callback) { documentEvents[name] = callback; } },
    window: { addEventListener(name, callback) { windowEvents[name] = callback; },
      api: { saveConfig: async patch => { saves.push(patch); return true; }, ...api } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8'), context);
  return { context, node, saves, documentEvents, windowEvents,
    run: code => vm.runInContext(code, context) };
}

test('tracking settings explain live, stale, unsupported and disabled states without exposing raw details', () => {
  const view = settings();
  const status = view.node('#player-tracking-status');
  for (const [value, pattern] of [['tracking', /Tracking player position and facing/], ['searching', /Finding the player/],
    ['stale', /fresh player position/], ['unsupported-build', /Soulframe build/], ['unsupported-platform', /Windows/],
    ['helper-missing', /reader is unavailable/], ['helper-unavailable', /reader is unavailable/], ['unavailable', /tracking is unavailable/],
    ['waiting-for-login', /Log in to Soulframe/], ['waiting-for-area', /current map/], ['scan-incomplete', /while it retries/],
    ['process-gone', /Start Soulframe/], ['profile-mismatch', /could not verify/], ['stopped', /Waiting for Soulframe/]]) {
    view.run(`playerTrackingState = { status: ${JSON.stringify(value)}, message: 'private memory details' }; renderPlayerTracking()`);
    assert.match(status.textContent, pattern);
    assert.doesNotMatch(status.textContent, /private memory details/);
  }
  view.run("config.livePlayerTracking = false; playerTrackingState = {status:'tracking'}; renderPlayerTracking()");
  assert.match(status.textContent, /tracking is off/);
  assert.equal(status.dataset.status, 'disabled');
});

test('Linux tracking permission failures explain how to enable the packaged native reader', () => {
  const view = settings();
  view.run("platformSupport = {platform:'linux'}; playerTrackingState = {status:'permission-denied'}; renderPlayerTracking()");
  assert.match(view.node('#player-tracking-status').textContent, /DEB\/Pacman package/);
  view.run("playerTrackingState = {status:'unsupported-platform'}; renderPlayerTracking()");
  assert.match(view.node('#player-tracking-status').textContent, /Windows and Linux with Wine\/Proton/);
});

test('tutorial toggle follows confirmed config and saves only its global preference through the dedicated endpoint', async () => {
  const calls = [];
  const view = settings({ setTutorialsEnabled: async enabled => { calls.push(enabled); return true; } });
  view.run('bindEvents(); confirmedConfig = { tutorialsEnabled: true, tutorialCompleted: {clock: true} }; config = {...confirmedConfig}; renderTutorialControls()');
  assert.equal(view.node('#chk-tutorials-enabled').checked, true);
  view.node('#chk-tutorials-enabled').checked = false;
  view.node('#chk-tutorials-enabled').change();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false]);
  assert.deepEqual(view.saves, []);
  assert.equal(view.run('config.tutorialsEnabled'), false);
  assert.equal(view.run('config.tutorialCompleted.clock'), true);
  view.run('config.tutorialsEnabled = true; renderTutorialControls()');
  assert.equal(view.node('#chk-tutorials-enabled').checked, true);
});

test('tutorial toggle saves once while pending and restores the saved choice on failure', async () => {
  let resolve;
  const calls = [];
  const view = settings({ setTutorialsEnabled: enabled => { calls.push(enabled); return new Promise(done => { resolve = done; }); } });
  view.run('confirmedConfig = { tutorialsEnabled: true }; config = {...confirmedConfig}');
  const first = view.run('setTutorialsEnabled(false)');
  await view.run('setTutorialsEnabled(false)');
  assert.deepEqual(calls, [false]);
  assert.equal(view.node('#chk-tutorials-enabled').disabled, true);
  resolve(false); await first;
  assert.equal(view.node('#tutorial-toggle-status').hidden, false);
  assert.equal(view.node('#chk-tutorials-enabled').checked, true);
  assert.equal(view.node('#chk-tutorials-enabled').disabled, false);
});

test('tracking checkbox uses the ordinary config save path and saves only its own setting', async () => {
  const view = settings();
  view.run('bindEvents(); renderStatus = () => {}; loadTranslations = () => {}; populateLanguageDropdown = () => {}; applyConfigToDOM = () => {}; initialized = true; confirmedConfig = {livePlayerTracking: true, language: "en"}; config = {...confirmedConfig}');
  view.node('#chk-live-player-tracking').checked = false;
  view.node('#chk-live-player-tracking').change();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(view.saves)), [{ livePlayerTracking: false }]);
  assert.equal(view.run('config.livePlayerTracking'), false);
  assert.match(view.node('#player-tracking-status').textContent, /tracking is off/);
});

test('hidden alerts are opt-in, save independently and follow external config changes', async () => {
  const view = settings();
  view.run('bindEvents(); renderStatus = loadTranslations = populateLanguageDropdown = updateOpacityControls = renderMapColors = populateInteractionHotkey = renderOverlayHotkey = renderPlatformSupport = renderMarket = renderPlayerTracking = () => {}; initialized = true; confirmedConfig = {language: "en", enableAlertPopup: false, enableAlertSound: true}; config = {...confirmedConfig}; applyConfigToDOM()');
  const checkbox = view.node('#chk-alerts-when-hidden');
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  checkbox.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(view.saves)), [{ showAlertsWhenHidden: true }]);
  assert.equal(view.run('config.showAlertsWhenHidden'), true);
  assert.equal(view.run('config.enableAlertPopup'), false);
  assert.equal(view.run('config.enableAlertSound'), true);
  view.run('receiveConfig({showAlertsWhenHidden: false})');
  assert.equal(checkbox.checked, false);
});

test('progressive dungeon reveal starts on, saves independently and follows shared config changes', async () => {
  const view = settings();
  view.run('bindEvents(); renderStatus = loadTranslations = populateLanguageDropdown = updateOpacityControls = renderMapColors = populateInteractionHotkey = renderOverlayHotkey = renderPlatformSupport = renderMarket = renderPlayerTracking = () => {}; initialized = true; confirmedConfig = {language: "en", dungeonMapAutoSwitch: true}; config = {...confirmedConfig}; applyConfigToDOM()');
  const checkbox = view.node('#chk-dungeon-progressive-reveal');
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(view.saves)), [{ dungeonMapProgressiveReveal: false }]);
  assert.equal(view.run('config.dungeonMapProgressiveReveal'), false);
  assert.equal(view.run('config.dungeonMapAutoSwitch'), true);
  view.run('receiveConfig({dungeonMapProgressiveReveal: true})');
  assert.equal(checkbox.checked, true);
});

test('a failed progressive reveal save restores the last confirmed preference', async () => {
  const view = settings({ saveConfig: async () => false });
  view.run('bindEvents(); renderStatus = loadTranslations = populateLanguageDropdown = updateOpacityControls = renderMapColors = populateInteractionHotkey = renderOverlayHotkey = renderPlatformSupport = renderMarket = renderPlayerTracking = () => {}; initialized = true; confirmedConfig = {dungeonMapProgressiveReveal: true}; config = {...confirmedConfig}; applyConfigToDOM()');
  const checkbox = view.node('#chk-dungeon-progressive-reveal');
  checkbox.checked = false;
  checkbox.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checkbox.checked, true);
  assert.equal(view.run('config.dungeonMapProgressiveReveal'), true);
  assert.equal(view.run('saveFailed'), true);
});

test('a failed hidden-alert preference save restores the confirmed choice', async () => {
  const view = settings({ saveConfig: async () => false });
  view.run('bindEvents(); renderStatus = loadTranslations = populateLanguageDropdown = updateOpacityControls = renderMapColors = populateInteractionHotkey = renderOverlayHotkey = renderPlatformSupport = renderMarket = renderPlayerTracking = () => {}; initialized = true; confirmedConfig = {showAlertsWhenHidden: false}; config = {...confirmedConfig}; applyConfigToDOM()');
  const checkbox = view.node('#chk-alerts-when-hidden');
  checkbox.checked = true;
  checkbox.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checkbox.checked, false);
  assert.equal(view.run('config.showAlertsWhenHidden'), false);
  assert.equal(view.run('saveFailed'), true);
});

test('map colour controls show defaults and external changes, save individual colours, and reset independently', async () => {
  const view = settings();
  view.run('bindEvents(); renderStatus = loadTranslations = populateLanguageDropdown = () => {}; applyConfigToDOM = renderMapColors; initialized = true; confirmedConfig = {language: "en"}; config = {...confirmedConfig}; renderMapColors()');
  assert.equal(view.node('#color-player-marker').value, '#f4b642');
  assert.equal(view.node('#color-player-marker-outline').value, '#241708');
  assert.equal(view.node('#color-dungeon-outline').value, '#d8d8d8');
  view.node('#color-player-marker').value = '#AE6712';
  view.node('#color-player-marker').input();
  assert.equal(view.node('#player-marker-color-value').textContent, '#AE6712');
  assert.equal(view.saves.length, 0, 'Dragging the native picker previews its label without flooding saves');
  view.node('#color-player-marker').change();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(view.saves)), [{ playerMarkerColor: '#ae6712' }]);
  view.run("receiveConfig({dungeonMapOutlineColor: '#4789ab', playerMarkerOutlineColor: '#080604'})");
  assert.equal(view.node('#color-dungeon-outline').value, '#4789ab');
  assert.equal(view.node('#dungeon-outline-color-value').textContent, '#4789AB');
  assert.equal(view.node('#color-player-marker').value, '#ae6712');
  assert.equal(view.node('#color-player-marker-outline').value, '#080604');
  view.node('#reset-player-marker-color').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(view.saves.at(-1))), { playerMarkerColor: '#f4b642' });
  assert.equal(view.node('#color-player-marker-outline').value, '#080604');
  assert.equal(view.node('#color-dungeon-outline').value, '#4789ab');
  view.node('#color-dungeon-outline').value = '#fa4e6c';
  view.node('#color-dungeon-outline').change();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(view.saves.at(-1))), { dungeonMapOutlineColor: '#fa4e6c' });
  view.node('#color-player-marker-outline').value = '#6C3511';
  view.node('#color-player-marker-outline').change();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(view.saves.at(-1))), { playerMarkerOutlineColor: '#6c3511' });
  assert.equal(view.node('#player-marker-outline-color-value').textContent, '#6C3511');
  view.node('#reset-player-marker-outline-color').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(view.saves.at(-1))), { playerMarkerOutlineColor: '#241708' });
  assert.equal(view.node('#color-player-marker').value, '#f4b642');
  assert.equal(view.node('#color-dungeon-outline').value, '#fa4e6c');
});

test('a failed colour save returns the picker to the last confirmed colour', async () => {
  for (const [input, output, key, confirmed] of [
    ['color-player-marker', 'player-marker-color-value', 'playerMarkerColor', '#aabbcc'],
    ['color-player-marker-outline', 'player-marker-outline-color-value', 'playerMarkerOutlineColor', '#0a0b0c'],
    ['color-dungeon-outline', 'dungeon-outline-color-value', 'dungeonMapOutlineColor', '#d1d2d3'],
  ]) {
    const view = settings({ saveConfig: async () => false });
    view.run(`bindEvents(); renderStatus = loadTranslations = populateLanguageDropdown = () => {}; applyConfigToDOM = renderMapColors; initialized = true; confirmedConfig = {${key}: "${confirmed}"}; config = {...confirmedConfig}; renderMapColors()`);
    view.node('#' + input).value = '#112233';
    view.node('#' + input).change();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.node('#' + input).value, confirmed);
    assert.equal(view.node('#' + output).textContent, confirmed.toUpperCase());
    assert.equal(view.run('saveFailed'), true);
  }
});

test('map appearance and dungeon controls belong only to the Mini-Map widget settings', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.html'), 'utf8');
  const panels = new Map([...html.matchAll(/<section id="(panel-[^"]+)"[^>]*>([\s\S]*?)<\/section>/g)]
    .map(match => [match[1], match[2]]));
  const widgets = panels.get('panel-widgets'), overlay = panels.get('panel-overlay');
  assert.ok(widgets && overlay);
  assert.match(widgets, /id="minimap-widget-settings"/);
  for (const id of ['color-player-marker', 'color-player-marker-outline', 'color-dungeon-outline',
    'chk-dungeon-auto-switch', 'chk-dungeon-progressive-reveal', 'chk-dungeon-see-through', 'slider-dungeon-opacity']) {
    assert.ok(widgets.includes(`id="${id}"`), `${id} is configurable with its widget`);
    assert.ok(!overlay.includes(`id="${id}"`), `${id} has no duplicate Overlay control`);
    assert.equal(html.split(`id="${id}"`).length, 2, `${id} has exactly one control`);
  }
  assert.match(overlay, /id="chk-live-player-tracking"/);
});

test('new tracking events outrank delayed initial state and listeners unsubscribe on close', async () => {
  let resolveTracking, event, unsubscribed = false;
  const view = settings({ getPlayerTracking: () => new Promise(resolve => { resolveTracking = resolve; }),
    onPlayerTrackingChanged: callback => { event = callback; return () => { unsubscribed = true; }; } });
  view.run('populateThemeDropdown = populateWidgetTutorials = loadTranslations = bindEvents = () => {}; loadSettings = loadMarket = loadAvakotAccount = loadGamePaths = async () => {}');
  view.documentEvents.DOMContentLoaded();
  event({ status: 'tracking' });
  resolveTracking({ status: 'unsupported-build' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.node('#player-tracking-status').dataset.status, 'tracking');
  const pending = view.run('loadPlayerTracking()');
  view.windowEvents.beforeunload();
  assert.equal(unsubscribed, true);
  resolveTracking({ status: 'stale' }); await pending;
  assert.equal(view.node('#player-tracking-status').dataset.status, 'tracking');
});
