'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodeLayout, placeRooms, transformPoint, FALLEN_FORTRESS_TABLE } = require('../src/modules/dungeonLayout');
const { DungeonWatcher, dungeonSet } = require('../src/modules/dungeonWatcher');
const { DungeonMap, makeScene } = require('../src/modules/dungeonMap');

const level = '/SF/Levels/Procs/FallenFortress/FallenFortressProcLevel';
const code = 'SSMCETyBURHUPG29PZBAQAAAAIAIIgA';
const layoutLine = `${level}/${code}.lp`;
const exitLine = `LoadTriggers.lua: STATS EXIT_LEVEL ${level}`;
const state = { active: true, set: 'FallenFortress', key: 'fallenFortress', levelPath: level, layoutCode: code };

test('labelled fortress captures decode rooms, bosses and loot branches', () => {
  const expected = [
    ['SSMCETyBURHUPG29PZBAQAAAAIAIIgA', 'FFxExitBossThrone', ['FFxDeadEndCollapsedHall', 'FFxDeadEndCorruptedCaveNook']],
    ['SSMEHSYAS4VA8LW15n7BCABAAAAABAEA', 'FFxExitBoss', ['FFxDeadEndCollapsedHall', 'FFxDeadEndHall', 'FFxDeadEndVentilation']],
    ['KSNgALzAiWuGQPVuwCCEAAAAAACAIA', 'FFxExitKnights', ['FFxDeadEndCollapsedHall']],
    ['SSPIQuK4IMIVA9p309kEIAAAAEAAEAQ', 'FFxExitBoss', ['FFxDeadEndVentilation', 'FFxDeadEndCorruptedCaveNook']],
    ['SSMULKCGcUFgOmuk+rewCAgAQAAAAAQRAA', 'FFxExitBoss', ['FFxDeadEndHall', 'FFxDeadEndVentilation', 'FFxDeadEndCollapsedHall']],
  ];
  for (const [capture, boss, pockets] of expected) {
    const decoded = decodeLayout(capture, FALLEN_FORTRESS_TABLE);
    assert.equal(decoded.rooms[0].room, 'FFxStreamingEntranceA');
    assert.equal(decoded.rooms[1].room, 'FFxSpawnTilted');
    assert.equal(decoded.rooms.find(room => /ExitBoss|ExitKnights/.test(room.room)).room, boss);
    assert.deepEqual(decoded.rooms.filter(room => room.room.includes('DeadEnd')).map(room => room.room), pockets);
    assert.equal(decoded.caps[0], 'CapStreamingEntrance');
    const portals = decoded.rooms.reduce((sum, room) => sum + (room.entry.portals?.length ?? room.entry.portal_count), 0);
    assert.equal(decoded.caps.length, portals - 2 * (decoded.rooms.length - 1), 'only unused portals receive caps');
  }
});

test('corrupt layouts and unverified extra serialization sections are rejected', () => {
  for (const bad of ['', 'a', '../path', code.slice(0, 10), code + 'AAAA']) assert.throws(() => decodeLayout(bad, FALLEN_FORTRESS_TABLE));
  assert.throws(() => decodeLayout(code, { ...FALLEN_FORTRESS_TABLE, tree_only: false }), /unavailable/);
});

test('portal assembly aligns doors and reverses their outward facing normals', () => {
  const north = { position: [0, 3.5, 12], normal: [0, 0, 1] };
  const south = { position: [0, 3.5, -2], normal: [0, 0, -1] };
  const east = { position: [10, 0, 0], normal: [1, 0, 0] };
  const decoded = { rooms: [
    { slot: 0, parent: null, entry: { portals: [north] } },
    { slot: 1, parent: 0, parentDoor: 0, ownDoor: 0, entry: { portals: [south, north] } },
    { slot: 2, parent: 1, parentDoor: 1, ownDoor: 0, entry: { portals: [east] } },
  ] };
  const placed = placeRooms(decoded, {});
  assert.deepEqual(placed[1].transform, { x: 0, y: 0, z: 14, rotation: 0 });
  assert.equal(placed[2].transform.rotation, Math.PI / 2);
  const a = transformPoint(north.position, placed[1].transform), b = transformPoint(east.position, placed[2].transform);
  assert.ok(a.every((value, i) => Math.abs(value - b[i]) < 1e-8));
  assert.equal(placeRooms({ rooms: [{ slot: 0, parent: null, entry: {} }, { slot: 1, parent: 0, parentDoor: 0, ownDoor: 0, entry: {} }] }, {}), null);
});

test('room-local data never claims screenshot coordinates are world aligned', () => {
  const table = { ...FALLEN_FORTRESS_TABLE,
    spawns: FALLEN_FORTRESS_TABLE.spawns.map(entry => ({ ...entry, portals: Array.from({ length: entry.portal_count }, () => ({ position: [0, 0, 0], normal: [0, 0, 1] })) })),
    components: FALLEN_FORTRESS_TABLE.components.map(entry => ({ ...entry, portals: Array.from({ length: entry.portal_count }, () => ({ position: [0, 0, 0], normal: [0, 0, 1] })) })),
  };
  const decoded = decodeLayout(code, table);
  const scene = makeScene(decoded, table, { rooms: decoded.rooms.map(room => ({ room: room.room, outline: [{ closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }] })) });
  assert.equal(scene.mode, 'placed');
  assert.equal(scene.coordinateSpace, 'layout-local');
  assert.equal(scene.rooms.length, decoded.rooms.length);
  assert.deepEqual(scene.missingRooms, []);
});

test('watcher handles dungeon entry, fresh fingerprints, multiplayer streams and exits', () => {
  const watcher = new DungeonWatcher();
  watcher._processLine('LoadTriggers.lua: StreamTrigger location is FallenFortressOne');
  assert.equal(watcher.getState().status, 'waiting');
  watcher._processLine('LoadTriggers.lua: STATS EXIT_LEVEL /SF/Levels/Procs/MidrathProc');
  assert.equal(watcher.getState().active, true);
  watcher._processLine(`StreamTrigger: Streaming started on level ${level} layer 256.`);
  watcher._processLine(layoutLine);
  assert.equal(watcher.getState().layoutCode, code);
  watcher._processLine(`ProcLevelSetup.lua: STATS ENTER_LEVEL ${level}`);
  assert.equal(watcher.getState().layoutCode, code, 'enter line preserves the freshly decoded fingerprint');
  watcher._processLine(exitLine);
  assert.equal(watcher.getState().active, false);
  watcher._processLine('Spot-building /SF/Levels/Procs/GladesofAndurin/GladesProcLevel');
  assert.equal(watcher.getState().active, false, 'background Spot-building cannot activate a player dungeon');
  watcher._processLine('LoadTriggers.lua: SetCurrentLocation: GladesofAndurinOne');
  watcher._processLine('StreamTrigger: Streaming started on level /SF/Levels/Procs/GladesofAndurin/GladesProcLevel layer 256.');
  assert.equal(watcher.getState().key, 'gladesofAndurin');
  watcher._processLine('MainMenu.lua: Main menu - LogOut()');
  assert.equal(watcher.getState().active, false);
  watcher._processLine(layoutLine);
  assert.equal(watcher.getState().active, false, 'generated layouts are cached until an entry signal');
  watcher._processLine(`ProcLevelSetup.lua: STATS ENTER_LEVEL ${level}`);
  watcher._processLine('ProcLevelSetup.lua: STATS ENTER_LEVEL /SF/Levels/Procs/FallenFortress/FallenFortressWarsongProcLevel');
  assert.equal(watcher.getState().layoutCode, null, 'another generator cannot retain the preceding normal layout');
  watcher._processLine('/SF/Levels/Procs/Tales/UnderCityTalesThirdProcLevel/ABCDE.lp');
  assert.equal(watcher.getState().key, 'fallenFortress', 'another region fingerprint cannot change current player location');
  watcher._processLine('STATS ENTER_LEVEL /SF/Levels/Procs/Tales/UnderCityTalesThirdProcLevel');
  assert.equal(watcher.getState().key, 'underCityMidrath');
  watcher._processLine('STATS EXIT_LEVEL /SF/Levels/Procs/UnderCityAlleys');
  assert.equal(watcher.getState().active, true, 'a different generator exit cannot end the selected instance');
  watcher._processLine('STATS EXIT_LEVEL /SF/Levels/Procs/Tales/UnderCityTalesThirdProcLevel');
  assert.equal(watcher.getState().active, false);
});

test('startup replay, partial lines, rewrites and stop cannot resurrect stale dungeon instances', t => {
  const root = path.resolve(__dirname, '..', '.build', 'dungeon-tests'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'log-')), log = path.join(directory, 'EE.log'), changes = [];
  const watcher = new DungeonWatcher({ candidates: () => [log], onChange: value => changes.push(value) });
  t.after(() => { watcher.stop(); assert.equal(path.dirname(directory), root); fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync(log, `${layoutLine}\nSTATS ENTER_LEVEL ${level}\n${'unrelated game message\n'.repeat(14000)}${exitLine}\n`);
  watcher._poll(); assert.deepEqual(watcher.getState(), { status: 'unknown', active: false }); assert.equal(changes.length, 0);
  while (watcher._pos < fs.statSync(log).size) watcher._poll();
  assert.equal(changes.length, 1); assert.equal(changes[0].active, false);
  fs.appendFileSync(log, layoutLine); watcher._poll(); assert.equal(watcher.getState().active, false);
  fs.appendFileSync(log, '\n'); watcher._poll(); assert.equal(watcher.getState().active, false);
  fs.appendFileSync(log, `STATS ENTER_LEVEL ${level}\n`); watcher._poll(); assert.equal(watcher.getState().layoutCode, code);
  fs.writeFileSync(log, `New session\n${'unrelated game message\n'.repeat(20000)}`); watcher._poll();
  assert.equal(watcher.getState().active, false);
  while (watcher._pos < fs.statSync(log).size) watcher._poll();
  assert.equal(watcher.getState().active, false);
  watcher._processLine(layoutLine); watcher._processLine(`STATS ENTER_LEVEL ${level}`); watcher.stop(); assert.equal(watcher.getState().active, false);
});

// Minimal location-only reproduction from the user's log. No session or
// account fields are retained in this fixture.
const cliffLevel = '/SF/Levels/Procs/UnderCityCliffCave';
const cliffCode = 'KhGCACHMpRNZ3fAghiCAAQjA';
const cliffEntry = [
  '1223.822 Script [Info]: LoadTriggers.lua: StreamTrigger location is UndercityPortalSproutCave',
  '1223.822 Script [Info]: LoadTriggers.lua: SetCurrentLocation: UndercityPortalSproutCave',
  '1223.822 Script [Info]: LoadTriggers.lua: STATS EXIT_LEVEL /SF/Levels/Procs/MidrathProc',
  `1224.357 Sys [Info]: StreamTrigger: Streaming started on level ${cliffLevel} layer 256.`,
  `1224.491 Sys [Info]: ${cliffLevel}/${cliffCode}.lp`,
  `1224.512 Sys [Info]: ClientImpl::StreamRegion: ${cliffLevel}/${cliffCode}.lp, layer=256, autonomous=0, prefetch=1, priority=low`,
  `1225.336 Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL ${cliffLevel}`,
];
const cliffExit = [
  `1277.945 Script [Info]: LoadTriggers.lua: STATS EXIT_LEVEL ${cliffLevel}`,
  `1277.945 Sys [Info]: StreamTrigger: Destreaming started on level ${cliffLevel} layer 256.`,
  `1278.008 Game [Info]: ${cliffLevel}/${cliffCode}.lp fully destroyed [layer=256]`,
  `1278.008 Sys [Info]: StreamTrigger: Destreaming complete on level ${cliffLevel}/${cliffCode}.lp layer 256.`,
];

test('actual CliffCave log selects its indexed Undercity set and exits without resurrection', () => {
  const watcher = new DungeonWatcher();
  cliffEntry.forEach(line => watcher._processLine(line));
  const { instanceId, ...state } = watcher.getState();
  assert.match(instanceId, /^[a-f0-9]{32}$/);
  assert.deepEqual(state, { status: 'ready', active: true, set: 'UnderCityMidrath', key: 'underCityMidrath', name: 'Undercity', levelPath: cliffLevel, layoutCode: cliffCode });
  cliffExit.forEach(line => watcher._processLine(line));
  assert.equal(watcher.getState().active, false);
  cliffExit.slice(1).forEach(line => watcher._processLine(line));
  assert.equal(watcher.getState().active, false, 'repeated .lp destruction does not reopen the dungeon');
  watcher._processLine(cliffEntry[4]);
  assert.equal(watcher.getState().active, false, 'a fresh raw fingerprint also waits for an actual entry');
  watcher._processLine(cliffEntry.at(-1));
  assert.equal(watcher.getState().layoutCode, cliffCode, 'a fresh trip consumes the cached fingerprint');
});

test('prefetch/resource/destruction paths cannot activate or replace player location', () => {
  const watcher = new DungeonWatcher();
  watcher._processLine(`Sys [Info]: ${cliffLevel}/${cliffCode}.lp`);
  watcher._processLine(`ClientImpl::StreamRegion: ${cliffLevel}/${cliffCode}.lp, prefetch=1`);
  watcher._processLine(`StreamTrigger: Streaming started on level ${cliffLevel} layer 256.`);
  watcher._processLine(`Spot-building ${cliffLevel}`);
  assert.equal(watcher.getState().active, false);
  watcher._processLine(`STATS ENTER_LEVEL ${cliffLevel}`);
  assert.equal(watcher.getState().layoutCode, cliffCode);
  watcher._processLine(`Sys [Info]: ${cliffLevel}/ANewPrefetchedCode.lp`);
  watcher._processLine(`Game [Info]: ${cliffLevel}/ANewPrefetchedCode.lp fully destroyed [layer=257]`);
  assert.equal(watcher.getState().layoutCode, cliffCode, 'another generated instance cannot overwrite the active fingerprint');
  watcher._processLine(`${level}/${code}.lp`);
  assert.equal(watcher.getState().levelPath, cliffLevel, 'an unrelated generated dungeon cannot steal selection');
  watcher._processLine(`Game [Info]: ${cliffLevel}/AnOldInstance.lp fully destroyed [layer=256]`);
  assert.equal(watcher.getState().active, true, 'destruction of a different fingerprint cannot close the active instance');
});

test('all current generator alias families classify correctly, including index-defined future paths', () => {
  for (const generator of ['UnderCityAllTiles', 'UnderCityAlleys', 'UnderCityBaseShort', 'UnderCityCliffCave', 'UnderCityCliffTown',
    'UnderCityForge', 'UnderCityGaol', 'UnderCityGauntlet', 'UnderCityGranary', 'UnderCityManor', 'UnderCityMill',
    'UnderCityNeighbourhood', 'UnderCityTestOne', 'UnderCityTheater', 'UnderCityTreasury']) assert.equal(dungeonSet(`/SF/Levels/Procs/${generator}`).key, 'underCityMidrath');
  for (const name of ['Alleys', 'BasePuzzles', 'Bastions', 'CliffCave', 'CliffTown', 'Forge', 'Gaol', 'Granary', 'Manor', 'Mine', 'Theater', 'Treasury']) assert.equal(dungeonSet(`/SF/Levels/Procs/Tales/UnderCityTales${name}`).key, 'underCityMidrath');
  for (const name of ['GladesTales', 'GladesTalesCorrupted']) assert.equal(dungeonSet(`/SF/Levels/Procs/Tales/${name}`).key, 'gladesofAndurin');
  assert.equal(dungeonSet('/SF/Levels/Procs/Quest/OrengallPupRescueUCMill').key, 'underCityMidrath');
  assert.equal(dungeonSet('/SF/Levels/Procs/UnderCityUnregistered'), null, 'unknown root aliases are not guessed');
  const watcher = new DungeonWatcher({ getIndex: () => ({ sets: [{ key: 'crypt', set: 'Crypt', level_paths: ['/SF/Levels/Procs/Quest/FutureCrypt'] }] }) });
  watcher._processLine('STATS ENTER_LEVEL /SF/Levels/Procs/Quest/FutureCrypt');
  assert.equal(watcher.getState().key, 'crypt');
});

test('map service uses matching extracted config and does not invent maps for unsupported sets', async () => {
  const decoded = decodeLayout(code, FALLEN_FORTRESS_TABLE);
  const dataManager = {
    checkForUpdates: async () => {}, ensureAsset: async () => {}, getInfo: () => ({ version: 'feed' }),
    readJSON: key => key.endsWith('rooms.json') ? { rooms: decoded.rooms.map(room => ({ room: room.room, outline: [{ points: [[0, 0], [10, 10]], closed: false }] })) } : null,
  };
  const service = new DungeonMap({ dataManager });
  const scene = await service.getSnapshot(state);
  assert.equal(scene.mode, 'schematic'); assert.equal(scene.rooms.length, decoded.rooms.length);
  const unsupported = await service.getSnapshot({ ...state, set: 'Crypt', key: 'crypt' });
  assert.equal(unsupported.reason, 'unsupported'); assert.equal(unsupported.mode, 'unavailable');
  assert.deepEqual(unsupported.rooms, []); assert.equal(unsupported.bounds, null);
  const waiting = await service.getSnapshot({ ...state, layoutCode: null });
  assert.equal(waiting.reason, 'waiting'); assert.equal(waiting.mode, 'unavailable');
  assert.deepEqual(waiting.rooms, []); assert.equal(waiting.bounds, null);
  const corrupt = await service.getSnapshot({ ...state, layoutCode: 'invalid-fingerprint' });
  assert.equal(corrupt.reason, 'decode'); assert.equal(corrupt.mode, 'unavailable');
  assert.deepEqual(corrupt.rooms, []); assert.equal(corrupt.bounds, null);
  assert.equal((await service.getSnapshot({ active: false })).reason, 'outside');
});

test('feed index resolves generators whose directory differs from their room set', async () => {
  const requested = [];
  const dataManager = { checkForUpdates: async () => {}, getInfo: () => ({ version: 'indexed' }),
    ensureAsset: async key => requested.push(key), readJSON: key => key === 'dungeons/index.json'
      ? { sets: [{ key: 'underCityMidrath', level_paths: ['/SF/Levels/Procs/UnderCityAlleys'] }] }
      : key.endsWith('rooms.json') ? { rooms: [{ room: 'UnderCityEntranceHall', outline: [{ points: [[0, 0], [10, 10]], closed: false }] }] } : null };
  const result = await new DungeonMap({ dataManager }).getSnapshot({ active: true, set: 'UnderCityAlleys', key: 'underCity', levelPath: '/SF/Levels/Procs/UnderCityAlleys', layoutCode: 'code' });
  assert.equal(result.mode, 'unavailable'); assert.deepEqual(result.rooms, []);
  assert.ok(requested.includes('dungeons/underCityMidrath/rooms.json'));
});

test('same-version data retries recover missing and partial room geometry', async () => {
  const component = entry => ({ ...entry, portals: Array.from({ length: entry.portal_count }, () => ({ position: [0, 0, 0], normal: [0, 0, 1] })) });
  const table = { ...FALLEN_FORTRESS_TABLE, level_path: level,
    spawns: FALLEN_FORTRESS_TABLE.spawns.map(component), components: FALLEN_FORTRESS_TABLE.components.map(component) };
  const decoded = decodeLayout(code, table);
  const complete = { rooms: [...new Set(decoded.rooms.map(room => room.room))].map(room => ({ room,
    outline: [{ closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }] })) };
  let geometry = null, roomReads = 0;
  const dataManager = { checkForUpdates: async () => {}, ensureAsset: async () => {}, getInfo: () => ({ version: 'unchanged-feed' }),
    readJSON: key => {
      if (key.endsWith('/rooms.json')) { roomReads++; return geometry; }
      return key.endsWith('/layouts.json') ? { layouts: [table] } : null;
    } };
  const service = new DungeonMap({ dataManager });
  const missing = await service.getSnapshot(state);
  assert.equal(missing.mode, 'unavailable'); assert.equal(missing.reason, 'data');
  assert.deepEqual(missing.rooms, [], 'Unavailable geometry cannot appear as a cached generated map');

  const missingRoom = decoded.rooms.at(-1).room;
  geometry = { rooms: complete.rooms.filter(room => room.room !== missingRoom) };
  const partial = await service.getSnapshot(state);
  assert.equal(partial.version, missing.version); assert.equal(partial.mode, 'placed');
  assert.deepEqual(partial.missingRooms, [missingRoom]);
  assert.ok(partial.rooms.some(room => room.outline.length), 'Available outlines remain useful while a room is missing');

  geometry = complete;
  const recovered = await service.getSnapshot(state);
  assert.equal(recovered.version, missing.version); assert.deepEqual(recovered.missingRooms, []);
  assert.ok(recovered.rooms.every(room => room.outline.length), 'Same-version retry reads the recovered outlines');
  assert.equal(roomReads, 3, 'Both the absent and partial geometry results are retried');
  await service.getSnapshot(state);
  assert.equal(roomReads, 3, 'The fully recovered scene can be reused without another geometry read');
});

test('layout metadata exposes placed room frames without loading outlines or leaking portal data', async () => {
  const component = entry => ({ ...entry, portals: Array.from({ length: entry.portal_count }, (_, i) => ({
    position: [i * 7, i * 2, 12 - i * 5], normal: [0, 0, i % 2 ? -1 : 1],
  })) });
  const table = { ...FALLEN_FORTRESS_TABLE, level_path: level, origin: [8, 3, -17], rotation: .25,
    spawns: FALLEN_FORTRESS_TABLE.spawns.map(component), components: FALLEN_FORTRESS_TABLE.components.map(component) };
  const requested = [];
  const service = new DungeonMap({ dataManager: { getInfo: () => ({ version: 'frames' }), checkForUpdates: async () => {},
    ensureAsset: async key => { requested.push(key); if (key.endsWith('/rooms.json')) throw Error('Outlines unavailable'); },
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: [table] } : null } });
  const result = await service.getLayoutSnapshot(state);
  assert.equal(result.status, 'ready'); assert.equal(result.coordinateSpace, 'layout-local');
  const expected = placeRooms(decodeLayout(code, table), table);
  assert.deepEqual(result.rooms.map(room => room.transform), expected.map(room => room.transform));
  assert.deepEqual(result.rooms[0].transform, { x: 8, y: 3, z: -17, rotation: .25 });
  assert.ok(result.rooms.slice(1).some(room => room.transform.x !== 8 || room.transform.z !== -17));
  assert.ok(result.rooms.every(room => !('entry' in room) && !('portals' in room) && !('outline' in room)));
  assert.equal(requested.some(key => key.endsWith('/rooms.json')), false);
  result.rooms[0].transform.x = 999;
  assert.equal((await service.getLayoutSnapshot(state)).rooms[0].transform.x, 8, 'A caller cannot alter cached room frames');
});

test('metadata leaves unknown placement explicit and keeps supported world coordinates unchanged', async () => {
  const service = table => new DungeonMap({ dataManager: { getInfo: () => ({ version: 'frames' }),
    checkForUpdates: async () => {}, ensureAsset: async () => {},
    readJSON: key => key.endsWith('/layouts.json') ? { layouts: [table] } : null } });
  const schematic = await service({ ...FALLEN_FORTRESS_TABLE, level_path: level }).getLayoutSnapshot(state);
  assert.equal(schematic.status, 'ready');
  assert.ok(schematic.rooms.length > 2 && schematic.rooms.every(room => room.transform === null),
    'Decoded topology without portal frames cannot supply guessed placement');
  const component = entry => ({ ...entry, portals: Array.from({ length: entry.portal_count }, () => ({ position: [0, 0, 0], normal: [0, 0, 1] })) });
  const world = await service({ ...FALLEN_FORTRESS_TABLE, level_path: level, coordinate_space: 'world', origin: [11, 4, -9],
    spawns: FALLEN_FORTRESS_TABLE.spawns.map(component), components: FALLEN_FORTRESS_TABLE.components.map(component) }).getLayoutSnapshot(state);
  assert.equal(world.coordinateSpace, 'world');
  assert.deepEqual(world.rooms[0].transform, { x: 11, y: 4, z: -9, rotation: 0 });
  const outside = await service(FALLEN_FORTRESS_TABLE).getLayoutSnapshot({ active: false });
  assert.equal(outside.status, 'unavailable'); assert.equal(outside.coordinateSpace, null); assert.deepEqual(outside.rooms, []);
});
