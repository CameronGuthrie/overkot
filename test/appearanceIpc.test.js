'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const Appearance = require('../src/modules/appearance');
const { getLocaleTag } = require('../src/modules/localization');
const { createAppearanceSession, registerAppearanceIpc, readPresetFile } = require('../src/modules/appearanceIpc');

function fixture(options = {}) {
  const data = { appearance: Appearance.extract({ theme: 'ember', backgroundOpacity: 73 }), appearancePresets: [],
    language: 'en', widgetOpen: { boss: true }, accountId: 'private-account' };
  const broadcasts = [], writes = [];
  let writable = true;
  const config = { getAll: () => ({ ...data }), setMany(patch) {
    if (!writable) return false;
    writes.push(structuredClone(patch)); Object.assign(data, patch); return true;
  } };
  const session = createAppearanceSession({ config, ...options, broadcast: value => { options.broadcast?.(value); broadcasts.push(value); } });
  return { session, config, data, broadcasts, writes, setWritable(value) { writable = value; } };
}

test('preview is transient; cancel restores the latest appearance and retains concurrent unrelated writes', () => {
  const f = fixture(), original = structuredClone(f.data.appearance);
  assert.equal(f.session.preview(Appearance.builtins.obsidian.appearance).ok, true);
  assert.equal(f.session.effectiveConfig().appearance.global.cornerRadius, 0);
  assert.equal(f.session.effectiveConfig().theme, 'midnight');
  assert.deepEqual(f.data.appearance, original);
  assert.equal(f.writes.length, 0);
  f.config.setMany({ language: 'de', widgetOpen: { boss: false, crafting: true }, automaticUpdates: false });
  assert.equal(f.session.effectiveConfig().language, 'de');
  assert.equal(f.session.effectiveConfig().appearance.global.cornerRadius, 0);
  f.session.cancel();
  assert.equal(f.session.isPreviewing(), false);
  assert.deepEqual(f.session.effectiveConfig().appearance, original);
  assert.equal(f.session.effectiveConfig().language, 'de');
  assert.deepEqual(f.data.widgetOpen, { boss: false, crafting: true });
  assert.equal(f.broadcasts.length, 2);
});

test('Apply saves only appearance and the optional library, preserves zero values and reports storage failure', () => {
  const f = fixture();
  const appearance = Appearance.normalize({ base: 'dark-mint', global: { cornerRadius: 0, borderWidth: 0 }, widgets: { boss: { borderOpacity: 0 } } });
  f.session.preview(appearance);
  f.config.setMany({ language: 'fr', dockEdge: 'left' });
  f.setWritable(false);
  const failed = f.session.apply({ appearance, presets: [] });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /could not be saved/);
  assert.equal(f.session.isPreviewing(), true, 'A failed Apply must retain the draft and preview');
  assert.equal(f.data.appearance.base, 'ember');
  f.setWritable(true);
  const presets = [{ id: 'style-copy', name: 'Sharp moss', appearance }];
  const applied = f.session.apply({ appearance, presets, language: 'stale', accountId: 'must-not-write' });
  assert.equal(applied.ok, true);
  assert.equal(f.session.isPreviewing(), false);
  assert.equal(f.data.language, 'fr');
  assert.equal(f.data.dockEdge, 'left');
  assert.equal(f.data.accountId, 'private-account');
  assert.deepEqual(Object.keys(f.writes.at(-1)), ['appearance', 'appearancePresets']);
  assert.equal(f.data.appearance.global.cornerRadius, 0);
  assert.equal(f.data.appearance.global.borderWidth, 0);
  assert.equal(f.data.appearance.widgets.boss.borderOpacity, 0);
  assert.deepEqual(f.data.appearancePresets, presets);
});

test('invalid preview or library rejects the transaction without discarding a valid draft', () => {
  const f = fixture();
  f.session.preview(Appearance.builtins.grove.appearance);
  assert.equal(f.session.preview({ global: { borderWidth: 50 } }).ok, false);
  assert.equal(f.session.effectiveConfig().appearance.base, 'dark-mint');
  const result = f.session.apply({ appearance: Appearance.builtins.obsidian.appearance, presets: [{ id: 'broken', name: 'Broken' }] });
  assert.equal(result.ok, false);
  assert.equal(f.session.effectiveConfig().appearance.base, 'dark-mint');
  assert.equal(f.data.appearance.base, 'ember');
  assert.equal(f.writes.length, 0);
});

function ipcFixture(options) {
  const f = fixture(options), handlers = new Map(), dialogs = [];
  const rendererRoot = path.resolve(__dirname, '../src/renderer');
  const sender = new EventEmitter();
  sender.mainFrame = { url: pathToFileURL(path.join(rendererRoot, 'settings.html')).href };
  const event = { sender, senderFrame: sender.mainFrame };
  let open = { canceled: true }, save = { canceled: true };
  registerAppearanceIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: { async showOpenDialog(...args) { dialogs.push(['open', args]); return open; },
      async showSaveDialog(...args) { dialogs.push(['save', args]); return save; } },
    BrowserWindow: { fromWebContents: () => null }, rendererRoot, session: f.session });
  return { ...f, event, sender, handlers, dialogs, invoke: (name, data, override) => handlers.get(`appearance:${name}`)(override || event, data),
    chooseOpen(value) { open = value; }, chooseSave(value) { save = value; } };
}

test('appearance IPC accepts only the trusted Settings main frame and releases previews on close, crash or reload', () => {
  const f = ipcFixture();
  assert.equal(f.invoke('preview', Appearance.builtins.grove.appearance, { ...f.event, senderFrame: { url: f.event.senderFrame.url } }).ok, false);
  f.sender.mainFrame.url = pathToFileURL(path.resolve(__dirname, '../src/renderer/widget-host.html')).href;
  assert.equal(f.invoke('preview', Appearance.builtins.grove.appearance).ok, false);
  f.sender.mainFrame.url = pathToFileURL(path.resolve(__dirname, '../src/renderer/settings.html')).href;
  for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
    assert.equal(f.invoke('preview', Appearance.builtins.grove.appearance).ok, true);
    assert.equal(f.sender.listenerCount('destroyed'), 1);
    if (event === 'did-start-navigation') f.sender.emit(event, {}, 'file:///other', false, true);
    else f.sender.emit(event);
    assert.equal(f.session.isPreviewing(), false, event);
    assert.equal(f.session.effectiveConfig().appearance.base, 'ember');
    assert.equal(f.sender.listenerCount('destroyed'), 0, 'Preview listeners are cleaned up');
  }
  f.invoke('preview', Appearance.builtins.obsidian.appearance);
  f.invoke('apply', { appearance: Appearance.builtins.obsidian.appearance });
  assert.equal(f.sender.listenerCount('destroyed'), 0);
  f.invoke('preview', Appearance.builtins.grove.appearance);
  f.invoke('cancel');
  assert.equal(f.sender.listenerCount('destroyed'), 0);
});

test('closing a preview owner clears its draft before deferring broadcasts beyond native teardown', () => {
  const pending = [];
  let destroying = false;
  const f = ipcFixture({ defer: callback => pending.push(callback), broadcast() {
    assert.equal(destroying, false, 'Never send to Chromium frames from a destruction listener');
  } });
  f.invoke('preview', Appearance.builtins.grove.appearance);
  destroying = true;
  assert.doesNotThrow(() => f.sender.emit('destroyed'));
  assert.equal(f.session.isPreviewing(), false, 'Cancellation is synchronous even though repaint is deferred');
  assert.equal(f.session.effectiveConfig().appearance.base, 'ember');
  assert.equal(f.broadcasts.length, 1, 'Native teardown does not synchronously enumerate or message frames');
  assert.equal(f.sender.listenerCount('destroyed'), 0);
  destroying = false;
  pending.shift()();
  assert.equal(f.broadcasts.length, 2);
  assert.equal(f.broadcasts.at(-1).appearance.base, 'ember');
});

test('a queued owner-close repaint cannot overwrite a newer preview or applied style', () => {
  const pending = [], f = ipcFixture({ defer: callback => pending.push(callback) });
  f.invoke('preview', Appearance.builtins.grove.appearance);
  f.sender.emit('destroyed');
  f.invoke('preview', Appearance.builtins.obsidian.appearance);
  const count = f.broadcasts.length;
  pending.shift()();
  assert.equal(f.broadcasts.length, count, 'A new preview invalidates the old close notification');
  assert.equal(f.session.isPreviewing(), true);
  assert.equal(f.session.effectiveConfig().appearance.base, 'midnight');
  f.sender.emit('destroyed');
  f.invoke('apply', { appearance: Appearance.builtins.grove.appearance });
  const appliedCount = f.broadcasts.length;
  pending.shift()();
  assert.equal(f.broadcasts.length, appliedCount);
  assert.equal(f.session.effectiveConfig().appearance.base, 'dark-mint');
});

test('native import validates before preview; export and import preserve visual data and exclude private state', async t => {
  const root = path.resolve(__dirname, '../.build/appearance-file-tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'fixture-'));
  t.after(() => { assert.equal(path.dirname(dir), root); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'style.json'), invalid = path.join(dir, 'invalid.json'), oversized = path.join(dir, 'oversized.json');
  const f = ipcFixture(), original = structuredClone(f.data);
  assert.deepEqual(await f.invoke('import'), { ok: true, canceled: true });
  assert.deepEqual(await f.invoke('export', { name: 'Moss', appearance: Appearance.builtins.grove.appearance }), { ok: true, canceled: true });
  f.chooseSave({ canceled: false, filePath: file });
  assert.equal((await f.invoke('export', { name: 'Moss', appearance: Appearance.builtins.grove.appearance, accountId: 'never-exported' })).ok, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /accountId|private-account|never-exported/);
  f.chooseOpen({ canceled: false, filePaths: [file] });
  const imported = await f.invoke('import');
  assert.equal(imported.ok, true);
  assert.equal(imported.preset.name, 'Moss');
  assert.deepEqual(imported.preset.appearance, Appearance.builtins.grove.appearance);
  assert.equal(f.session.isPreviewing(), false, 'A valid import must wait for user Preview and Apply');
  assert.deepEqual(f.data, original);
  fs.writeFileSync(invalid, '{not json');
  f.chooseOpen({ canceled: false, filePaths: [invalid] });
  assert.match((await f.invoke('import')).message, /not valid JSON/);
  fs.writeFileSync(oversized, ' '.repeat(Appearance.MAX_FILE_BYTES + 1));
  f.chooseOpen({ canceled: false, filePaths: [oversized] });
  assert.match((await f.invoke('import')).message, /too large/);
  await assert.rejects(readPresetFile(oversized), /too large/);
  f.chooseOpen({ canceled: false, filePaths: [path.join(dir, 'missing')] });
  assert.match((await f.invoke('import')).message, /could not be read/);
  f.chooseSave({ canceled: false, filePath: dir });
  assert.match((await f.invoke('export', { name: 'Moss', appearance: Appearance.builtins.grove.appearance })).message, /could not be saved/);
  assert.deepEqual(f.data, original, 'Failed imports and exports leave the active appearance unchanged');
});

test('all native frames receive shape, outline and motion fields from one appearance broadcast allowlist', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8');
  const f = fixture(), messages = [];
  f.data.language = 'tc';
  f.session.preview(Appearance.normalize({ global: { cornerShape: 'sharp', cornerRadius: 0, borderWidth: 0, widgetOutlineOpacity: 0, motionLevel: 'off' }, widgets: { boss: { cornerShape: 'pill' } } }));
  const frame = id => ({ send(channel, value) { messages.push({ id, channel, value }); } });
  const windows = [{ isDestroyed: () => false, webContents: { mainFrame: { framesInSubtree: [frame('window'), frame('embedded')] } } },
    { isDestroyed: () => true, webContents: { mainFrame: { framesInSubtree: [frame('destroyed')] } } }];
  const context = vm.createContext({ Appearance, getLocaleTag, appearanceSession: f.session, BrowserWindow: { getAllWindows: () => windows } });
  vm.runInContext(main.slice(main.indexOf('function appearanceFrames('), main.indexOf('let calendarAccountId')), context);
  vm.runInContext('broadcastAppearance()', context);
  assert.equal(messages.length, 4);
  for (const message of messages) {
    assert.equal(message.value.appearance.global.cornerRadius, 0);
    assert.equal(message.value.appearance.global.borderWidth, 0);
    assert.equal(message.value.appearance.global.motionLevel, 'off');
    assert.equal(message.value.widgetOutlineOpacity, 0);
    if (message.channel === 'theme-changed') {
      assert.equal(Object.hasOwn(message.value, 'accountId'), false);
      assert.equal(message.value.locale, 'zh-Hant-TW');
    }
  }
});

test('appearance broadcasts skip destroyed contents and detached frame trees without losing live recipients', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8');
  const f = fixture(), received = [];
  const live = { send: (channel, value) => received.push({ channel, value }) };
  const closedFrame = { send() { throw new Error('Frame detached during send'); } };
  const windows = [
    { isDestroyed: () => false, webContents: { isDestroyed: () => true, get mainFrame() { assert.fail('Destroyed contents must not enumerate frames'); } } },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, get mainFrame() { throw new Error('Frame tree is detached'); } } },
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: { framesInSubtree: [closedFrame, live] } } },
  ];
  const context = vm.createContext({ Appearance, getLocaleTag, appearanceSession: f.session, BrowserWindow: { getAllWindows: () => windows } });
  vm.runInContext(main.slice(main.indexOf('function appearanceFrames('), main.indexOf('let calendarAccountId')), context);
  assert.doesNotThrow(() => vm.runInContext('broadcastAppearance()', context));
  assert.deepEqual(received.map(value => value.channel), ['theme-changed', 'config-changed']);
  assert.equal(received[0].value.appearance.base, 'ember');
});

test('preload invokes the dedicated validated appearance endpoints', () => {
  const exposed = {}, invoked = [];
  const context = vm.createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
    ipcRenderer: { sendSync: () => ({}), invoke: (...args) => { invoked.push(args); }, on() {}, send() {} } }) });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/preload.js'), 'utf8'), context);
  const appearance = Appearance.builtins.obsidian.appearance;
  exposed.api.appearancePreview(appearance);
  exposed.api.appearanceApply({ appearance, presets: [] });
  exposed.api.appearanceCancel();
  exposed.api.appearanceImport();
  exposed.api.appearanceExport({ name: 'Square', appearance });
  assert.deepEqual(invoked.map(args => args[0]), ['appearance:preview', 'appearance:apply', 'appearance:cancel', 'appearance:import', 'appearance:export']);
  assert.equal(invoked[0][1], appearance);
});
