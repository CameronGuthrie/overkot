// Uses the packaged renderer/preload with synthetic accounts and no network.
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, [], 30000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
const output = fs.mkdtempSync(path.join(root, 'output/group-identity-'));
app.setPath('userData', path.join(output, 'profile'));
const base = require('../src/modules/groupFinderService').getState();
let state = { ...base, playerId: 'a'.repeat(24), displayName: 'FirstEnvoy' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(50); }
  throw new Error('Group Finder UI did not update');
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const { createHeadersHandler } = require('../src/modules/guard');
  session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
  ipcMain.on('get-i18n', event => { event.returnValue = { translations: { en: JSON.parse(fs.readFileSync(path.join(archive, 'langs/en.json'), 'utf8')) }, languages: [] }; });
  ipcMain.handle('get-state', () => ({ config: { language: 'en' } }));
  ipcMain.handle('gf:get-state', () => state);
  ipcMain.handle('gf:get-suggestions', () => []);
  ipcMain.handle('gf:get-profile', async () => {
    const captured = state;
    await pause(300);
    return { id: captured.playerId, displayName: 'OldStoredName' };
  });
  const win = new BrowserWindow({ show: false, width: 950, height: 700, webPreferences: {
    preload: path.join(archive, 'src/preload.js'), contextIsolation: true, nodeIntegration: false,
  } });
  const errors = [];
  win.webContents.on('console-message', ({ message }) => {
    if (/Uncaught|ReferenceError|TypeError/.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(archive, 'src/renderer/group-finder.html'));
  const names = () => win.webContents.executeJavaScript("[document.getElementById('gf-home-name').textContent,document.getElementById('gf-profile-name').value]");
  await until(async () => (await names())[0] === 'FirstEnvoy');
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('gf-home-group').textContent"), 'Solo (1/4)');
  assert.deepEqual(await win.webContents.executeJavaScript("Array.from(document.getElementById('gf-create-slots').options, option => option.value)"), ['1', '2', '3']);
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('gf-create-slots').value"), '3');
  state = { ...base, playerId: 'b'.repeat(24), displayName: 'SecondEnvoy' };
  win.webContents.send('gf:state-update', state);
  await pause(500);
  assert.deepEqual(await names(), ['SecondEnvoy', 'SecondEnvoy']);
  state = { ...base, playerId: null, displayName: null };
  win.webContents.send('gf:state-update', state);
  await until(async () => (await names())[1] === '');
  assert.ok(!(await names()).includes('SecondEnvoy'));
  assert.deepEqual(errors, []);
  console.log('Packaged Group Finder: four-player capacity, account switch, stale profile response and logout name checks passed.');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
