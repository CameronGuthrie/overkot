'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Layouts = require('../src/modules/layouts');
const { registerLayoutIpc, readLayoutFile } = require('../src/modules/layoutIpc');

function fixture() {
  const handlers = new Map(), dialogs = [], writes = [], changed = [], applied = [];
  const data = { savedLayouts: [], accountId: 'private-account', eeLogPath: 'private-game-log', interactionHotkey: 'Alt+F1' };
  const current = { dockEdge: 'left', dockAutoHide: true, dockWidgetOrder: ['minimap', 'boss'],
    widgetVisibility: { minimap: true, boss: true }, widgetOpen: { minimap: true }, widgetDocked: { minimap: false },
    widgetBounds: { minimap: { x: -650, y: 120, width: 400, height: 300 } },
    display: { x: -1920, y: 0, width: 1920, height: 1080 }, accountId: 'never-export-me' };
  let writable = true, applyResult = true, open = { canceled: true }, save = { canceled: true };
  const rendererRoot = path.resolve(__dirname, '../src/renderer');
  const sender = { mainFrame: { url: pathToFileURL(path.join(rendererRoot, 'settings.html')).href }, isDestroyed: () => false };
  const event = { sender, senderFrame: sender.mainFrame }, owner = { id: 'settings-window' };
  registerLayoutIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, rendererRoot,
    BrowserWindow: { fromWebContents: contents => contents === sender ? owner : null },
    dialog: { async showOpenDialog(...args) { dialogs.push(['open', args]); return typeof open === 'function' ? open() : open; },
      async showSaveDialog(...args) { dialogs.push(['save', args]); return typeof save === 'function' ? save() : save; } },
    config: { get: (key, fallback) => data[key] ?? fallback, setMany(patch) {
      if (!writable) return false;
      writes.push(['transaction', structuredClone(patch)]); Object.assign(data, structuredClone(patch)); return true;
    }, set(key, value) {
      if (!writable) return false;
      writes.push([key, structuredClone(value)]); data[key] = structuredClone(value); return true;
    } },
    captureCurrent: () => structuredClone(current),
    onApply: layout => { applied.push(structuredClone(layout)); return applyResult; },
    onChanged: () => changed.push(structuredClone(data)),
  });
  return { data, current, dialogs, writes, changed, applied, event, sender, owner,
    invoke: (name, value, override = event) => handlers.get(`layouts:${name}`)(override, value),
    writable(value) { writable = value; }, applyResult(value) { applyResult = value; },
    chooseOpen(value) { open = value; }, chooseSave(value) { save = value; } };
}

function files(t) {
  const base = path.join(os.tmpdir(), 'overkot-layout-ipc-');
  const directory = fs.mkdtempSync(base);
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('overkot-layout-ipc-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return name => path.join(directory, name);
}

test('every layout endpoint accepts only the Settings main frame', async () => {
  const f = fixture();
  for (const [name, value] of [['list'], ['save', { name: 'Moss' }], ['rename', { id: 'x', name: 'Moss' }],
    ['delete', 'x'], ['apply', 'x'], ['startup', null], ['import'], ['export', 'x']]) {
    for (const override of [
      { ...f.event, senderFrame: { url: f.event.senderFrame.url } },
      { sender: { mainFrame: { url: 'https://untrusted.example/settings.html' } }, senderFrame: null },
    ]) assert.equal((await f.invoke(name, value, override)).ok, false, name);
  }
  f.sender.mainFrame.url = pathToFileURL(path.resolve(__dirname, '../src/renderer/widget-host.html')).href;
  assert.equal((await f.invoke('save', { name: 'Moss' })).ok, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.applied.length, 0);
});

test('startup selection is validated, persisted separately and never applies immediately', async () => {
  const f = fixture(), saved = await f.invoke('save', { name: 'Exploring' });
  assert.equal((await f.invoke('list')).startupLayoutId, null);
  const selected = await f.invoke('startup', saved.id);
  assert.equal(selected.ok, true); assert.equal(selected.startupLayoutId, saved.id);
  assert.equal(f.data.startupLayoutId, saved.id); assert.equal(f.applied.length, 0);
  for (const bad of ['missing', '', undefined, {}, 5]) assert.equal((await f.invoke('startup', bad)).ok, false);
  assert.equal(f.data.startupLayoutId, saved.id);
  const before = structuredClone(f.data), notifications = f.changed.length;
  f.writable(false);
  assert.equal((await f.invoke('startup', null)).ok, false);
  assert.deepEqual(f.data, before); assert.equal(f.changed.length, notifications);
  f.writable(true);
  assert.equal((await f.invoke('startup', null)).startupLayoutId, null);
  assert.equal(f.data.startupLayoutId, null);
});

test('deleting the startup layout clears its selection in the same successful transaction', async () => {
  const f = fixture(), first = await f.invoke('save', { name: 'Exploring' });
  const second = await f.invoke('save', { name: 'Trading' });
  await f.invoke('startup', first.id);
  const before = structuredClone(f.data), writes = f.writes.length;
  f.writable(false);
  assert.equal((await f.invoke('delete', first.id)).ok, false);
  assert.deepEqual(f.data, before); assert.equal(f.writes.length, writes);
  f.writable(true);
  const deleted = await f.invoke('delete', first.id);
  assert.equal(deleted.startupLayoutId, null);
  assert.deepEqual(deleted.layouts.map(item => item.id), [second.id]);
  assert.deepEqual(f.writes.at(-1), ['transaction', { savedLayouts: f.data.savedLayouts, startupLayoutId: null }]);
  assert.equal(f.applied.length, 0);
});

test('save captures the current arrangement, updates by ID and never accepts renderer-supplied layout data', async () => {
  const f = fixture();
  const saved = await f.invoke('save', { name: '  Exploration  ', layout: { dockEdge: 'right' }, accountId: 'injected' });
  assert.equal(saved.ok, true);
  assert.equal(saved.layouts.length, 1);
  assert.equal(saved.layouts[0].name, 'Exploration');
  assert.equal(saved.layouts[0].layout.dockEdge, 'left');
  assert.deepEqual(saved.layouts[0].layout.widgetBounds.minimap, f.current.widgetBounds.minimap);
  assert.doesNotMatch(JSON.stringify(saved.layouts), /accountId|never-export-me|private-game-log/);
  assert.equal(f.data.accountId, 'private-account');
  assert.equal(f.data.interactionHotkey, 'Alt+F1');
  f.current.dockEdge = 'top';
  const updated = await f.invoke('save', { id: saved.id, name: 'Exploration' });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.layouts.length, 1);
  assert.equal(updated.layouts[0].layout.dockEdge, 'top');
  assert.equal(f.changed.length, 2);
  assert.ok(f.writes.every(([key]) => key === 'savedLayouts'));
  assert.equal((await f.invoke('save', { id: 'removed', name: 'New' })).ok, false);
  assert.equal((await f.invoke('save', { name: 'EXPLORATION' })).ok, false);
  assert.equal((await f.invoke('save', { name: '\n' })).ok, false);
  assert.equal((await f.invoke('save', { name: 'x'.repeat(81) })).ok, false);
});

test('renaming and deleting saved choices preserve the live arrangement and reject duplicate or stale IDs', async () => {
  const f = fixture();
  const first = await f.invoke('save', { name: 'Exploration' });
  const second = await f.invoke('save', { name: 'Arena' });
  const renamed = await f.invoke('rename', { id: first.id, name: 'Dungeon' });
  assert.equal(renamed.layouts.find(item => item.id === first.id).name, 'Dungeon');
  assert.equal((await f.invoke('rename', { id: first.id, name: 'ARENA' })).ok, false);
  assert.equal((await f.invoke('rename', { id: 'missing', name: 'Unknown' })).ok, false);
  const deleted = await f.invoke('delete', first.id);
  assert.deepEqual(deleted.layouts.map(item => item.id), [second.id]);
  assert.equal((await f.invoke('delete', first.id)).ok, false);
  assert.equal(f.applied.length, 0);
  assert.equal(f.current.dockEdge, 'left');
});

test('failed storage leaves the saved library and notifications unchanged for save, rename and delete', async () => {
  const f = fixture();
  const saved = await f.invoke('save', { name: 'Exploration' });
  const before = structuredClone(f.data), notifications = f.changed.length;
  f.writable(false);
  for (const [name, value] of [['save', { name: 'Arena' }], ['save', { id: saved.id, name: 'Exploration' }],
    ['rename', { id: saved.id, name: 'Changed' }], ['delete', saved.id]]) {
    const result = await f.invoke(name, value);
    assert.equal(result.ok, false, name);
    assert.match(result.message, /could not be saved/);
    assert.deepEqual(f.data, before);
    assert.equal(f.changed.length, notifications);
  }
});

test('Apply uses a stored validated layout and reports live-application failures', async () => {
  const f = fixture();
  const saved = await f.invoke('save', { name: 'Exploration' });
  const before = structuredClone(f.data), notifications = f.changed.length;
  assert.equal((await f.invoke('apply', 'missing')).ok, false);
  assert.equal(f.applied.length, 0);
  assert.equal((await f.invoke('apply', saved.id)).ok, true);
  assert.deepEqual(f.applied[0], saved.layouts[0].layout);
  assert.deepEqual(f.data, before, 'Apply does not rewrite saved choices or unrelated preferences');
  assert.equal(f.changed.length, notifications + 1);
  f.applyResult(false);
  assert.equal((await f.invoke('apply', saved.id)).ok, false);
  f.applyResult(Promise.reject(new Error('Native window unavailable')));
  assert.equal((await f.invoke('apply', saved.id)).ok, false);
  assert.equal(f.changed.length, notifications + 1);
});

test('native export round-trips arrangement data; import appends a uniquely named choice without applying it', async t => {
  const file = files(t)('exploration.json'), f = fixture();
  const first = await f.invoke('save', { name: 'Exploration' });
  assert.deepEqual(await f.invoke('import'), { ok: true, canceled: true });
  assert.deepEqual(await f.invoke('export', first.id), { ok: true, canceled: true });
  f.chooseSave({ canceled: false, filePath: file });
  assert.equal((await f.invoke('export', first.id)).ok, true);
  const exported = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(exported, /accountId|private-account|eeLogPath|private-game-log|interactionHotkey|never-export-me/);
  assert.equal(JSON.parse(exported).format, 'overkot-layout');
  const saveDialog = f.dialogs.filter(([kind]) => kind === 'save').at(-1)[1];
  assert.equal(saveDialog[0], f.owner);
  assert.match(saveDialog[1].defaultPath, /\.overkot-layout\.json$/);
  f.chooseOpen({ canceled: false, filePaths: [file] });
  const imported = await f.invoke('import');
  assert.equal(imported.ok, true);
  assert.equal(imported.layouts.length, 2);
  assert.notEqual(imported.id, first.id);
  assert.equal(imported.layouts[1].name, 'Exploration (2)');
  assert.deepEqual(imported.layouts[1].layout, first.layouts[0].layout);
  assert.equal(f.applied.length, 0);
});

test('bad, oversized, missing and non-file imports never change the library', async t => {
  const file = files(t), f = fixture();
  const invalid = file('invalid.json'), oversized = file('large.json'), version = file('future.json');
  fs.writeFileSync(invalid, '{broken');
  fs.writeFileSync(oversized, ' '.repeat(Layouts.MAX_FILE_BYTES + 1));
  fs.writeFileSync(version, JSON.stringify({ format: 'overkot-layout', version: 999, name: 'Future', layout: f.current }));
  const before = structuredClone(f.data);
  for (const selected of [invalid, oversized, version, file('missing.json'), path.dirname(invalid)]) {
    f.chooseOpen({ canceled: false, filePaths: [selected] });
    assert.equal((await f.invoke('import')).ok, false, selected);
    assert.deepEqual(f.data, before);
  }
  assert.equal(f.changed.length, 0);
  assert.equal(f.applied.length, 0);
});

test('imports reconcile library changes made while a native dialog is open and honor failed writes', async t => {
  const file = files(t)('layout.json'), f = fixture();
  fs.writeFileSync(file, Layouts.exportLayout('Exploration', f.current));
  let finishDialog;
  f.chooseOpen(() => new Promise(resolve => { finishDialog = resolve; }));
  const pending = f.invoke('import');
  const concurrent = await f.invoke('save', { name: 'Exploration' });
  finishDialog({ canceled: false, filePaths: [file] });
  const imported = await pending;
  assert.equal(imported.layouts.length, 2);
  assert.equal(imported.layouts[0].id, concurrent.id);
  assert.equal(imported.layouts[1].name, 'Exploration (2)');
  const before = structuredClone(f.data), notifications = f.changed.length;
  f.chooseOpen({ canceled: false, filePaths: [file] });
  f.writable(false);
  assert.equal((await f.invoke('import')).ok, false);
  assert.deepEqual(f.data, before);
  assert.equal(f.changed.length, notifications);
});

test('a closed or navigated Settings dialog cannot finish an import or export', async t => {
  const file = files(t)('layout.json');
  for (const action of ['import', 'export']) {
    const f = fixture();
    const saved = await f.invoke('save', { name: 'Exploration' });
    fs.writeFileSync(file, Layouts.exportLayout('Exploration', f.current));
    let finishDialog;
    const deferred = () => new Promise(resolve => { finishDialog = resolve; });
    if (action === 'import') f.chooseOpen(deferred); else f.chooseSave(deferred);
    const before = structuredClone(f.data), beforeFile = fs.readFileSync(file, 'utf8');
    const pending = f.invoke(action, saved.id);
    f.sender.mainFrame.url = 'https://untrusted.example';
    finishDialog({ canceled: false, filePaths: [file], filePath: file });
    assert.equal((await pending).ok, false);
    assert.deepEqual(f.data, before);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
  }
});

test('the 50-layout limit applies to saves and imports without deleting existing choices', async t => {
  const f = fixture(), file = files(t)('layout.json');
  const layout = Layouts.normalizeLayout(f.current);
  f.data.savedLayouts = Array.from({ length: 50 }, (_, index) => ({ id: `layout-${index}`, name: `Layout ${index}`, layout }));
  const before = structuredClone(f.data);
  assert.equal((await f.invoke('save', { name: 'One more' })).ok, false);
  fs.writeFileSync(file, Layouts.exportLayout('One more', layout));
  f.chooseOpen({ canceled: false, filePaths: [file] });
  assert.equal((await f.invoke('import')).ok, false);
  assert.deepEqual(f.data, before);
  assert.equal(f.changed.length, 0);
});

test('bounded layout reads handle partial reads, growth, non-files and always close the handle', async () => {
  const content = Buffer.from('\uFEFF{"name":"Dungeon"}');
  let closed = 0;
  const open = async () => ({ stat: async () => ({ size: content.length, isFile: () => true }),
    read: async (buffer, offset, length, position) => {
      const count = Math.min(3, length, content.length - position);
      if (count > 0) content.copy(buffer, offset, position, position + count);
      return { bytesRead: count };
    }, close: async () => { closed++; } });
  assert.equal(await readLayoutFile('partial', open), '{"name":"Dungeon"}');
  assert.equal(closed, 1);
  for (const mode of ['stat-large', 'growing', 'directory', 'read-error']) {
    let reads = 0;
    const handle = { stat: async () => ({ size: mode === 'stat-large' ? Layouts.MAX_FILE_BYTES + 1 : 1,
      isFile: () => mode !== 'directory' }),
    read: async (_buffer, _offset, length) => { reads++; if (mode === 'read-error') throw new Error('read failed'); return { bytesRead: length }; },
    close: async () => { closed++; } };
    await assert.rejects(readLayoutFile(mode, async () => handle), mode === 'read-error' ? /read failed/ : mode === 'directory' ? /JSON layout/ : /too large/);
    if (mode === 'stat-large' || mode === 'directory') assert.equal(reads, 0);
  }
  assert.equal(closed, 5);
});
