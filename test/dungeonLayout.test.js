'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cliff = require('./fixtures/underCityCliffCave.json');
const cliffTown = require('./fixtures/underCityCliffTown.json');
const glades = require('./fixtures/gladesProcLevel.json');
const { decodeLayout, supportsLayout, placeRooms, transformPoint, portalPose, FALLEN_FORTRESS_TABLE } = require('../src/modules/dungeonLayout');

// Independent live EE.log captures, 2026-10-03. The compact fixture preserves
// the extracted portal transforms for every room used by either capture.
const firstCode = 'KhGCACHMpRNZ3fAghiCAAQjA';
const secondCode = 'ShGaIa5IZlKJq676AAGIIAhAEYA';
const shape = decoded => decoded.rooms.map(({ room, parent, parentDoor, ownDoor }) => [room, parent, parentDoor, ownDoor]);

function replaceBits(code, start, width, value) {
  const bytes = Buffer.from(code.replace(/-/g, '/'), 'base64');
  for (let i = 0; i < width; i++) {
    const position = start + i, mask = 1 << (7 - (position & 7));
    if ((value >> (width - 1 - i)) & 1) bytes[position >> 3] |= mask;
    else bytes[position >> 3] &= ~mask;
  }
  return bytes.toString('base64').replace(/\//g, '-').replace(/=+$/, '');
}

test('first real Cliff Cave capture decodes eight rooms and its complete native tail', () => {
  assert.equal(supportsLayout(cliff), true);
  const decoded = decodeLayout(firstCode, cliff);
  assert.deepEqual(shape(decoded), [
    ['UnderCityEntranceHall', null, null, null],
    ['UnderCitySpawnFortified', 0, 1, 2],
    ['UnderCityConBrewery', 1, 1, 2],
    ['UnderCityIntCliffCave', 2, 0, 2],
    ['UnderCitySpecialCheckpointA', 3, 1, 0],
    ['UnderCityExitBossA', 4, 1, 2],
    ['UnderCityExitStreamingTileA', 5, 1, 0],
    ['UnderCityDeadEndCavedInC', 3, 3, 0],
  ]);
  assert.deepEqual(decoded.capPlacements.map(({ slot, door, index }) => [slot, door, index]), [
    [0, 0, 6], [1, 0, 0], [2, 1, 1], [3, 0, 0], [3, 4, 1], [5, 0, 0], [6, 1, 3],
  ]);
  assert.deepEqual(decoded.attachments.map(({ category, index }) => [category, index]), [
    [0, 2], [0, 1], [0, 0], [0, 0], [0, 1], [0, 1], [0, 3],
  ]);
  assert.equal(decoded.attachments.at(-1).none, true);
  assert.equal(decoded.rooms[0].caps[1], null);
  assert.equal(decoded.cinematic, null);
});

test('second independently captured Cliff Cave has a different nine-room hierarchy', () => {
  const decoded = decodeLayout(secondCode, cliff);
  assert.deepEqual(shape(decoded), [
    ['UnderCityEntranceHall', null, null, null],
    ['UnderCitySpawnFortified', 0, 1, 2],
    ['UnderCityConJunctionHall', 1, 1, 2],
    ['UnderCityObjCrypt', 2, 1, 1],
    ['UnderCityConJunctionPassage', 3, 3, 2],
    ['UnderCitySpecialCheckpointA', 4, 0, 0],
    ['UnderCityExitBossA', 5, 1, 2],
    ['UnderCityExitStreamingTileA', 6, 1, 0],
    ['UnderCityDeadEndCavedInC', 3, 2, 0],
  ]);
  assert.deepEqual(decoded.capPlacements.map(({ slot, door, index }) => [slot, door, index]), [
    [0, 0, 5], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 1, 0], [6, 0, 0], [7, 1, 3],
  ]);
  assert.deepEqual(decoded.attachments.map(entry => entry.index), [2, 1, 0, 1, 1, 0, 1, 3]);
  assert.equal(decoded.backBits, 3);
});

test('all real Cliff Cave connections align the actual baked doors and opposite normals', () => {
  for (const code of [firstCode, secondCode]) {
    const placed = placeRooms(decodeLayout(code, cliff), cliff);
    assert.ok(placed);
    for (const child of placed.slice(1)) {
      const parent = placed[child.parent];
      const parentPortal = parent.entry.portals[child.parentDoor];
      const childPortal = child.entry.portals[child.ownDoor];
      const a = transformPoint(parentPortal.position, parent.transform);
      const b = transformPoint(childPortal.position, child.transform);
      assert.ok(a.every((n, i) => Math.abs(n - b[i]) < 1e-7), `room ${child.slot} door position`);
      const parentHeading = portalPose(parentPortal).heading + parent.transform.rotation;
      const childHeading = portalPose(childPortal).heading + child.transform.rotation;
      assert.ok(Math.abs(Math.cos(parentHeading - childHeading) + 1) < 1e-9, `room ${child.slot} facing`);
    }
  }
});

// Fresh trips captured after the original two-generator implementation. These
// use different component tables and must consume the complete native tail.
const freshCaptures = [
  [cliffTown, 'ShF45xiBqkiijMpxNZ2XU-QAGIIQACEAABGA', [
    'UnderCityEntranceHall', 'UnderCitySpawnFortified', 'UnderCityConStairs', 'UnderCitySpecialCheckpointA',
    'UnderCityConHouseA', 'UnderCityObjCrypt', 'UnderCityConJunctionPassage', 'UnderCityConHallwaysB',
    'UnderCitySpecialCheckpointA', 'UnderCityExitBossB', 'UnderCityExitStreamingTileA', 'UnderCityDeadEndCavedIn', 'UnderCityDeadEndHomeC',
  ]],
  [cliffTown, 'SeJaAJFQ5lSJqxhhy-AkBiAAAAgCMA', [
    'UnderCityEntranceHall', 'UnderCitySpawnD', 'UnderCityConBridgesA', 'UnderCityIntCliffCave',
    'UnderCityConShortStairwell', 'UnderCitySpecialCheckpointA', 'UnderCityExitBossC', 'UnderCityExitStreamingTileA',
    'UnderCityDeadEndRubble', 'UnderCityDeadEndRubbleC',
  ]],
  [glades, 'SeXCNGh9IRWPOteCiCAIQgAI', [
    'GoAxStreamingTileA', 'GoAxSpawnCorruptedRuins', 'GoAxConCorruptedCaveA', 'GoAxConB', 'GoAxConJauntZigZag',
    'GoAxSpecialCheckpointA', 'GoAxExitBossOpening', 'GoAxStreamingExitA', 'GoAxDeadendCorruptedStags', 'GoAxDeadendCorruptedDen',
  ]],
  [glades, 'SeHISGp8YRV2uu+AiCAIAAAI', [
    'GoAxStreamingTileA', 'GoAxSpawnCorruptedRuins', 'GoAxConCorruptedCaveA', 'GoAxConJauntRuinsTiered', 'GoAxConJauntPond',
    'GoAxSpecialCheckpointA', 'GoAxExitBossOpening', 'GoAxStreamingExitA', 'GoAxDeadendCorruptedDen', 'GoAxDeadEndBramble',
  ]],
];

test('fresh Cliff Town and Glades trips decode their own selected rooms and exact doorway placements', () => {
  for (const [table, code, expected] of freshCaptures) {
    assert.equal(supportsLayout(table), true);
    const decoded = decodeLayout(code, table);
    assert.deepEqual(decoded.rooms.map(room => room.room), expected);
    assert.equal(decoded.attachments.length, expected.length - 1);
    const placed = placeRooms(decoded, table);
    assert.ok(placed);
    for (const child of placed.slice(1)) {
      const parent = placed[child.parent];
      const parentPortal = parent.entry.portals[child.parentDoor], childPortal = child.entry.portals[child.ownDoor];
      const a = transformPoint(parentPortal.position, parent.transform), b = transformPoint(childPortal.position, child.transform);
      assert.ok(a.every((n, i) => Math.abs(n - b[i]) < 1e-7), `${table.level_path} slot ${child.slot}`);
      const heading = portalPose(parentPortal).heading + parent.transform.rotation - portalPose(childPortal).heading - child.transform.rotation;
      assert.ok(Math.abs(Math.cos(heading) + 1) < 1e-9);
    }
    assert.throws(() => decodeLayout(code + 'AAAA', table), /padding/, 'New generators retain complete-tail validation');
  }
});

test('six labelled fortress captures keep their rooms with the native unused-door caps', () => {
  const captures = [
    ['SSMCETyBURHUPG29PZBAQAAAAIAIIgA', 11, 'FFxExitBossThrone', [3, 1, 0, 1, 0]],
    ['SSMEHSYAS4VA8LW15n7BCABAAAAABAEA', 12, 'FFxExitBoss', [3, 0, 1]],
    ['KSNgALzAiWuGQPVuwCCEAAAAAACAIA', 11, 'FFxExitKnights', [3, 0, 0, 1, 0, 1]],
    ['SSPIQuK4IMIVA9p309kEIAAAAEAAEAQ', 12, 'FFxExitBoss', [3, 1, 0, 1]],
    ['SSMULKCGcUFgOmuk+rewCAgAQAAAAAQRAA', 12, 'FFxExitBoss', [3, 0, 0, 1, 0]],
    ['SSPghyLoFbIGQPWdlvYAIQAAAIIAAIAg', 12, 'FFxExitKnights', [3, 0, 0, 0, 1]],
  ];
  for (const [code, count, boss, capIndexes] of captures) {
    const decoded = decodeLayout(code, FALLEN_FORTRESS_TABLE);
    assert.equal(decoded.rooms.length, count);
    assert.equal(decoded.rooms.find(room => /ExitBoss|ExitKnights/.test(room.room)).room, boss);
    assert.deepEqual(decoded.capPlacements.map(entry => entry.index), capIndexes);
    const portals = decoded.rooms.reduce((sum, room) => sum + room.entry.portal_count, 0);
    assert.equal(decoded.caps.length, portals - 2 * (count - 1));
    assert.equal(decoded.attachments.length, count - 1);
    assert.equal(decoded.attachments.at(-1).none, true);
  }
});

test('native tail rejects invalid caps, categories, attachment indexes, truncation and padding', () => {
  assert.throws(() => decodeLayout(replaceBits(firstCode, 82, 3, 7), cliff), /cap index/);
  assert.throws(() => decodeLayout(replaceBits(firstCode, 103, 3, 7), cliff), /attachment category/);
  const invalidAttachment = replaceBits(replaceBits(firstCode, 103, 3, 1), 106, 2, 3);
  assert.throws(() => decodeLayout(invalidAttachment, cliff), /attachment index/);
  assert.throws(() => decodeLayout(replaceBits(firstCode, 143, 1, 1), cliff), /padding/);
  assert.throws(() => decodeLayout(firstCode + 'AAAA', cliff), /padding/);
  assert.throws(() => decodeLayout(secondCode.slice(0, -1) + 'B', cliff), /encoding/);
  const truncated = Buffer.from(firstCode, 'base64').subarray(0, -1).toString('base64').replace(/=+$/, '');
  assert.throws(() => decodeLayout(truncated, cliff), /ended unexpectedly/);
});

test('tree rejects reused doors and out-of-range room and door references', () => {
  assert.throws(() => decodeLayout(replaceBits(firstCode, 70, 3, 1), cliff), /connected more than once/);
  assert.throws(() => decodeLayout(replaceBits(firstCode, 5, 6, 63), cliff), /component index/);
  assert.throws(() => decodeLayout(replaceBits(firstCode, 14, 2, 3), cliff), /door index/);
});

test('native-format support uses extracted metadata instead of a generator-name allowlist', () => {
  assert.equal(supportsLayout({ ...cliff, level_path: '/SF/Levels/Procs/UnderCityTreasury' }), true);
  assert.equal(supportsLayout({ ...cliff, serialization: undefined }), false);
  assert.equal(supportsLayout({ ...cliff, serialization: { ...cliff.serialization, attachment_counts: [3, 2] } }), false);
  assert.equal(supportsLayout({ ...cliff, serialization: { ...cliff.serialization, attachment_type_bits: 2 } }), false);
  assert.equal(supportsLayout({ ...cliff, serialization: { ...cliff.serialization, backdrop_count: 2 } }), false);
  assert.equal(supportsLayout({ ...FALLEN_FORTRESS_TABLE, tree_only: false }), false);
  assert.equal(supportsLayout({ ...FALLEN_FORTRESS_TABLE, level_path: '/SF/Levels/Procs/FallenFortress/FallenFortressProcLevel' }), true);
  const raw = { ...cliff, serialization: undefined, extra_components: {
    fitting: Array(3), exit_gate: Array(2), boss_gate: Array(2), objective_gate: Array(2), special_gate: Array(1), backdrop: [{}],
  } };
  assert.equal(decodeLayout(firstCode, raw).rooms.length, 8);
});

test('generators without custom layouts omit categories and old feed metadata still resolves their route', () => {
  // Native-format fixture: two rooms, one joined door per room, no cap bits,
  // fitting index 5 of six, cinematic sentinel 1, then zero byte padding.
  // Tree: back-width 1, next room, component 0, end marker (11).
  const table = { level_path: '/SF/Levels/Procs/Crypt/NoCustomLayouts',
    spawns: [{ room: 'Entrance', portal_count: 1 }], components: [{ room: 'Crypt', portal_count: 1 }], caps: ['Cap'],
    serialization: { format: 'tree-caps-attachments-v1', attachment_type_bits: 0,
      attachment_counts: [6, 0, 0, 0, 0], cinematic_count: 1, backdrop_count: 0 } };
  const code = Buffer.from([0b00001110, 0b11000000]).toString('base64').replace(/=+$/, '');
  const explicit = decodeLayout(code, table);
  assert.deepEqual(explicit.rooms.map(room => room.room), ['Entrance', 'Crypt']);
  assert.equal(explicit.attachmentTypeBits, 0);
  assert.deepEqual(explicit.attachments, [{ category: 0, kind: 'fitting', index: 5, none: false }]);
  assert.equal(explicit.cinematic, null);
  const legacy = decodeLayout(code, { ...table, serialization: { ...table.serialization, attachment_type_bits: 3 } });
  assert.deepEqual(legacy, explicit);
  assert.throws(() => decodeLayout(code + 'AAAA', table), /padding/);
  assert.throws(() => decodeLayout(code + 'AAAA', { ...table, serialization: { ...table.serialization, attachment_type_bits: 3 } }));
  for (const [table, code] of freshCaptures) assert.equal(decodeLayout(code, table).attachmentTypeBits, 3);
});
