'use strict';

const { resolveName } = require('../renderer/inventory-format');
const { getCollectionCatalog, validIcon } = require('./collectionCatalog');
const { masteryTargetForItem, WEAPON_MAX_XP } = require('./masteryTracker');

// The legacy Player equipment tab shows mastery boundaries only. Its target
// comes from the same current progression data as the full Mastery Tracker.
const WEAPON_MASTERY_XP = WEAPON_MAX_XP;
const BUCKETS = { Melee: 'melee', LongGuns: 'ranged', Pistols: 'sidearm', Suits: 'pact' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validXP = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const maxXP = (left, right) => left === null ? right : right === null ? left : Math.max(left, right);

function equipmentType(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^\/SF\/(?:StoreItems\/)?(?:Weapons|Souls)\/[A-Za-z0-9_./-]+$/i.test(value)) return null;
  const path = value.replace(/^\/sf\/storeitems\//i, '/SF/');
  if (path.split('/').some(part => part === '.' || part === '..')) return null;
  const id = path.toLowerCase();
  const category = id.startsWith('/sf/souls/') ? 'pact' : id.startsWith('/sf/weapons/melee/') ? 'melee'
    : /^\/sf\/weapons\/(?:bows|ranged)\//.test(id) ? 'ranged' : 'weapon';
  return { id, path, category };
}

/** Project only equipment XP and labels; no account, nonce or instance IDs escape. */
function createEquipmentProgressModel({ getCatalog = getCollectionCatalog } = {}) {
  return {
    read(inventory, context = {}) {
      const rows = new Map();
      let unreadableRecords = 0;
      const available = plain(inventory) && !['connect', 'waiting'].includes(context.status);
      const source = available ? inventory : {};
      const catalog = getCatalog();
      const mastery = catalog?.mastery;
      const catalogue = new Map((Array.isArray(catalog?.items) ? catalog.items : []).map(row => [equipmentType(row?.itemType)?.id, row]));
      const approved = new Set([...catalogue.keys(), ...(Array.isArray(mastery?.items) ? mastery.items : [])
        .map(row => equipmentType(row?.itemType)?.id)].filter(Boolean));
      const untracked = new Set();
      const incompleteOwnership = new Set(Object.keys(BUCKETS).filter(bucket => !Array.isArray(source[bucket])));
      function entries(bucket) {
        if (source[bucket] == null) return [];
        if (!Array.isArray(source[bucket])) { unreadableRecords++; return []; }
        return source[bucket];
      }
      function get(type) {
        if (!rows.has(type.id)) rows.set(type.id, { id: type.id, itemType: type.path, category: type.category,
          owned: false, recorded: false, recordedXP: null, ownedXP: null, ownedCategories: new Set() });
        return rows.get(type.id);
      }
      for (const record of entries('XPInfo')) {
        if (!plain(record)) { unreadableRecords++; continue; }
        const type = equipmentType(record.ItemType);
        // Other XPInfo categories are outside this widget's scope.
        if (!type) {
          if (typeof record.ItemType !== 'string' || /^\/SF\/(?:StoreItems\/)?(?:Weapons|Souls)(?:\/|$)/i.test(record.ItemType)) unreadableRecords++;
          continue;
        }
        if (!approved.has(type.id)) { untracked.add(type.id); continue; }
        const row = get(type); row.recorded = true;
        if (validXP(record.XP)) row.recordedXP = maxXP(row.recordedXP, record.XP);
        else unreadableRecords++;
      }
      for (const [bucket, category] of Object.entries(BUCKETS)) {
        for (const record of entries(bucket)) {
          const type = plain(record) ? equipmentType(record.ItemType) : null;
          if (!type || (category === 'pact') !== (type.category === 'pact')) {
            unreadableRecords++; incompleteOwnership.add(bucket); continue;
          }
          if (!approved.has(type.id)) { untracked.add(type.id); continue; }
          const row = get(type); row.owned = true; row.ownedCategories.add(category);
          if (validXP(record.XP)) row.ownedXP = maxXP(row.ownedXP, record.XP);
          else if (record.XP !== undefined) unreadableRecords++;
        }
      }
      const output = [...rows.values()].map(row => {
        const category = row.ownedCategories.size === 1 ? [...row.ownedCategories][0]
          : row.ownedCategories.size > 1 ? 'weapon' : row.category;
        const xp = maxXP(row.recordedXP, row.ownedXP);
        const masteryTarget = ['melee', 'ranged'].includes(category) ? masteryTargetForItem(row.itemType, mastery) : null;
        const ownershipBuckets = { melee: ['Melee'], ranged: ['LongGuns'], pact: ['Suits'], sidearm: ['Pistols'],
          weapon: ['Melee', 'LongGuns', 'Pistols'] }[category];
        const owned = row.owned ? true : ownershipBuckets.some(bucket => incompleteOwnership.has(bucket)) ? null : false;
        const catalogIcon = catalogue.get(row.id)?.icon;
        return { id: row.id, itemType: row.itemType, name: resolveName(row.itemType, context.names), category,
          icon: typeof catalogIcon === 'string' && validIcon(catalogIcon) ? catalogIcon : null,
          owned, recorded: row.recorded, xp, recordedXP: row.recordedXP, ownedXP: row.ownedXP,
          masteryTarget, mastered: masteryTarget !== null && xp !== null ? xp >= masteryTarget : null };
      }).sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' }) || left.id.localeCompare(right.id));
      return { rows: output, unreadableRecords, untrackedEquipment: untracked.size, ownershipUnavailableSections: [...incompleteOwnership], summary: { total: output.length,
        owned: output.filter(row => row.owned).length, recorded: output.filter(row => row.recorded).length,
        masteredWeapons: output.filter(row => row.mastered === true).length } };
    },
  };
}

module.exports = { createEquipmentProgressModel, WEAPON_MASTERY_XP };
