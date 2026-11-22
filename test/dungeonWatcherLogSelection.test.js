'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DungeonWatcher } = require('../src/modules/dungeonWatcher');
const { createGamePathResolver } = require('../src/modules/gamePaths');

const overworld = '/SF/Levels/MidrathRedux';
const tower = '/SF/Levels/PlayerTower';

function fixture(t) {
  const root = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(root, 'overkot-map-logs-'));
  t.after(() => {
    assert.equal(path.dirname(directory), root);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const log = (name, zone, seconds) => {
    const folder = path.join(directory, name);
    fs.mkdirSync(folder);
    const filename = path.join(folder, 'EE.log');
    fs.writeFileSync(filename, `STATS ENTER_LEVEL ${zone}\n`);
    fs.utimesSync(filename, seconds, seconds);
    return filename;
  };
  return { directory, log };
}

test('the map replays the newest readable automatic log on every launch', t => {
  const { directory, log } = fixture(t);
  const stale = log('old', tower, 1000), live = log('live', overworld, 2000);
  const inaccessible = log('locked', tower, 3000);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (filename, ...args) => {
    if (filename === inaccessible) throw new Error('Simulated sharing violation');
    return open(filename, ...args);
  });
  for (const candidates of [[stale, live], [directory, inaccessible, stale, live]]) {
    const watcher = new DungeonWatcher({ candidates: () => candidates });
    watcher._poll();
    assert.equal(watcher.getState().levelPath, overworld);
    watcher.stop();
  }
});

test('a new automatic log is replayed from the beginning when it appears after startup', t => {
  const { directory, log } = fixture(t);
  const first = log('first', tower, 1000);
  const second = path.join(directory, 'second', 'EE.log');
  const watcher = new DungeonWatcher({ candidates: () => [first, second] });
  watcher._poll();
  assert.equal(watcher.getState().levelPath, tower);
  log('second', overworld, 2000);
  watcher._poll();
  assert.equal(watcher.getState().levelPath, overworld);
  watcher.stop();
});

test('live growth moves the map off a stale log even with an older unchanged mtime', t => {
  const { log } = fixture(t);
  const first = log('preferred', tower, 3000), second = log('growing', tower, 1000);
  const watcher = new DungeonWatcher({ candidates: () => [first, second] });
  watcher._poll();
  assert.equal(watcher.getState().levelPath, tower);
  fs.appendFileSync(second, `STATS ENTER_LEVEL ${overworld}\n`);
  fs.utimesSync(second, 1000, 1000);
  watcher._poll();
  assert.equal(watcher.getState().levelPath, overworld);
  const instance = watcher.getState().instanceId;
  watcher._poll();
  assert.equal(watcher.getState().instanceId, instance);
  watcher.stop();
});

test('equal timestamps preserve candidate order at startup and retain the current log when idle', t => {
  const { log } = fixture(t);
  const first = log('first', overworld, 1000), second = log('second', tower, 1000);
  let candidates = [first, second];
  const watcher = new DungeonWatcher({ candidates: () => candidates });
  watcher._poll();
  assert.equal(watcher.getState().levelPath, overworld);
  candidates = [second, first];
  watcher._poll();
  assert.equal(watcher.getState().levelPath, overworld);
  watcher.stop();
});

test('a selected log remains authoritative when a newer automatic log is available', t => {
  const { directory, log } = fixture(t);
  const selected = log('selected', tower, 1000);
  const config = {};
  const resolver = createGamePathResolver({ env: { LOCALAPPDATA: path.join(directory, 'Local') }, home: directory,
    getConfig: () => config });
  const automatic = resolver.logCandidates()[0];
  if (automatic) {
    fs.mkdirSync(path.dirname(automatic), { recursive: true });
    fs.writeFileSync(automatic, `STATS ENTER_LEVEL ${overworld}\n`);
  }
  config.eeLogPath = selected;
  const watcher = new DungeonWatcher({ candidates: resolver.logCandidates });
  watcher._poll();
  assert.equal(watcher.getState().levelPath, tower);
  fs.unlinkSync(selected);
  watcher._poll();
  assert.deepEqual(watcher.getState(), { status: 'unknown', active: false });
  watcher.stop();
});
