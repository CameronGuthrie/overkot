'use strict';

const { humanize } = require('../renderer/inventory-format');

// Preludes 17 halves weapon XP, while item ranks still cap at 30. Player and
// Pact scales compensate for the lower multiplier and retain their old curves.
// Keep float32 operations: rounding changes some rank boundaries.
const LEVEL_CAP = 30;
const XP_MULTIPLIER = 125;
const PLAYER_XP_SCALE = 10;
const PACT_XP_SCALE = 4;
const XP_PER_DISCOVERY = 5000;
const BUCKETS = { Melee: 'melee', LongGuns: 'ranged', Pistols: 'sidearm', Suits: 'pact' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validXP = value => Number.isSafeInteger(value) && value >= 0;
const maxXP = (left, right) => left === null ? right : right === null ? left : Math.max(left, right);
const f = Math.fround;
const normalizeNameKey = value => String(value || '').toLowerCase().replace(/^\/sf\/storeitems\//, '/sf/');
function indexedName(reference, index) {
  const id = normalizeNameKey(reference), visited = new Set([id]);
  let label = index.get(id);
  while (label && index.has(normalizeNameKey(label)) && !visited.has(normalizeNameKey(label))) {
    visited.add(normalizeNameKey(label)); label = index.get(normalizeNameKey(label));
  }
  return label ? /^\/SF\//i.test(label) ? humanize(label) : label : humanize(reference);
}
function localizedCatalogName(item, index) {
  for (const reference of [item?.langKey, item?.itemType]) {
    if (reference && index.has(normalizeNameKey(reference))) return indexedName(reference, index);
  }
  return typeof item?.name === 'string' && item.name.trim() ? item.name : indexedName(item?.itemType, index);
}
function namesIndex(names) {
  return new Map((names instanceof Map ? [...names.entries()] : Object.entries(names || {}))
    .filter(([, label]) => typeof label === 'string' && label.trim())
    .map(([reference, label]) => [normalizeNameKey(reference), label.trim()]));
}

function curveXP(rank, scale) {
  if (!Number.isFinite(rank) || rank <= 0 || !Number.isFinite(scale) || scale <= 0) return 0;
  return 100 * Math.ceil(f(f(f(rank ** 2) * XP_MULTIPLIER) * f(scale * f(0.01))));
}

const validTable = value => Array.isArray(value) && value.length >= 2 && value.length <= 256 && value[0] === 0
  && value.every((entry, index) => validXP(entry) && (!index || entry > value[index - 1]));

function totalXPForRank(rank, table = null) {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  rank = Math.min(65536, Math.floor(rank));
  if (validTable(table)) {
    const last = table.length - 1;
    return rank <= last ? table[rank] : table[last] + (rank - last) * (table[last] - table[last - 1]);
  }
  const cap = curveXP(LEVEL_CAP, PLAYER_XP_SCALE);
  return rank <= LEVEL_CAP ? curveXP(rank, PLAYER_XP_SCALE)
    : cap + (rank - LEVEL_CAP) * (cap - curveXP(LEVEL_CAP - 1, PLAYER_XP_SCALE));
}

function itemXPForRank(rank, pact = false, table = null) {
  if (!Number.isFinite(rank)) return 0;
  if (validTable(table)) return table[Math.max(0, Math.min(table.length - 1, Math.floor(rank)))];
  return curveXP(Math.max(0, Math.min(LEVEL_CAP, Math.floor(rank))), pact ? PACT_XP_SCALE : 1);
}

function itemRankFromXP(xp, pact = false, table = null, maxRank = LEVEL_CAP) {
  if (!validXP(xp)) return null;
  let rank = 0;
  const cap = validTable(table) ? Math.min(maxRank, table.length - 1) : Math.min(maxRank, LEVEL_CAP);
  while (rank < cap && itemXPForRank(rank + 1, pact, table) <= xp) rank++;
  return rank;
}

function rankProgress(totalXP, table = null) {
  if (!validXP(totalXP)) return null;
  let lower = 0, upper = 65535;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (totalXPForRank(middle, table) <= totalXP) lower = middle;
    else upper = middle - 1;
  }
  const rank = lower;
  const current = totalXPForRank(rank, table), next = totalXPForRank(rank + 1, table);
  const currentRankXP = Math.min(next - current, totalXP - current);
  return { rank, currentRankXP, nextRankXP: next - current,
    progressPercent: Math.round(currentRankXP / (next - current) * 1000) / 10,
    totalXPForCurrentRank: current, totalXPForNextRank: next };
}

function equipmentType(value) {
  if (typeof value !== 'string' || value.length > 240
      || !/^\/SF\/(?:StoreItems\/)?(?:Weapons|Souls)\/[A-Za-z0-9_./-]+$/i.test(value)) return null;
  const path = value.replace(/^\/sf\/storeitems\//i, '/SF/');
  if (path.split('/').some(part => part === '.' || part === '..' || part.toLowerCase() === 'pets')) return null;
  const id = path.toLowerCase();
  const category = id.startsWith('/sf/souls/') ? 'pact' : id.startsWith('/sf/weapons/melee/') ? 'melee'
    : /^\/sf\/weapons\/(?:bows|ranged)\//.test(id) ? 'ranged'
      : /^\/sf\/weapons\/(?:pistols|sidearms)\//.test(id) ? 'sidearm' : 'weapon';
  return { id, path, category };
}

const WEAPON_MAX_XP = itemXPForRank(LEVEL_CAP);
const PACT_MAX_XP = itemXPForRank(LEVEL_CAP, true);

/** Upgrade only the known pre-P17 extraction; preserve current and future tables. */
function normalizeMasteryData(mastery) {
  const table = mastery?.itemRankXP?.weapon;
  if (!Array.isArray(table) || table.length !== LEVEL_CAP + 1 || !table.every((xp, rank) =>
    xp === 100 * Math.ceil(f(f(f(rank ** 2) * 250) * f(f(0.01)))))) return mastery;
  const weapon = table.map((_, rank) => itemXPForRank(rank));
  return { ...mastery, itemRankXP: { ...mastery.itemRankXP, weapon },
    items: Array.isArray(mastery.items) ? mastery.items.map(item => item.kind === 'weapon'
      && validXP(item.maxRank) && item.maxRank < weapon.length
      ? { ...item, xpForMaxRank: weapon[item.maxRank] } : item) : mastery.items };
}

function masteryTargetForItem(itemType, mastery) {
  mastery = normalizeMasteryData(mastery);
  const type = equipmentType(itemType);
  if (!type) return null;
  const config = (Array.isArray(mastery?.items) ? mastery.items : [])
    .find(item => equipmentType(item?.itemType)?.id === type.id);
  const pact = config?.kind ? config.kind === 'pact' : type.category === 'pact';
  const table = mastery?.itemRankXP?.[pact ? 'pact' : 'weapon'];
  const cap = validXP(config?.maxRank) && config.maxRank > 0 ? config.maxRank : LEVEL_CAP;
  return itemXPForRank(cap, pact, table);
}

function discoveryProgress(inventory, catalog, names = {}) {
  const normalize = value => typeof value === 'string' && value.length <= 300
    && /^\/SF\/[A-Za-z0-9_./-]+$/i.test(value) && !value.split('/').some(part => part === '.' || part === '..')
    ? value.toLowerCase().replace(/^\/sf\/storeitems\//, '/sf/') : null;
  const available = Array.isArray(inventory?.LoreFragmentScans);
  const configs = Array.isArray(catalog?.discoveries) ? catalog.discoveries : [];
  const labels = namesIndex(names);
  const known = new Set(configs.map(item => normalize(item?.itemType)).filter(Boolean));
  const progress = new Map(), masks = new Map();
  let unreadableRecords = 0, untrackedLocations = 0, invalidCatalogRows = 0;
  for (const scan of available ? inventory.LoreFragmentScans : []) {
    const id = normalize(scan?.ItemType);
    if (!id || !validXP(scan?.Progress)) { unreadableRecords++; continue; }
    if (!known.has(id)) {
      if (id.startsWith('/sf/types/quests/locationlorequests/')) untrackedLocations++;
      continue;
    }
    progress.set(id, Math.max(progress.get(id) || 0, scan.Progress));
    masks.set(id, (masks.get(id) || 0n) | BigInt(scan.Progress));
  }
  const seen = new Set();
  const rows = [];
  for (const item of configs) {
    const type = normalize(item?.itemType), id = typeof item?.id === 'string' ? item.id : type;
    if (!type || !id || seen.has(id) || !validXP(item.required) || item.required <= 0
        || !['location', 'tree'].includes(item.kind)
        || item.kind === 'tree' && (!validXP(item.bit) || item.bit > 52)) {
      invalidCatalogRows++; continue;
    }
    seen.add(id);
    const count = item.kind === 'tree' ? ((masks.get(type) || 0n) & (1n << BigInt(item.bit))) !== 0n ? 1 : 0 : progress.get(type) || 0;
    const current = available ? Math.min(item.required, count) : null;
    const name = localizedCatalogName(item, labels);
    rows.push({ id, itemType: item.itemType, name, kind: item.kind, required: item.required,
      current, complete: available ? current >= item.required : null,
      masteryEligible: item.kind === 'location' && item.masteryEligible === true,
      mastery: validXP(item.mastery) ? item.mastery : item.kind === 'location' ? XP_PER_DISCOVERY : 0,
      icon: typeof item.icon === 'string' ? item.icon : null, catalogOnly: !progress.has(type) });
  }
  rows.sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' }) || left.id.localeCompare(right.id));
  const eligible = rows.filter(row => row.masteryEligible);
  return { rows, available, complete: eligible.filter(row => row.complete === true).length, total: eligible.length,
    masteryXP: eligible.filter(row => row.complete === true).reduce((sum, row) => sum + row.mastery, 0),
    completeCatalog: available && eligible.length > 0 && invalidCatalogRows === 0 && unreadableRecords === 0 && untrackedLocations === 0,
    unreadableRecords, untrackedLocations };
}

/**
 * Inventory projection only. Missing discovery caps must not manufacture a
 * complete Envoy XP total. Optional verified discovery data has this contract:
 * { available: true, complete: number, total?: number, completeCatalog?: true }.
 * A catalog may supply { items: [{ itemType, name?, category? }] } for missing gear.
 */
function createMasteryTrackerModel({ getDiscoveries = () => null, getCatalog = () => null } = {}) {
  return {
    read(inventory, context = {}) {
      const available = plain(inventory) && !['connect', 'waiting'].includes(context.status);
      const source = available ? inventory : {};
      const catalog = available ? getCatalog(inventory, context) : null;
      const names = context.names || {}, labels = namesIndex(names);
      const mastery = normalizeMasteryData(catalog?.mastery);
      const progressionAvailable = validTable(mastery?.levelXP) && validTable(mastery?.itemRankXP?.weapon)
        && validTable(mastery?.itemRankXP?.pact);
      const configs = new Map((Array.isArray(mastery?.items) ? mastery.items : [])
        .map(item => [equipmentType(item?.itemType)?.id, item]).filter(([id]) => id));
      const excluded = new Set((Array.isArray(mastery?.excludedItemTypes) ? mastery.excludedItemTypes : [])
        .map(value => equipmentType(value)?.id).filter(Boolean));
      const approved = new Set(configs.keys()), untracked = new Set();
      const rows = new Map();
      let unreadableRecords = 0, invalidHistoricalXP = false;
      const historicalAvailable = Array.isArray(source.XPInfo);
      const incompleteOwnership = new Set(Object.keys(BUCKETS).filter(bucket => !Array.isArray(source[bucket])));
      function get(type) {
        if (!rows.has(type.id)) rows.set(type.id, { id: type.id, itemType: type.path, category: type.category,
          catalogName: null, catalogIcon: null, catalogued: false, owned: false, recorded: false,
          recordedXP: null, ownedXP: null, ownedCategories: new Set() });
        return rows.get(type.id);
      }
      function entries(bucket) {
        if (source[bucket] == null) return [];
        if (!Array.isArray(source[bucket])) { unreadableRecords++; return []; }
        return source[bucket];
      }
      for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
        const type = equipmentType(item?.itemType);
        if (!type || excluded.has(type.id)) continue;
        // The general collection catalog also contains abilities and upgrades
        // under /SF/Souls; those are not independently rankable Pacts.
        if (item.category && !['Soul', 'Weapon', 'pact', 'melee', 'ranged', 'sidearm', 'weapon'].includes(item.category)
            && !configs.has(type.id)) continue;
        approved.add(type.id);
        const row = get(type); row.catalogued = true;
        row.catalogName = localizedCatalogName(item, labels);
        row.catalogIcon = typeof item.icon === 'string' ? item.icon : null;
        if (['melee', 'ranged', 'sidearm', 'weapon'].includes(item.category) && row.category !== 'pact') row.category = item.category;
      }
      for (const entry of entries('XPInfo')) {
        if (!plain(entry)) { unreadableRecords++; invalidHistoricalXP = true; continue; }
        const type = equipmentType(entry.ItemType);
        if (type && excluded.has(type.id)) continue;
        if (!type) {
          // Pets and non-equipment entries grant no equipment mastery.
          if (typeof entry.ItemType !== 'string') { unreadableRecords++; invalidHistoricalXP = true; }
          continue;
        }
        if (!approved.has(type.id)) { untracked.add(type.id); continue; }
        const row = get(type); row.recorded = true;
        if (validXP(entry.XP)) row.recordedXP = maxXP(row.recordedXP, entry.XP);
        else { unreadableRecords++; invalidHistoricalXP = true; }
      }
      for (const [bucket, category] of Object.entries(BUCKETS)) {
        for (const entry of entries(bucket)) {
          if (typeof entry?.ItemType === 'string' && /\/pets\//i.test(entry.ItemType)) continue;
          const type = plain(entry) ? equipmentType(entry.ItemType) : null;
          if (type && excluded.has(type.id)) continue;
          if (!type || (category === 'pact') !== (type.category === 'pact')) {
            unreadableRecords++; incompleteOwnership.add(bucket); continue;
          }
          if (!approved.has(type.id)) { untracked.add(type.id); continue; }
          const row = get(type); row.owned = true; row.ownedCategories.add(category);
          if (validXP(entry.XP)) row.ownedXP = maxXP(row.ownedXP, entry.XP);
          else if (entry.XP !== undefined) unreadableRecords++;
        }
      }
      const output = [...rows.values()].map(row => {
        const category = row.ownedCategories.size === 1 ? [...row.ownedCategories][0]
          : row.ownedCategories.size > 1 ? 'weapon' : row.category;
        // XPInfo is the all-time record. A newly owned item without a valid
        // historical entry can still show useful progress, with its source marked.
        const xp = row.recordedXP ?? row.ownedXP ?? (row.catalogued && historicalAvailable && !row.recorded ? 0 : null);
        const xpSource = row.recordedXP !== null ? 'history' : row.ownedXP !== null ? 'owned-fallback'
          : xp === 0 ? 'catalog' : 'unavailable';
        const ownershipBuckets = { melee: ['Melee'], ranged: ['LongGuns'], pact: ['Suits'], sidearm: ['Pistols'],
          weapon: ['Melee', 'LongGuns', 'Pistols'] }[category];
        const owned = row.owned ? true : ownershipBuckets.some(bucket => incompleteOwnership.has(bucket)) ? null : false;
        const config = configs.get(row.id);
        const pact = config?.kind ? config.kind === 'pact' : category === 'pact';
        const table = progressionAvailable ? mastery.itemRankXP[pact ? 'pact' : 'weapon'] : null;
        const maxRank = validXP(config?.maxRank) && config.maxRank > 0 && config.maxRank <= 255 ? config.maxRank : LEVEL_CAP;
        const weight = validXP(config?.masteryPerRank) ? config.masteryPerRank : pact ? 200 : 100;
        const estimated = !progressionAvailable || !config || !validXP(config.masteryPerRank);
        const rank = itemRankFromXP(xp, pact, table, maxRank), target = itemXPForRank(maxRank, pact, table);
        const nextXP = rank === null || rank === maxRank ? null : itemXPForRank(rank + 1, pact, table);
        const currentXP = rank === null ? null : itemXPForRank(rank, pact, table);
        return { id: row.id, itemType: row.itemType, name: row.catalogName || indexedName(row.itemType, labels),
          category, owned, recorded: row.recorded, catalogued: row.catalogued, catalogOnly: row.catalogued && !row.recorded && !row.owned,
          icon: row.catalogIcon,
          xp, xpSource, rank, maxRank, nextXP, target, estimated, mastered: rank === null ? null : rank === maxRank,
          masteryXP: rank === null ? null : rank * weight,
          remainingMasteryXP: rank === null ? null : (maxRank - rank) * weight,
          rankProgressPercent: rank === null ? null : rank === maxRank ? 100
            : Math.round((xp - currentXP) / (nextXP - currentXP) * 1000) / 10 };
      }).sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'base' }) || left.id.localeCompare(right.id));
      const equipmentXP = output.reduce((sum, row) => sum + (row.masteryXP || 0), 0);
      const discoveries = available ? getDiscoveries(inventory, context) : null;
      const discoveriesAvailable = discoveries?.available === true && validXP(discoveries.complete) && discoveries.complete <= 10000;
      const completedDiscoveries = discoveriesAvailable ? discoveries.complete : null;
      const discoveryXP = discoveriesAvailable ? validXP(discoveries.masteryXP) ? discoveries.masteryXP
        : completedDiscoveries * XP_PER_DISCOVERY : null;
      // PlayerSkills is unused by Soulframe today. Accept only an explicit
      // numeric rank list/object if it starts appearing; unknown shapes cannot
      // silently produce a supposedly exact total.
      const skills = source.PlayerSkills;
      const skillValues = skills == null ? [] : Array.isArray(skills) ? skills : plain(skills) ? Object.values(skills) : null;
      const skillRanksAvailable = skillValues !== null && skillValues.length <= 1000 && skillValues.every(rank => validXP(rank) && rank <= 1000);
      const skillWeight = validXP(mastery?.playerSkillsPerRank) ? mastery.playerSkillsPerRank : 1500;
      const skillXP = skillRanksAvailable ? skillValues.reduce((sum, rank) => sum + rank * skillWeight, 0) : null;
      const totalXP = discoveryXP === null || skillXP === null ? null : equipmentXP + discoveryXP + skillXP;
      const scope = !discoveriesAvailable ? 'equipment-only'
        : discoveries.completeCatalog === true && historicalAvailable && !invalidHistoricalXP && untracked.size === 0 && progressionAvailable && skillRanksAvailable
          && !output.some(row => row.xpSource === 'owned-fallback' || row.xp === null || row.estimated && row.masteryXP > 0) ? 'complete' : 'known-discoveries';
      const inventoryEvidence = available && (historicalAvailable && !invalidHistoricalXP
        || output.some(row => row.xp !== null && ['history', 'owned-fallback'].includes(row.xpSource))
        || discoveriesAvailable || skillRanksAvailable && skillValues.length > 0);
      const progress = inventoryEvidence ? rankProgress(totalXP ?? equipmentXP, progressionAvailable ? mastery.levelXP : null) : null;
      // Envoy Rank is earned mastery from inventory, converted through the XP
      // curve. Endpoint PlayerLevel/Stats values and a release ceiling never
      // override it. Equipment alone is only a lower-bound diagnostic until
      // discovery and skill contributions can also be read.
      const currentRank = totalXP !== null && progress ? progress.rank : null;
      return { currentRank, rankSource: currentRank === null ? null : 'inventory-mastery',
        rankIsExact: currentRank !== null && scope === 'complete',
        equipmentXP, discoveryXP, skillXP, totalXP, completedDiscoveries, computedRank: progress?.rank ?? null,
        progress, scope, progressionAvailable, masteryDataSource: progressionAvailable ? 'catalog' : 'reference',
        rows: output, unreadableRecords, untrackedEquipment: untracked.size, historicalAvailable,
        ownershipUnavailableSections: [...incompleteOwnership], summary: { total: output.length,
          owned: output.filter(row => row.owned === true).length, recorded: output.filter(row => row.recorded).length,
          mastered: output.filter(row => row.mastered === true).length,
          inProgress: output.filter(row => row.rank > 0 && row.rank < row.maxRank).length,
          unstarted: output.filter(row => row.rank === 0).length, unknownXP: output.filter(row => row.xp === null).length,
          estimated: output.filter(row => row.estimated).length,
          ownedFallbacks: output.filter(row => row.xpSource === 'owned-fallback').length,
          remainingMasteryXP: output.reduce((sum, row) => sum + (row.remainingMasteryXP || 0), 0) } };
    },
  };
}

module.exports = { createMasteryTrackerModel, discoveryProgress, masteryTargetForItem, curveXP, totalXPForRank, itemXPForRank, itemRankFromXP, rankProgress,
  normalizeMasteryData, WEAPON_MAX_XP, PACT_MAX_XP, LEVEL_CAP, XP_PER_DISCOVERY };
