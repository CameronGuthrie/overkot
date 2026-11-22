'use strict';

const { resolveName } = require('../renderer/inventory-format');

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_UNIX_SECONDS = 253402300799; // Last second of year 9999, also rejects modern millisecond timestamps.
const ITEM_TYPE = /^\/SF\/[A-Za-z0-9_/.-]+$/;

function expiryMilliseconds(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_UNIX_SECONDS ? Math.floor(seconds * 1000) : null;
}

/** Read only the account-wide boon list; unrelated timer and inventory fields stay private. */
function createActiveBoonsModel() {
  return {
    read(inventory, context = {}) {
      const now = Number.isFinite(context.now) ? context.now : Date.now();
      const result = { state: 'unavailable', rows: [], unreadableCount: 0, duplicateCount: 0,
        activeCount: 0, expiredCount: 0 };
      if (!plain(inventory) || !Object.prototype.hasOwnProperty.call(inventory, 'Boosters')) return result;
      if (!Array.isArray(inventory.Boosters)) return { ...result, state: 'unreadable', unreadableCount: 1 };
      if (!inventory.Boosters.length) return { ...result, state: 'empty' };

      const byType = new Map();
      for (const booster of inventory.Boosters) {
        const id = plain(booster) && typeof booster.ItemType === 'string' ? booster.ItemType.trim() : '';
        const expiresAt = plain(booster) ? expiryMilliseconds(booster.ExpiryDate) : null;
        if (!id || id.length > 300 || !ITEM_TYPE.test(id) || expiresAt === null) {
          result.unreadableCount++;
          continue;
        }
        const previous = byType.get(id);
        if (previous) result.duplicateCount++;
        // Repeated records do not imply multiple copies or an extended duration.
        if (!previous || expiresAt > previous.expiresAt) {
          byType.set(id, { id, name: resolveName(id, context.names), expiresAt, active: expiresAt > now });
        }
      }
      result.rows = [...byType.values()].sort((a, b) => Number(b.active) - Number(a.active)
        || (a.active ? a.expiresAt - b.expiresAt : b.expiresAt - a.expiresAt) || a.id.localeCompare(b.id));
      result.activeCount = result.rows.filter(row => row.active).length;
      result.expiredCount = result.rows.length - result.activeCount;
      result.state = result.rows.length ? 'ready' : 'unreadable';
      return result;
    },
  };
}

module.exports = { createActiveBoonsModel };
