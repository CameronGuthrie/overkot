'use strict';

const { resolveName } = require('../renderer/inventory-format');
const { discoveryProgress } = require('./masteryTracker');
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/^\/sf\/storeitems\//, '/sf/') : '';
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const QUALITY = { IQ_WORN: 'Stock', IQ_MILITARY: 'Military', IQ_OFFICER: 'Officer', IQ_NOBLE: 'Noble', IQ_MASTERWORK: 'Sovereign', IQ_LEGENDARY: 'Legendary' };
const EQUIPMENT_SECTIONS = ['Melee', 'LongGuns', 'Pistols', 'Suits'];
const SECTIONS = ['Melee', 'LongGuns', 'Pistols', 'Suits', 'WeaponSkins', 'FlavourItems', 'MiscItems', 'Consumables', 'RawUpgrades', 'Upgrades'];
const list = value => Array.isArray(value) ? value : [];

/** Catalogue membership is separate from current ownership and historical XP. */
function createCollectionTrackerModel({ getCatalog = () => ({ items: [] }), cosmeticsOnly = false } = {}) {
  return {
    read(inventory, context = {}) {
      const catalog = getCatalog() || { items: [] }, names = context.names || {};
      const available = inventory && ['live', 'cached'].includes(context.status);
      const counts = new Map(), copies = new Map(), historical = new Set(), invalidSections = new Set();
      const catalogItems = catalog.items || [];
      const appearances = new Set(catalogItems.filter(row => ['Armor', 'Cosmetic'].includes(row.category)).map(row => normalize(row.itemType)));
      // Some owned appearances have no standalone inventory entry. Applied
      // game paths establish availability, but do not represent extra copies.
      const observeAppearance = value => {
        const id = normalize(value);
        if (appearances.has(id)) counts.set(id, Math.max(1, counts.get(id) || 0));
      };
      for (const section of SECTIONS) {
        if (!available || !Array.isArray(inventory[section])) { invalidSections.add(section); continue; }
        for (const row of inventory[section]) {
          const type = normalize(row?.ItemType);
          if (!type || row.ItemCount !== undefined && !validCount(row.ItemCount)) { invalidSections.add(section); continue; }
          const count = row.ItemCount === undefined ? 1 : row.ItemCount;
          counts.set(type, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(type) || 0) + count));
          if (EQUIPMENT_SECTIONS.includes(section)) {
            let fingerprint = row.AspectFingerprint;
            if (typeof fingerprint === 'string' && fingerprint.length < 65536) { try { fingerprint = JSON.parse(fingerprint); } catch { fingerprint = null; } }
            const buffs = fingerprint?.buffs || fingerprint?.Buffs;
            const tempers = (Array.isArray(buffs) ? buffs : []).slice(0, 16).filter(buff => typeof buff?.Tag === 'string' && buff.Tag.length <= 200)
              .map(buff => resolveName(buff.Tag, names));
            if (!copies.has(type)) copies.set(type, []);
            if (copies.get(type).length < 100) copies.get(type).push({ quality: QUALITY[row.Quality] || 'Quality unavailable',
              xp: validCount(row.XP) ? row.XP : null, tempers, moonsteel: row.Shiny === true || row.Moonsteel === true });
          }
        }
      }
      if (available) {
        for (const section of [...EQUIPMENT_SECTIONS, 'KubrowPets']) for (const row of list(inventory[section])) {
          if (!normalize(row?.ItemType) || row.ItemCount !== undefined && (!validCount(row.ItemCount) || row.ItemCount === 0)) continue;
          for (const config of list(row.Configs)) {
            for (const type of [...list(config?.Skins), ...list(config?.Transmog)]) observeAppearance(type);
          }
        }
        for (const field of ['MotherCustomization', 'SparrowCustomization']) {
          for (const type of list(inventory[field]?.Skins)) observeAppearance(type);
        }
        observeAppearance(inventory.ActiveAvatarImageType);
      }
      if (available && Array.isArray(inventory.XPInfo)) for (const row of inventory.XPInfo) {
        if (normalize(row?.ItemType) && validCount(row.XP) && row.XP > 0) historical.add(normalize(row.ItemType));
      }
      const sectionsFor = row => row.category === 'Weapon' ? /\/weapons\/melee\//i.test(row.itemType) ? ['Melee']
        : /\/weapons\/(?:bows|ranged)\//i.test(row.itemType) ? ['LongGuns'] : ['Melee', 'LongGuns', 'Pistols'] : row.category === 'Soul' ? ['Suits']
        : ['Armor', 'Cosmetic'].includes(row.category) ? ['WeaponSkins', 'FlavourItems']
          : ['Rune', 'Totem', 'Mote', 'Technique', 'Joinery'].includes(row.category) ? ['RawUpgrades', 'Upgrades', 'MiscItems']
            : ['MiscItems', 'Consumables'];
      const included = row => cosmeticsOnly ? row.category === 'Cosmetic' : ['Weapon', 'Armor', 'Soul', 'Cosmetic'].includes(row.category);
      const rows = catalogItems.filter(included).map(row => {
        const id = normalize(row.itemType), count = Math.max(counts.get(id) || 0,
          available && appearances.has(id) && row.defaultOwned === true ? 1 : 0);
        const owned = count > 0 ? true : sectionsFor(row).some(section => invalidSections.has(section)) ? null : false;
        return { id, itemType: row.itemType, name: names[row.itemType] || names[row.langKey] || row.name || resolveName(row.itemType, names),
          category: row.category, subcategory: row.subcategory, icon: row.icon, count, owned,
          acquired: owned === true || historical.has(id), historical: historical.has(id), copies: copies.get(id) || [], catalogued: true };
      });
      rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }));
      const summary = Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => {
        const group = rows.filter(row => row.category === category && row.catalogued);
        return [category, { total: group.length, owned: group.filter(row => row.owned === true).length,
          acquired: group.filter(row => row.acquired).length, unknown: group.filter(row => row.owned === null).length }];
      }));
      const scans = [];
      const approvedScans = new Set([...catalogItems, ...(catalog.discoveries || [])].map(row => normalize(row.itemType)));
      if (available && !cosmeticsOnly) for (const row of Array.isArray(inventory.LoreFragmentScans) ? inventory.LoreFragmentScans : []) {
        const type = row?.ItemType || row?.FragmentType || row?.LoreFragment;
        if (typeof type !== 'string' || !type.startsWith('/SF/') || type.length > 400 || !approvedScans.has(normalize(type))) continue;
        scans.push({ id: normalize(type), name: resolveName(type, names), count: validCount(row.Progress) ? row.Progress : null,
          read: row.Read === true, redeemed: row.Redeemed === true });
      }
      const discovery = discoveryProgress(available ? inventory : null, catalog, names);
      return { rows, summary, scans, discoveries: discovery.rows, discoveriesAvailable: discovery.available,
        catalogSource: catalog.source?.buildId || null,
        unavailableSections: [...invalidSections], total: rows.filter(row => row.catalogued).length };
    },
  };
}

module.exports = { createCollectionTrackerModel, normalize };
