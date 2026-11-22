'use strict';

const { getCollectionCatalog, normalizeItemType, itemId } = require('./collectionCatalog');

const MAX_WORLD_DROPS = 64;
const WORLD_DROP_TTL_MS = 2000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = (value, max = 96) => typeof value === 'string' && value.length > 0 && value.length <= max
  && /^[A-Za-z0-9_.:-]+$/.test(value);
const coordinate = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6;
const name = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120
  && !/^\/SF\//i.test(value.trim()) && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/.test(value) ? value.trim() : null;
const weaponType = value => {
  if (value === null) return null;
  const type = normalizeItemType(value);
  return type && /^\/SF\/Weapons\//i.test(type) ? type : undefined;
};

/** A complete native observation; never infer drops from loaded resources. */
function normalizeWorldDropsMessage(value, now = Date.now()) {
  if (!record(value) || value.type !== 'world-drops' || value.source !== 'memory'
    || !['available', 'unavailable'].includes(value.status)
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(value.timestamp) || value.timestamp <= 0
    || value.timestamp > now + 1000 || value.timestamp < now - WORLD_DROP_TTL_MS
    || !Array.isArray(value.items) || value.items.length > MAX_WORLD_DROPS) return null;
  const items = new Map();
  if (value.status === 'available') for (const row of value.items) {
    if (!record(row) || !token(row.id) || !record(row.position)
      || !['x', 'y', 'z'].every(axis => coordinate(row.position[axis]))) return null;
    const itemType = weaponType(row.itemType);
    if (itemType === undefined) return null;
    const item = { id: row.id, itemType, position: { x: row.position.x, y: row.position.y, z: row.position.z },
      shiny: typeof row.shiny === 'boolean' ? row.shiny : null };
    const previous = items.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) return null;
    items.set(item.id, item);
  }
  return { type: 'world-drops', source: 'memory', status: value.status, sampledAt: value.timestamp, items: [...items.values()] };
}

/** Keep only the latest full set in one verified process session. No persistence. */
function createWorldDropsStore({ now = Date.now, getCatalog = getCollectionCatalog, getNames = () => ({}) } = {}) {
  let latest = null;
  function clear() { latest = null; }
  function receive(message) {
    if (!record(message) || !token(message.trackingSession, 128)) return false;
    const normalized = normalizeWorldDropsMessage({ ...message, timestamp: message.sampledAt ?? message.timestamp }, now());
    if (!normalized || latest?.trackingSession === message.trackingSession && normalized.sampledAt <= latest.sampledAt) return false;
    latest = { ...normalized, trackingSession: message.trackingSession };
    return true;
  }
  function read(trackingSession) {
    if (latest && latest.trackingSession !== trackingSession) clear();
    const unavailable = () => ({ status: 'unavailable', sampledAt: latest?.sampledAt ?? null, items: [] });
    const age = now() - latest?.sampledAt;
    if (!latest || latest.status !== 'available' || !Number.isFinite(age) || age < 0 || age > WORLD_DROP_TTL_MS) return unavailable();
    let catalog, names;
    try { catalog = getCatalog(); names = getNames(); } catch { /* Metadata remains unknown when sources are unavailable. */ }
    const weapons = new Map();
    for (const item of Array.isArray(catalog?.items) ? catalog.items.slice(0, 5000) : []) {
      if (item?.category !== 'Weapon') continue;
      const type = weaponType(item.itemType);
      if (type) weapons.set(itemId(type), item);
    }
    const lookup = key => key && (names instanceof Map ? names.get(key)
      : record(names) && Object.hasOwn(names, key) ? names[key] : undefined);
    return { status: 'available', sampledAt: latest.sampledAt, items: latest.items.map(row => {
      const item = row.itemType ? weapons.get(itemId(row.itemType)) : null;
      const resolvedName = item ? name(lookup(item.langKey)) || name(lookup(item.itemType))
        || name(lookup(itemId(item.itemType))) || name(item.name) : null;
      return { id: row.id, name: resolvedName, kind: 'weapon', shiny: row.shiny, position: { ...row.position } };
    }) };
  }
  return { receive, read, clear };
}

module.exports = { MAX_WORLD_DROPS, WORLD_DROP_TTL_MS, normalizeWorldDropsMessage, createWorldDropsStore };
