'use strict';

const { decodeLayout, supportsLayout, placeRooms, attachAtPortal, transformPoint, FALLEN_FORTRESS_TABLE } = require('./dungeonLayout');

const finiteCoordinate = value => Number.isFinite(value) && Math.abs(value) <= 1e7;
const safeKey = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
const normalizedPath = value => String(value || '').replace(/^\//, '').replace(/\.(?:level|lp)$/, '');

function outlineOf(room) {
  if (!Array.isArray(room?.outline) || room.outline.length > 4096) return [];
  let count = 0;
  return room.outline.filter(chain => Array.isArray(chain?.points) && chain.points.length >= 2
    && (count += chain.points.length) <= 250000 && chain.points.every(point => Array.isArray(point)
      && point.length === 2 && point.every(finiteCoordinate)))
    .map(chain => ({ points: chain.points, closed: chain.closed === true }));
}

function labelOf(name) {
  const named = { FFxStreamingEntranceA: 'Entrance', FFxStreamingExitA: 'Exit', FFxSpawnTilted: 'Tilted hall',
    FFxExitBoss: 'Wyrm', FFxExitKnights: 'Twins', FFxExitBossThrone: 'King', FFxDeadEndCorruptedCaveNook: 'Loot: Corrupted nook',
    UnderCityEntranceHall: 'Entrance', UnderCitySpawnFortified: 'Fortified hall', UnderCityConBrewery: 'Brewery',
    UnderCityIntCliffCave: 'Cliff cave', UnderCityConJunctionHall: 'Junction hall', UnderCityObjCrypt: 'Crypt',
    UnderCityConJunctionPassage: 'Junction passage', UnderCitySpecialCheckpointA: 'Checkpoint',
    UnderCityExitBossA: 'Boss chamber', UnderCityExitStreamingTileA: 'Exit', UnderCityDeadEndCavedInC: 'Loot: Caved-in chamber' };
  if (named[name]) return named[name];
  return String(name).replace(/^(?:FFx|GoAx|NEAx|OSCx|UnderCity|Crypt|Mines)/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^(?:Con|Int) /, '').replace(/^Dead End /, 'Loot: ');
}

function makeScene(decoded, table, document) {
  const geometries = new Map((Array.isArray(document?.rooms) ? document.rooms : []).map(room => [room.room, room]));
  const placed = placeRooms(decoded, table);
  let mode = placed ? 'placed' : 'schematic';
  const rooms = (placed || decoded.rooms).map(room => {
    const geometry = geometries.get(room.room);
    const outline = outlineOf(geometry);
    const kind = room.entry.kind || geometry?.kind || (room.parent === null ? 'spawn' : 'room');
    return { slot: room.slot, room: room.room, label: room.entry.label || labelOf(room.room), kind,
      parent: room.parent, parentDoor: room.parentDoor, ownDoor: room.ownDoor,
      transform: room.transform || null, outline, caps: room.caps, missing: !outline.length };
  });
  // A missing shape gets an explicit missing indicator; inventing an outline
  // would make corridors appear traversable when we do not know their shape.
  if (mode === 'schematic') {
    const depth = [], leafRows = [], children = new Map();
    for (const room of rooms) {
      depth[room.slot] = room.parent === null ? 0 : depth[room.parent] + 1;
      if (room.parent !== null) {
        if (!children.has(room.parent)) children.set(room.parent, []);
        children.get(room.parent).push(room.slot);
      }
    }
    let row = 0;
    const assign = slot => {
      const kids = children.get(slot) || [];
      if (!kids.length) leafRows[slot] = row++;
      else { kids.forEach(assign); leafRows[slot] = kids.reduce((sum, kid) => sum + leafRows[kid], 0) / kids.length; }
    };
    assign(0);
    for (const room of rooms) room.transform = { x: depth[room.slot] * 160, y: 0, z: -leafRows[room.slot] * 140, rotation: 0 };
  }
  const missingRooms = rooms.filter(room => room.missing).map(room => room.room);
  const capOutlines = [];
  if (placed) {
    for (const { slot, door, index, room } of decoded.capPlacements) {
      // Some doorway caps have their own walkable floor. Plain seals have no
      // geometry entry. Each selected cap joins its parent through portal 0.
      const geometry = geometries.get(room);
      if (!geometry) continue;
      const outline = outlineOf(geometry);
      const transform = attachAtPortal(placed[slot], door, table.caps[index]?.portals?.[0]);
      if (outline.length && transform) capOutlines.push({ room, parent: slot, parentDoor: door, transform, outline });
      else missingRooms.push(room);
    }
  }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const room of [...rooms, ...capOutlines]) {
    const { transform } = room;
    const points = mode === 'placed' && room.outline.length ? room.outline.flatMap(chain => chain.points)
      : [[-50, -35], [50, 35]];
    for (const [x, z] of points) {
      const world = transformPoint([x, 0, z], transform);
      minX = Math.min(minX, world[0]); maxX = Math.max(maxX, world[0]);
      minZ = Math.min(minZ, world[2]); maxZ = Math.max(maxZ, world[2]);
    }
  }
  return { mode, rooms, capOutlines, bounds: { x: [minX, maxX], z: [minZ, maxZ] },
    coordinateSpace: table.coordinate_space === 'world' ? 'world' : 'layout-local',
    missingRooms };
}

class DungeonMapService {
  constructor({ dataManager, log = () => {} }) {
    this.dataManager = dataManager; this.log = log; this.cache = new Map(); this.metadataChecks = new Map();
    this.layoutCache = new Map(); this.layoutRequests = new Map();
  }
  async _read(key) {
    await this.dataManager.ensureAsset(key);
    return this.dataManager.readJSON(key);
  }
  /** Resolve the generated rooms once for both maps and room-presence checks. */
  async _getLayout(state) {
    const empty = { status: 'unavailable', version: this.dataManager.getInfo().version };
    if (!state?.active) return { ...empty, reason: 'outside' };
    if (!safeKey(state.key)) return { ...empty, reason: 'unsupported' };
    try {
      await this.dataManager.checkForUpdates();
      const version = this.dataManager.getInfo().version;
      // Exact generator aliases are shared with the rendered map. Tile geometry
      // and portal positions are not needed to identify fully decoded rooms.
      let key = state.key;
      try {
        const index = await this._read('dungeons/index.json');
        const indexed = index?.sets?.find(entry => safeKey(entry.key) && entry.level_paths?.some(level => normalizedPath(level) === normalizedPath(state.levelPath)));
        if (indexed) key = indexed.key;
      } catch { /* Older feeds still provide direct set documents. */ }
      const cacheKey = `${version}:${key}:${state.levelPath}:${state.layoutCode}`;
      if (this.layoutCache.has(cacheKey)) return this.layoutCache.get(cacheKey);
      if (this.layoutRequests.has(cacheKey)) return await this.layoutRequests.get(cacheKey);
      const request = (async () => {
        let layouts = null;
        try { layouts = await this._read(`dungeons/${key}/layouts.json`); } catch { /* A metadata refresh can recover a missing table. */ }
        const entries = Array.isArray(layouts?.layouts) ? layouts.layouts : [];
        let table = entries.find(entry => normalizedPath(entry.level_path) === normalizedPath(state.levelPath));
        if (!table && state.set === 'FallenFortress' && /\/FallenFortressProcLevel$/.test(normalizedPath(state.levelPath))) table = FALLEN_FORTRESS_TABLE;
        // Share early metadata checks across both consumers and fingerprints.
        // Unavailable results are not cached, so same-version recovery can retry.
        if (state.layoutCode && (!table || !supportsLayout(table))) {
          const checkKey = `${version}:${key}`;
          if (!this.metadataChecks.has(checkKey)) {
            this.metadataChecks.set(checkKey, this.dataManager.checkForUpdates({ force: true }));
            if (this.metadataChecks.size > 16) this.metadataChecks.delete(this.metadataChecks.keys().next().value);
          }
          await this.metadataChecks.get(checkKey);
          if (this.dataManager.getInfo().version !== version) return this._getLayout(state);
        }
        if (!state.layoutCode || !table || !supportsLayout(table)) {
          return { ...empty, version, key, cacheKey, reason: !state.layoutCode ? 'waiting' : 'unsupported' };
        }
        const decoded = decodeLayout(state.layoutCode, table);
        const result = { status: 'ready', reason: null, version, key, cacheKey, table, decoded };
        this.layoutCache.set(cacheKey, result);
        if (this.layoutCache.size > 8) this.layoutCache.delete(this.layoutCache.keys().next().value);
        return result;
      })();
      this.layoutRequests.set(cacheKey, request);
      try { return await request; }
      finally { if (this.layoutRequests.get(cacheKey) === request) this.layoutRequests.delete(cacheKey); }
    } catch (error) {
      this.log(`Dungeon layout unavailable: ${error.message}`);
      return { ...empty, version: this.dataManager.getInfo().version, reason: 'decode', error: error.message };
    }
  }
  async getLayoutSnapshot(state) {
    const captured = { ...state };
    const result = await this._getLayout(captured);
    // The decoded portal graph also supplies room frames for matching native
    // LevelInfo placements. This needs no room outlines or other geometry.
    const placed = result.status === 'ready' ? placeRooms(result.decoded, result.table) : null;
    const rooms = result.status === 'ready' ? (placed || result.decoded.rooms).map(room => ({ slot: room.slot, room: room.room,
      label: room.entry.label || labelOf(room.room), kind: room.entry.kind || (room.parent === null ? 'spawn' : 'room'),
      parent: room.parent, parentDoor: room.parentDoor, ownDoor: room.ownDoor,
      transform: room.transform || null })) : [];
    return { state: captured, status: result.status, setKey: result.key || null, rooms, version: result.version, reason: result.reason,
      coordinateSpace: result.status === 'ready' ? result.table.coordinate_space === 'world' ? 'world' : 'layout-local' : null,
      ...(result.error ? { error: result.error } : {}) };
  }
  async getSnapshot(state) {
    const captured = { ...state }, layout = await this._getLayout(captured);
    const empty = { state: captured, mode: 'unavailable', rooms: [], bounds: null, version: layout.version };
    if (layout.status !== 'ready') {
      // The map still preloads its room document while waiting for a supported
      // fingerprint. Room-presence consumers never request geometry here.
      if (layout.key) {
        try { await this._read(`dungeons/${layout.key}/rooms.json`); } catch { /* A later map request can retry. */ }
      }
      return { ...empty, reason: layout.reason, ...(layout.error ? { error: layout.error } : {}) };
    }
    const { cacheKey, key, table, decoded, version } = layout;
    if (this.cache.has(cacheKey)) return { ...this.cache.get(cacheKey), state: captured };
    try {
      let document = null;
      try { document = await this._read(`dungeons/${key}/rooms.json`); } catch { /* Geometry remains independently retryable. */ }
      if (!Array.isArray(document?.rooms) || !document.rooms.length) return { ...empty, reason: 'data' };
      const scene = makeScene(decoded, table, document);
      const result = { ...scene, state: captured, version, reason: scene.mode === 'schematic' ? 'portal-data' : null };
      this.cache.clear();
      // Keep a partial map useful, but do not pin its missing outlines in the
      // scene cache after a same-version download retry or data refresh.
      if (!scene.missingRooms.length) this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      this.log(`Dungeon map unavailable: ${error.message}`);
      return { ...empty, reason: 'decode', error: error.message };
    }
  }
}

module.exports = { DungeonMapService, DungeonMap: DungeonMapService, makeScene, outlineOf };
