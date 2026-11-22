'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

function settingsWindowBounds(saved, screen) {
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))
    && saved.width > 0 && saved.height > 0;
  const area = valid ? screen.getDisplayMatching(saved).workArea
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const minWidth = Math.min(560, area.width), minHeight = Math.min(420, area.height);
  const width = Math.round(Math.min(area.width, Math.max(minWidth, valid ? saved.width : 780)));
  const height = Math.round(Math.min(area.height, Math.max(minHeight, valid ? saved.height : 650)));
  return { width, height, minWidth, minHeight,
    x: Math.round(Math.max(area.x, Math.min(valid ? saved.x : area.x + (area.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(valid ? saved.y : area.y + (area.height - height) / 2, area.y + area.height - height))) };
}

function registerGamePathsIpc({ ipcMain, dialog, BrowserWindow, rendererRoot, getResolver, config, onChanged = () => {} }) {
  const allowed = event => {
    try { return path.relative(rendererRoot, fileURLToPath(event.senderFrame.url)) === 'settings.html'; }
    catch { return false; }
  };
  const failure = message => ({ ok: false, message });
  ipcMain.handle('game-paths:get', event => allowed(event) ? getResolver().status() : failure('Open Settings to configure game files.'));
  ipcMain.handle('game-paths:choose', async (event, kind) => {
    if (!allowed(event) || !['log', 'screenshots'].includes(kind)) return { canceled: true };
    const state = getResolver().status();
    const current = kind === 'log' ? state.eeLog : state.screenshots;
    const options = { title: kind === 'log' ? 'Choose Soulframe EE.log' : 'Choose Soulframe screenshot folder',
      properties: [kind === 'log' ? 'openFile' : 'openDirectory'],
      ...(current.path ? { defaultPath: current.path } : {}),
      ...(kind === 'log' ? { filters: [{ name: 'Soulframe log', extensions: ['log'] }] } : {}) };
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled || !result.filePaths[0] ? { canceled: true } : { canceled: false, path: result.filePaths[0] };
    } catch { return { canceled: true }; }
  });
  ipcMain.handle('game-paths:save', (event, values) => {
    if (!allowed(event)) return failure('Open Settings to configure game files.');
    const checked = getResolver().validate(values);
    if (!checked.ok) return checked;
    const changed = {};
    for (const [key, value] of Object.entries(checked.values)) {
      if (config.get(key, '') !== value) { config.set(key, value); changed[key] = value; }
    }
    if (Object.keys(changed).length) onChanged(changed);
    return { ok: true, paths: getResolver().status() };
  });
}

module.exports = { settingsWindowBounds, registerGamePathsIpc };
