'use strict';

const EQUIPMENT_SECTIONS = ['Melee', 'LongGuns', 'Suits', 'WeaponSkins'];
const LABELS = { Melee: 'Melee weapons', LongGuns: 'Ranged weapons', Suits: 'Pacts', WeaponSkins: 'Equipment cosmetics' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function storageCapacity(inventory) {
  const slots = inventory?.UniversalBin?.Slots;
  const free = Number.isSafeInteger(slots) ? slots : null;
  let unreadableCount = 0;
  const missingSections = [];
  const seen = new Set();
  const rows = EQUIPMENT_SECTIONS.map(key => {
    const items = inventory?.[key];
    if (!Array.isArray(items)) { missingSections.push(key); return { key, name: LABELS[key], count: null }; }
    let count = 0;
    for (const item of items) {
      if (!plain(item) || typeof item.ItemType !== 'string' || !item.ItemType.trim()) { unreadableCount++; continue; }
      if (Object.hasOwn(item, 'IgnoreBinCount') && ![true, false, 'true', 'false'].includes(item.IgnoreBinCount)) { unreadableCount++; continue; }
      if (item.IgnoreBinCount === true || item.IgnoreBinCount === 'true') continue;
      const id = typeof item.ItemId === 'string' ? item.ItemId : item.ItemId?.$oid;
      if (typeof id === 'string' && id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      count++;
    }
    return { key, name: LABELS[key], count };
  });
  const complete = missingSections.length === 0 && unreadableCount === 0;
  const observedUsed = rows.reduce((sum, row) => sum + (row.count || 0), 0);
  const used = complete ? observedUsed : null;
  const computedTotal = used === null || free === null ? null : used + free;
  const total = computedTotal !== null && computedTotal >= 0 && Number.isSafeInteger(computedTotal) ? computedTotal : null;
  return { state: free === null ? 'unavailable' : complete && total !== null ? 'ready' : 'partial',
    free, used, observedUsed, total, overCapacity: free !== null && free < 0,
    percent: total > 0 && used !== null ? Math.min(100, Math.max(0, used / total * 100)) : null,
    rows, unreadableCount, missingSections };
}

function createStorageCapacityModel() { return { read: storageCapacity }; }
module.exports = { createStorageCapacityModel, storageCapacity, EQUIPMENT_SECTIONS };
