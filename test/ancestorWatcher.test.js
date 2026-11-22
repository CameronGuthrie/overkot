const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AncestorWatcher } = require('../src/modules/ancestorWatcher');

const encounter = '/SF/Types/Game/Encounters/Ambient/Dynamic/DynamicGodsAndGhostEncounter';
const hint = '/Layer0/GodsAndGhostsContainerHint1';
// The position and lifecycle syntax mirror ENCMGR lines in the local EE.log.
const start = (id = hint, name = encounter, coords = '-1098.65, -81.85, -430.75') =>
  `100.000 AI [Info]: ENCMGR: Encounter ${name} started at ${id} at pos [(${coords}, 0)]`;
const boon = (name = 'GarrenRoodBoonNpc', seconds = '100.001') =>
  `${seconds} ResourceLoader [Info]: Loading (/SF/Types/Npcs/BoonNPC/${name})`;
const end = (id = hint, action = 'has completed', brackets = true) =>
  `101.000 AI [Info]: ENCMGR: Encounter ${brackets ? `[${encounter}]` : encounter} ${action} on hint ${brackets ? `[${id}]` : id} at pos [(0, 0, 0, 0)] status ES_NONE`;
const feed = (watcher, lines) => lines.forEach(line => watcher._processLine(line));

function withLog(t, content = '') {
  const root = path.resolve(__dirname, '..', '.build', 'ancestor-tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'log-'));
  const log = path.join(dir, 'EE.log');
  const changes = [];
  const watcher = new AncestorWatcher({ onChange: entries => changes.push(entries) });
  watcher._findLog = () => fs.existsSync(log) ? log : null;
  fs.writeFileSync(log, content);
  t.after(() => {
    watcher.stop();
    assert.equal(path.dirname(dir), root);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { watcher, log, changes };
}

test('ancestor discovery preserves world x/z and strips the BoonNpc resource suffix', () => {
  const watcher = new AncestorWatcher();
  feed(watcher, [start(), boon()]);
  const [entry] = watcher.getAncestors();
  assert.equal(entry.ancestorName, 'Garren Rood');
  assert.equal(entry.ancestorRaw, 'GarrenRoodBoonNpc');
  assert.equal(entry.id, hint);
  assert.deepEqual([entry.x, entry.y, entry.z], [-1098.65, -81.85, -430.75]);
  entry.x = 999;
  assert.equal(watcher.getAncestors()[0].x, -1098.65, 'consumers cannot mutate stored coordinates');
});

test('all eight pipeline candidate resource names resolve to readable labels', () => {
  for (const [raw, name] of [
    ['GarrenRoodBoonNpc', 'Garren Rood'], ['BromiusBoonNpc', 'Bromius'],
    ['OrengallBoonNpc', 'Orengall'], ['MooseBoonNpc', 'Moose'],
    ['ZenithBoonNpc', 'Zenith'], ['TuvalkaneBoonNpc', 'Tuvalkane'],
    ['VerminiaBoonNpc', 'Verminia'], ['OrlickBoonNpc', 'Orlick'],
  ]) {
    const watcher = new AncestorWatcher();
    feed(watcher, [start(), boon(raw)]);
    assert.equal(watcher.getAncestors()[0].ancestorName, name);
  }
});

test('resource preloads, failed hints and unrelated encounters do not create markers or broadcasts', () => {
  const changes = [];
  const watcher = new AncestorWatcher({ onChange: value => changes.push(value) });
  feed(watcher, [
    `Game [Info]: ${encounter}`,
    `AI [Info]: Hint ${hint} missing tags required by Encounter ${encounter}: No valid EnvironmentTags.`,
    boon(),
    start('/DynamicRandomEncounterHint2', '/SF/Types/Game/Encounters/Ambient/SquirrelWildlifeEncounter'),
    end('/DynamicRandomEncounterHint2'),
  ]);
  assert.deepEqual(watcher.getAncestors(), []);
  assert.deepEqual(changes, []);
  assert.equal(watcher._encounters.size, 0);
});

test('helper resources cannot consume or overwrite the nearby ancestor identification', () => {
  const watcher = new AncestorWatcher();
  feed(watcher, [start(), boon('BoonNpcCameraSpot'), boon('BoonNpcConversationAction')]);
  assert.equal(watcher.getAncestors()[0].ancestorName, null);
  feed(watcher, [boon('VerminiaBoonNpc'), boon('OrlickBoonNpc')]);
  assert.equal(watcher.getAncestors()[0].ancestorName, 'Verminia');
});

test('a later encounter receives its own name and does not relabel an earlier encounter', () => {
  const watcher = new AncestorWatcher();
  feed(watcher, [start(), start('/SecondHint'), boon('BromiusBoonNpc')]);
  assert.deepEqual(watcher.getAncestors().map(e => e.ancestorName), [null, 'Bromius']);
  feed(watcher, [end('/SecondHint'), boon('OrlickBoonNpc')]);
  assert.equal(watcher.getAncestors()[0].ancestorName, null);
});

test('distant BoonNPC loads cannot incorrectly name an old pending encounter', () => {
  const timed = new AncestorWatcher();
  feed(timed, [start(), boon('OrlickBoonNpc', '110.000')]);
  assert.equal(timed.getAncestors()[0].ancestorName, null);

  const busy = new AncestorWatcher();
  feed(busy, [start(), ...Array(65).fill('100.001 Game [Info]: unrelated log activity'), boon()]);
  assert.equal(busy.getAncestors()[0].ancestorName, null);
});

test('completion and abandonment remove bracketed and unbracketed hints and pending names', () => {
  for (const action of ['has completed', 'was abandoned']) {
    for (const brackets of [true, false]) {
      const watcher = new AncestorWatcher();
      feed(watcher, [start(`[${hint}]`, `[${encounter}]`), end(hint, action, brackets), boon()]);
      assert.deepEqual(watcher.getAncestors(), []);
    }
  }
});

test('logout and level transitions remove every marker and pending identification', () => {
  for (const reset of [
    'MainMenu.lua: Main menu - LogOut()', 'QUIT :Logged out of game',
    'ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/MidrathProc',
    'ProcLevelSetup.lua: STATS EXIT_LEVEL /SF/Levels/Procs/MidrathProc',
    'LoginScripts.lua: STATS ENTER_LEVEL /SF/Levels/Procs/MidrathProc',
  ]) {
    const watcher = new AncestorWatcher();
    feed(watcher, [start(), boon(), start('/SecondHint'), reset, boon()]);
    assert.deepEqual(watcher.getAncestors(), []);
  }
});

test('numeric formats remain world coordinates and non-finite positions are rejected', () => {
  const watcher = new AncestorWatcher();
  watcher._processLine(start(hint, encounter, '+1.25e2, -.5, -4.3075e2'));
  assert.deepEqual(watcher.getAncestors().map(e => [e.x, e.y, e.z]), [[125, -0.5, -430.75]]);
  watcher._processLine(start('/Overflow', encounter, '1e999, 0, 1'));
  assert.equal(watcher.getAncestors().length, 1);
});

test('startup replay publishes only active ancestors after all old lifecycle events', t => {
  const padding = `${'Game [Info]: unrelated\n'.repeat(13000)}`;
  const { watcher, log, changes } = withLog(t,
    `${start()}\n${boon()}\n${padding}${end()}\n${start('/ActiveHint')}\n${boon('OrlickBoonNpc')}\n`);
  watcher._poll();
  assert.deepEqual(watcher.getAncestors(), [], 'partial replay must not resurrect a completed ancestor');
  assert.deepEqual(changes, []);
  while (watcher._pos < fs.statSync(log).size) watcher._poll();
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].map(e => [e.id, e.ancestorName]), [['/ActiveHint', 'Orlick']]);
});

test('startup replay ending in logout cannot flash old markers', t => {
  const { watcher, changes } = withLog(t, `${start()}\n${boon()}\nMainMenu.lua: Main menu - LogOut()\n`);
  watcher._poll();
  assert.deepEqual(watcher.getAncestors(), []);
  assert.ok(changes.every(entries => entries.length === 0));
});

test('tailing waits for complete lines and batches encounter plus name into one update', t => {
  const { watcher, log, changes } = withLog(t);
  watcher._poll();
  const partial = start();
  fs.appendFileSync(log, partial.slice(0, -6));
  watcher._poll();
  assert.deepEqual(changes, []);
  fs.appendFileSync(log, `${partial.slice(-6)}\r\n${boon()}\r\n`);
  watcher._poll();
  assert.equal(changes.length, 1);
  assert.equal(changes[0][0].ancestorName, 'Garren Rood');
  fs.appendFileSync(log, `${end()}\n`);
  watcher._poll();
  assert.deepEqual(changes[1], []);
});

test('log truncation, larger rewrites and disappearance clear previous discoveries', t => {
  const { watcher, log, changes } = withLog(t, `${start()}\n${boon()}\n`);
  watcher._poll();
  assert.equal(watcher.getAncestors().length, 1);
  fs.writeFileSync(log, '');
  watcher._poll();
  assert.deepEqual(watcher.getAncestors(), []);
  fs.writeFileSync(log, `${start()}\n${boon()}\n`);
  watcher._poll();
  assert.equal(watcher.getAncestors().length, 1);
  fs.writeFileSync(log, `NEW SESSION\n${'Game [Info]: unrelated\n'.repeat(30)}`);
  watcher._poll();
  assert.deepEqual(watcher.getAncestors(), []);
  fs.appendFileSync(log, `${start('/NewHint')}\n${boon('BromiusBoonNpc')}\n`);
  watcher._poll();
  assert.equal(watcher.getAncestors()[0].ancestorName, 'Bromius');
  fs.unlinkSync(log);
  watcher._poll();
  assert.deepEqual(changes.at(-1), []);
});

test('starting twice keeps one polling timer and stop releases all scheduled reads', t => {
  const { watcher } = withLog(t);
  watcher.start();
  const interval = watcher._interval;
  watcher.start();
  assert.equal(watcher._interval, interval);
  watcher.stop();
  assert.equal(watcher._interval, null);
  assert.equal(watcher._drainTimer, null);
});

test('stopping clears active markers and restarting replays the current session with fresh pairing', t => {
  const { watcher, log, changes } = withLog(t, `${start()}\n${boon()}\n${start('/PendingHint')}\n`);
  watcher.start();
  assert.equal(watcher.getAncestors().length, 2);
  assert.ok(watcher._pendingBoon);
  watcher.stop();
  assert.deepEqual(watcher.getAncestors(), []);
  assert.deepEqual(changes.at(-1), []);
  assert.equal(watcher._pendingBoon, null);
  assert.equal(watcher._filePath, null);

  // A new game's log must not identify a pending encounter from the old one.
  fs.writeFileSync(log, `${boon('OrlickBoonNpc')}\n${start('/CurrentHint')}\n${boon('BromiusBoonNpc')}\n`);
  watcher.start();
  assert.deepEqual(watcher.getAncestors().map(e => [e.id, e.ancestorName]), [['/CurrentHint', 'Bromius']]);

  // Restart also reconstructs an active encounter when the file is unchanged.
  watcher.stop();
  watcher.start();
  assert.deepEqual(watcher.getAncestors().map(e => [e.id, e.ancestorName]), [['/CurrentHint', 'Bromius']]);
});
