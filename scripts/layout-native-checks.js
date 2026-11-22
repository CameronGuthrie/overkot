'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const { readEncryptedJSON } = require('../src/modules/fileEncryption');
const { CONFIG_PATH } = require('../src/modules/appPaths');

/** Real Settings controls, preload IPC, saved files and native widget geometry. */
async function checkLayouts({ settings, main, evaluate, until, click, state, capturePaint, checks, out, dialogs, BrowserWindow }) {
  const current = async () => (await state(main)).config;
  const original = await current();
  const save = async patch => {
    assert.equal(await evaluate(settings, `window.api.saveConfig(${JSON.stringify(patch)})`), true);
  };
  const setName = async name => evaluate(settings, `(() => {
    const input = document.getElementById('layout-name'); input.value = ${JSON.stringify(name)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const press = async id => {
    await until(() => evaluate(settings, "document.getElementById('saved-layouts').getAttribute('aria-busy') !== 'true'"), 'layouts ready');
    await click(settings, id);
    await until(() => evaluate(settings, "document.getElementById('saved-layouts').getAttribute('aria-busy') !== 'true'"), 'layouts action finished');
    assert.equal(await evaluate(settings, "document.getElementById('layout-status').dataset.error"), 'false', id);
  };
  const choose = async id => evaluate(settings, `(() => {
    const select = document.getElementById('layout-select'); select.value = ${JSON.stringify(id)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const chooseStartup = async id => {
    await until(() => evaluate(settings, "!document.getElementById('layout-startup').disabled"), 'startup layout ready');
    await evaluate(settings, `(() => {
      const select = document.getElementById('layout-startup'); select.value = ${JSON.stringify(id || '')};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(async () => (await current()).startupLayoutId === (id || null)
      && await evaluate(settings, "document.getElementById('saved-layouts').getAttribute('aria-busy') !== 'true'"), 'startup choice saved through actual preload IPC');
    assert.equal(await evaluate(settings, "document.getElementById('layout-startup').value"), id || '');
    assert.equal(readEncryptedJSON(CONFIG_PATH).startupLayoutId, id || null, 'Startup selection persists to the isolated profile');
    assert.equal(await evaluate(settings, "document.getElementById('layout-status').dataset.error"), 'false');
  };
  const area = screen.getDisplayMatching(main.getBounds()).workArea;
  const minimapBounds = { x: area.x + 100, y: area.y + 80, width: 430, height: 430 };
  await click(settings, 'tab-widgets');
  await until(() => evaluate(settings, "!document.getElementById('layout-name').disabled"), 'layout library loaded');
  await save({ widgetVisibility: { clock: true, minimap: true } });
  await save({ dockEdge: 'left', dockAutoHide: false, dockWidgetOrder: ['minimap', 'clock'],
    widgetOpen: { clock: false, minimap: true }, widgetDocked: { minimap: false }, widgetBounds_minimap: minimapBounds });
  const minimap = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('widget-host.html?widget=minimap')), 'layout minimap window');
  await until(async () => minimap.isVisible() && !minimap.webContents.isLoading(), 'layout minimap rendered');
  await setName('Exploring');
  await press('layout-save');
  const exploring = (await current()).savedLayouts.find(layout => layout.name === 'Exploring');
  assert.ok(exploring);
  assert.deepEqual(exploring.layout.widgetBounds.minimap, minimapBounds);
  assert.equal(exploring.layout.widgetOpen.minimap, true);
  await evaluate(settings, "document.getElementById('saved-layouts').scrollIntoView({block:'start'})");
  await capturePaint(settings, 'layouts-saved');

  await save({ dockEdge: 'right', widgetOpen: { minimap: false, clock: false } });
  await chooseStartup(exploring.id);
  assert.equal((await current()).dockEdge, 'right', 'Choosing a startup layout does not apply it now');
  assert.equal(minimap.isVisible(), false, 'Startup choice does not open its saved widgets now');
  assert.equal(await evaluate(settings, "document.getElementById('layout-select').value"), exploring.id,
    'Startup and Apply controls keep separate selections');
  await chooseStartup(null);
  await chooseStartup(exploring.id);
  const exported = path.join(out, 'Exploring.overkot-layout.json');
  dialogs.save = exported;
  await press('layout-export');
  const file = JSON.parse(fs.readFileSync(exported, 'utf8'));
  assert.equal(file.format, 'overkot-layout');
  assert.equal(file.version, 1);
  assert.equal(file.name, 'Exploring');
  assert.equal(file.layout.dockEdge, 'left');
  assert.equal(JSON.stringify(file).includes(out), false, 'Export excludes the local profile/game paths');
  assert.equal(Object.hasOwn(file, 'id'), false);

  dialogs.open = exported;
  await press('layout-import');
  let imported = (await current()).savedLayouts.find(layout => layout.name === 'Exploring (2)');
  assert.ok(imported && imported.id !== exploring.id);
  assert.equal((await current()).dockEdge, 'right', 'Import does not rearrange the space');
  assert.equal((await current()).startupLayoutId, exploring.id, 'Import does not replace the selected startup layout');
  assert.equal(await evaluate(settings, "document.getElementById('layout-select').value"), imported.id);
  assert.equal(await evaluate(settings, "document.getElementById('layout-startup').value"), exploring.id,
    'An imported Apply choice is independent from the startup choice');
  await press('layout-apply');
  await until(async () => (await current()).dockEdge === 'left' && minimap.isVisible(), 'layout restores open panels and bar');
  assert.deepEqual(minimap.getBounds(), minimapBounds);
  assert.equal((await current()).widgetDocked.minimap, false);

  await setName('Trading');
  await press('layout-rename');
  await save({ dockEdge: 'bottom', widgetOpen: { minimap: false, clock: false } });
  await press('layout-update');
  imported = (await current()).savedLayouts.find(layout => layout.id === imported.id);
  assert.equal(imported.name, 'Trading');
  assert.equal(imported.layout.dockEdge, 'bottom');
  assert.equal(imported.layout.widgetOpen.minimap, false);
  await choose(exploring.id);
  await press('layout-apply');
  assert.equal((await current()).dockEdge, 'left');
  await choose(imported.id);
  await press('layout-apply');
  assert.equal((await current()).dockEdge, 'bottom');
  assert.equal(minimap.isVisible(), false);

  await chooseStartup(imported.id);
  await press('layout-delete');
  assert.equal((await current()).savedLayouts.length, 2, 'Delete waits for inline confirmation');
  assert.equal((await current()).startupLayoutId, imported.id, 'Startup choice remains selected until deletion is confirmed');
  await press('layout-delete-confirm');
  assert.equal((await current()).savedLayouts.length, 1);
  assert.equal((await current()).startupLayoutId, null, 'Deleting the startup layout falls back to the last used arrangement');
  assert.equal(readEncryptedJSON(CONFIG_PATH).startupLayoutId, null, 'Deletion persists its startup fallback');
  assert.equal(await evaluate(settings, "document.getElementById('layout-startup').value"), '');
  assert.equal((await current()).dockEdge, 'bottom', 'Deleting leaves the current arrangement alone');
  assert.equal(readEncryptedJSON(CONFIG_PATH).savedLayouts[0].name, 'Exploring', 'Saved library persists to disk');
  checks.push('named layouts save, rename, update, apply and delete through real Settings controls and restore native minimap geometry');
  checks.push('layout JSON export/import round-trips, keeps both names, excludes private paths and waits for Apply');
  checks.push('Startup layout autosaves separately from Apply, persists to disk, survives imports and falls back to Last used arrangement when its saved layout is deleted');
  await chooseStartup(exploring.id);

  // Restore this fixture's baseline for the independent appearance checks.
  await save({ widgetVisibility: original.widgetVisibility });
  await save({ widgetOpen: original.widgetOpen, widgetDocked: original.widgetDocked,
    dockEdge: original.dockEdge, dockAutoHide: original.dockAutoHide, dockWidgetOrder: original.dockWidgetOrder });
  return exploring.id;
}

module.exports = { checkLayouts };
