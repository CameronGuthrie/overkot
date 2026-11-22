'use strict';

const { resolveName } = require('../renderer/inventory-format');
const { imageUrl: iconUrl } = require('./gameDataImages');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/^\/sf\/storeitems\//, '/sf/') : '';
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const list = value => Array.isArray(value) ? value : [];
const raw = inventory => plain(inventory?.inventory) ? inventory.inventory : plain(inventory) ? inventory : {};
const catalogRows = getCatalog => list(getCatalog?.()?.items);
const translated = (row, context) => context.names?.[row.itemType] || context.names?.[row.langKey] || row.name || resolveName(row.itemType, context.names);
const details = (row, context) => ({ id: key(row.itemType), itemType: row.itemType, name: translated(row, context),
  category: row.category || 'Other', subcategory: row.subcategory || '', icon: iconUrl(row.icon) });
// Published grip restrictions also used by the build exporter. Fingerprints
// can contain other internal definitions; their paths must not enter row IDs.
const PUBLIC_COMPATIBILITY = new Set(['Archery', 'Casting', 'Dagger', 'Greatsword', 'Polearm', 'Sword', 'SecondaryThrowingKnives', 'Shield']
  .map(name => key(`/SF/Upgrades/Techniques/${name}SkillTree`)));
PUBLIC_COMPATIBILITY.add('/sf/types/game/sfskilltree');

/** Missing/malformed sections are unknown, never evidence that the player holds zero. */
function stackCounts(inventory, sections) {
  const totals = new Map(), unavailable = [];
  for (const section of sections) {
    const rows = inventory[section];
    if (!Array.isArray(rows)) { unavailable.push(section); continue; }
    const values = new Map(); let valid = true;
    for (const entry of rows) {
      const id = key(entry?.ItemType), count = amount(entry?.ItemCount === undefined ? 1 : entry.ItemCount);
      if (!plain(entry) || !id || count === null || !Number.isSafeInteger((values.get(id) || 0) + count)) { valid = false; break; }
      values.set(id, (values.get(id) || 0) + count);
    }
    if (!valid) { unavailable.push(section); continue; }
    for (const [id, count] of values) totals.set(id, (totals.get(id) || 0) + count);
  }
  return { totals, unavailable };
}

// Currency art comes from the same extracted image collection as catalogue items.
const CURRENCIES = [
  { itemType: 'RegularCredits', name: 'Dracs', icon: '/SF/Interface/Graphics/StoreItems/Currency/Coin1.png' },
  { itemType: 'PremiumCredits', name: 'Arcs', icon: '/SF/Interface/Graphics/StoreItems/Currency/PremiumCurrency.png' },
  { itemType: 'FusionPoints', name: 'Harmony', icon: null },
];
function holdings(inventory) {
  const state = stackCounts(inventory, ['MiscItems', 'Consumables', 'RawUpgrades']);
  for (const row of CURRENCIES) {
    const count = amount(inventory[row.itemType]);
    if (count !== null) state.totals.set(key(row.itemType), count);
  }
  // Recipes can require equipment, skins or other crafted objects, not just resource stacks.
  for (const section of ['Melee', 'LongGuns', 'Suits', 'WeaponSkins', 'FlavourItems']) {
    if (!Array.isArray(inventory[section])) { state.unavailable.push(section); continue; }
    for (const row of inventory[section]) if (key(row?.ItemType)) {
      const id = key(row.ItemType); state.totals.set(id, (state.totals.get(id) || 0) + 1);
    }
  }
  return state;
}

function createResourcesModel({ getCatalog = () => null } = {}) {
  return { read(value, context = {}) {
    const inventory = raw(value), state = stackCounts(inventory, ['MiscItems', 'Consumables']);
    const rows = catalogRows(getCatalog).filter(row => ['resource', 'consumable', 'key item'].includes(String(row.category).toLowerCase()))
      .map(row => ({ ...details(row, context), count: state.totals.get(key(row.itemType)) ?? (state.unavailable.length ? null : 0) }));
    for (const row of CURRENCIES) rows.unshift({ ...row, id: key(row.itemType), category: 'Currency', subcategory: '', icon: iconUrl(row.icon), count: amount(inventory[row.itemType]) });
    rows.sort((a, b) => (a.category === 'Currency' ? -1 : b.category === 'Currency' ? 1 : 0) || a.name.localeCompare(b.name));
    return { rows, catalogAvailable: catalogRows(getCatalog).length > 0, unavailableSections: state.unavailable,
      summary: { types: rows.length, held: rows.filter(row => row.count > 0).length } };
  } };
}

function fingerprint(value) {
  if (plain(value)) return value;
  if (typeof value !== 'string' || value.length > 16384) return null;
  try { const result = JSON.parse(value); return plain(result) ? result : null; } catch { return null; }
}
function enhancementKind(row) {
  const category = String(row.category || '').toLowerCase();
  if (category === 'kintsugi') return 'joinery';
  if (category === 'mote' || category === 'rune') return 'mote';
  if (category === 'technique') return 'technique';
  if (category === 'totem') return 'totem';
  const text = `${row.category || ''} ${row.itemType || ''}`.toLowerCase();
  if (/kintsugi|joiner/.test(text)) return 'joinery';
  if (/totem/.test(text)) return 'totem';
  if (/technique/.test(text)) return 'technique';
  if (/mote|rune/.test(text)) return 'mote';
  return null;
}

function createEnhancementsModel({ getCatalog = () => null } = {}) {
  return { read(value, context = {}) {
    const inventory = raw(value), catalog = catalogRows(getCatalog), byType = new Map(catalog.map(row => [key(row.itemType), row]));
    const rows = new Map(), unavailableSections = [], unreadable = [];
    for (const section of ['RawUpgrades', 'Upgrades']) {
      if (!Array.isArray(inventory[section])) { unavailableSections.push(section); continue; }
      for (const entry of inventory[section]) {
        if (!plain(entry) || !key(entry.ItemType)) { unreadable.push(section); continue; }
        const def = byType.get(key(entry.ItemType));
        if (!def) continue;
        const kind = enhancementKind(def); if (!kind) continue;
        const fp = fingerprint(entry.UpgradeFingerprint);
        const level = section === 'RawUpgrades' ? 0 : fp?.lvl == null ? 0 : Number(fp.lvl);
        const count = section === 'RawUpgrades' ? amount(entry.ItemCount === undefined ? 1 : entry.ItemCount) : 1;
        if (!Number.isInteger(level) || level < 0 || level > 3 || count === null || entry.UpgradeFingerprint && !fp) { unreadable.push(section); continue; }
        const virtue = ['AP_COURAGE', 'AP_GRACE', 'AP_SPIRIT'].find(virtue => fp?.pol === virtue || fp?.Pol === virtue || fp?.virtue === virtue || entry.ItemType.includes(virtue))?.slice(3) || '';
        const compatibility = fp?.compat ?? fp?.Compat;
        const compatByType = new Map((Array.isArray(compatibility) ? compatibility : [compatibility])
          .filter(path => typeof path === 'string' && path.length <= 300 && /^\/SF\/[A-Za-z0-9_./-]+$/i.test(path)
            && !path.split('/').some(part => part === '.' || part === '..')
            && (PUBLIC_COMPATIBILITY.has(key(path)) || byType.has(key(path))))
          .map(path => [key(path), path]));
        const compatTypes = [...compatByType.keys()].sort();
        const compat = compatTypes.filter(path => path !== '/sf/types/game/sfskilltree')
          .map(path => resolveName(compatByType.get(path), context.names)).join(', ');
        // Identity uses the game paths. Different grips can share a translated
        // label, and localized labels change when the language changes.
        const id = `${key(entry.ItemType)}:${virtue}:${compatTypes.join('|')}`;
        if (!rows.has(id)) rows.set(id, { ...details(def, context), id, kind, virtue, compat, ranks: [0, 0, 0, 0], count: 0 });
        const row = rows.get(id); row.ranks[level] += count; row.count += count;
      }
    }
    return { rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)), unavailableSections, unreadableRecords: unreadable.length,
      summary: { types: rows.size, copies: [...rows.values()].reduce((sum, row) => sum + row.count, 0) } };
  } };
}

function ingredientCount(item, state, inventory, catalog) {
  const id = key(item.itemType);
  if (state.totals.has(id)) return state.totals.get(id);
  if (CURRENCIES.some(row => key(row.itemType) === id)) return amount(inventory[item.itemType]);
  const category = String(catalog.get(id)?.category || '').toLowerCase();
  const sections = category === 'consumable' ? ['Consumables'] : category === 'weapon' ? ['Melee', 'LongGuns']
    : category === 'soul' ? ['Suits'] : category === 'cosmetic' || category === 'armor' ? ['WeaponSkins', 'FlavourItems']
      : ['mote', 'totem', 'kintsugi', 'technique'].includes(category) ? ['RawUpgrades'] : ['MiscItems'];
  return sections.some(section => state.unavailable.includes(section)) ? null : 0;
}

function createCraftingPlannerModel({ getCatalog = () => null } = {}) {
  return { read(value, context = {}) {
    const inventory = raw(value), catalog = catalogRows(getCatalog), byType = new Map(catalog.map(row => [key(row.itemType), row]));
    const state = holdings(inventory);
    const rows = catalog.filter(row => plain(row.recipe) && Array.isArray(row.recipe.ingredients)).map(row => {
      const ingredients = row.recipe.ingredients.filter(item => key(item?.itemType) && amount(item.count) !== null && item.count > 0).map(item => {
        const def = byType.get(key(item.itemType)) || item;
        const choices = [...new Set([item.itemType, ...list(item.alternatives)].filter(value => typeof value === 'string'))]
          .map(itemType => ({ itemType, owned: ingredientCount({ itemType }, state, inventory, byType) }));
        const known = choices.filter(choice => choice.owned !== null).reduce((sum, choice) => sum + choice.owned, 0);
        return { ...details(def, context), required: item.count, choices,
          owned: choices.some(choice => choice.owned === null) && known < item.count ? null : known };
      });
      const complete = ingredients.length === row.recipe.ingredients.length;
      return { ...details(row, context), ingredients, recipeComplete: complete, recipeItemType: row.recipe.itemType,
        recipeKind: /reforge/i.test(row.recipe.itemType || '') || ingredients.some(item => key(item.itemType) === key(row.itemType)) ? 'reforge' : 'craft',
        owned: state.totals.get(key(row.itemType)) || 0,
        ready: complete && ingredients.every(item => item.owned !== null && item.owned >= item.required) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { rows, catalogAvailable: catalog.length > 0, unavailableSections: state.unavailable };
  } };
}

const QUALITY_NAMES = { IQ_WORN: 'Stock', IQ_MILITARY: 'Military', IQ_OFFICER: 'Officer', IQ_NOBLE: 'Noble', IQ_MASTERWORK: 'Sovereign', IQ_LEGENDARY: 'Legendary' };
function createCraftingLogModel({ getCatalog = () => null } = {}) {
  return { read(value, context = {}) {
    const inventory = raw(value), catalog = catalogRows(getCatalog), byType = new Map();
    for (const row of catalog) { byType.set(key(row.itemType), row); if (row.recipe?.itemType) byType.set(key(row.recipe.itemType), row); }
    const rows = [], ancestors = []; let unreadableRecords = 0;
    for (const ancestor of list(inventory.Ancestors)) {
      if (!plain(ancestor) || !key(ancestor.ItemType)) { unreadableRecords++; continue; }
      const ancestorName = resolveName(ancestor.ItemType, context.names), ancestorId = key(ancestor.ItemType);
      ancestors.push({ id: ancestorId, name: ancestorName, rank: amount(ancestor.Rank), xp: amount(ancestor.XP) });
      const seen = new Set();
      for (const path of list(ancestor.CompletedRecipes)) {
        if (typeof path !== 'string' || !path.startsWith('/SF/') || path.length > 1024) { unreadableRecords++; continue; }
        const match = /_IQ_([A-Z0-9]+)$/.exec(path), base = match ? path.slice(0, match.index) : path;
        const quality = match ? `IQ_${match[1]}` : 'IQ_WORN', id = `${ancestorId}:${key(base)}:${quality}`;
        if (seen.has(id)) continue; seen.add(id);
        const def = byType.get(key(base));
        if (!def) continue;
        rows.push({ ...details(def, context), id, ancestorId, ancestorName, quality, qualityName: QUALITY_NAMES[quality] || resolveName(quality), recorded: true });
      }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.quality.localeCompare(b.quality));
    return { rows, ancestors, available: Array.isArray(inventory.Ancestors), unreadableRecords };
  } };
}

/** Compare adjacent complete live snapshots only. No historical events are fabricated from a cache. */
function activityObservations(inventory) {
  const observations = new Map(), withheldSections = [];
  for (const section of ['MiscItems', 'Consumables', 'RawUpgrades', 'Melee', 'LongGuns', 'Suits', 'XPInfo']) {
    if (!Array.isArray(inventory[section])) { withheldSections.push(section); continue; }
    const entries = new Map(); let complete = true;
    for (const row of inventory[section]) {
      const type = key(row?.ItemType);
      const count = section === 'XPInfo' ? amount(row?.XP) : amount(row?.ItemCount === undefined ? 1 : row.ItemCount);
      if (!plain(row) || !type || count === null) { complete = false; break; }
      const previous = entries.get(type)?.count || 0;
      entries.set(type, { itemType: row.ItemType, count: section === 'XPInfo' ? Math.max(previous, count) : previous + count });
    }
    if (complete) observations.set(section, entries); else withheldSections.push(section);
  }
  for (const row of CURRENCIES) {
    const count = amount(inventory[row.itemType]);
    if (count === null) withheldSections.push(row.itemType);
    else observations.set(row.itemType, new Map([[key(row.itemType), { itemType: row.itemType, count, name: row.name }]]));
  }
  return { observations, withheldSections };
}

function createActivityModel({ getCatalog = () => null } = {}) {
  let identity = null, previous = new Map(), rows = [], observedAt = null, baselineAt = null, sequence = 0;
  const clear = () => { previous = new Map(); rows = []; observedAt = null; baselineAt = null; sequence = 0; };
  return { read(value, context = {}) {
    const nextIdentity = JSON.stringify([context.accountId ?? null, context.sessionEpoch ?? null]);
    if (identity !== nextIdentity || context.status !== 'live') { clear(); identity = nextIdentity; }
    if (context.status !== 'live') return { rows: [], baselineAt: null, tracking: false, withheldSections: [] };
    const at = Number.isFinite(context.updatedAt) && context.updatedAt > 0 ? context.updatedAt : Number.isFinite(context.now) ? context.now : Date.now();
    if (observedAt !== null && at < observedAt) return { rows, baselineAt, tracking: true, withheldSections: [] };
    const { observations, withheldSections } = activityObservations(raw(value));
    if (baselineAt === null) baselineAt = at;
    for (const [section, counts] of observations) {
      const before = previous.get(section); if (!before) continue;
      for (const id of new Set([...before.keys(), ...counts.keys()])) {
        const first = before.get(id), last = counts.get(id), delta = (last?.count || 0) - (first?.count || 0);
        // XPInfo is cumulative and can disappear from truncated snapshots; decreases are not observed XP gains.
        if (!delta || section === 'XPInfo' && delta < 0) continue;
        const item = last || first;
        rows.unshift({ id: ++sequence, itemType: item.itemType, name: item.name || resolveName(item.itemType, context.names), section,
          kind: section === 'XPInfo' ? 'xp' : CURRENCIES.some(row => row.itemType === section) ? 'currency' : 'item', delta, at });
      }
    }
    rows = rows.slice(0, 100); previous = observations; observedAt = at;
    // Catalogue/name data can arrive after events; enrich retained observations
    // without changing their identity or persisting raw inventory records.
    const catalogue = new Map(catalogRows(getCatalog).map(item => [key(item.itemType), item]));
    rows = rows.filter(row => CURRENCIES.some(item => item.itemType === row.itemType) || catalogue.has(key(row.itemType))).map(row => {
      const currency = CURRENCIES.find(item => item.itemType === row.itemType), item = catalogue.get(key(row.itemType));
      return { ...row, name: currency?.name || (item ? translated(item, context) : resolveName(row.itemType, context.names)),
        icon: iconUrl(currency?.icon || item?.icon), category: currency ? 'Currency' : item?.category || 'Other' };
    });
    return { rows, baselineAt, tracking: true, withheldSections };
  }, action(action) { if (action !== 'reset') return { ok: false }; clear(); return { ok: true }; } };
}

module.exports = { createResourcesModel, createEnhancementsModel, createCraftingPlannerModel, createActivityModel, createCraftingLogModel };
