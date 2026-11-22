const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { settingsWindowBounds, registerGamePathsIpc } = require('../src/modules/settingsIpc');

test('Settings bounds fit the active display and recover stale saved geometry', () => {
  const area = { x: -1280, y: 0, width: 1280, height: 720 };
  const screen = { getDisplayMatching: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area }), getCursorScreenPoint: () => ({ x: -800, y: 300 }) };
  assert.deepEqual(settingsWindowBounds(null, screen), { x: -1030, y: 35, width: 780, height: 650, minWidth: 560, minHeight: 420 });
  const saved = settingsWindowBounds({ x: 9000, y: -100, width: 2000, height: 2000 }, screen);
  assert.deepEqual(saved, { x: -1280, y: 0, width: 1280, height: 720, minWidth: 560, minHeight: 420 });
});

test('game file dialogs and saves are restricted to Settings and canceled dialogs keep configuration', async () => {
  const root = path.resolve(__dirname, '../src/renderer'), handlers = {}, values = {}, changes = [], dialogs = [];
  const event = file => ({ sender: {}, senderFrame: { url: pathToFileURL(path.join(root, file)).href } });
  const snapshot = { eeLog: { path: null }, screenshots: { path: null } };
  const resolver = { status: () => snapshot, validate: input => input?.invalid ? { ok: false, field: 'eeLogPath', message: 'Missing file' } : { ok: true, values: input } };
  registerGamePathsIpc({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, rendererRoot: root,
    BrowserWindow: { fromWebContents: () => null }, dialog: { showOpenDialog: async options => { dialogs.push(options); return { canceled: true, filePaths: [] }; } },
    config: { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } },
    getResolver: () => resolver, onChanged: change => changes.push(change) });
  assert.equal(handlers['game-paths:get'](event('index.html')).ok, false);
  assert.equal(handlers['game-paths:save'](event('../settings.html'), {}).ok, false);
  assert.deepEqual(await handlers['game-paths:choose'](event('index.html'), 'log'), { canceled: true });
  assert.equal(dialogs.length, 0);
  assert.deepEqual(await handlers['game-paths:choose'](event('settings.html'), 'screenshots'), { canceled: true });
  assert.deepEqual(dialogs[0].properties, ['openDirectory']);
  assert.deepEqual(values, {});
  assert.equal(handlers['game-paths:save'](event('settings.html'), { invalid: true }).ok, false);
  assert.deepEqual(values, {});
  assert.equal(handlers['game-paths:save'](event('settings.html'), { eeLogPath: 'test EE.log' }).ok, true);
  assert.deepEqual(values, { eeLogPath: 'test EE.log' });
  handlers['game-paths:save'](event('settings.html'), { eeLogPath: 'test EE.log' });
  assert.deepEqual(changes, [{ eeLogPath: 'test EE.log' }]);
});
