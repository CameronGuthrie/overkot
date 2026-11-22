'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const Appearance = require('./appearance');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = message => ({ ok: false, message });

/** A preview is transient. Every read merges it over the latest persisted config. */
function createAppearanceSession({ config, broadcast = () => {}, defer = callback => setImmediate(callback) }) {
  let preview = null;
  let revision = 0;
  const effectiveConfig = (source = config.getAll()) => {
    const current = preview ? { ...source, appearance: preview } : source;
    return { ...current, ...Appearance.appearanceConfig(current) };
  };
  const state = () => ({ ok: true, appearance: Appearance.extract(effectiveConfig()),
    presets: Appearance.normalizePresets(config.getAll().appearancePresets) });
  const cancel = ({ deferBroadcast = false } = {}) => {
    preview = null;
    const canceledRevision = ++revision;
    if (deferBroadcast) {
      // WebContents destruction runs inside Chromium's native teardown. Clear
      // the draft now, then notify surviving frames after that stack unwinds.
      defer(() => { if (revision === canceledRevision) broadcast(effectiveConfig()); });
    } else broadcast(effectiveConfig());
    return state();
  };
  return {
    effectiveConfig,
    isPreviewing: () => preview !== null,
    preview(value) {
      try {
        if (!record(value)) return failure('Choose appearance values to preview.');
        const checked = Appearance.normalize(value, { strict: true });
        revision++;
        preview = checked;
        broadcast(effectiveConfig());
        return state();
      } catch (error) { return failure(error.message); }
    },
    apply(value) {
      try {
        if (!record(value) || !record(value.appearance)) return failure('Choose appearance values to apply.');
        const appearance = Appearance.normalize(value.appearance, { strict: true });
        const patch = { appearance };
        if (Object.hasOwn(value, 'presets')) patch.appearancePresets = Appearance.normalizePresets(value.presets, { strict: true });
        // Only these validated appearance fields are saved. A stale editor can
        // never roll back a calendar preference, layout, account or shortcut.
        if (config.setMany(patch) === false) return failure('The appearance could not be saved. Check that the application data folder is writable, then try Apply again.');
        revision++;
        preview = null;
        broadcast(effectiveConfig());
        return state();
      } catch (error) { return failure(error.message); }
    },
    cancel,
  };
}

async function readPresetFile(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a JSON appearance preset file.');
    if (stat.size > Appearance.MAX_FILE_BYTES) throw new Error('This preset is too large. Appearance files must be 256 KB or smaller.');
    // A bounded read remains safe if the file changes between stat and read.
    const bytes = Buffer.alloc(Appearance.MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > Appearance.MAX_FILE_BYTES) throw new Error('This preset is too large. Appearance files must be 256 KB or smaller.');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

function registerAppearanceIpc({ ipcMain, dialog, BrowserWindow, rendererRoot, session }) {
  let owner = null;
  const allowed = event => {
    try {
      return event.senderFrame === event.sender.mainFrame
        && path.relative(rendererRoot, fileURLToPath(event.senderFrame.url)) === 'settings.html';
    } catch { return false; }
  };
  const detachOwner = () => {
    if (!owner) return;
    owner.removeListener('destroyed', abandon);
    owner.removeListener('render-process-gone', abandon);
    owner.removeListener('did-start-navigation', navigating);
    owner = null;
  };
  const abandon = () => { detachOwner(); if (session.isPreviewing()) session.cancel({ deferBroadcast: true }); };
  const navigating = (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) abandon(); };
  const editable = event => allowed(event) && (!owner || owner === event.sender);
  const attachOwner = sender => {
    if (owner === sender) return;
    detachOwner();
    owner = sender;
    owner.once('destroyed', abandon);
    owner.once('render-process-gone', abandon);
    owner.on('did-start-navigation', navigating);
  };
  ipcMain.handle('appearance:preview', (event, value) => {
    if (!editable(event)) return failure('Open Settings to edit the appearance.');
    const result = session.preview(value);
    if (result.ok) attachOwner(event.sender);
    return result;
  });
  ipcMain.handle('appearance:apply', (event, value) => {
    if (!editable(event)) return failure('Open Settings to edit the appearance.');
    const result = session.apply(value);
    if (result.ok) detachOwner();
    return result;
  });
  ipcMain.handle('appearance:cancel', event => {
    if (!editable(event)) return failure('Open Settings to edit the appearance.');
    detachOwner();
    return session.cancel();
  });
  ipcMain.handle('appearance:import', async event => {
    if (!allowed(event)) return failure('Open Settings to import an appearance preset.');
    try {
      const options = { title: 'Import appearance preset', properties: ['openFile'],
        filters: [{ name: 'Overkot appearance preset', extensions: ['json'] }] };
      const window = BrowserWindow.fromWebContents(event.sender);
      const selected = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (selected.canceled || !selected.filePaths?.[0]) return { ok: true, canceled: true };
      // Parsing never starts a preview or writes configuration. The editor
      // displays the summary, then the user chooses Preview and Apply.
      return Appearance.validateImport(await readPresetFile(selected.filePaths[0]));
    } catch (error) {
      return failure(error.message.startsWith('This preset is too large') ? error.message : 'The preset could not be read. Choose an accessible JSON file and try again.');
    }
  });
  ipcMain.handle('appearance:export', async (event, value) => {
    if (!allowed(event)) return failure('Open Settings to export an appearance preset.');
    let content, name;
    try {
      if (!record(value) || !record(value.appearance)) return failure('Choose an appearance preset to export.');
      name = Appearance.presetName(value.name);
      content = Appearance.exportPreset(name, value.appearance);
    } catch (error) { return failure(error.message); }
    try {
      const options = { title: 'Export appearance preset', defaultPath: `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')}.overkot.json`,
        filters: [{ name: 'Overkot appearance preset', extensions: ['json'] }] };
      const window = BrowserWindow.fromWebContents(event.sender);
      const selected = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (selected.canceled || !selected.filePath) return { ok: true, canceled: true };
      await fs.promises.writeFile(selected.filePath, content, 'utf8');
      return { ok: true, name };
    } catch { return failure('The preset could not be saved. Choose a writable location and try again.'); }
  });
  return { cancel: abandon };
}

module.exports = { createAppearanceSession, registerAppearanceIpc, readPresetFile };
