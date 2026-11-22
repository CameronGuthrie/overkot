'use strict';

// Called by the isolated Settings smoke. These controls use the real main,
// preload and renderer; no game is attached and no user profile is modified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const { normalize } = require('../src/modules/moonsteelAlertSettings');
const { readEncryptedJSON } = require('../src/modules/fileEncryption');
const { CONFIG_PATH } = require('../src/modules/appPaths');

async function checkMoonsteelSettings({ settings, main, evaluate, until, click, state, capturePaint, checks, BrowserWindow, out }) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const current = async () => normalize((await state(main)).config.moonsteelAlert);
  const original = await current(), originalBounds = settings.getBounds();
  const alerts = () => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()
    && win.webContents.getURL().split('?')[0].endsWith('/moonsteel-alert.html'));
  const setValue = async (id, value) => evaluate(settings, `(() => {
    const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const setChecked = async (id, checked) => {
    if (await evaluate(settings, `document.getElementById(${JSON.stringify(id)}).checked`) !== checked) await click(settings, id);
  };
  let selected;
  try {
    assert.equal(BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('widget-host.html?widget=minimap')), false,
      'Moonsteel alert settings and preview are available without a minimap window');
    await click(settings, 'tab-moonsteel-alert');
    await until(() => evaluate(settings, "!document.getElementById('panel-moonsteel-alert').hidden"), 'Moonsteel alert tab opens');
    settings.setSize(560, Math.max(620, Math.min(740, originalBounds.height)));
    await pause(80);
    const layout = await evaluate(settings, `(() => {
      const content=document.getElementById('settings-content');
      return {client:content.clientWidth,scroll:content.scrollWidth,
        labelled:[...document.querySelectorAll('#panel-moonsteel-alert input,#panel-moonsteel-alert select')].every(input=>input.labels?.length>0)};
    })()`);
    assert.ok(layout.scroll <= layout.client, 'Moonsteel controls fit the minimum Settings width');
    assert.equal(layout.labelled, true, 'Every Moonsteel control has an associated label');
    await capturePaint(settings, 'moonsteel-settings-narrow');
    settings.setBounds(originalBounds);

    await setChecked('chk-moonsteel-enabled', false);
    await setChecked('chk-moonsteel-flash', true);
    await setChecked('chk-moonsteel-sound', true);
    await setValue('color-moonsteel-alert', '#c070ff');
    for (const [suffix, value] of [['opacity', .4], ['border-width', 72], ['blur', 45], ['duration', 1], ['pulse-speed', .5], ['volume', .05]]) {
      await setValue('slider-moonsteel-' + suffix, value);
    }
    await setValue('moonsteel-monitor-select', 'primary');
    await setValue('moonsteel-sound-select', 'soft');
    assert.equal(await evaluate(settings, 'flushPendingSettings()'), true, 'Moonsteel controls persist through the Settings save queue');
    selected = await current();
    assert.deepEqual(selected, { enabled: false, flashEnabled: true, soundEnabled: true, color: '#c070ff',
      opacity: .4, borderWidth: 72, blur: 45, duration: 1, pulseSpeed: .5, sound: 'soft', volume: .05, monitor: 'primary' });
    assert.deepEqual(readEncryptedJSON(CONFIG_PATH).moonsteelAlert, selected, 'All Moonsteel preferences persist in the isolated profile');
    checks.push('Moonsteel controls fit at minimum width, save every preference through real preload IPC, and persist without the minimap');

    assert.equal(await evaluate(main, `window.api.previewMoonsteelAlert(${JSON.stringify(selected)})`), false,
      'An unrelated renderer cannot request a monitor flash');
    assert.equal(await evaluate(settings, "window.api.previewMoonsteelAlert({volume:2})"), false, 'Malformed preview preferences are rejected');
    assert.equal(await evaluate(settings, "window.api.saveConfig({moonsteelAlert:{opacity:2}})"), false, 'Malformed Moonsteel saves are rejected');
    assert.deepEqual(await current(), selected, 'Invalid requests do not change confirmed preferences');

    const focusedBefore = BrowserWindow.getFocusedWindow();
    await click(settings, 'btn-test-moonsteel-alert');
    const alert = await until(() => alerts()[0], 'Moonsteel preview window opens while automatic alerts are off');
    await until(async () => !alert.isDestroyed() && alert.isVisible() && await evaluate(alert,
      "document.documentElement.dataset.soundPlayed==='soft' && document.documentElement.dataset.audioState==='running'"), 'Moonsteel preview plays its configured sound');
    assert.equal(alert.isFocusable(), false, 'The full-monitor flash cannot activate');
    assert.equal(BrowserWindow.getFocusedWindow(), focusedBefore, 'The monitor flash preserves the current keyboard focus');
    assert.deepEqual(alert.getBounds(), screen.getPrimaryDisplay().bounds, 'The flash covers the full monitor rather than the work area');
    const rendered = await evaluate(alert, `({flash:document.documentElement.dataset.flashEnabled,
      sound:document.documentElement.dataset.soundPlayed,audio:document.documentElement.dataset.audioState,
      colour:document.documentElement.style.getPropertyValue('--edge-color'),
      width:document.documentElement.style.getPropertyValue('--edge-width'),
      spread:document.documentElement.style.getPropertyValue('--edge-spread')})`);
    assert.equal(rendered.flash, 'true'); assert.equal(rendered.colour, selected.color);
    assert.equal(rendered.width, '72px'); assert.equal(rendered.spread, '117px');
    fs.writeFileSync(path.join(out, 'moonsteel-settings-preview.png'), (await alert.webContents.capturePage()).toPNG());
    await until(() => alerts().length === 0, 'Moonsteel preview destroys itself after the selected duration and sound tail', 5000);
    assert.equal((await current()).enabled, false, 'Manual preview never enables automatic Moonsteel alerts');
    checks.push('Moonsteel Test alert works while disabled, preserves focus, covers the full monitor, runs configured Web Audio, and cleans up');

    await setValue('slider-moonsteel-opacity', 0);
    await setChecked('chk-moonsteel-sound', false);
    await until(() => evaluate(settings, "document.getElementById('btn-test-moonsteel-alert').disabled"), 'A silent invisible alert cannot be tested');
    assert.equal(await evaluate(settings, 'flushPendingSettings()'), true);
    checks.push('Moonsteel preview rejects invalid or unrelated requests and disables testing when both outputs are ineffective');
    fs.writeFileSync(path.join(out, 'moonsteel-settings-check.json'), JSON.stringify({ ok: true, selected, layout, rendered }, null, 2));
  } finally {
    if (!settings.isDestroyed()) {
      settings.setBounds(originalBounds);
      await evaluate(settings, `window.api.saveConfig({moonsteelAlert:${JSON.stringify(original)}})`);
    }
  }
}

module.exports = { checkMoonsteelSettings };
