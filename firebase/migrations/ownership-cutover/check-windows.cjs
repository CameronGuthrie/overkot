// Private QA harness. No game process, existing user profile or production project is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { setTimeout: pause } = require('node:timers/promises');
const projectId = 'demo-overkot-rules';

async function until(check, description) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error('Timed out waiting for ' + description);
}

function emulator(variable) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(process.env[variable] || '');
  assert.ok(match, 'Expected loopback emulator: ' + variable);
  return Number(match[1]);
}

async function control() {
  const [source, packageDirectory] = process.argv.slice(2).map(p => path.resolve(p));
  const archive = path.join(packageDirectory, 'resources', 'app.asar');
  assert.ok(fs.existsSync(archive), 'Expected the built public Windows package');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-group-finder-qa-'));
  const runtime = path.join(work, 'runtime');
  function linkDirectory(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const item of fs.readdirSync(from, { withFileTypes: true })) {
      if (item.name === 'app.asar' || item.name === 'app.asar.unpacked') continue;
      const src = path.join(from, item.name), dest = path.join(to, item.name);
      if (item.isDirectory()) linkDirectory(src, dest);
      else {
        try { fs.linkSync(src, dest); }
        catch (error) {
          if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
          fs.copyFileSync(src, dest);
        }
      }
    }
  }
  linkDirectory(packageDirectory, runtime);
  const dir = path.join(runtime, 'resources', 'app');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'overkot-group-qa', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(dir, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');');
  const executable = fs.readdirSync(runtime).find(file => /^Overkot.*\.exe$/i.test(file));
  assert.ok(executable);
  const children = [];
  async function launch(role) {
    const env = { ...process.env, QA_GROUP_WORK: work, QA_GROUP_SOURCE: source, QA_GROUP_ARCHIVE: archive, QA_GROUP_ROLE: role };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.join(runtime, executable), ['--disable-background-networking'], {
      env, stdio: ['ignore','pipe','pipe'], windowsHide: true, timeout: 75_000,
    });
    children.push(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(role + ' failed: ' + output);
    console.log(role + ' client passed');
  }
  try {
    await Promise.all([launch('host'), launch('guest')]);
    await launch('restart');
    console.log('Passed Windows packaged UI, two desktop owners, join, accept, restart, profile switch, logout.');
  } finally {
    for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
    const absoluteWork = fs.realpathSync(work);
    if (path.dirname(absoluteWork) === fs.realpathSync(os.tmpdir()) && /^overkot-group-finder-qa-[a-zA-Z0-9]+$/.test(path.basename(absoluteWork))) {
      fs.rmSync(absoluteWork, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
    }
  }
}

async function worker() {
  const { app, BrowserWindow, ipcMain, session, safeStorage } = require('electron');
  const { QA_GROUP_SOURCE: source, QA_GROUP_WORK: work, QA_GROUP_ARCHIVE: archive, QA_GROUP_ROLE: role } = process.env;
  const host = role !== 'guest';
  const name = host ? 'TestHost' : 'TestGuest';
  const account = (host ? 'a' : 'b').repeat(24);
  const profileDir = path.join(work, host ? 'host' : 'guest');
  fs.mkdirSync(profileDir, { recursive: true });
  app.setPath('userData', path.join(profileDir, 'desktop'));
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
  await app.whenReady();
  assert.ok(safeStorage.isEncryptionAvailable(), 'Windows OS encryption must be available for restart test');
  const r = createRequire(path.join(source, 'package.json'));
  const web = { projectId, apiKey: 'demo-emulator-only', appId: 'group-test', databaseURL: 'https://' + projectId + '-default-rtdb.firebaseio.com' };
  global.__OVERKOT_SERVICES__ = { groupFirebase: web };
  const originalFetch = global.fetch;
  global.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.hostname, '127.0.0.1', 'Expected a loopback-only desktop API request');
    return originalFetch(input, options);
  };
  // Redirect each genuine SDK client before its first network operation. This
  // shim is supplied only by the private harness, outside the Windows archive.
  function connect(packageName, initialize, connectEmulator) {
    const sdk = r(packageName), seen = new WeakSet();
    r.cache[r.resolve(packageName)].exports = { ...sdk, [initialize](...args) {
      const client = sdk[initialize](...args);
      if (!seen.has(client)) { connectEmulator(sdk, client); seen.add(client); }
      return client;
    } };
  }
  connect('firebase/auth', 'initializeAuth', (sdk, client) =>
    sdk.connectAuthEmulator(client, 'http://127.0.0.1:' + emulator('FIREBASE_AUTH_EMULATOR_HOST'), { disableWarnings: true }));
  connect('firebase/database', 'getDatabase', (sdk, client) =>
    sdk.connectDatabaseEmulator(client, '127.0.0.1', emulator('FIREBASE_DATABASE_EMULATOR_HOST')));
  connect('firebase/firestore', 'getFirestore', (sdk, client) =>
    sdk.connectFirestoreEmulator(client, '127.0.0.1', emulator('FIRESTORE_EMULATOR_HOST')));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*'] },
    (request, done) => done({ cancel: new URL(request.url).hostname !== '127.0.0.1' }));
  session.defaultSession.webRequest.onHeadersReceived(r('./src/modules/guard').createHeadersHandler(path.join(archive, 'src', 'renderer')));
  const groupFinder = r('./src/modules/groupFinderService');
  const config = r('./src/modules/firebaseConfig');
  config.configureAuthStorage({ directory: profileDir, safeStorage });
  const { LogWatcher } = r('./src/modules/logWatcher');
  const { GroupFinderIdentity } = r('./src/modules/playerIdentity');
  const watcher = new LogWatcher();
  watcher._filePath = path.join(profileDir, 'synthetic.log');
  fs.writeFileSync(watcher._filePath, 'Logged in ' + name + ' (' + account + ')\n');
  const identity = new GroupFinderIdentity({ service: groupFinder, fallback: id => {
    const login = watcher.currentLogin();
    return login?.accountId === id ? login.name : '';
  } });
  await identity.connect(watcher.currentLogin().accountId);
  assert.equal(identity.ready, true, 'desktop group service should have signed in');
  ipcMain.on('get-i18n', event => { event.returnValue = { translations: { en: {} }, languages: [] }; });
  ipcMain.handle('get-state', () => ({ config: { language: 'en' } }));
  const main = fs.readFileSync(path.join(source, 'src', 'main.js'), 'utf8');
  const handlers = main.slice(main.indexOf("ipcMain.handle('gf:get-state'"), main.indexOf('// ─── Background loop'));
  assert.ok(handlers.includes("ipcMain.handle('gf:accept-request'"));
  require('node:vm').runInNewContext(handlers, { ipcMain, groupFinder, usage: { track() {} } });
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(archive, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false,
  } });
  const js = expression => win.webContents.executeJavaScript(expression);
  const state = () => js('window.api.gfGetState()');
  const events = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (typeof message === 'string' && /Uncaught|ReferenceError|TypeError/.test(message)) events.push(message);
  });
  await win.loadFile(path.join(archive, 'src', 'renderer', 'group-finder.html'));
  groupFinder.startListeners(win);
  groupFinder.pushUpdate();
  await until(async () => (await js("document.getElementById('gf-home-name').textContent")) === name, 'packaged UI to display invite name');
  const uid = (await state()).playerId;
  assert.ok(uid && uid !== account);
  const listingFile = path.join(work, 'listing.json'), acceptedFile = path.join(work, 'accepted');
  if (role === 'host') {
    const listing = await js('window.api.gfCreateListing({ slotsNeeded: 2 })');
    assert.equal(listing.hostPlayer, uid);
    fs.writeFileSync(listingFile, JSON.stringify({ id: listing.id, uid }));
    const request = await until(async () => (await state()).incomingRequests[0], 'incoming join');
    assert.notEqual(request.playerId, uid);
    assert.equal(await js('window.api.gfAcceptRequest(' + JSON.stringify(listing.id) + ',' + JSON.stringify(request.playerId) + ')'), true);
    await until(() => fs.existsSync(acceptedFile), 'guest to see acceptance');
  } else if (role === 'guest') {
    await until(() => fs.existsSync(listingFile), 'host listing');
    const listing = JSON.parse(fs.readFileSync(listingFile, 'utf8'));
    assert.notEqual(listing.uid, uid);
    await until(async () => (await state()).listings.some(row => row.id === listing.id), 'visible host listing');
    const request = await js('window.api.gfRequestJoin(' + JSON.stringify(listing.id) + ')');
    assert.equal(request.requesterUid, uid);
    await until(async () => (await state()).myRequests.some(row => row.status === 'accepted'), 'accepted request in guest UI');
    fs.writeFileSync(acceptedFile, 'ok');
  } else {
    const listing = JSON.parse(fs.readFileSync(listingFile, 'utf8'));
    assert.equal(uid, listing.uid);
    assert.equal((await state()).myListing?.id, listing.id);
    const second = 'c'.repeat(24);
    fs.appendFileSync(watcher._filePath, 'Logged in NextEnvoy (' + second + ')\n');
    await identity.connect(second);
    assert.notEqual((await state()).playerId, uid);
    assert.equal((await state()).myListing, null);
    await identity.disconnect();
    assert.equal((await state()).playerId, null);
  }
  assert.deepEqual(events, []);
  await identity.disconnect();
  app.exit(0);
}

assert.equal(process.env.GCLOUD_PROJECT, projectId);
for (const key of ['FIREBASE_AUTH_EMULATOR_HOST','FIREBASE_DATABASE_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST']) emulator(key);
(process.versions.electron ? worker() : control()).catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
