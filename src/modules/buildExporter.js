'use strict';

const { EventEmitter } = require('node:events');
const { deflateRawSync } = require('node:zlib');
const { validBuildCatalog } = require('./catalogData');
const { getCollectionCatalog } = require('./collectionCatalog');
const { masteryTargetForItem, createMasteryTrackerModel, discoveryProgress } = require('./masteryTracker');
let catalog = { schema: 1, tempers: {}, weaponTempers: {} };
function setBuildExportCatalog(value) {
  if (!validBuildCatalog(value)) return false;
  catalog = value; return true;
}
const { services } = require('./serviceConfig');
const QUALITY = ['IQ_WORN', 'IQ_MILITARY', 'IQ_OFFICER', 'IQ_NOBLE', 'IQ_MASTERWORK', 'IQ_LEGENDARY'];
const GRIPS = new Set(['Archery', 'Casting', 'Dagger', 'Greatsword', 'Polearm', 'Sword', 'SecondaryThrowingKnives', 'Shield']
  .map(name => `/SF/Upgrades/Techniques/${name}SkillTree`));
const list = value => Array.isArray(value) ? value : [];
const oid = value => typeof value === 'string' ? value : typeof value?.$oid === 'string' ? value.$oid : '';
const itemPath = value => typeof value === 'string' && /^\/SF\/[\w/.-]+$/.test(value) && value.length <= 180 ? value : '';
const key = value => String(value || '').toLowerCase().replace('/sf/storeitems/', '/sf/');
const integer = (value, min, max, fallback = min) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
const fingerprint = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.length < 100000) {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch {}
  }
  return {};
};
function failure(code) { return Object.assign(new Error(code), { code }); }
function currentPreset(inventory) {
  const active = new Set(list(inventory?.CurrentLoadOutIds).map(oid).filter(Boolean));
  const matches = list(inventory?.LoadOutPresets?.NORMAL).filter(preset => active.has(oid(preset?.ItemId)));
  // CurrentLoadOutIds also contains PVP and companion presets. Never guess the
  // first NORMAL preset or use one of those other categories.
  return matches.length === 1 ? matches[0] : null;
}
function nameOf(preset) { return typeof preset?.n === 'string' && preset.n.trim() ? preset.n.trim().slice(0, 42) : 'Current build'; }
function configOf(item, selection) {
  const configs = list(item?.Configs);
  return configs[integer(selection?.cus, 0, Math.max(0, configs.length - 1))] || {};
}
function buffsOf(value) {
  const out = [];
  for (const key of ['Buffs', 'buffs', 'TemperBuffs', 'temperBuffs', 'TemperSlots', 'temperSlots', 'Tempers', 'tempers',
    'TemperLoadout', 'temperLoadout', 'Mods', 'mods', 'PassiveMods', 'passiveMods', 'WeaponMods', 'weaponMods']) {
    const rows = value?.[key];
    if (Array.isArray(rows)) out.push(...rows);
    else if (rows && typeof rows === 'object') {
      for (const [tag, row] of Object.entries(rows)) {
        if (row === true || row === '' || row === 1) out.push(tag);
        else if (typeof row === 'string') out.push(row);
        else if (row && typeof row === 'object') out.push({ ...row, ItemType: row.ItemType ?? row.itemType ?? tag });
      }
    }
  }
  const aspect = fingerprint(value?.AspectFingerprint ?? value?.aspectFingerprint);
  out.push(...list(aspect.buffs), ...list(aspect.Buffs));
  return out; // The planner models positive tempers, not curses or random seeds.
}
function temperTag(value) {
  if (typeof value === 'string') return value;
  return ['ItemType', 'itemType', 'InternalID', 'internalId', 'Tag', 'tag', 'ModType', 'modType', 'BuffType', 'buffType']
    .map(field => value?.[field]).find(row => typeof row === 'string') || '';
}

function inventoryToBuild(inventory, data = catalog, mastery = getCollectionCatalog().mastery) {
  const preset = currentPreset(inventory);
  if (!preset) throw failure('no-loadout');
  let partial = false;
  const weapons = new Map([...list(inventory.LongGuns), ...list(inventory.Melee)].map(row => [oid(row.ItemId), row]));
  const suits = new Map(list(inventory.Suits).map(row => [oid(row.ItemId), row]));
  function equipped(selection, entries) {
    const ref = oid(selection?.ItemId);
    if (!ref || /^0+$/.test(ref)) return null;
    const item = entries.get(ref);
    if (!item || !itemPath(item.ItemType)) throw failure('incomplete-loadout');
    return item;
  }
  const primary = equipped(preset.m, weapons), secondary = equipped(preset.l, weapons), pact = equipped(preset.s, suits);
  if (!primary && !secondary && !pact) throw failure('incomplete-loadout');
  const upgrades = new Map(), upgradesByType = new Map();
  for (const row of [...list(inventory.Upgrades), ...list(inventory.RawUpgrades)]) {
    if (oid(row?.ItemId) && !upgrades.has(oid(row.ItemId))) upgrades.set(oid(row.ItemId), row);
    if (itemPath(row?.ItemType) && !upgradesByType.has(key(row.ItemType))) upgradesByType.set(key(row.ItemType), row);
  }
  function upgrade(ref) {
    const direct = itemPath(ref), item = direct ? upgradesByType.get(key(direct)) : upgrades.get(oid(ref));
    const id = itemPath(item?.ItemType) || direct;
    if (!id && oid(ref) && !/^0+$/.test(oid(ref))) partial = true;
    const fp = fingerprint(item?.UpgradeFingerprint);
    const pol = fp.pol ?? fp.Pol;
    const virtue = /^AP_(COURAGE|SPIRIT|GRACE)$/.test(pol) ? pol.slice(3).toLowerCase()
      : /AP_(COURAGE|SPIRIT|GRACE)/.exec(id)?.[1].toLowerCase() || '';
    const compat = fp.compat ?? fp.Compat;
    const grip = (Array.isArray(compat) ? compat : [compat]).find(row => GRIPS.has(row)) || '';
    return { id, rank: id ? integer(fp.lvl, 0, 3) : 0, virtue, grip };
  }
  function weapon(item, selection) {
    const config = configOf(item, selection), refs = list(config.Upgrades);
    const rune = upgrade(refs[0]);
    const motes = Object.fromEntries(['courage', 'spirit', 'grace', 'bonus'].map((socket, index) => [socket, upgrade(refs[index + 1])]));
    const tempers = [], counts = new Map();
    for (const raw of [...buffsOf(config), ...buffsOf(item)]) {
      const tag = temperTag(raw).trim().toLowerCase();
      const short = tag.split('/').pop().replace(/\.(lua|json|cfg)$/, '');
      const id = data.weaponTempers?.[key(item?.ItemType)]?.[short] || data.tempers[tag] || data.tempers[short];
      if (typeof id !== 'string' || !id) { if (tag) partial = true; continue; }
      const count = counts.get(id) || 0;
      if (count < 2 && tempers.length < 8) { tempers.push(id); counts.set(id, count + 1); }
    }
    const xp = Number.isSafeInteger(item?.XP) && item.XP >= 0 ? item.XP : list(inventory.XPInfo)
      .filter(row => key(row?.ItemType) === key(item?.ItemType) && Number.isSafeInteger(row?.XP) && row.XP >= 0)
      .reduce((highest, row) => Math.max(highest, row.XP), 0);
    // Preserve the exporter contract: mastered or editable at zero. Use the
    // current threshold, shared with both equipment progress widgets.
    const target = masteryTargetForItem(item?.ItemType, mastery);
    if (item && (target === null || xp < target)) partial = true;
    const minimum = tempers.length <= 1 ? 0 : tempers.length <= 3 ? 1 : Math.min(5, tempers.length - 2);
    return { rank: target !== null && xp >= target ? 30 : 0, craftwork: Math.max(minimum, QUALITY.indexOf(item?.Quality)),
      rune: { id: rune.id, rank: rune.rank }, motes, tempers, joinery: itemPath(item?.UpgradeType) };
  }
  const main = weapon(primary, preset.m), side = weapon(secondary, preset.l);
  const equipment = { helm: '', cuirass: '', leggings: '', talisman: '', pact: itemPath(pact?.ItemType),
    weapon: itemPath(primary?.ItemType), sidearm: itemPath(secondary?.ItemType) };
  const skins = new Map(list(inventory.WeaponSkins).map(row => [oid(row.ItemId), itemPath(row.ItemType)]));
  for (const ref of list(configOf(pact, preset.s).Skins)) {
    const path = itemPath(ref) || skins.get(oid(ref)) || '';
    const slot = path.includes('/Skins/Totem/') ? 'talisman' : path.includes('/Skins/Helmets/') ? 'helm'
      : path.includes('/Skins/Legs/') ? 'leggings' : path.includes('/Skins/Body/') ? 'cuirass' : null;
    if (slot && !equipment[slot]) equipment[slot] = path;
  }
  // Use the same inventory-only mastery projection as the rank widget. The
  // planner needs a numeric editable value; missing mastery stays partial at
  // zero rather than silently substituting PlayerLevel or profile statistics.
  const collection = { ...getCollectionCatalog(), mastery };
  const progression = createMasteryTrackerModel({ getCatalog: () => collection,
    getDiscoveries: value => discoveryProgress(value, collection) }).read(inventory, { status: 'live' });
  const rank = progression.currentRank ?? 0;
  if (progression.currentRank === null || !progression.rankIsExact) partial = true;
  const entry = Number.isFinite(preset.vu) && Number.isFinite(preset.vv) ? preset
    : list(preset.p || preset.at || preset.Perks).find(row => row?.v === '/SF/Types/Items/AttributeItems/DynamicVirtues');
  if (!Number.isFinite(entry?.vu) || !Number.isFinite(entry?.vv)) partial = true;
  const pool = 13 + rank;
  const spirit = 1 + Math.round(Math.max(0, Math.min(1, entry?.vu || 0)) * pool);
  const grace = Math.min(15 + rank - spirit, 1 + Math.round(Math.max(0, Math.min(1, entry?.vv || 0)) * pool));
  const stats = { courage: 16 + rank - spirit - grace, spirit, grace };
  const bonus = quest => {
    const row = list(inventory.BonusAttributes).find(row => row?.key === quest);
    return { AT_COURAGE: 'courage', AT_SPIRIT: 'spirit', AT_GRACE: 'grace' }[row?.value] || '';
  };
  const skillTrees = list(inventory.SkillTrees).filter(tree => itemPath(tree?.ItemType) && Array.isArray(tree.Skills)).map(tree => ({
    treeId: tree.ItemType, skills: tree.Skills.filter(skill => itemPath(skill?.ItemType) && Number.isInteger(skill.Level) && skill.Level >= 0 && skill.Level <= 3)
      .map(skill => ({ skillId: skill.ItemType, level: skill.Level })),
  }));
  if (skillTrees.length > 30 || skillTrees.some(tree => tree.skills.length > 32)) throw failure('too-large');
  return { partial, state: { name: nameOf(preset), notes: '', rank, stats,
    questVirtues: { shewolf: bonus('OrengallQuest'), wasteBear: bonus('BromiusQuest') }, equipment,
    weaponRanks: { weapon: main.rank, sidearm: side.rank }, craftworks: { weapon: main.craftwork, sidearm: side.craftwork },
    pactSkills: {}, combatArts: {}, skillTrees,
    joineries: { weapon: main.joinery, sidearm: side.joinery }, tempers: { weapon: main.tempers, sidearm: side.tempers },
    runes: { weapon: main.rune, sidearm: side.rune }, motes: { weapon: main.motes, sidearm: side.motes } } };
}

function buildImportUrl(state, website = services.buildWebsite) {
  if (!website) throw failure('not-configured');
  // The existing website requires this source marker for its v1 import contract.
  const bytes = Buffer.from(JSON.stringify({ v: 1, source: 'little-genius', state }));
  if (bytes.length > 100000) throw failure('too-large');
  const code = 'v1z.' + deflateRawSync(bytes, { level: 9 }).toString('base64url');
  if (code.length > 32768) throw failure('too-large');
  return `${website}/?new=1&import=1#lg=${code}`;
}

class BuildExporter extends EventEmitter {
  constructor({ getSession, openDraft, website = services.buildWebsite }) {
    super();
    this.getSession = getSession;
    this.openDraft = openDraft;
    this.website = website;
    this.pending = null;
    this.lastStatus = '';
  }
  getStatus() {
    if (!this.website) return { available: false, reason: 'not-configured', name: '' };
    const session = this.getSession();
    if (!session || session.isNonceExpired()) return { available: false, reason: 'connect', name: '' };
    if (!Object.keys(catalog.tempers).length) return { available: false, reason: 'data', name: '' };
    if (session.isInventoryCached() || !session.getRawInventory()) return { available: false, reason: 'waiting', name: '' };
    const preset = currentPreset(session.getRawInventory());
    return { available: !!preset, reason: preset ? 'ready' : 'no-loadout', name: preset ? nameOf(preset) : '' };
  }
  update() {
    const status = this.getStatus(), value = JSON.stringify(status);
    if (value !== this.lastStatus) { this.lastStatus = value; this.emit('changed', status); }
  }
  exportCurrent() {
    if (this.pending) return this.pending;
    this.pending = this.export().finally(() => { this.pending = null; });
    return this.pending;
  }
  async export() {
    if (!this.website) return { ok: false, error: 'not-configured' };
    try {
      const session = this.getSession();
      if (!session || session.isNonceExpired()) throw failure('connect');
      if (!Object.keys(catalog.tempers).length) throw failure('data');
      // One explicit fresh read per click. Never export the old account cache.
      const result = await session.api.fetchInventory(session.accountId, session.nonce).catch(() => null);
      if (session !== this.getSession() || result?.nonceExpired || session.isNonceExpired()) throw failure('session-changed');
      if (!result?.data) throw failure('refresh-failed');
      const { state, partial } = inventoryToBuild(result.data);
      await this.openDraft(buildImportUrl(state, this.website));
      return { ok: true, partial };
    } catch (error) {
      const allowed = ['connect', 'data', 'session-changed', 'refresh-failed', 'no-loadout', 'incomplete-loadout', 'too-large'];
      return { ok: false, error: allowed.includes(error.code) ? error.code : 'open-failed' };
    }
  }
}
module.exports = { BuildExporter, inventoryToBuild, currentPreset, buildImportUrl, setBuildExportCatalog };
