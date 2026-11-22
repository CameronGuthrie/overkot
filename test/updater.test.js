const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const { Updater, CURRENT_VERSION, releaseChanges } = require('../src/modules/updater');
const { BaseUpdater } = require('electron-updater/out/BaseUpdater');
const { CancellationToken } = require('builder-util-runtime');
const nextVersion = require('semver').inc(CURRENT_VERSION, 'patch');
const futureVersion = require('semver').inc(nextVersion, 'patch');

test('maintenance beta on the latest feed upgrades stable 0.0.11 and then accepts stable 0.0.12', async () => {
  const semver = require('semver');
  const { AppUpdater } = require('electron-updater/out/AppUpdater');
  const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
  const { createConfig, parseOptions } = require('../scripts/build');
  const publish = createConfig(require('../package.json'), parseOptions([], { platform: 'win32', arch: 'x64' })).publish;
  assert.equal(publish.channel, 'latest');
  const installed = {
    currentVersion: semver.parse('0.0.11'), allowPrerelease: false, allowDowngrade: false,
    isUpdateSupported: () => true, isUserWithinRollout: () => true,
  };
  assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(installed, { version: '0.0.12-beta.1' }), true);
  installed.currentVersion = semver.parse('0.0.12-beta.1');
  installed.allowPrerelease = true;
  assert.equal(new GenericProvider(publish, installed, { platform: 'win32' }).channel, 'latest');
  assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(installed, { version: '0.0.12-beta.2' }), true);
  installed.currentVersion = semver.parse('0.0.12-beta.2');
  assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(installed, { version: '0.0.12' }), true);
  assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(installed, { version: '0.0.11' }), false);
});

function fixture(options = {}) {
  const backend = new EventEmitter(), pendingInstalls = [];
  const calls = { checks: 0, downloads: 0, installs: [], restarts: [], quitHandlers: 0 };
  backend._logger = { info() {}, warn() {} };
  backend.app = { onQuit: handler => { calls.quitHandlers++; backend.quitHook = handler; } };
  backend.addQuitHandler = BaseUpdater.prototype.addQuitHandler;
  backend.install = (...args) => calls.installs.push(args);
  backend.quit = code => backend.quitHook?.(code);
  backend.quitAndInstall = (...args) => calls.restarts.push(args);
  backend.checkForUpdates = async () => { calls.checks++; return { updateInfo: { version: nextVersion } }; };
  backend.downloadUpdate = async () => {
    calls.downloads++;
    // Use the real library guard, including its cached-download path.
    backend.addQuitHandler();
    return ['installer.exe'];
  };
  const fetch = async url => ({ data: url.endsWith('killswitch.json') ? { action: 'none' } :
    { versions: [{ version: `v${futureVersion}`, changes: ['Future feature'] }, { version: `v${nextVersion}`, changes: ['New feature'] }] } });
  const updater = new Updater({ supported: true, backend, fetch,
    makeToken: () => new CancellationToken(), scheduleInstall: callback => pendingInstalls.push(callback), ...options });
  return { updater, backend, calls, pendingInstalls, handoff() { pendingInstalls.shift()?.(); } };
}

test('startup checks only report availability, even for a legacy automatic preference', async () => {
  for (const automatic of [undefined, true, false]) {
    const { updater, backend, calls } = fixture({ automatic });
    assert.equal(updater.installNow(), false);
    const state = await updater.check();
    assert.equal(state.phase, 'available'); assert.equal(state.automatic, false);
    assert.deepEqual(state.changes, ['New feature']);
    assert.equal(calls.downloads, 0);
    assert.equal(backend.autoDownload, false); assert.equal(backend.autoInstallOnAppQuit, false);
    assert.equal(calls.quitHandlers, 0);
  }
});

test('download and install require separate deliberate actions and installation has a visible handoff', async () => {
  const f = fixture(); await f.updater.check();
  assert.equal((await f.updater.download()).phase, 'ready');
  assert.equal(f.calls.downloads, 1); assert.equal(f.backend.autoInstallOnAppQuit, false);
  f.backend.quit(0); f.backend.quit(1);
  assert.deepEqual(f.calls.installs, []); assert.deepEqual(f.calls.restarts, []);
  const states = []; f.updater.on('changed', state => states.push(state));
  assert.equal(f.updater.installNow(), true);
  assert.equal(f.updater.snapshot().phase, 'installing'); assert.equal(states.at(-1).phase, 'installing');
  assert.deepEqual(f.calls.restarts, [], 'The in-app installing surface can paint before NSIS starts');
  assert.equal(f.updater.installNow(), false, 'Repeated install clicks cannot launch another installer');
  assert.equal((await f.updater.check()).phase, 'installing');
  f.handoff();
  assert.deepEqual(f.calls.restarts, [[false, true]], 'The explicit update opens the branded NSIS progress page');
  assert.equal(f.backend.autoRunAppAfterInstall, true, 'Non-silent NSIS updates reopen Overkot afterward');
});

test('legacy setters never enable unattended downloading or installation', async () => {
  const f = fixture({ automatic: true }); await f.updater.check();
  f.updater.setAutomatic(true);
  assert.equal(f.updater.snapshot().automatic, false);
  assert.equal((await f.updater.download(false)).phase, 'available'); assert.equal(f.calls.downloads, 0);
  await f.updater.download(); f.updater.setAutomatic(true); f.backend.quit(0);
  assert.equal(f.backend.autoDownload, false); assert.equal(f.backend.autoInstallOnAppQuit, false);
  assert.equal(f.calls.quitHandlers, 0);
  assert.deepEqual(f.calls.installs, []); assert.deepEqual(f.calls.restarts, []);
});

test('concurrent checks coalesce and never download when preferences change during the request', async () => {
  const f = fixture(); let resolve;
  f.backend.checkForUpdates = () => new Promise(done => { resolve = done; f.calls.checks++; });
  const first = f.updater.check(), second = f.updater.check();
  await new Promise(done => setImmediate(done)); f.updater.setAutomatic(true);
  resolve({ updateInfo: { version: nextVersion } }); await Promise.all([first, second]);
  assert.equal(f.calls.checks, 1); assert.equal(f.calls.downloads, 0);
  assert.equal(f.updater.snapshot().phase, 'available');
});

test('concurrent manual downloads share their promise and expose real bounded progress', async () => {
  const f = fixture(); await f.updater.check(); let resolve;
  f.backend.downloadUpdate = () => new Promise(done => { resolve = done; f.calls.downloads++; });
  const first = f.updater.download(), second = f.updater.download();
  assert.equal(first, second); assert.equal(f.calls.downloads, 1);
  f.backend.emit('download-progress', { percent: 36.6, transferred: 367, total: 1000, bytesPerSecond: 240 });
  assert.deepEqual(Object.fromEntries(['percent', 'transferred', 'total', 'bytesPerSecond'].map(key => [key, f.updater.snapshot()[key]])),
    { percent: 37, transferred: 367, total: 1000, bytesPerSecond: 240 });
  f.backend.emit('download-progress', { percent: Infinity, transferred: 2000, total: 1000, bytesPerSecond: -5 });
  assert.equal(f.updater.snapshot().percent, 100); assert.equal(f.updater.snapshot().transferred, 1000);
  assert.equal(f.updater.snapshot().bytesPerSecond, 0);
  f.backend.emit('download-progress', null);
  assert.equal(f.updater.snapshot().percent, 0); assert.equal(f.updater.snapshot().total, 0);
  resolve([]); await first; assert.equal(f.updater.snapshot().percent, 100);
  f.backend.emit('download-progress', { percent: 5 });
  assert.equal(f.updater.snapshot().percent, 100, 'Late backend progress cannot move a completed download backward');
});

test('shutdown and its short installation-transition race never start an installer', async () => {
  const f = fixture(); await f.updater.check(); await f.updater.download();
  assert.equal(f.updater.installNow(), true);
  f.updater.sessionEnding(); f.updater.setAutomatic(true); f.handoff(); f.backend.quit(0);
  assert.deepEqual(f.calls.restarts, []); assert.deepEqual(f.calls.installs, []);
  assert.equal(f.updater.installNow(), false); assert.equal(f.backend.autoInstallOnAppQuit, false);
});

test('unsupported portable/development mode never creates a backend or fetches', async () => {
  const updater = new Updater({ fetch: () => { throw new Error('Network not expected'); } });
  assert.equal((await updater.check()).phase, 'unsupported');
  assert.equal((await updater.download()).phase, 'unsupported'); assert.equal(updater.installNow(), false);
});

test('offline/error events are nonfatal and checks can be retried', async () => {
  const f = fixture();
  f.backend.checkForUpdates = async () => { f.backend.emit('error', new Error('offline')); throw new Error('offline'); };
  assert.equal((await f.updater.check()).phase, 'error'); assert.equal(f.updater.snapshot().errorStage, 'check');
  f.backend.checkForUpdates = async () => ({ updateInfo: { version: CURRENT_VERSION } });
  assert.equal((await f.updater.check()).phase, 'current'); assert.equal(f.updater.snapshot().errorStage, null);
});

test('malformed/missing notes do not prevent a valid update or show notes for another version', async () => {
  assert.deepEqual(releaseChanges({ versions: {} }, nextVersion), []);
  assert.deepEqual(releaseChanges({ versions: [{ version: 'garbage', changes: ['Bad'] }] }, nextVersion), []);
  const { updater } = fixture({ fetch: async () => { throw new Error('notes offline'); } });
  assert.equal((await updater.check()).phase, 'available'); assert.deepEqual(updater.snapshot().changes, []);
});

test('download errors preserve manual control and permit retry', async () => {
  const f = fixture(); await f.updater.check();
  f.backend.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  assert.equal((await f.updater.download()).phase, 'error'); assert.equal(f.updater.snapshot().errorStage, 'download');
  assert.equal(f.updater.installNow(), false);
  f.backend.downloadUpdate = async () => [];
  assert.equal((await f.updater.download()).phase, 'ready'); f.backend.quit(0);
  assert.deepEqual(f.calls.installs, []);
});

test('a canceled download returns to available without authorizing installation', async () => {
  const f = fixture(); await f.updater.check();
  f.backend.downloadUpdate = async token => { token.cancel(); throw new Error('canceled'); };
  assert.equal((await f.updater.download()).phase, 'available'); assert.equal(f.updater.snapshot().errorStage, null);
  assert.equal(f.updater.installNow(), false);
});

test('failed installer handoffs can be retried without downloading again', async () => {
  const f = fixture(); await f.updater.check(); await f.updater.download();
  f.backend.quitAndInstall = () => { throw new Error('installer unavailable'); };
  assert.equal(f.updater.installNow(), true); f.handoff();
  assert.equal(f.updater.snapshot().phase, 'error'); assert.equal(f.updater.snapshot().errorStage, 'install');
  assert.equal((await f.updater.download()).phase, 'error'); assert.equal(f.calls.downloads, 1);
  f.backend.quitAndInstall = (...args) => f.calls.restarts.push(args);
  assert.equal(f.updater.installNow(), true); f.handoff(); assert.deepEqual(f.calls.restarts, [[false, true]]);
});

test('asynchronous backend installation failures leave a retryable error state', async () => {
  const f = fixture(); await f.updater.check(); await f.updater.download();
  f.updater.installNow(); f.handoff(); f.backend.emit('error', new Error('could not start installer'));
  assert.equal(f.updater.snapshot().phase, 'error'); assert.equal(f.updater.snapshot().errorStage, 'install');
  assert.equal(f.updater.installNow(), true);
});

test('an old deferred handoff cannot launch a second installer after an early failure and retry', async () => {
  const f = fixture(); await f.updater.check(); await f.updater.download();
  f.updater.installNow(); f.backend.emit('error', new Error('early backend failure'));
  assert.equal(f.updater.installNow(), true);
  f.handoff(); assert.deepEqual(f.calls.restarts, [], 'The superseded timer is no longer authorized');
  f.handoff(); assert.deepEqual(f.calls.restarts, [[false, true]]);
});

test('quitting before any download never registers or attempts installation', () => {
  const f = fixture(); f.backend.quit(0);
  assert.equal(f.calls.quitHandlers, 0); assert.deepEqual(f.calls.installs, []);
});

test('an already registered cached-update quit hook is disarmed before any check', () => {
  const backend = new EventEmitter(), installs = [];
  backend.autoInstallOnAppQuit = true;
  backend._logger = { info() {}, warn() {} };
  backend.app = { onQuit: handler => { backend.quit = handler; } };
  backend.install = (...args) => installs.push(args);
  BaseUpdater.prototype.addQuitHandler.call(backend);
  const updater = new Updater({ supported: true, backend });
  updater.setAutomatic(true); backend.quit(0);
  assert.equal(backend.autoInstallOnAppQuit, false);
  assert.deepEqual(installs, []);
});

test('release blocking remains informational to the updater and never downloads or installs', async () => {
  const f = fixture({ fetch: async () => ({ data: { action: 'force-update', affected_versions: CURRENT_VERSION, message: 'Please update' } }) });
  const blocked = []; f.updater.on('killswitch', data => blocked.push(data));
  assert.equal((await f.updater.check()).phase, 'blocked'); assert.deepEqual(blocked, [{ message: 'Please update' }]);
  assert.equal(f.calls.downloads, 0); assert.equal(f.updater.installNow(), false);
});
