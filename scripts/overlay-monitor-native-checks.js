'use strict';

// Real Settings/preload/main geometry checks in the runner's isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const { railBounds } = require('../src/modules/edgeDockGeometry');
const { readEncryptedJSON } = require('../src/modules/fileEncryption');
const { CONFIG_PATH } = require('../src/modules/appPaths');

const sameBounds = (a, b) => ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
const contains = (area, bounds) => bounds.x >= area.x - 1 && bounds.y >= area.y - 1
  && bounds.x + bounds.width <= area.x + area.width + 1 && bounds.y + bounds.height <= area.y + area.height + 1;

async function checkOverlayMonitor({ settings, main, evaluate, until, click, state, capturePaint, checks, BrowserWindow, out }) {
  const original = (await state(main)).config;
  const originalSettingsBounds = settings.getBounds();
  const initialSnapshot = await evaluate(settings, 'window.api.getOverlayDisplays()');
  const displays = initialSnapshot.displays;
  const originalDisplay = displays.find(display => display.id === initialSnapshot.selectedDisplayId);
  assert.ok(originalDisplay, 'The active bar monitor is in the connected display list');
  const target = displays.find(display => display.id !== originalDisplay.id && !sameBounds(display.bounds, originalDisplay.bounds)) || originalDisplay;
  const current = async () => (await state(main)).config;
  const panel = () => BrowserWindow.getAllWindows().find(win => !win.isDestroyed()
    && win.webContents.getURL().includes('widget-host.html?widget=clock'));
  let moved = false, selectedState, narrowLayout;
  try {
    await click(settings, 'tab-overlay');
    await until(() => evaluate(settings, "!document.getElementById('panel-overlay').hidden && !document.getElementById('dock-display-select').disabled"), 'Overlay monitor selector is ready');
    const selector = await evaluate(settings, `(() => {
      const select=document.getElementById('dock-display-select');
      return {labelled:select.labels?.length>0,value:select.value,options:[...select.options].map(option=>({id:Number(option.value),label:option.textContent}))};
    })()`);
    assert.equal(selector.labelled, true, 'The monitor selector has an accessible label');
    assert.deepEqual(selector.options.map(option => option.id), displays.map(display => display.id));
    assert.equal(selector.value, String(initialSnapshot.selectedDisplayId));
    assert.ok(selector.options.every(option => option.label.length > 0), 'Every connected monitor has a readable name');
    assert.ok(selector.options.some(option => /Primary/.test(option.label)), 'The primary monitor is identified');
    settings.setSize(560, Math.max(620, Math.min(740, originalSettingsBounds.height)));
    narrowLayout = await evaluate(settings, `(() => {const content=document.getElementById('settings-content');return {width:content.clientWidth,scroll:content.scrollWidth};})()`);
    assert.ok(narrowLayout.scroll <= narrowLayout.width, 'The monitor selector fits minimum-width Settings');
    await capturePaint(settings, 'overlay-monitor-settings');
    settings.setBounds(originalSettingsBounds);

    assert.equal(await evaluate(main, `window.api.saveConfig({widgetVisibility:${JSON.stringify({ ...original.widgetVisibility, clock: true })}})`), true);
    assert.equal(await evaluate(main, `window.api.saveConfig(${JSON.stringify({ widgetOpen: { ...original.widgetOpen, clock: true }, widgetDocked: { ...original.widgetDocked, clock: true } })})`), true);
    const clock = await until(() => panel(), 'Attached clock window opens for the monitor move');
    await until(() => !clock.webContents.isLoading() && clock.isVisible(), 'Attached clock finishes opening');
    await evaluate(settings, `(() => {const select=document.getElementById('dock-display-select');select.value=${JSON.stringify(String(target.id))};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await evaluate(settings, 'flushPendingSettings()'), true, 'The monitor choice saves through the Settings queue');
    await until(async () => (await current()).dockDisplayId === target.id, 'The selected monitor is persisted');
    selectedState = await current();
    assert.equal(readEncryptedJSON(CONFIG_PATH).dockDisplayId, target.id, 'The monitor choice persists on disk');
    const expectedRail = railBounds(target.bounds, selectedState.dockEdge || 'bottom');
    await until(() => sameBounds(main.getBounds(), expectedRail), 'The bar moves to the selected monitor edge');
    assert.deepEqual(main.getBounds(), expectedRail);
    const nativeDisplay = screen.getAllDisplays().find(display => display.id === target.id);
    assert.ok(nativeDisplay, 'The selected native monitor is connected');
    await until(() => contains(nativeDisplay.workArea, clock.getBounds()), 'Attached widgets follow the bar into the selected work area');
    assert.equal(contains(nativeDisplay.workArea, clock.getBounds()), true);
    moved = target.id !== originalDisplay.id;
    checks.push(moved
      ? 'The Overlay monitor selector moves the native bar and attached clock to another physical monitor and persists the choice'
      : 'The Overlay monitor selector identifies the active monitor, persists its choice and keeps the attached clock inside its work area');

    assert.equal(await evaluate(settings, 'window.api.saveConfig({dockDisplayId:1e30})'), false, 'Invalid numeric monitor IDs are rejected');
    assert.equal(await evaluate(settings, `window.api.saveConfig({dockDisplayId:${JSON.stringify(String(target.id))}})`), false, 'String monitor IDs are rejected');
    assert.equal((await current()).dockDisplayId, target.id, 'Rejected requests leave the monitor choice intact');
    await click(settings, 'tab-updates');
    assert.equal(await evaluate(settings, "document.getElementById('chk-automatic-updates')===null"), true, 'Settings has no automatic-update switch');
    assert.match(await evaluate(settings, "document.getElementById('app-update-policy').textContent"), /startup.*Download and install when you choose/i);
    await evaluate(settings, 'window.api.saveConfig({automaticUpdates:true})');
    assert.equal((await current()).automaticUpdates, false, 'Legacy automatic-update saves cannot enable automatic app updates');
    assert.equal(readEncryptedJSON(CONFIG_PATH).automaticUpdates, false);
    checks.push('The Updates panel states the startup-check/manual-download policy and legacy automatic-update requests cannot enable it');
    fs.writeFileSync(path.join(out, 'overlay-monitor-check.json'), JSON.stringify({ ok: true, moved, displays, selectedDisplayId: target.id,
      rail: main.getBounds(), attachedClock: clock.getBounds(), narrowLayout }, null, 2));
  } finally {
    if (!settings.isDestroyed()) {
      settings.setBounds(originalSettingsBounds);
      await evaluate(settings, 'flushPendingSettings()');
      await evaluate(settings, `window.api.saveConfig({dockDisplayId:${JSON.stringify(originalDisplay.id)}})`);
    }
    if (!main.isDestroyed()) {
      await evaluate(main, `window.api.saveConfig({widgetVisibility:${JSON.stringify(original.widgetVisibility || {})}})`);
      await evaluate(main, `window.api.saveConfig(${JSON.stringify({ widgetOpen: original.widgetOpen || {}, widgetDocked: original.widgetDocked || {} })})`);
    }
  }
}

module.exports = { checkOverlayMonitor };
