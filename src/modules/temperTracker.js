'use strict';

const { EventEmitter } = require('node:events');
const { validTemperCatalog, resolveTemperIcon } = require('./catalogData');
let catalog = { schema: 1, tempers: [], weapons: {}, aliases: {}, weaponAliases: {} };
function setTemperCatalog(value) {
  if (!validTemperCatalog(value) || JSON.stringify(value) === JSON.stringify(catalog)) return false;
  catalog = value; return true;
}
const { currentPreset } = require('./buildExporter');
const list = value => Array.isArray(value) ? value : [];
const key = value => String(value || '').toLowerCase().replace('/sf/storeitems/', '/sf/');
const oid = value => typeof value === 'string' ? value : typeof value?.$oid === 'string' ? value.$oid : '';
const nameFromPath = value => String(value || '').split('/').pop().replace(/([a-z])([A-Z])/g, '$1 $2');
const QUALITY = { IQ_WORN: 'Stock', IQ_MILITARY: 'Military', IQ_OFFICER: 'Officer', IQ_NOBLE: 'Noble', IQ_MASTERWORK: 'Sovereign', IQ_LEGENDARY: 'Legendary' };
const UNLOCK_TARGET = 10;
// Weapon fingerprints share the heavy-attack tag; blacksmith items have distinct types.
const BLACKSMITH_ALIASES = {
  heavyattackdamageandstaggermod: '/SF/Language/Upgrades/AspectHeavyAttackName',
  magickheavyattackdamageandstaggermod: '/SF/Language/Upgrades/AspectHeavyCastAttackName',
};

function readUnlocks(inventory, rows, data) {
  let unreadableTempers = inventory?.RawUpgrades != null && !Array.isArray(inventory.RawUpgrades) ? 1 : 0;
  for (const item of list(inventory?.RawUpgrades)) {
    if (typeof item?.ItemType !== 'string') continue;
    const path = key(item.ItemType);
    if (!path.startsWith('/sf/types/items/aspects/tempers/')) continue;
    if (!/^\/sf\/types\/items\/aspects\/tempers\/[a-z0-9_-]{1,100}$/.test(path)
      || !Number.isSafeInteger(item.ItemCount) || item.ItemCount < 0) { unreadableTempers++; continue; }
    const tag = path.split('/').pop();
    const temperId = BLACKSMITH_ALIASES[tag] || data.aliases[path] || data.aliases[tag];
    const resolved = rows.has(temperId) ? temperId : 'unknown:' + tag;
    if (!rows.has(resolved)) rows.set(resolved, { id: resolved, name: nameFromPath(item.ItemType), description: '', origin: 'Unknown', icon: '',
      unknown: true, copies: 0, weaponCount: 0, sources: new Map(), unlockCount: 0, unlockTarget: UNLOCK_TARGET, unlocked: false });
    const row = rows.get(resolved);
    // RawUpgrades holds a total per type. Duplicate records must not invent progress.
    row.unlockCount = Math.max(row.unlockCount, Math.min(UNLOCK_TARGET, item.ItemCount));
    row.unlocked = row.unlockCount === UNLOCK_TARGET;
  }
  return unreadableTempers;
}

function readBuffs(weapon) {
  let fp = weapon.AspectFingerprint ?? weapon.aspectFingerprint;
  if (fp === '' || fp == null) return [];
  if (typeof fp === 'string') {
    if (fp.length > 65536) return null;
    try { fp = JSON.parse(fp); } catch { return null; }
  }
  if (!fp || typeof fp !== 'object' || Array.isArray(fp)) return null;
  const buffs = fp.buffs ?? fp.Buffs ?? [];
  return Array.isArray(buffs) && buffs.length <= 64 ? buffs : null;
}

function inventoryTempers(inventory, data = catalog) {
  const rows = new Map(data.tempers.map(temper => [temper.id, { ...temper, icon: resolveTemperIcon(temper.id, temper.icon), copies: 0, weaponCount: 0, sources: new Map(),
    unlockCount: 0, unlockTarget: UNLOCK_TARGET, unlocked: false }]));
  const unreadableTempers = readUnlocks(inventory, rows, data);
  const preset = currentPreset(inventory);
  const equipped = new Set([oid(preset?.m?.ItemId), oid(preset?.l?.ItemId)].filter(Boolean));
  const seen = new Set();
  let weaponCount = 0, unreadableWeapons = 0;
  for (const item of [...list(inventory?.Melee), ...list(inventory?.LongGuns)]) {
    if (!item || typeof item.ItemType !== 'string' || !/^\/SF\/[\w/.-]{1,180}$/.test(item.ItemType)) { unreadableWeapons++; continue; }
    const id = oid(item.ItemId);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    weaponCount++;
    const buffs = readBuffs(item);
    if (!buffs) { unreadableWeapons++; continue; }
    const itemKey = key(item.ItemType), weapon = data.weapons[itemKey];
    const name = weapon?.name || nameFromPath(item.ItemType);
    const quality = QUALITY[item.Quality] || '';
    const counts = new Map();
    let malformed = false;
    for (const buff of buffs) {
      // Value is a random roll seed, never the quantity. Each entry is one copy.
      const tag = typeof buff === 'string' ? buff : buff?.Tag ?? buff?.tag;
      if (typeof tag !== 'string' || !tag.trim() || tag.length > 180) { malformed = true; continue; }
      const normalized = key(tag.trim()), short = normalized.split('/').pop();
      const temperId = data.weaponAliases[itemKey]?.[short] || data.aliases[normalized] || data.aliases[short];
      const resolved = rows.has(temperId) ? temperId : 'unknown:' + normalized;
      if (!rows.has(resolved)) rows.set(resolved, { id: resolved, name: tag.trim(), description: '', origin: 'Unknown', icon: '',
        unknown: true, copies: 0, weaponCount: 0, sources: new Map(), unlockCount: null, unlockTarget: UNLOCK_TARGET, unlocked: false });
      counts.set(resolved, (counts.get(resolved) || 0) + 1);
    }
    if (malformed) unreadableWeapons++;
    for (const [temperId, stacks] of counts) {
      const row = rows.get(temperId);
      row.copies += stacks; row.weaponCount++;
      const sourceKey = JSON.stringify([itemKey, quality, stacks]);
      let source = row.sources.get(sourceKey);
      if (!source) {
        source = { name, quality, art: weapon?.art || '', stacks, count: 0, equippedCount: 0 };
        row.sources.set(sourceKey, source);
      }
      source.count++;
      if (equipped.has(id)) source.equippedCount++;
    }
  }
  const output = [...rows.values()].map(row => ({ ...row, sources: [...row.sources.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.quality.localeCompare(b.quality, 'en') || a.stacks - b.stacks) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
  return { weaponCount, unreadableWeapons, unreadableTempers, rows: output };
}

class TemperTracker extends EventEmitter {
  constructor({ getSession }) {
    super(); this.getSession = getSession;
    this.previous = null; this.session = null; this.status = null; this.lastValue = '';
    this.snapshot = { status: 'connect', ...inventoryTempers(null) };
  }
  update() {
    const session = this.getSession();
    const valid = session && !session.isNonceExpired();
    const raw = valid ? session.getRawInventory() : null;
    const status = !valid ? 'connect' : !raw ? 'waiting' : !catalog.tempers.length ? 'data' : session.isInventoryCached() ? 'cached' : 'live';
    const sameCatalog = catalog === this.previousCatalog;
    if (raw === this.previous && session === this.session && status === this.status && sameCatalog) return;
    const tally = raw === this.previous && session === this.session && sameCatalog ? this.snapshot : inventoryTempers(raw);
    this.previousCatalog = catalog;
    this.previous = raw; this.session = session; this.status = status;
    this.snapshot = { status, weaponCount: tally.weaponCount, unreadableWeapons: tally.unreadableWeapons,
      unreadableTempers: tally.unreadableTempers, rows: tally.rows };
    const value = JSON.stringify(this.snapshot);
    if (value !== this.lastValue) { this.lastValue = value; this.emit('changed', this.snapshot); }
  }
  getSnapshot() { this.update(); return this.snapshot; }
}
module.exports = { TemperTracker, inventoryTempers, setTemperCatalog, getTemperCatalog: () => catalog };
