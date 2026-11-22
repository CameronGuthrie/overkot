'use strict';

const { createHash } = require('node:crypto');
const { imageUrl: gameImageUrl, LEGACY_IMAGE_ORIGIN } = require('./gameDataImages');

// These are physical holdings. XPInfo is ownership history, PendingRecipes are
// unfinished crafts, and a weapon's UpgradeType is already consumed joinery.
const SECTIONS = ['MiscItems', 'Consumables', 'Recipes', 'Melee', 'LongGuns', 'Suits', 'WeaponSkins', 'FlavourItems', 'Upgrades', 'RawUpgrades'];
const GEAR = ['Melee', 'LongGuns', 'Suits'];
const QUALITY_SLOTS = { NONE: [0, 1], WORN: [0, 1], MILITARY: [1, 3], OFFICER: [2, 4], NOBLE: [3, 5], MASTERWORK: [4, 6], LEGENDARY: [4, 8] };
const GRIPS = Object.fromEntries(Object.entries({ Archery: 'BowSkill', SecondaryThrowingKnives: 'ThrowingKnivesSkill', Greatsword: 'HeavySkill', Sword: 'SwordSkill', Casting: 'CastSkill', Polearm: 'PolearmSkill', Shield: 'ShieldsSkill', Dagger: 'DaggerSkill' })
  .map(([tree, grip]) => [`/SF/Upgrades/Techniques/${tree}SkillTree`, grip]));
const list = value => Array.isArray(value) ? value : [];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value.trim() : '';
const leaf = value => value.split('/').pop();
const oid = value => string(typeof value === 'string' ? value : value?.$oid);
const itemType = item => string(item?.ItemType || item?.Type);
const truthy = value => value === true || value === 'true';
// The market feed identifies store definitions, while physical holdings use
// their underlying game type. Preserve the entire remaining path: many runes
// share a leaf name such as StarterRune but belong to different weapon grips.
const inventoryPath = value => value.replace(/^\/SF\/StoreItems\//, '/SF/');

function integer(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fingerprint(value) {
  if (value == null || value === '') return {};
  if (record(value)) return value;
  if (typeof value === 'string' && value.length <= 65536) {
    try { const parsed = JSON.parse(value); if (record(parsed)) return parsed; } catch {}
  }
  return null;
}

function imageUrl(value) {
  value = string(value);
  if (!value) return '';
  const gameImage = gameImageUrl(value) || gameImageUrl('/' + value);
  if (gameImage) return gameImage;
  if (value.startsWith(LEGACY_IMAGE_ORIGIN) || value.startsWith('/SF/')) return '';
  if (/^https:\/\//i.test(value)) {
    try { const url = new URL(value); return !url.username && !url.password ? url.href : ''; } catch { return ''; }
  }
  return '';
}

function addIndex(index, key, item) {
  if (!key) return;
  if (!index.has(key)) index.set(key, new Map());
  index.get(key).set(item.id, item);
}

function catalogueIndex(items) {
  const paths = new Map(), inventoryPaths = new Map(), names = new Map();
  for (const input of list(items)) {
    if (!record(input)) continue;
    const data = record(input.attributes) ? { ...input, ...input.attributes } : input;
    // Never reconstruct an ID from unique_name: the server disambiguates IDs.
    const id = string(input.id);
    if (!id || id.length > 128 || /[/?#\\\u0000-\u001f]/.test(id) || data.isActive === false) continue;
    const path = string(data.path || data.sourcePath);
    const category = string(data.category).toLowerCase();
    const item = { id, path, category: path.includes('/Upgrades/Runes/') ? 'rune' : category,
      uniqueName: string(data.unique_name || data.sourceUniqueName), name: string(data.name || data.displayName) || id,
      slug: string(data.slug), imageUrl: imageUrl(data.imageUrl || data.image_path || data.icon),
      tradable: data.tradeable !== false && data.tradability !== 'NOT_TRADABLE',
      tempers: list(data.possible_tempers || data.sourcePossibleTempers) };
    addIndex(paths, path, item);
    addIndex(inventoryPaths, inventoryPath(path), item);
    addIndex(names, item.uniqueName, item);
  }
  return { paths, inventoryPaths, names };
}

function matchItem(type, index) {
  const direct = index.paths.get(type);
  if (direct) return direct.size === 1 ? { item: [...direct.values()][0] } : { ambiguous: true };
  const canonical = index.inventoryPaths.get(inventoryPath(type));
  if (canonical) return canonical.size === 1 ? { item: [...canonical.values()][0] } : { ambiguous: true };
  const named = index.names.get(leaf(type));
  if (!named) return {};
  if (named.size !== 1) return { ambiguous: true };
  const item = [...named.values()][0];
  // A conflicting full path is evidence of a different item, even when the
  // public feed happens to contain only one of the similarly named items.
  if (type.includes('/') && item.path.includes('/') && type !== item.path) return {};
  return { item };
}

function attributesFor(entry, section, item, options) {
  const attributes = {}, warnings = [];
  if (item.category === 'weapon' || item.category === 'weapons') {
    const quality = string(entry.Quality).replace(/^IQ_/, '');
    if (!Object.hasOwn(QUALITY_SLOTS, quality)) warnings.push('Weapon quality could not be read.');
    const aspect = fingerprint(entry.AspectFingerprint);
    const buffs = aspect && (aspect.buffs ?? aspect.Buffs ?? []);
    const tempers = [];
    if (!aspect || !Array.isArray(buffs) || buffs.length > 64) warnings.push('Weapon tempers could not be read.');
    else {
      const tags = new Map();
      for (const option of item.tempers) {
        if (!record(option) || !string(option.unique_name)) continue;
        let id = option.unique_name;
        // Match the market's configurable correction for the upstream Bypass ID.
        if (options.temperBypassOverrideEnabled !== false && id === 'AspectStaggerCrit'
          && (option.tag === 'OdeReduceDefenseMod' || option.icon === '/SF/Interface/Graphics/Aspects/Ode/Crush.png')) id = 'AspectReduceArmour';
        for (const alias of [string(option.tag), string(option.unique_name)]) {
          if (!alias) continue;
          if (!tags.has(alias)) tags.set(alias, new Set());
          tags.get(alias).add(id);
        }
      }
      for (const buff of buffs) {
        const tag = typeof buff === 'string' ? string(buff) : string(buff?.Tag || buff?.tag);
        const candidates = tags.get(tag);
        if (!candidates || candidates.size !== 1) warnings.push('A weapon temper is not recognised by the market catalogue.');
        else tempers.push([...candidates][0]);
      }
    }
    tempers.sort();
    const slots = QUALITY_SLOTS[quality];
    if (slots && (tempers.length < slots[0] || tempers.length > slots[1]
      || tempers.some(id => tempers.filter(value => value === id).length > 2))) {
      warnings.push('Weapon temper slots do not match its quality.');
    }
    if (entry.Shiny != null && ![true, false, 'true', 'false'].includes(entry.Shiny)) warnings.push('Moonsteel status could not be read.');
    attributes.weapon = { quality: Object.hasOwn(QUALITY_SLOTS, quality) ? quality : null,
      moonsteel: truthy(entry.Shiny), tempers };
  }
  if (item.category === 'rune' || item.category === 'mote') {
    const fp = fingerprint(entry.UpgradeFingerprint);
    // Unranked motes are individual Upgrades with compat/pol but no lvl. Runes
    // instead keep their rank-zero stacks in RawUpgrades. An explicit invalid
    // rank must never become zero through a null/default coercion.
    const defaultRank = section === 'RawUpgrades' || item.category === 'mote'
      && fp && ['compat', 'pol', 'virtue'].some(key => Object.hasOwn(fp, key)) ? 0 : null;
    const level = fp && integer(Object.hasOwn(fp, 'lvl') ? fp.lvl : defaultRank);
    const upgradeLevel = level !== null && level <= 3 ? level : null;
    if (upgradeLevel === null) warnings.push('Upgrade rank could not be read.');
    if (item.category === 'rune') attributes.rune = { upgradeLevel };
    else {
      const pol = fp && string(fp.pol || fp.virtue);
      const fromPath = /(?:^|[^A-Z])AP_(COURAGE|GRACE|SPIRIT)(?:$|[^A-Z])/.exec(itemType(entry))?.[1];
      const virtue = /^(?:AP_)?(COURAGE|GRACE|SPIRIT)$/.exec(pol)?.[1] || fromPath || null;
      if (!virtue) warnings.push('Mote virtue could not be read.');
      const compat = fp?.compat;
      const paths = compat == null ? [] : typeof compat === 'string' ? [compat] : list(compat);
      const grips = new Set(paths.map(path => path === '/SF/Types/Game/SFSkillTree' ? 'UNIVERSAL' : GRIPS[path] || null));
      const gripType = fp && (compat == null || (Array.isArray(compat) && compat.length === 0)) ? 'UNIVERSAL'
        : grips.size === 1 && !grips.has(null) ? [...grips][0] : null;
      if (!gripType) warnings.push('Mote grip could not be read.');
      attributes.mote = { virtue, upgradeLevel, gripType };
    }
  }
  return { attributes, warnings: [...new Set(warnings)] };
}

function collectReservations(inventory) {
  const ids = new Set(), counts = new Map();
  const reserveId = ref => { const id = oid(ref); if (id && !/^0+$/.test(id)) ids.add(id); };
  const active = new Set(list(inventory.CurrentLoadOutIds).map(oid).filter(Boolean));
  for (const presets of Object.values(record(inventory.LoadOutPresets) ? inventory.LoadOutPresets : {})) {
    for (const preset of list(presets)) {
      if (!active.has(oid(preset?.ItemId))) continue;
      for (const selection of Object.values(preset || {})) if (record(selection) && selection.ItemId) reserveId(selection.ItemId);
    }
  }
  const seenGear = new Set();
  for (const section of GEAR) {
    for (const gear of list(inventory[section])) {
      const id = oid(gear?.ItemId);
      if (id && seenGear.has(id)) continue;
      if (id) seenGear.add(id);
      // Installed upgrades and armour stay reserved even on an unequipped
      // weapon/pact. Configs reuse the same copy, so take the largest count
      // per path within a gear item, not the sum over saved configurations.
      const maximum = new Map();
      for (const config of list(gear?.Configs)) {
        const local = new Map();
        for (const ref of [...list(config?.Upgrades), ...list(config?.Skins)]) {
          if (typeof ref === 'string' && ref.startsWith('/')) local.set(ref, (local.get(ref) || 0) + 1);
          else reserveId(record(ref) && ref.ItemId ? ref.ItemId : ref);
        }
        for (const [path, count] of local) maximum.set(path, Math.max(maximum.get(path) || 0, count));
      }
      for (const [path, count] of maximum) counts.set(path, (counts.get(path) || 0) + count);
    }
  }
  return { ids, counts };
}

/**
 * Map current physical holdings to approved market items without exposing the
 * inventory envelope, account IDs, item instance IDs, or session credentials.
 * Variants have stable keys and API-ready weapon/mote/rune attributes. Unknown
 * attributes remain visible but cannot be quick-listed. Callers must separately
 * enforce fresh inventory and subtract existing sale commitments.
 */
function buildMarketInventory(rawInventory, catalogueItems, options = {}) {
  const inventory = record(rawInventory?.inventory) ? rawInventory.inventory : rawInventory;
  const summary = { inventoryAvailable: Boolean(record(inventory)), scannedEntries: 0, matchedEntries: 0,
    unmatchedEntries: 0, ambiguousEntries: 0, invalidEntries: 0, totalQuantity: 0,
    availableQuantity: 0, equippedQuantity: 0, protectedQuantity: 0, listableRows: 0 };
  if (!summary.inventoryAvailable) return { rows: [], summary };
  const index = catalogueIndex(catalogueItems), reserved = collectReservations(inventory);
  const groups = new Map(), seenIds = new Set(), instanceSignatures = new Map(), conflictingIds = new Set();
  // An instance repeated in two sections is one item. Conflicting repeats are
  // incomplete data, so neither version is safe for an automatic listing.
  for (const section of SECTIONS) {
    for (const entry of list(inventory[section])) {
      const id = oid(entry?.ItemId);
      if (!id) continue;
      const signature = JSON.stringify([itemType(entry), entry.ItemCount ?? 1, entry.Quality, entry.Shiny,
        entry.AspectFingerprint, entry.UpgradeFingerprint, entry.Tradeable, entry.Tradable,
        ...['Equipped', 'IsEquipped', 'Locked', 'IsLocked', 'Favourite', 'Favorite', 'IsFavourite', 'IsFavorite', 'Consumed', 'Deleted'].map(flag => truthy(entry[flag]))]);
      if (instanceSignatures.has(id) && instanceSignatures.get(id) !== signature) conflictingIds.add(id);
      else instanceSignatures.set(id, signature);
    }
  }
  for (const section of SECTIONS) {
    for (const entry of list(inventory[section])) {
      summary.scannedEntries++;
      const type = itemType(entry);
      if (!record(entry) || !type || type.length > 512 || /[\u0000-\u001f]/.test(type)) { summary.invalidEntries++; continue; }
      const id = oid(entry.ItemId);
      if (id && conflictingIds.has(id)) { summary.invalidEntries++; continue; }
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      const quantity = integer(entry.ItemCount ?? (section === 'RawUpgrades' && !id ? 0 : 1));
      if (quantity === null || (id && quantity > 1)) { summary.invalidEntries++; continue; }
      if (!quantity) continue;
      const match = matchItem(type, index);
      if (!match.item) {
        if (match.ambiguous) summary.ambiguousEntries++;
        else summary.unmatchedEntries++;
        continue;
      }
      summary.matchedEntries++;
      const item = match.item, { attributes, warnings } = attributesFor(entry, section, item, options);
      if (!item.tradable || entry.Tradeable === false || entry.Tradable === false) warnings.push('This item is marked as not tradeable.');
      const equipped = id && reserved.ids.has(id) || truthy(entry.Equipped) || truthy(entry.IsEquipped);
      const protectedItem = ['Locked', 'IsLocked', 'Favourite', 'Favorite', 'IsFavourite', 'IsFavorite', 'Consumed', 'Deleted'].some(flag => truthy(entry[flag]));
      const key = createHash('sha256').update(JSON.stringify([item.id, attributes, warnings])).digest('hex').slice(0, 32);
      let row = groups.get(key);
      if (!row) {
        row = { key, itemId: item.id, itemType: type, name: item.name, slug: item.slug, category: item.category,
          imageUrl: item.imageUrl, quantity: 0, availableQuantity: 0, equippedQuantity: 0, protectedQuantity: 0,
          attributes, warnings, canList: false, _types: new Set() };
        groups.set(key, row);
      }
      row._types.add(type);
      if (!Number.isSafeInteger(row.quantity + quantity)) { row.warnings.push('The inventory quantity is too large to list safely.'); continue; }
      row.quantity += quantity;
      if (equipped) row.equippedQuantity += quantity;
      else if (protectedItem) row.protectedQuantity += quantity;
    }
  }
  const rows = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.key.localeCompare(b.key));
  const variantsByType = new Map();
  for (const row of rows) {
    for (const type of row._types) {
      if (!variantsByType.has(type)) variantsByType.set(type, []);
      variantsByType.get(type).push(row);
    }
  }
  for (const [type, variants] of variantsByType) {
    if (!(reserved.counts.get(type) > 0) || variants.length < 2) continue;
    // A path-only installed reference cannot identify the rank/roll of a copy.
    // Never choose one variant based on sorting order and list the other one.
    for (const row of variants) {
      row.warnings.push('An installed copy of this item cannot be distinguished from its other variants.');
      row.protectedQuantity = row.quantity - row.equippedQuantity;
    }
    reserved.counts.delete(type);
  }
  for (const row of rows) {
    for (const type of row._types) {
      const needed = reserved.counts.get(type) || 0;
      const extra = Math.min(needed, row.quantity - row.equippedQuantity - row.protectedQuantity);
      row.equippedQuantity += extra;
      reserved.counts.set(type, needed - extra);
    }
    delete row._types;
    row.availableQuantity = row.quantity - row.equippedQuantity - row.protectedQuantity;
    row.canList = row.availableQuantity > 0 && row.warnings.length === 0;
    summary.totalQuantity += row.quantity;
    summary.availableQuantity += row.availableQuantity;
    summary.equippedQuantity += row.equippedQuantity;
    summary.protectedQuantity += row.protectedQuantity;
    if (row.canList) summary.listableRows++;
  }
  return { rows, summary };
}

module.exports = { buildMarketInventory };
