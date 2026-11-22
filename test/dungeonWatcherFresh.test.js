'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DungeonWatcher } = require('../src/modules/dungeonWatcher');

// Location and generated resource events from six successive EE.log visits
// on 2026-10-03, without account or session information.
const visits = [
  ['UndercityPortalSproutCave', '/SF/Levels/Procs/UnderCityCliffCave', 'KhGCACHMpRNZ3fAghiCAAQjA', 'underCityMidrath'],
  ['UndercityPortalSproutCave', '/SF/Levels/Procs/UnderCityCliffCave', 'ShGaIa5IZlKJq676AAGIIAhAEYA', 'underCityMidrath'],
  ['UndercityPortalNearTower', '/SF/Levels/Procs/UnderCityCliffTown', 'ShF45xiBqkiijMpxNZ2XU-QAGIIQACEAABGA', 'underCityMidrath'],
  ['UndercityPortalNearTower', '/SF/Levels/Procs/UnderCityCliffTown', 'SeJaAJFQ5lSJqxhhy-AkBiAAAAgCMA', 'underCityMidrath'],
  ['GladesProcEntrance', '/SF/Levels/Procs/GladesofAndurin/GladesProcLevel', 'SeXCNGh9IRWPOteCiCAIQgAI', 'gladesofAndurin'],
  ['GladesTreeEntrance', '/SF/Levels/Procs/GladesofAndurin/GladesProcLevel', 'SeHISGp8YRV2uu+AiCAIAAAI', 'gladesofAndurin'],
];
const enter = ([location, level, code]) => [
  `Script [Info]: LoadTriggers.lua: StreamTrigger location is ${location}`,
  `Script [Info]: LoadTriggers.lua: SetCurrentLocation: ${location}`,
  'Script [Info]: LoadTriggers.lua: STATS EXIT_LEVEL /SF/Levels/Procs/MidrathProc',
  `Sys [Info]: StreamTrigger: Streaming started on level ${level} layer 256.`,
  `Sys [Info]: ${level}/${code}.lp`,
  `Sys [Info]: ClientImpl::StreamRegion: ${level}/${code}.lp, layer=256, autonomous=0, prefetch=1, priority=low`,
  `Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL ${level}`,
];
const exit = ([, level, code]) => [
  `Script [Info]: LoadTriggers.lua: STATS EXIT_LEVEL ${level}`,
  `Game [Info]: ${level}/${code}.lp fully destroyed [layer=256]`,
  `Sys [Info]: StreamTrigger: Destreaming complete on level ${level}/${code}.lp layer 256.`,
  'Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/MidrathProc',
];

function logWatcher(t) {
  const root = path.resolve(__dirname, '..', '.build', 'dungeon-tests');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'fresh-'));
  const log = path.join(directory, 'EE.log');
  const changes = [];
  const watcher = new DungeonWatcher({ candidates: () => [log], onChange: state => changes.push(state) });
  fs.writeFileSync(log, 'Session started\n');
  watcher._poll();
  t.after(() => {
    watcher.stop();
    assert.equal(path.dirname(directory), root);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const append = line => { fs.appendFileSync(log, `${line}\n`); watcher._poll(); };
  return { watcher, log, changes, append };
}

test('fresh log appends resolve every successive captured visit and re-entry', t => {
  const { watcher, append } = logWatcher(t);
  for (const visit of visits) {
    enter(visit).forEach(append);
    const [, level, code, key] = visit;
    assert.equal(watcher.getState().status, 'ready');
    assert.equal(watcher.getState().levelPath, level);
    assert.equal(watcher.getState().layoutCode, code);
    assert.equal(watcher.getState().key, key);
    exit(visit).forEach(append);
    assert.equal(watcher.getState().active, false);
    assert.equal(watcher._fingerprints.has(level), false, 'exit discards the preceding instance');
  }
});

test('fresh generation split over polling boundaries waits for the complete line', t => {
  const { watcher, log, append } = logWatcher(t);
  const [, level, code] = visits[0];
  append(`Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL ${level}`);
  assert.equal(watcher.getState().status, 'waiting');
  const line = `1224.491 Sys [Info]: ${level}/${code}.lp`;
  const split = line.indexOf(code) + 6;
  fs.appendFileSync(log, line.slice(0, split));
  watcher._poll();
  assert.equal(watcher.getState().layoutCode, null);
  fs.appendFileSync(log, line.slice(split));
  watcher._poll();
  assert.equal(watcher.getState().layoutCode, null);
  fs.appendFileSync(log, '\n');
  watcher._poll();
  assert.equal(watcher.getState().layoutCode, code);
  assert.equal(watcher.getState().status, 'ready');
});

test('startup replay and incremental appends finish on the same fresh generated instance', t => {
  const { watcher, log } = logWatcher(t);
  const lines = visits.flatMap((visit, i) => [...enter(visit), ...(i < visits.length - 1 ? exit(visit) : [])]);
  fs.appendFileSync(log, `${lines.join('\n')}\n`);
  watcher._poll();
  const replay = new DungeonWatcher({ candidates: () => [log] });
  t.after(() => replay.stop());
  replay._poll();
  assert.deepEqual(replay.getState(), watcher.getState());
  assert.equal(replay.getState().layoutCode, visits.at(-1)[2]);
});

test('connected and ENTER generated resource paths resolve their generator and explicit fingerprint', () => {
  const [, level, code, key] = visits[0];
  for (const line of [
    `21.985 Sys [Info]: ===[ Game successfully connected to: ${level}/${code}.lp ]===`,
    `Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL ${level}/${code}.lp`,
  ]) {
    const watcher = new DungeonWatcher();
    watcher._processLine(line);
    assert.equal(watcher.getState().levelPath, level);
    assert.equal(watcher.getState().layoutCode, code);
    assert.equal(watcher.getState().status, 'ready');
    assert.equal(watcher.getState().key, key);
    watcher._processLine(`STATS ENTER_LEVEL ${level}`);
    assert.equal(watcher.getState().layoutCode, code, 'subsequent generator-only entry retains the connected instance');
  }
});

test('an explicit generated ENTER overrides a cached prefetch and stale generated EXIT cannot end it', () => {
  const [, level, first] = visits[0], second = visits[1][2];
  const watcher = new DungeonWatcher();
  watcher._processLine(`Sys [Info]: ${level}/${first}.lp`);
  watcher._processLine(`STATS ENTER_LEVEL ${level}/${second}.lp`);
  assert.equal(watcher.getState().layoutCode, second);
  watcher._processLine(`STATS EXIT_LEVEL ${level}/${first}.lp`);
  assert.equal(watcher.getState().active, true);
  watcher._processLine(`Game [Info]: ${level}/${first}.lp fully destroyed [layer=256]`);
  assert.equal(watcher.getState().active, true);
  watcher._processLine(`STATS EXIT_LEVEL ${level}/${second}.lp`);
  assert.equal(watcher.getState().active, false);
  assert.equal(watcher._fingerprints.has(level), false);
});

test('generated resource paths use exact index aliases when the generator has an unknown family', () => {
  const level = '/SF/Levels/Procs/Quest/FutureCrypt';
  const watcher = new DungeonWatcher({ getIndex: () => ({ sets: [{ key: 'crypt', set: 'Crypt', level_paths: [level] }] }) });
  watcher._processLine(`Game successfully connected to: ${level}/Abc+123-XYZ.lp ]===`);
  assert.equal(watcher.getState().key, 'crypt');
  assert.equal(watcher.getState().levelPath, level);
  assert.equal(watcher.getState().layoutCode, 'Abc+123-XYZ');
});

test('instance IDs survive destination refinements and change after identical-layout re-entry', () => {
  const watcher = new DungeonWatcher();
  const [location, level, code] = visits[0];
  watcher._processLine(`LoadTriggers.lua: SetCurrentLocation: ${location}`);
  const instance = watcher.getState().instanceId;
  assert.match(instance, /^[a-f0-9]{32}$/);
  for (const line of enter(visits[0]).slice(1)) {
    watcher._processLine(line);
    assert.equal(watcher.getState().instanceId, instance);
  }
  assert.equal(watcher.getState().layoutCode, code);
  exit(visits[0]).forEach(line => watcher._processLine(line));
  enter(visits[0]).forEach(line => watcher._processLine(line));
  assert.notEqual(watcher.getState().instanceId, instance);
  assert.equal(watcher.getState().levelPath, level);
  assert.equal(watcher.getState().layoutCode, code);
});

test('log replay retains entry IDs and physical replacement gives a new incarnation', t => {
  const { watcher, log, append } = logWatcher(t);
  enter(visits[0]).forEach(append);
  const first = watcher.getState().instanceId;
  const replay = new DungeonWatcher({ candidates: () => [log] });
  t.after(() => replay.stop()); replay._poll();
  assert.equal(replay.getState().instanceId, first);
  const text = fs.readFileSync(log, 'utf8');
  fs.renameSync(log, `${log}.old`); fs.writeFileSync(log, text);
  watcher._poll();
  assert.notEqual(watcher.getState().instanceId, first);
  const secondReplay = new DungeonWatcher({ candidates: () => [log] });
  t.after(() => secondReplay.stop()); secondReplay._poll();
  assert.equal(secondReplay.getState().instanceId, watcher.getState().instanceId);
});

test('outside context distinguishes the overworld from the tower and logout clears it', () => {
  const watcher = new DungeonWatcher();
  watcher._processLine('STATS ENTER_LEVEL /SF/Levels/MidrathRedux');
  const world = watcher.getState();
  assert.equal(world.active, false); assert.equal(world.levelPath, '/SF/Levels/MidrathRedux');
  assert.match(world.instanceId, /^[a-f0-9]{32}$/);
  watcher._processLine('Game successfully connected to: /SF/Levels/MidrathRedux');
  assert.equal(watcher.getState().instanceId, world.instanceId);
  watcher._processLine('STATS EXIT_LEVEL /SF/Levels/MidrathRedux');
  assert.equal(watcher.getState().levelPath, undefined);
  watcher._processLine('STATS ENTER_LEVEL /SF/Levels/MidrathRedux');
  assert.notEqual(watcher.getState().instanceId, world.instanceId);
  watcher._processLine('STATS ENTER_LEVEL /SF/Levels/PlayerTower');
  assert.equal(watcher.getState().levelPath, '/SF/Levels/PlayerTower');
  assert.notEqual(watcher.getState().instanceId, world.instanceId);
  watcher._processLine('MainMenu.lua: Main menu - LogOut()');
  assert.deepEqual(watcher.getState(), { status: 'outside', active: false });
});
