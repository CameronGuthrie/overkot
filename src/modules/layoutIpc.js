'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { randomUUID } = require('node:crypto');
const Layouts = require('./layouts');

const MAX_LAYOUTS = 50;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = message => ({ ok: false, message });
const tooLarge = 'This layout is too large. Layout files must be 256 KB or smaller.';

/** Bound both allocation and reads, including files that grow after stat(). */
async function readLayoutFile(file, open = fs.promises.open) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a JSON layout file.');
    if (stat.size > Layouts.MAX_FILE_BYTES) throw new Error(tooLarge);
    const bytes = Buffer.alloc(Layouts.MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > Layouts.MAX_FILE_BYTES) throw new Error(tooLarge);
    return bytes.subarray(0, total).toString('utf8').replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
}

function registerLayoutIpc({ ipcMain, dialog, BrowserWindow, rendererRoot, config,
  captureCurrent, onApply, onChanged = () => {} }) {
  const allowed = event => {
    try {
      return !event.sender.isDestroyed?.() && event.senderFrame === event.sender.mainFrame
        && path.relative(rendererRoot, fileURLToPath(event.senderFrame.url)) === 'settings.html';
    } catch { return false; }
  };
  const read = () => Layouts.normalizeSavedLayouts(config.get('savedLayouts', []));
  const state = id => {
    const layouts = read(), startup = config.get('startupLayoutId', null);
    return { ok: true, layouts, startupLayoutId: layouts.some(layout => layout.id === startup) ? startup : null, ...(id ? { id } : {}) };
  };
  const duplicateName = (list, name, exceptId) => list.some(item => item.id !== exceptId && item.name.toLowerCase() === name.toLowerCase());
  const find = id => typeof id === 'string' ? read().find(item => item.id === id) : undefined;
  const persist = (next, id, clearStartup = false) => {
    const saved = clearStartup ? config.setMany({ savedLayouts: next, startupLayoutId: null }) : config.set('savedLayouts', next);
    if (saved === false) {
      return failure('The layout could not be saved. Check that the application data folder is writable and try again.');
    }
    onChanged();
    return state(id);
  };
  const handle = (name, callback) => ipcMain.handle(`layouts:${name}`, (event, value) => {
    if (!allowed(event)) return failure('Open Settings to manage layouts.');
    try { return callback(event, value); }
    catch (error) { return failure(error.message || 'The layout could not be changed. Try again.'); }
  });

  handle('list', () => state());
  handle('startup', (_event, id) => {
    if (id !== null && !find(id)) return failure('Choose an existing saved layout or your last used arrangement for startup.');
    if (config.set('startupLayoutId', id) === false) return failure('The startup layout could not be saved. Try again.');
    onChanged();
    return state();
  });
  handle('save', (_event, value) => {
    if (!record(value)) return failure('Enter a name for this layout.');
    const name = Layouts.layoutName(value.name), list = read();
    const updating = Object.hasOwn(value, 'id');
    const existing = updating ? list.find(item => item.id === value.id) : null;
    if (updating && !existing) return failure('That saved layout is no longer available.');
    if (duplicateName(list, name, existing?.id)) return failure('A layout already has that name. Choose another name.');
    if (!updating && list.length >= MAX_LAYOUTS) return failure('You can save up to 50 layouts. Delete a layout before saving another.');
    const saved = { id: existing?.id || randomUUID(), name,
      layout: Layouts.normalizeLayout(captureCurrent(), { strict: true }) };
    return persist(existing ? list.map(item => item.id === saved.id ? saved : item) : [...list, saved], saved.id);
  });
  handle('rename', (_event, value) => {
    if (!record(value)) return failure('Choose a layout to rename.');
    const name = Layouts.layoutName(value.name), list = read();
    if (!list.some(item => item.id === value.id)) return failure('That saved layout is no longer available.');
    if (duplicateName(list, name, value.id)) return failure('A layout already has that name. Choose another name.');
    return persist(list.map(item => item.id === value.id ? { ...item, name } : item), value.id);
  });
  handle('delete', (_event, id) => {
    const list = read();
    if (!list.some(item => item.id === id)) return failure('That saved layout is no longer available.');
    return persist(list.filter(item => item.id !== id), undefined, config.get('startupLayoutId', null) === id);
  });
  handle('apply', async (_event, id) => {
    const saved = find(id);
    if (!saved) return failure('That saved layout is no longer available.');
    try {
      const applied = await onApply(saved.layout);
      if (applied === false || applied?.ok === false) return failure(applied?.message || 'The layout could not be applied. Try again.');
      onChanged();
      return state(saved.id);
    } catch { return failure('The layout could not be applied. Try again.'); }
  });
  handle('import', async event => {
    try {
      const options = { title: 'Import layout', properties: ['openFile'],
        filters: [{ name: 'Overkot layout', extensions: ['json'] }] };
      const owner = BrowserWindow.fromWebContents(event.sender);
      const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (selected.canceled || !selected.filePaths?.[0]) return { ok: true, canceled: true };
      const imported = Layouts.validateImport(await readLayoutFile(selected.filePaths[0]));
      if (!imported.ok) return imported;
      if (!allowed(event)) return failure('Open Settings to manage layouts.');
      // Other changes can finish while the dialog/read is pending. Append to
      // the latest library and keep both layouts when their names coincide.
      const list = read();
      if (list.length >= MAX_LAYOUTS) return failure('You can save up to 50 layouts. Delete a layout before importing another.');
      let name = imported.name;
      for (let suffix = 2; duplicateName(list, name); suffix++) {
        const ending = ` (${suffix})`;
        name = imported.name.slice(0, 80 - ending.length).trimEnd() + ending;
      }
      const saved = { id: randomUUID(), name, layout: imported.layout };
      // Import saves a new choice; applying it is a separate user action.
      return persist([...list, saved], saved.id);
    } catch (error) {
      return failure(error.message === tooLarge ? tooLarge : 'The layout could not be read. Choose an accessible JSON layout file and try again.');
    }
  });
  handle('export', async (event, id) => {
    const saved = find(id);
    if (!saved) return failure('That saved layout is no longer available.');
    try {
      const content = Layouts.exportLayout(saved.name, saved.layout);
      const filename = saved.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '') || 'Layout';
      const options = { title: 'Export layout', defaultPath: `${filename}.overkot-layout.json`,
        filters: [{ name: 'Overkot layout', extensions: ['json'] }] };
      const owner = BrowserWindow.fromWebContents(event.sender);
      const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (selected.canceled || !selected.filePath) return { ok: true, canceled: true };
      if (!allowed(event)) return failure('Open Settings to manage layouts.');
      await fs.promises.writeFile(selected.filePath, content, 'utf8');
      return { ...state(saved.id), name: saved.name };
    } catch { return failure('The layout could not be saved. Choose a writable location and try again.'); }
  });
}

module.exports = { registerLayoutIpc, readLayoutFile };
