const test = require('node:test');
const assert = require('node:assert/strict');
const { GroupFinderIdentity, profileDisplayName } = require('../src/modules/playerIdentity');
const { LogWatcher } = require('../src/modules/logWatcher');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const ACCOUNT_A = 'a'.repeat(24), ACCOUNT_B = 'b'.repeat(24);
const profile = (id, name) => ({ Results: [{ AccountId: { $oid: id }, DisplayName: name }] });

test('profile names must belong to the current account and fit the game alias rules', () => {
  assert.equal(profileDisplayName(profile(ACCOUNT_A, 'Envoy.Name'), ACCOUNT_A), 'Envoy.Name');
  assert.equal(profileDisplayName(profile(ACCOUNT_A, 'Envoy.Name'), ACCOUNT_B), null);
  assert.equal(profileDisplayName(profile(ACCOUNT_A, 'bad name@example.com'), ACCOUNT_A), null);
  assert.equal(profileDisplayName({ DisplayName: 'Unbound' }, ACCOUNT_A), null);
  assert.equal(profileDisplayName({ Results: [...profile(ACCOUNT_B, 'Wrong').Results, ...profile(ACCOUNT_A, 'Right').Results] }, ACCOUNT_A), 'Right');
});

function fixture(extra = {}) {
  const calls = [];
  const service = Object.fromEntries(['shutdown', 'initialize', 'restoreMyListing', 'startBackgroundListeners', 'pushUpdate', 'setDisplayName']
    .map(name => [name, async (...args) => { calls.push([name, ...args]); return true; }]));
  const identity = new GroupFinderIdentity({ service, api: { fetchProfile: async id => profile(id, 'RealEnvoy') }, ...extra });
  return { calls, identity, service };
}

test('profile identity is used before a listing/presence can expose a fallback account ID', async () => {
  const { identity, calls } = fixture({ fallback: () => 'LegacyName' });
  await identity.connect(ACCOUNT_A);
  assert.deepEqual(calls.find(x => x[0] === 'initialize'), ['initialize', ACCOUNT_A, 'RealEnvoy', 1]);
  assert.ok(calls.some(x => x[0] === 'startBackgroundListeners'));
  await identity.disconnect();
  assert.equal(identity.ready, false);
});

test('missing name keeps group creation unavailable and retries without inventing an alias', async () => {
  let time = 1000;
  const f = fixture({ api: { fetchProfile: async () => null }, now: () => time });
  await f.identity.connect(ACCOUNT_A);
  assert.equal(f.calls.some(x => x[0] === 'initialize'), false);
  assert.equal(f.identity.ready, false);
  f.identity.api.fetchProfile = async id => profile(id, 'Recovered');
  time += 60_001;
  await f.identity.refresh();
  assert.equal(f.calls.find(x => x[0] === 'initialize')[2], 'Recovered');
});

test('late profile response after account switch never initializes the old account', async () => {
  let release;
  const f = fixture({ api: { fetchProfile: id => id === ACCOUNT_A ? new Promise(resolve => { release = resolve; }) : Promise.resolve(profile(id, 'SecondEnvoy')) } });
  const first = f.identity.connect(ACCOUNT_A);
  await f.identity.connect(ACCOUNT_B);
  release(profile(ACCOUNT_A, 'FirstEnvoy'));
  await first;
  assert.deepEqual(f.calls.filter(x => x[0] === 'initialize'), [['initialize', ACCOUNT_B, 'SecondEnvoy', 1]]);
});

test('EE.log fallback only accepts a login line for the supplied account', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'EE.log');
  fs.writeFileSync(file, `Logged in CurrentEnvoy (${ACCOUNT_A})\nLogged in OtherEnvoy (${ACCOUNT_B})`);
  t.mock.method(LogWatcher, 'candidatePaths', () => [file]);
  const watcher = new LogWatcher();
  assert.equal(watcher.extractDisplayName(ACCOUNT_A), 'CurrentEnvoy');
  assert.equal(watcher.extractDisplayName('c'.repeat(24)), '');
  assert.equal(watcher.extractDisplayName(), '');
});

test('game-log monitoring switches Firebase profiles independently of inventory and stops on game exit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-group-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'EE.log');
  t.mock.method(LogWatcher, 'candidatePaths', () => [file]);
  const watcher = new LogWatcher();
  const { identity, calls } = fixture({ api: { fetchProfile() { assert.fail('An observed login needs no remote profile'); } } });
  t.after(() => identity.stopWatching());
  let running = true;
  async function until(predicate) {
    for (let i = 0; i < 120; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Timed out waiting for the local login monitor');
  }
  fs.writeFileSync(file, `Logged in FirstEnvoy (${ACCOUNT_A})\n` + 'other event\n'.repeat(70000));
  await identity.watchGame(() => watcher.currentLogin(), () => running);
  assert.equal(identity.ready, true);
  fs.appendFileSync(file, `Logged in bad@name (${ACCOUNT_B})\n`);
  await until(() => identity.accountId === null);
  fs.appendFileSync(file, `Logged in SecondEnvoy (${ACCOUNT_B})\n`);
  await until(() => identity.ready && identity.accountId === ACCOUNT_B);
  assert.deepEqual(calls.filter(row => row[0] === 'initialize'), [
    ['initialize', ACCOUNT_A, 'FirstEnvoy', 1], ['initialize', ACCOUNT_B, 'SecondEnvoy', 1],
  ]);
  fs.appendFileSync(file, 'QUIT :Logged out of game\n');
  await until(() => identity.accountId === null);
  running = false;
  await until(() => identity.watcher === null);
  assert.equal(identity.ready, false);
});

test('service logout clears the visible identity before an offline presence write completes', async () => {
  let releasePresence, waiting = false;
  const fb = {
    isConfigured: () => true, isInitialized: () => true,
    initializeFirebase: async () => ({ uid: 'fixture' }),
    getRTDB: () => ({}), getFirestoreInstance: () => ({}),
    getAuthInstance: () => ({ currentUser: { uid: 'fixture' } }),
    ref: (_db, key) => key, doc: (_db, ...keys) => keys.join('/'),
    onValue: () => () => {}, onDisconnect: () => ({ cancel: async () => {} }),
    setDoc: async () => {}, rtdbServerTimestamp: () => 1, firestoreServerTimestamp: () => 1,
    update: () => waiting ? new Promise(resolve => { releasePresence = resolve; }) : Promise.resolve(),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/groupFinderService'), 'utf8'), {
    module, console, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    require: name => name === './firebaseConfig' ? fb : require('../src/modules/playerIdentity'),
  });
  const service = module.exports;
  const views = [];
  service.startListeners({ isDestroyed: () => false, webContents: { send: (_channel, state) => views.push(state.playerId) } });
  await service.initialize(ACCOUNT_A, 'FirstEnvoy');
  service.pushUpdate();
  assert.equal(service.getState().playerId, 'fixture');
  waiting = true;
  const stopping = service.shutdown();
  assert.equal(service.getState().playerId, null);
  assert.equal(service.getState().displayName, null);
  assert.deepEqual(views, ['fixture', null]);
  releasePresence();
  await stopping;
  let releaseAuth;
  fb.initializeFirebase = () => new Promise(resolve => { releaseAuth = resolve; });
  const starting = service.initialize(ACCOUNT_A, 'FirstEnvoy');
  const disconnect = service.shutdown();
  releaseAuth({ uid: 'fixture' });
  assert.equal(await starting, false);
  await disconnect;
  assert.equal(service.getState().displayName, null);
});
