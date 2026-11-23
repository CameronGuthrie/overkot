'use strict';

// The engine's fingerprint uses MSB-first bits and a URL-safe DE alphabet
// (a hyphen in place of slash). Tables are supplied by the extracted level.
const ceilLog2 = value => value <= 1 ? 0 : Math.ceil(Math.log2(value));
const roomName = entry => entry?.room || entry?.prefab;
const portalCount = entry => Array.isArray(entry?.portals) ? entry.portals.length : entry?.portal_count;

const ATTACHMENT_KINDS = ['fitting', 'exit_gate', 'boss_gate', 'objective_gate', 'special_gate'];
const FORTRESS_SERIALIZATION = {
  format: 'tree-caps-attachments-v1', attachment_type_bits: 3,
  attachment_counts: [4, 0, 0, 0, 0], cinematic_count: 0, backdrop_count: 1,
};

function serializationOf(table) {
  if (!table) return null;
  // Only the legacy Fortress fallback may omit native serialization metadata.
  // All indexed generators use their own extracted tables and count metadata;
  // support depends on that format, rather than a list of captured level names.
  const fallback = !table.level_path && table.tree_only === true
    && table.spawns?.length === 1 && roomName(table.spawns[0]) === 'FFxStreamingEntranceA'
    && table.components?.length === FALLEN_FORTRESS_TABLE.components.length
    && table.components.every((entry, i) => roomName(entry) === roomName(FALLEN_FORTRESS_TABLE.components[i]));
  let value = table.serialization;
  if (!value && table.extra_components && typeof table.extra_components === 'object') {
    const count = kind => Array.isArray(table.extra_components[kind]) ? table.extra_components[kind].length : 0;
    value = { format: 'tree-caps-attachments-v1', attachment_type_bits: 3,
      attachment_counts: ATTACHMENT_KINDS.map(count), cinematic_count: count('cinematic'), backdrop_count: count('backdrop') };
  }
  if (!value && (fallback || table.level_path === '/SF/Levels/Procs/FallenFortress/FallenFortressProcLevel')) value = FORTRESS_SERIALIZATION;
  const count = n => Number.isInteger(n) && n >= 0 && n <= 4096;
  if (!value || value.format !== 'tree-caps-attachments-v1' || ![0, 3].includes(value.attachment_type_bits)
      || !Array.isArray(value.attachment_counts) || value.attachment_counts.length !== 5 || !value.attachment_counts.every(count)
      || !count(value.cinematic_count) || !count(value.backdrop_count)
      // A multiple-backdrop section needs its placed count, which is not part
      // of the compact feed contract. No current indexed level uses that form.
      || value.backdrop_count > 1) return null;
  return value;
}

function supportsLayout(table) {
  try { validateTable(table); return true; } catch { return false; }
}

class Bits {
  constructor(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9+\-]{1,16384}$/.test(code) || code.length % 4 === 1) throw new Error('Invalid layout fingerprint');
    this.bytes = Buffer.from(code.replace(/-/g, '/'), 'base64');
    if (this.bytes.toString('base64').replace(/\//g, '-').replace(/=+$/, '') !== code) throw new Error('Invalid layout fingerprint encoding');
    this.position = 0;
  }
  read(count) {
    if (!Number.isInteger(count) || count < 0 || count > 24 || this.position + count > this.bytes.length * 8) throw new Error('Layout fingerprint ended unexpectedly');
    let value = 0;
    for (let i = 0; i < count; i++, this.position++) value = value * 2 + ((this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1);
    return value;
  }
}

function validateTable(table) {
  if (!table || !serializationOf(table) || !Array.isArray(table.spawns) || !table.spawns.length
      || !Array.isArray(table.components) || !table.components.length || !Array.isArray(table.caps) || !table.caps.length
      || table.components.length > 4096 || table.spawns.length > 4096 || table.caps.length > 4096) throw new Error('Dungeon layout tables are unavailable');
  for (const entry of [...table.spawns, ...table.components]) {
    if (!entry || typeof roomName(entry) !== 'string' || !Number.isInteger(portalCount(entry)) || portalCount(entry) < 1 || portalCount(entry) > 256) throw new Error('Invalid dungeon component table');
  }
  for (const entry of table.caps) {
    if (typeof entry !== 'string' && (!entry || typeof roomName(entry) !== 'string')) throw new Error('Invalid dungeon cap table');
  }
  return table;
}

function decodeLayout(code, rawTable) {
  const table = validateTable(rawTable);
  const bits = new Bits(code);
  const backBits = bits.read(3) + 1;
  const spawnIndex = bits.read(ceilLog2(table.spawns.length));
  if (!table.spawns[spawnIndex]) throw new Error('Unknown dungeon entrance');
  const rooms = [{ slot: 0, room: roomName(table.spawns[spawnIndex]), entry: table.spawns[spawnIndex], parent: null, parentDoor: null, ownDoor: null }];
  const usedDoors = new Set();
  const indexBits = table.index_bits ?? ceilLog2(table.components.length);
  if (!Number.isInteger(indexBits) || indexBits < ceilLog2(table.components.length) || indexBits > 16) throw new Error('Invalid component index width');
  while (true) {
    let back = 0;
    if (bits.read(1)) {
      back = bits.read(backBits);
      if (back === (1 << backBits) - 1) break;
      back++;
    }
    if (rooms.length >= 4096) throw new Error('Dungeon contains too many rooms');
    const parent = rooms.length - 1 - back;
    if (parent < 0) throw new Error('Layout parent precedes the entrance');
    const parentDoor = bits.read(ceilLog2(portalCount(rooms[parent].entry)));
    const index = bits.read(indexBits);
    const entry = table.components[index];
    if (!entry) throw new Error('Dungeon component index is out of range');
    const ownDoor = bits.read(ceilLog2(portalCount(entry)));
    if (parentDoor >= portalCount(rooms[parent].entry) || ownDoor >= portalCount(entry)) throw new Error('Dungeon door index is out of range');
    const parentKey = `${parent}:${parentDoor}`;
    if (usedDoors.has(parentKey)) throw new Error('Dungeon door is connected more than once');
    usedDoors.add(parentKey);
    usedDoors.add(`${rooms.length}:${ownDoor}`);
    rooms.push({ slot: rooms.length, room: roomName(entry), entry, parent, parentDoor, ownDoor });
  }
  // Native serialization writes caps only for unjoined doors. Joined doors
  // instead contribute an attachment record after the complete cap section.
  const caps = [], capPlacements = [];
  for (const room of rooms) {
    room.caps = Array(portalCount(room.entry)).fill(null);
    for (let door = 0; door < portalCount(room.entry); door++) {
      if (usedDoors.has(`${room.slot}:${door}`)) continue;
      const index = bits.read(ceilLog2(table.caps.length));
      if (index >= table.caps.length) throw new Error('Dungeon cap index is out of range');
      const cap = typeof table.caps[index] === 'string' ? table.caps[index] : roomName(table.caps[index]);
      room.caps[door] = cap; caps.push(cap);
      capPlacements.push({ slot: room.slot, door, index, room: cap });
    }
  }
  const serialization = serializationOf(table), tailStart = bits.position;
  const readTail = typeBits => {
    bits.position = tailStart;
    const attachments = [];
    for (let i = 1; i < rooms.length; i++) {
      // Native generators without custom layouts omit the category field:
      // joins retain their initial type 8 (fitting).
      const category = bits.read(typeBits);
      if (category >= ATTACHMENT_KINDS.length) throw new Error('Dungeon attachment category is out of range');
      const count = serialization.attachment_counts[category];
      const index = bits.read(ceilLog2(count + 1));
      if (index > count) throw new Error('Dungeon attachment index is out of range');
      // Authored and missing fittings are grouped; their order does not
      // identify which room edge owns them.
      attachments.push({ category, kind: ATTACHMENT_KINDS[category], index, none: index === count });
    }
    const cinematicIndex = bits.read(ceilLog2(serialization.cinematic_count + 1));
    if (cinematicIndex > serialization.cinematic_count) throw new Error('Dungeon cinematic index is out of range');
    const remaining = bits.bytes.length * 8 - bits.position;
    if (remaining >= 8 || bits.read(remaining) !== 0) throw new Error('Invalid dungeon fingerprint padding or extra sections');
    return { attachments, attachmentTypeBits: typeBits, cinematic: cinematicIndex === serialization.cinematic_count ? null : cinematicIndex };
  };
  let tail;
  try { tail = readTail(serialization.attachment_type_bits); }
  catch (error) {
    if (serialization.attachment_type_bits !== 3) throw error;
    // Older compact feeds report three category bits for every generator.
    // Accept the engine's other format only if its entire tail validates. The
    // already validated tree, door links and caps are identical in both forms.
    try { tail = readTail(0); } catch { throw error; }
  }
  return { rooms, caps, capPlacements, backBits, ...tail };
}

function portalPose(portal) {
  const position = portal?.position;
  if (!Array.isArray(position) || position.length < 3 || !position.every(Number.isFinite)) return null;
  let heading = portal.heading;
  if (!Number.isFinite(heading) && Array.isArray(portal.normal) && portal.normal.length === 3 && portal.normal.every(Number.isFinite)) {
    const [x, , z] = portal.normal;
    if (Math.hypot(x, z) < 1e-6) return null;
    heading = Math.atan2(x, z);
  }
  if (!Number.isFinite(heading) && Array.isArray(portal.rotation) && portal.rotation.length === 4 && portal.rotation.every(Number.isFinite)) {
    const [x, y, z, w] = portal.rotation;
    // Rotate the door's +z facing vector by its quaternion, then project x/z.
    heading = Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
  }
  return Number.isFinite(heading) ? { x: position[0], y: position[1], z: position[2], heading } : null;
}

function transformPoint(point, transform) {
  const [x, y, z] = point;
  const c = Math.cos(transform.rotation), s = Math.sin(transform.rotation);
  return [transform.x + x * c + z * s, transform.y + y, transform.z - x * s + z * c];
}

function attachAtPortal(parent, parentDoor, ownPortal) {
  const parentPose = portalPose(parent.entry.portals?.[parentDoor]);
  const ownPose = portalPose(ownPortal);
  if (!parentPose || !ownPose) return null;
  const target = transformPoint([parentPose.x, parentPose.y, parentPose.z], parent.transform);
  const rotation = parent.transform.rotation + parentPose.heading + Math.PI - ownPose.heading;
  const own = transformPoint([ownPose.x, ownPose.y, ownPose.z], { x: 0, y: 0, z: 0, rotation });
  return { x: target[0] - own[0], y: target[1] - own[1], z: target[2] - own[2], rotation };
}

function placeRooms(decoded, table) {
  const placed = [];
  const origin = table.origin || [0, 0, 0];
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) return null;
  for (const room of decoded.rooms) {
    const transform = room.parent === null
      ? { x: origin[0], y: origin[1], z: origin[2], rotation: table.rotation || 0 }
      : attachAtPortal(placed[room.parent], room.parentDoor, room.entry.portals?.[room.ownDoor]);
    if (!transform) return null;
    placed.push({ ...room, transform });
  }
  return placed;
}

// Verified tables from DungeonDecode.md, used only for the labelled schematic
// fallback when a feed has room outlines but no baked portal transforms yet.
const FALLEN_FORTRESS_TABLE = {
  tree_only: true,
  spawns: [{ room: 'FFxStreamingEntranceA', portal_count: 2, label: 'Entrance' }],
  components: [
    ['FFxIntCeremony', 3, 'Ceremony'], ['FFxIntCrossing', 4, 'Crossing'], ['FFxIntMechanicalRoom', 4, 'Mechanical room'],
    ['FFxStreamingExitA', 1, 'Exit'], ['FFxSpawnTilted', 2, 'Tilted hall'],
    ['FFxExitBoss', 3, 'Wyrm'], ['FFxExitKnights', 3, 'Twins'], ['FFxExitBossThrone', 3, 'King'],
    ['FFxConStraightHall', 2], ['FFxConBuriedHall', 2], ['FFxConCornerHall', 2], ['FFxConSunkenHall', 2],
    ['FFxConTunnelCollapse', 3], ['FFxConFourwayJunction', 4], ['FFxConTunnelPath', 2], ['FFxConStairwell', 2],
    ['FFxConRoundCorner', 2], ['FFxConTunnelSpew', 3], ['FFxConCorruptedPassage', 2],
    ['FFxDeadEndVentilation', 1], ['FFxDeadEndCorruptedCaveNook', 1], ['FFxDeadEndHall', 1], ['FFxDeadEndCollapsedHall', 1],
  ].map(([room, portal_count, label]) => ({ room, portal_count, label })),
  caps: ['CapDoor', 'CapTunnel', 'CapSpawn', 'CapStreamingEntrance', 'CapStreamingExit'],
};

module.exports = { decodeLayout, supportsLayout, placeRooms, attachAtPortal, transformPoint, portalPose, FALLEN_FORTRESS_TABLE };
