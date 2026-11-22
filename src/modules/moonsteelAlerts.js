'use strict';

const Settings = require('./moonsteelAlertSettings');
const { WORLD_DROP_TTL_MS, MAX_WORLD_DROPS } = require('./worldDrops');

const MAX_SEEN_DROPS = 4096;
const NEARBY_RADIUS = 80;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;
const position = value => record(value) && ['x', 'y', 'z'].every(key => finite(value[key]));
const fresh = (sampledAt, now) => Number.isSafeInteger(sampledAt) && sampledAt > 0 && Number.isSafeInteger(now)
  && now >= sampledAt && now - sampledAt <= WORLD_DROP_TTL_MS;
const label = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120
  && !/^\/SF\//i.test(value.trim()) && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/.test(value) ? value.trim() : 'Dropped weapon';

/** Consume authoritative player telemetry in main, independently of map windows. */
function createMoonsteelAlerts({ getSettings = () => Settings.DEFAULTS, onAlert = () => {}, now = Date.now } = {}) {
  let scope = null, lastPoseTime = 0, lastDropTime = 0;
  const seen = new Set();
  function clear() {
    scope = null; lastPoseTime = 0; lastDropTime = 0; seen.clear();
  }
  function receive(location) {
    const timestamp = now();
    if (!record(location) || location.status !== 'found' || location.source !== 'memory'
      || !fresh(location.sampledAt, timestamp) || location.sampledAt < lastPoseTime
      || !token(location.trackingSession, 128) || !token(location.instanceId, 256)
      || typeof location.zone !== 'string' || !/^\/SF\/Levels\/[A-Za-z0-9_/-]{1,512}$/.test(location.zone)
      || typeof location.isOverworld !== 'boolean' || !position(location.position)) return 0;
    const nextScope = JSON.stringify([location.trackingSession, location.instanceId, location.zone]);
    if (scope !== nextScope) { scope = nextScope; lastDropTime = 0; seen.clear(); }
    lastPoseTime = location.sampledAt;
    const drops = location.worldDrops;
    if (!record(drops) || drops.status !== 'available' || !fresh(drops.sampledAt, timestamp)
      || drops.sampledAt <= lastDropTime || !Array.isArray(drops.items) || drops.items.length > MAX_WORLD_DROPS) return 0;
    lastDropTime = drops.sampledAt;
    const items = [];
    for (const item of drops.items) {
      if (!record(item) || item.kind !== 'weapon' || item.shiny !== true || !token(item.id, 96)
        || !position(item.position) || seen.has(item.id) || seen.size >= MAX_SEEN_DROPS
        || Math.hypot(item.position.x - location.position.x, item.position.y - location.position.y,
          item.position.z - location.position.z) > NEARBY_RADIUS) continue;
      seen.add(item.id);
      items.push({ id: item.id, name: label(item.name), position: { ...item.position } });
    }
    if (!items.length) return 0;
    // Consume detections even while muted, so enabling alerts cannot replay old loot.
    const settings = Settings.normalize(getSettings());
    if (settings.enabled && (settings.flashEnabled && settings.opacity > 0 || settings.soundEnabled && settings.volume > 0)) {
      onAlert({ items, settings, trackingSession: location.trackingSession, instanceId: location.instanceId, zone: location.zone });
    }
    return items.length;
  }
  return { receive, clear };
}

module.exports = { createMoonsteelAlerts, MAX_SEEN_DROPS, NEARBY_RADIUS };
