'use strict';
// Actual update renderer/preload with synthetic states. No network or installer runs.
if (!process.versions.electron) {
  const args = process.argv.slice(2), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = args.includes('--source')
    ? require('node:child_process').spawnSync(require('electron'), [__filename, ...args], { env, stdio: 'inherit', windowsHide: true, timeout: 40000 })
    : require('./run-packaged-check').runPackagedCheck(__filename, args, 40000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), source = process.argv.includes('--source');
const appRoot = source ? root : path.join(process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist', 'win-unpacked'), 'resources', 'app.asar');
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, 'output', `update-check-${source ? 'source' : 'packaged'}-`));
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await pause(40); }
  throw new Error('Update UI did not settle: ' + label);
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_event, done) => done({ cancel: true }));
  session.defaultSession.webRequest.onHeadersReceived(require('../src/modules/guard').createHeadersHandler(path.join(appRoot, 'src', 'renderer')));
  const english = JSON.parse(fs.readFileSync(path.join(appRoot, 'langs', 'en.json'), 'utf8'));
  ipcMain.on('get-i18n', event => { event.returnValue = { translations: { en: english }, languages: [] }; });
  const actions = [], errors = [], captures = [];
  let state = { supported: true, automatic: false, currentVersion: '0.0.14', version: '0.0.15', phase: 'available', percent: 0,
    changes: ['Choose the monitor for your Overkot bar.', '<img src=x onerror="throw new Error(123)">'] };
  let finishDownload, finishInstall;
  let win;
  const emit = patch => { state = { ...state, ...patch }; win.webContents.send('updates:changed', state); };
  ipcMain.handle('get-state', () => ({ config: { language: 'en', theme: 'classic' }, platformSupport: { platform: 'win32' } }));
  ipcMain.handle('updates:state', () => state);
  ipcMain.handle('updates:check', () => { actions.push('check'); return state; });
  ipcMain.handle('updates:download', () => {
    actions.push('download'); emit({ phase: 'downloading', percent: 0 });
    return new Promise(resolve => { finishDownload = resolve; });
  });
  ipcMain.handle('updates:install', () => {
    actions.push('install'); emit({ phase: 'installing' });
    return new Promise(resolve => { finishInstall = resolve; });
  });
  ipcMain.on('updates:installer', () => actions.push('installer'));
  ipcMain.on('window-close', () => actions.push('close'));
  win = new BrowserWindow({ show: false, frame: false, width: 540, height: 600,
    webPreferences: { preload: path.join(appRoot, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', ({ message }) => { if (/Uncaught|ReferenceError|TypeError|Error invoking/.test(message)) errors.push(message); });
  const evaluate = script => win.webContents.executeJavaScript(script);
  const capture = async name => {
    // Let native progress paint and its short width transition reach this state.
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await pause(230);
    const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); captures.push(file);
  };
  await win.loadFile(path.join(appRoot, 'src', 'renderer', 'update-window.html'));
  await until(async () => await evaluate("!document.getElementById('update-download').hidden"), 'available update');
  await until(async () => await evaluate("document.getElementById('update-app-icon').complete && document.getElementById('update-app-icon').naturalWidth>500"), 'full quality app icon');
  assert.deepEqual(actions, [], 'Opening the notice never downloads or installs');
  assert.equal(await evaluate("document.getElementById('update-heading').textContent"), 'Overkot 0.0.15');
  assert.match(await evaluate("document.getElementById('update-version-path').textContent"), /Installed 0\.0\.14.*New 0\.0\.15/);
  assert.match(await evaluate("document.getElementById('update-policy').textContent"), /only when you choose/);
  assert.equal(await evaluate("document.querySelectorAll('#update-notes img').length"), 0, 'Release notes remain plain text');
  await capture('available');
  await evaluate("document.getElementById('update-download').click();document.getElementById('update-download').click()");
  await until(() => !!finishDownload, 'explicit download action');
  assert.deepEqual(actions, ['download']);
  emit({ phase: 'downloading', percent: 37, transferred: 37 * 1024 * 1024, total: 100 * 1024 * 1024, bytesPerSecond: 2 * 1024 * 1024 });
  await until(async () => await evaluate("document.getElementById('update-progress').value===37"), 'real download progress');
  assert.equal(await evaluate("document.getElementById('update-progress').getAttribute('aria-valuenow')"), '37');
  assert.match(await evaluate("document.getElementById('update-transfer').textContent"), /37\.0 MB of 100\.0 MB.*2\.0 MB\/s/);
  await capture('downloading-37');
  emit({ phase: 'ready', percent: 100 }); finishDownload(state);
  await until(async () => await evaluate("!document.getElementById('update-install').hidden && !document.getElementById('update-install').disabled"), 'ready install button');
  assert.equal(await evaluate("document.getElementById('update-progress').value"), 100);
  await capture('ready');
  await evaluate("document.getElementById('update-install').click();document.getElementById('update-install').click()");
  await until(() => !!finishInstall, 'explicit install action');
  assert.deepEqual(actions, ['download', 'install']);
  assert.equal(await evaluate("document.getElementById('update-progress').hasAttribute('value')"), false, 'Installation preparation has no invented percentage');
  assert.equal(await evaluate("document.getElementById('update-install').disabled"), true);
  await capture('installing');
  finishInstall(false);
  await until(async () => await evaluate("!document.getElementById('update-install').disabled && document.getElementById('update-status').textContent.includes('still ready')"), 'failed install retry');
  finishInstall = null;
  await evaluate("document.getElementById('update-install').click()");
  await until(() => !!finishInstall, 'explicit install retry'); finishInstall(true);
  await pause(30); assert.equal(actions.filter(action => action === 'install').length, 2);
  emit({ phase: 'error', errorStage: 'install', percent: 0 });
  await until(async () => await evaluate("!document.getElementById('update-install').hidden && !document.getElementById('update-install').disabled"), 'asynchronous install failure retry');
  assert.equal(await evaluate("document.getElementById('update-download').hidden"), true);
  assert.equal(await evaluate("document.getElementById('update-progress').value"), 100);
  finishInstall = null; await evaluate("document.getElementById('update-install').click()");
  await until(() => !!finishInstall, 'retry without downloading again'); finishInstall(true);
  await pause(30); assert.equal(actions.filter(action => action === 'install').length, 3);
  emit({ phase: 'current', errorStage: null, version: null, changes: [] });
  await until(async () => await evaluate("document.getElementById('update-progress-card').hidden"), 'up to date');
  emit({ phase: 'error', errorStage: 'check' }); await pause(30);
  assert.equal(await evaluate("document.getElementById('update-check').disabled"), false, 'Offline check can be retried');
  await evaluate("document.getElementById('update-check').click()"); await until(() => actions.includes('check'), 'manual retry');
  emit({ supported: false, phase: 'unsupported', version: null, changes: [] });
  await until(async () => await evaluate("!document.getElementById('update-installer').hidden"), 'portable/unsupported installer action');
  assert.equal(await evaluate("document.getElementById('update-download').hidden"), true);
  win.setSize(360, 480); await pause(60);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'Narrow update dialog has no horizontal overflow');
  await capture('narrow-unsupported');
  assert.deepEqual(errors, []);
  const summary = { ok: true, source, output, actions, captures, checks: ['full quality icon and new version', 'manual download and install', 'real progress and transfer rate', 'safe release notes', 'indeterminate install preparation', 'duplicate action prevention', 'failed install retry', 'current/offline/unsupported', 'narrow layout'], errors };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary)); app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
