'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGamePathResolver, getGamePathResolver, setGamePathResolver } = require('../src/modules/gamePaths');
const { LogWatcher } = require('../src/modules/logWatcher');
const { ArenaWatcher } = require('../src/modules/arenaWatcher');
const { AncestorWatcher } = require('../src/modules/ancestorWatcher');

function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'overkot-game-paths-'));
  t.after(() => {
    assert.equal(path.dirname(directory), tempRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const folder = (...parts) => { const value = path.join(directory, ...parts); fs.mkdirSync(value, { recursive: true }); return value; };
  const file = (...parts) => { const value = path.join(directory, ...parts); fs.mkdirSync(path.dirname(value), { recursive: true }); fs.writeFileSync(value, 'synthetic test log\n'); return value; };
  const config = {};
  const options = { home: directory, env: { USERPROFILE: directory, LOCALAPPDATA: path.join(directory, 'Local'), APPDATA: path.join(directory, 'Roaming') },
    getConfig: () => config, platform: process.platform };
  return { directory, folder, file, config, options };
}

test('automatic log discovery uses the current user and never creates relative candidates', t => {
  const f = fixture(t);
  const log = process.platform === 'win32' ? f.file('Local', 'Soulframe', 'EE.log')
    : process.platform === 'linux' ? f.file('.local', 'share', 'Soulframe', 'EE.log') : null;
  const resolver = createGamePathResolver(f.options);
  assert.equal(resolver.status().eeLog.path, log);
  assert.deepEqual(resolver.status().eeLog.override, '');
  const withoutEnvironment = createGamePathResolver({ ...f.options, env: {} });
  assert.ok(withoutEnvironment.logCandidates().every(value => path.isAbsolute(value)));
  assert.equal(withoutEnvironment.logCandidates().some(value => value === path.join('Soulframe', 'EE.log')), false);
});

test('macOS allows selected logs without assuming a native game install layout', () => {
  const config = {};
  const resolver = createGamePathResolver({ platform: 'darwin', home: '/Users/envoy', env: {}, getConfig: () => config,
    fsImpl: { readdirSync() { throw new Error('No automatic compatibility-prefix searches expected'); } } });
  assert.deepEqual(resolver.logCandidates(), []);
  config.eeLogPath = '/Users/envoy/Games/Soulframe/EE.log';
  assert.deepEqual(resolver.logCandidates(), [config.eeLogPath]);
});

test('native redirected Pictures precedes OneDrive and conventional Pictures fallbacks', t => {
  const f = fixture(t);
  const native = f.folder('Redirected', 'Pictures', 'Soulframe');
  const cloud = f.folder('CloudAccount', 'Pictures', 'Soulframe');
  const ordinary = f.folder('Pictures', 'Soulframe');
  const resolver = createGamePathResolver({ ...f.options, picturesPath: () => path.dirname(native),
    env: { ...f.options.env, OneDrive: path.join(f.directory, 'CloudAccount'), OneDriveConsumer: path.join(f.directory, 'CloudAccount') } });
  const status = resolver.status().screenshots;
  assert.equal(status.path, native);
  assert.deepEqual(status.paths, [native, cloud, ordinary]);
  assert.equal(status.candidates.filter(value => value === cloud).length, 1);
});

test('missing explicit paths do not fall back to an unrelated discovered file or directory', t => {
  const f = fixture(t);
  if (process.platform === 'win32') f.file('Local', 'Soulframe', 'EE.log');
  else f.file('.local', 'share', 'Soulframe', 'EE.log');
  f.folder('Pictures', 'Soulframe');
  f.config.eeLogPath = path.join(f.directory, 'Selected', 'EE.log');
  f.config.screenshotDir = path.join(f.directory, 'SelectedScreenshots');
  const resolver = createGamePathResolver(f.options);
  const status = resolver.status();
  assert.equal(status.eeLog.found, false); assert.equal(status.eeLog.path, null);
  assert.deepEqual(status.eeLog.candidates, [f.config.eeLogPath]);
  assert.equal(status.screenshots.found, false); assert.deepEqual(status.screenshots.paths, []);
  assert.equal(resolver.validate({ eeLogPath: f.config.eeLogPath }).field, 'eeLogPath');
  assert.equal(resolver.validate({ screenshotDir: f.config.screenshotDir }).field, 'screenshotDir');
  assert.equal(fs.existsSync(f.config.screenshotDir), false);
});

test('path validation requires an existing readable EE.log or directory and supports auto reset', t => {
  const f = fixture(t);
  const log = f.file('Selected', 'EE.log'), wrong = f.file('Selected', 'notes.txt'), screenshots = f.folder('Screenshots');
  const resolver = createGamePathResolver(f.options);
  assert.deepEqual(resolver.validate({ eeLogPath: `  ${log}  `, screenshotDir: screenshots }), { ok: true, values: { eeLogPath: log, screenshotDir: screenshots } });
  assert.deepEqual(resolver.validate({ eeLogPath: '', screenshotDir: '  ' }), { ok: true, values: { eeLogPath: '', screenshotDir: '' } });
  for (const invalid of ['EE.log', wrong, screenshots, 12, 'bad\0path']) assert.equal(resolver.validate({ eeLogPath: invalid }).ok, false);
  assert.equal(resolver.validate({ screenshotDir: log }).ok, false);
  assert.equal(resolver.validate({ unrelated: 'ignored' }).values.unrelated, undefined);
  const denied = createGamePathResolver({ ...f.options, fsImpl: { ...fs, accessSync() { throw new Error('denied'); } } });
  assert.equal(denied.validate({ screenshotDir: screenshots }).ok, false);
});

test('log, arena and ancestor readers follow an override change without retaining previous state', t => {
  const f = fixture(t), previous = getGamePathResolver();
  const first = f.file('First', 'EE.log'), second = f.file('Second', 'EE.log');
  f.config.eeLogPath = first;
  setGamePathResolver(createGamePathResolver(f.options));
  t.after(() => setGamePathResolver(previous));
  const log = new LogWatcher(), arena = new ArenaWatcher(), ancestor = new AncestorWatcher();
  t.after(() => { log.stop(); arena.stop(); ancestor.stop(); });
  for (const watcher of [log, arena, ancestor]) watcher._poll();
  fs.appendFileSync(first, 'Script [Info]: Logging in as SyntheticEnvoy\n');
  log._poll();
  assert.equal(log.consumeLoginSignal(), true);
  arena._state = 'arena'; arena._wave = 4; arena._tier = 1; arena._tail = 'partial old line';
  ancestor._encounters.set('old', { hint: 'old', name: 'old', x: 1, y: 2, z: 3 });
  f.config.eeLogPath = second;
  for (const watcher of [log, arena, ancestor]) {
    watcher._poll(); assert.equal(watcher._filePath, second);
  }
  assert.equal(arena.getState(), 'unknown'); assert.equal(arena.getWave(), null); assert.equal(arena._tail, '');
  assert.deepEqual(ancestor.getAncestors(), []); assert.equal(log.consumeLoginSignal(), false);
  fs.appendFileSync(first, 'QUIT :Logged out of game\n'); log._poll();
  assert.equal(log.consumeLogoutSignal(), false, 'Old log notifications are ignored');
  fs.appendFileSync(second, 'QUIT :Logged out of game\n'); log._poll();
  assert.equal(log.consumeLogoutSignal(), true);
});
