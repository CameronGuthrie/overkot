const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ArenaWatcher } = require('../src/modules/arenaWatcher');

const glades = '/SF/Levels/Procs/GladesofAndurin/GladesProcLevel';
const enter = `Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL ${glades}`;
const exit = `Script [Info]: ProcLevelSetup.lua: STATS EXIT_LEVEL ${glades}`;
const physics = '50.000 Physics [Error]: Invalid rigid body /Layer8/Prefab7/HangingDecoration';
// This ordinary message occurred in the running game's EE.log.
const mapTree = '36.867 Script [Info]: MapTree.lua: SparrowLib: Add Sparrow Destination: MapTreeJobBoard0(495, -37, -47), /Layer0/Layer8/Prefab7/MapTreeJobBoard0 [MapTreeJobBoard] , LOW, 1-300';
const wave = ['UnderCityArena.lua: New wave:', '\tWave Number: 7', '\tTier: 2'];
const feed = (watcher, lines) => lines.forEach(line => watcher._processLine(line));
const dungeon = code => ({ active: true, status: 'ready', key: 'underCityMidrath',
  levelPath: '/SF/Levels/Procs/UnderCityGauntlet', layoutCode: code });

test('an incomplete wave block cannot retain its tier in another instance', () => {
  const watcher = new ArenaWatcher();
  feed(watcher, [physics, 'UnderCityArena.lua: New wave:', '\tTier: 4']);
  assert.equal(watcher.getWave(), null);
  watcher.setDungeonState(dungeon('AAwBgA'));
  feed(watcher, [`STATS ENTER_LEVEL ${dungeon('AAwBgA').levelPath}/AAwBgA.lp`]);
  watcher.setTilePresence(true);
  feed(watcher, ['UnderCityArena.lua: New wave:', '\tWave Number: 1']);
  assert.deepEqual(watcher.getWave(), { wave: 1, tier: 0, total: 20 });
});
const loaded = state => `STATS ENTER_LEVEL ${state.levelPath}${state.layoutCode ? `/${state.layoutCode}.lp` : ''}`;

test('decoded arena tiles enable wave tracking without a physics diagnostic', () => {
  const watcher = new ArenaWatcher();
  watcher.setDungeonState(dungeon('AAwBgA')); watcher.setTilePresence(true);
  assert.deepEqual(watcher.getDetection(), { state: 'arena', source: 'tiles' });
  feed(watcher, [loaded(dungeon('AAwBgA')), ...wave]); assert.deepEqual(watcher.getWave(), { wave: 7, tier: 2, total: 20 });
  watcher._processLine(`STATS ENTER_LEVEL ${glades}`);
  assert.equal(watcher.getState(), 'arena', 'Backup location messages cannot override current tile evidence');
});

test('a complete non-arena tile list overrides backup diagnostics and blocks waves', () => {
  const watcher = new ArenaWatcher(); watcher.setDungeonState(dungeon('AEYAAw'));
  feed(watcher, [loaded(dungeon('AEYAAw')), physics, ...wave]); assert.equal(watcher.getState(), 'arena');
  watcher.setTilePresence(false); feed(watcher, [physics, ...wave]);
  assert.deepEqual(watcher.getDetection(), { state: 'no_arena', source: 'tiles' }); assert.equal(watcher.getWave(), null);
});

test('unavailable tile data permits the existing diagnostic fallback', () => {
  const watcher = new ArenaWatcher(); watcher.setDungeonState(dungeon('unavailable'));
  watcher.setTilePresence(null); feed(watcher, [loaded(dungeon('unavailable')), physics, ...wave]);
  assert.deepEqual(watcher.getDetection(), { state: 'arena', source: 'log' }); assert.equal(watcher.getWave().wave, 7);
});

test('a fresh fingerprint clears both previous tile and backup confirmation before decoding', () => {
  const watcher = new ArenaWatcher(); watcher.setDungeonState(dungeon('AAwBgA'));
  watcher.setTilePresence(true); feed(watcher, [loaded(dungeon('AAwBgA')), physics, ...wave]);
  watcher.setDungeonState(dungeon('AEYAAw'));
  assert.deepEqual(watcher.getDetection(), { state: 'unknown', source: 'none' }); assert.equal(watcher.getWave(), null);
  feed(watcher, wave); assert.equal(watcher.getWave(), null);
});

test('same-instance updates and an initially missing fingerprint preserve confirmed waves', () => {
  const watcher = new ArenaWatcher(); watcher.setDungeonState(dungeon(null));
  feed(watcher, [loaded(dungeon(null)), physics, ...wave]);
  watcher.setDungeonState(dungeon('AAwBgA')); watcher.setTilePresence(true);
  watcher.setDungeonState({ ...dungeon('AAwBgA'), name: 'Renamed label' });
  assert.equal(watcher.getWave().wave, 7); assert.equal(watcher.getDetection().source, 'tiles');
});

test('leaving or resetting a dungeon clears waves and rejects late tile confirmation', () => {
  const watcher = new ArenaWatcher(); watcher.setDungeonState(dungeon('AAwBgA')); watcher.setTilePresence(true); feed(watcher, [loaded(dungeon('AAwBgA')), ...wave]);
  watcher.setDungeonState({ active: false, status: 'outside' }); watcher.setTilePresence(true); feed(watcher, [physics, ...wave]);
  assert.deepEqual(watcher.getDetection(), { state: 'not_in_dungeon', source: 'tiles' }); assert.equal(watcher.getWave(), null);
  watcher.setDungeonState({ active: false, status: 'unknown' });
  assert.deepEqual(watcher.getDetection(), { state: 'unknown', source: 'none' });
});

test('same-instance metadata refresh hides its buffered wave and restores it after confirmation', () => {
  const watcher = new ArenaWatcher(), current = dungeon('AAwBgA');
  watcher.setDungeonState(current); watcher.setTilePresence(true); feed(watcher, [loaded(current), ...wave]);
  watcher.setTilePresence(null); assert.equal(watcher.getWave(), null);
  watcher.setDungeonState({ ...current }); watcher.setTilePresence(true);
  assert.deepEqual(watcher.getWave(), { wave: 7, tier: 2, total: 20 });
  watcher.setTilePresence(null); watcher.setTilePresence(false); watcher.setTilePresence(true);
  assert.equal(watcher.getWave(), null, 'A complete negative result discards the buffered wave');
});

test('lagging diagnostics and wave blocks cannot confirm the previous instance', () => {
  const watcher = new ArenaWatcher(), old = dungeon('AAwBgA'), current = dungeon('AEYAAw');
  watcher.setDungeonState(old); watcher.setTilePresence(true); feed(watcher, [loaded(old), physics, ...wave]);
  watcher.setDungeonState(current); watcher.setTilePresence(null);
  feed(watcher, [physics, ...wave]);
  assert.equal(watcher.getState(), 'unknown'); assert.equal(watcher.getWave(), null);
  feed(watcher, [loaded(current), physics, ...wave]);
  assert.deepEqual(watcher.getDetection(), { state: 'arena', source: 'log' });
  assert.equal(watcher.getWave().wave, 7);
});

test('a raw cursor ahead of the selected dungeon cannot leak its physics or wave tier', () => {
  const watcher = new ArenaWatcher(), old = dungeon('AAwBgA'), next = dungeon('AEYAAw');
  watcher.setDungeonState(old); watcher.setTilePresence(true); feed(watcher, [loaded(old), ...wave]);
  feed(watcher, [loaded(next), physics, ...wave]); assert.equal(watcher.getWave(), null);
  watcher.setDungeonState(next); watcher.setTilePresence(true); watcher._processLine('Tier: 9');
  assert.equal(watcher.getWave(), null, 'A trailing tier does not complete the previous block');
  feed(watcher, wave); assert.equal(watcher.getWave().tier, 2);
});

test('background fingerprint prefetch does not change the observed current instance', () => {
  const watcher = new ArenaWatcher(), current = dungeon('AAwBgA');
  watcher.setDungeonState(current); watcher.setTilePresence(true); feed(watcher, [loaded(current), ...wave]);
  watcher._processLine(`Sys [Info]: ${current.levelPath}/AEYAAw.lp`);
  assert.equal(watcher.getWave().wave, 7);
  watcher.setTilePresence(null); watcher._processLine(physics);
  assert.deepEqual(watcher.getDetection(), { state: 'arena', source: 'log' });
});

test('inactive primary state rejects otherwise valid fallback diagnostics and waves', () => {
  const watcher = new ArenaWatcher(); watcher.setDungeonState({ status: 'unknown', active: false });
  feed(watcher, [loaded(dungeon('AAwBgA')), physics, ...wave]);
  assert.deepEqual(watcher.getDetection(), { state: 'unknown', source: 'none' }); assert.equal(watcher.getWave(), null);
});

function scopedLog(t) {
  const root = path.resolve(__dirname, '..', '.build', 'arena-tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'scope-')), filename = path.join(dir, 'EE.log');
  fs.writeFileSync(filename, 'Session started\n');
  const watcher = new ArenaWatcher(); watcher._findLog = () => fs.existsSync(filename) ? filename : null;
  watcher._poll();
  t.after(() => { watcher.stop(); assert.equal(path.dirname(dir), root); fs.rmSync(dir, { recursive: true, force: true }); });
  return { watcher, filename, append(lines) { fs.appendFileSync(filename, lines.join('\n') + '\n'); watcher._poll(); } };
}

test('starting at EOF can bind the current dungeon without replaying historical entry logs', t => {
  const f = scopedLog(t), current = dungeon('AAwBgA');
  f.watcher.setDungeonState(current); f.watcher.setTilePresence(true); f.append(wave);
  assert.deepEqual(f.watcher.getWave(), { wave: 7, tier: 2, total: 20 });
  f.append([loaded(dungeon('AEYAAw')), physics, ...wave]);
  assert.equal(f.watcher.getWave(), null, 'An observed different destination invalidates bootstrap trust');
});

test('unread bytes and partial lines cannot receive EOF trust for a newly selected instance', t => {
  for (const partial of [false, true]) {
    const f = scopedLog(t);
    fs.appendFileSync(f.filename, partial ? physics.slice(0, 20) : `${physics}\n${wave.join('\n')}\n`);
    if (partial) f.watcher._poll();
    f.watcher.setDungeonState(dungeon('AAwBgA')); f.watcher.setTilePresence(null);
    if (partial) fs.appendFileSync(f.filename, physics.slice(20) + '\n' + wave.join('\n') + '\n');
    f.watcher._poll();
    assert.equal(f.watcher.getState(), 'unknown'); assert.equal(f.watcher.getWave(), null);
  }
});

test('a log reset invalidates buffered waves and any existing EOF binding', t => {
  const f = scopedLog(t), current = dungeon('AAwBgA');
  f.watcher.setDungeonState(current); f.watcher.setTilePresence(true); f.append(wave);
  f.watcher.setTilePresence(null); fs.writeFileSync(f.filename, ''); f.watcher._poll();
  f.append([physics, ...wave]); assert.notEqual(f.watcher.getState(), 'arena');
  f.watcher.setTilePresence(true); assert.equal(f.watcher.getWave(), null);
});

test('ordinary entity paths, legacy markers and level names cannot confirm an arena', () => {
  const watcher = new ArenaWatcher({ arenaPattern: ['BossArena', 'ThicketSubboss'] });
  feed(watcher, [enter, mapTree, 'ResourceLoader [Info]: BossArena',
    'ResourceLoader [Info]: GoAxDeadendGarrenRood.level',
    `Game successfully connected to: ${glades}/ThicketSubboss ]===`,
    `STATS ENTER_LEVEL ${glades}/Layer8/Prefab7/`]);
  assert.equal(watcher.getState(), 'no_arena');
});

test('physics diagnostics must contain the arena path on the same line', () => {
  const watcher = new ArenaWatcher();
  feed(watcher, [enter, 'Physics [Error]: Invalid rigid body /Layer8/Prefab6/Decoration',
    'Sys [Error]: Could not find physics material: /EE/Types/Physics/Materials/DeepSnow',
    mapTree, 'Physics [Info]: Loaded /Layer8/Prefab7/Decoration',
    'Sys [Error]: Missing resource /Layer8/Prefab7/Decoration']);
  assert.equal(watcher.getState(), 'no_arena');
});

test('the physics diagnostic confirms an arena even during squad region streaming', () => {
  for (const before of [[], [enter], ['Game successfully connected to: /SF/Levels/MidrathProc ]===']]) {
    for (const diagnostic of [physics, physics.replace('[Error]', '[Warning]'),
      'Phys [Error]: Invalid rigid body /Layer8/Prefab7/Decoration',
      'Sys [Error]: Could not use physics behavior: /Layer8/Prefab7/Decoration']) {
      const watcher = new ArenaWatcher();
      feed(watcher, [...before, diagnostic]);
      assert.equal(watcher.getState(), 'arena');
    }
  }
});

test('wave messages cannot confirm an arena or expose a wave before physics confirmation', () => {
  const waves = [];
  const watcher = new ArenaWatcher({ onWaveChange: info => waves.push(info) });
  feed(watcher, [enter, ...wave]);
  assert.equal(watcher.getState(), 'no_arena');
  assert.equal(watcher.getWave(), null);
  assert.deepEqual(waves, []);
  watcher._processLine(physics);
  assert.equal(watcher.getWave(), null, 'unconfirmed wave messages must not carry forward');
  feed(watcher, wave);
  assert.deepEqual(watcher.getWave(), { wave: 7, tier: 2, total: 20 });
});

test('leaving and re-entering Glades requires a new physics confirmation', () => {
  const watcher = new ArenaWatcher();
  feed(watcher, [enter, physics, ...wave, exit, enter, ...wave]);
  assert.equal(watcher.getState(), 'no_arena');
  assert.equal(watcher.getWave(), null);
  watcher._processLine(physics);
  assert.equal(watcher.getState(), 'arena');
});

test('same-instance Glades connection/streaming preserves an existing physics confirmation', () => {
  const watcher = new ArenaWatcher();
  feed(watcher, [physics, `Game successfully connected to: ${glades} ]===`, enter,
    `Spot-building ${glades}`]);
  assert.equal(watcher.getState(), 'arena');
});

test('tailed partial lines need a complete diagnostic and log reset clears confirmation', t => {
  const root = path.resolve(__dirname, '..', '.build', 'arena-tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'log-'));
  const log = path.join(dir, 'EE.log');
  t.after(() => {
    assert.equal(path.dirname(dir), root);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(log, '');
  const watcher = new ArenaWatcher();
  watcher._findLog = () => fs.existsSync(log) ? log : null;
  watcher._poll();
  fs.appendFileSync(log, `${enter}\n${physics.slice(0, 30)}`);
  watcher._poll();
  assert.equal(watcher.getState(), 'no_arena');
  fs.appendFileSync(log, `${physics.slice(30)}\n${wave.join('\n')}\n`);
  watcher._poll();
  assert.equal(watcher.getState(), 'arena');
  assert.equal(watcher.getWave().wave, 7);
  fs.writeFileSync(log, '');
  watcher._poll();
  assert.equal(watcher.getState(), 'unknown');
  assert.equal(watcher.getWave(), null);
  fs.appendFileSync(log, `${enter}\n${mapTree}\n${wave.join('\n')}\n`);
  watcher._poll();
  assert.equal(watcher.getState(), 'no_arena');
  fs.appendFileSync(log, `${physics}\n`);
  watcher._poll();
  assert.equal(watcher.getState(), 'arena');
  fs.unlinkSync(log);
  watcher._poll();
  assert.equal(watcher.getState(), 'unknown');
});

test('the arena widget hides a stale wave whenever arena presence is unconfirmed', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/widget-host.js'), 'utf8');
  const render = source.slice(source.indexOf('function renderArena()'), source.indexOf('function bindWidgetEvents()'));
  const elements = new Map();
  const context = {
    arenaStatus: 'no_arena', arenaWave: { wave: 7, tier: 2, total: 20 }, t: {},
    $(id) {
      if (!elements.has(id)) elements.set(id, { style: {} });
      return elements.get(id);
    },
  };
  vm.runInNewContext(`${render}\nrenderArena();`, context);
  assert.equal(elements.get('#arena-wave-row').style.display, 'none');
  context.arenaStatus = 'arena';
  vm.runInNewContext(`${render}\nrenderArena();`, context);
  assert.equal(elements.get('#arena-wave-row').style.display, '');
});
