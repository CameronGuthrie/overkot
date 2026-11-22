'use strict';

const { EventEmitter } = require('node:events');
const PACKAGE_PROGRESSION = require('../data/wolf-progression.json');

const PREFIX = '/SF/Language/Pets/';
const TRAINED_STATS = Object.freeze([
  { key: 'guard', field: 'Guard', label: 'Guts' },
  { key: 'speed', field: 'Speed', label: 'Speed' },
  { key: 'stamina', field: 'Stamina', label: 'Endurance' },
  { key: 'search', field: 'Search', label: 'Curiosity' },
  { key: 'support', field: 'Support', label: 'Heart' },
]);

// Verified native rule: floor(((base * level) ** power) / 100 + 0.5) * 100.
// Bond display ranks start at Wild; thresholds below describe ranks 2 through 5.
const DEFAULT_PROGRESSION = Object.freeze({
  maxEnergy: PACKAGE_PROGRESSION.maxEnergy, maxMaturity: PACKAGE_PROGRESSION.maxMaturity,
  skillThresholds: Object.freeze([600, 2000, 3900, 6300, 9000]),
  bondThresholds: Object.freeze([125000, 421900, 1000000, 1953100]), estimated: false, confirmedSkillLevels: 5,
});
const ENGLISH_LABELS = Object.freeze({
  ...Object.fromEntries(TRAINED_STATS.map(stat => [`${PREFIX}PetStat_${stat.field}`, stat.label])),
  [`${PREFIX}PetStat_Energy`]: 'Energy', [`${PREFIX}PetStat_Bond`]: 'Bond',
  [`${PREFIX}PetStat_Temperament`]: 'Temperament',
  [`${PREFIX}PetTemperment_Curious`]: 'Clever', [`${PREFIX}PetTemperment_Loyal`]: 'Loyal',
  [`${PREFIX}PetTemperment_Playful`]: 'Playful',
  [`${PREFIX}PetRank1_Wild`]: 'Wild', [`${PREFIX}PetRank2_Tame`]: 'Tame',
  [`${PREFIX}PetRank3_Loyal`]: 'Loyal', [`${PREFIX}PetRank4_Loving`]: 'Loving',
  [`${PREFIX}PetRank5_Soulbound`]: 'Soulbound',
  '/SF/Language/Quests/OrengallPupName1': 'Ciar',
  '/SF/Language/Quests/OrengallPupName2': 'Cathal',
  '/SF/Language/Quests/OrengallPupName3': 'Cuan',
});
const catalogs = new Map();
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e12;
const num = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
const oid = value => typeof value === 'string' ? value : typeof value?.$oid === 'string' ? value.$oid : '';
const locale = value => typeof value === 'string' ? value.toLowerCase().split('-')[0] : 'en';

function ascending(values, allowEmpty = false) {
  return Array.isArray(values) && values.length <= 16 && (allowEmpty || values.length > 0)
    && values.every((value, i) => positive(value) && (i === 0 || value > values[i - 1]));
}

function validWolfTrainingCatalog(value) {
  const progression = value?.progression;
  return value?.schema === 1 && plain(value.labels) && Object.keys(value.labels).length <= 500
    && TRAINED_STATS.every(stat => typeof value.labels[`${PREFIX}PetStat_${stat.field}`] === 'string'
      && value.labels[`${PREFIX}PetStat_${stat.field}`].trim())
    && Object.entries(value.labels).every(([key, label]) =>
      (/^\/SF\/Language\/Pets\/[A-Za-z0-9_]+$/.test(key)
        || /^\/SF\/Language\/Quests\/OrengallPupName\d+$/.test(key))
      && typeof label === 'string' && label.length > 0 && label.length <= 2000 && label.trim())
    && plain(progression) && positive(progression.maxEnergy) && positive(progression.maxMaturity)
    && ascending(progression.skillThresholds) && ascending(progression.bondThresholds, true)
    && (progression.estimated === undefined || typeof progression.estimated === 'boolean')
    && (progression.confirmedSkillLevels === undefined || (Number.isSafeInteger(progression.confirmedSkillLevels)
      && progression.confirmedSkillLevels >= 0 && progression.confirmedSkillLevels <= progression.skillThresholds.length));
}

function normalizeProgression(value) {
  if (!plain(value)) return DEFAULT_PROGRESSION;
  // Migrate the exact first-preview catalogue, including encrypted offline caches.
  // Other explicitly unknown or estimated catalogues retain their own precision.
  const legacy = value.estimated === true && Array.isArray(value.bondThresholds) && value.bondThresholds.length === 0
    && JSON.stringify(value.skillThresholds) === '[600,2000,3829,6156,8896]'
    && (value.confirmedSkillLevels === undefined || value.confirmedSkillLevels === 2);
  // The older overlay feed carries the previous game's 100-energy definition.
  // Upgrade only that known progression shape; explicit future/custom data must
  // retain its own maximum even when it differs from the packaged game snapshot.
  const legacyEnergy = value.maxEnergy === 100 && value.maxMaturity === 15
    && (legacy || value.estimated !== true
      && JSON.stringify(value.skillThresholds) === JSON.stringify(DEFAULT_PROGRESSION.skillThresholds)
      && JSON.stringify(value.bondThresholds) === JSON.stringify(DEFAULT_PROGRESSION.bondThresholds)
      && (value.confirmedSkillLevels === undefined || value.confirmedSkillLevels === 5));
  const maxEnergy = !legacyEnergy && positive(value.maxEnergy) ? value.maxEnergy : DEFAULT_PROGRESSION.maxEnergy;
  if (legacy) return { ...DEFAULT_PROGRESSION,
    maxEnergy,
    maxMaturity: positive(value.maxMaturity) ? value.maxMaturity : DEFAULT_PROGRESSION.maxMaturity };
  const thresholds = ascending(value.skillThresholds) ? [...value.skillThresholds] : [...DEFAULT_PROGRESSION.skillThresholds];
  const estimated = ascending(value.skillThresholds) ? value.estimated === true : DEFAULT_PROGRESSION.estimated;
  return {
    maxEnergy,
    maxMaturity: positive(value.maxMaturity) ? value.maxMaturity : DEFAULT_PROGRESSION.maxMaturity,
    skillThresholds: thresholds,
    bondThresholds: ascending(value.bondThresholds, true) ? [...value.bondThresholds] : [...DEFAULT_PROGRESSION.bondThresholds],
    estimated,
    confirmedSkillLevels: estimated ? Math.min(thresholds.length,
      Number.isSafeInteger(value.confirmedSkillLevels) ? Math.max(0, value.confirmedSkillLevels)
        : ascending(value.skillThresholds) ? 0 : DEFAULT_PROGRESSION.confirmedSkillLevels) : thresholds.length,
  };
}

function setWolfTrainingCatalog(value, language = 'en') {
  if (!validWolfTrainingCatalog(value)) return false;
  const next = { schema: 1, labels: { ...value.labels }, progression: normalizeProgression(value.progression) };
  const key = locale(language);
  if (JSON.stringify(catalogs.get(key)) === JSON.stringify(next)) return false;
  catalogs.set(key, next);
  return true;
}

function pawLevel(value, thresholds = DEFAULT_PROGRESSION.skillThresholds) {
  const xp = num(value);
  let level = 0;
  while (level < thresholds.length && xp >= thresholds[level]) level++;
  return level;
}

function pawProgress(value, thresholds = DEFAULT_PROGRESSION.skillThresholds) {
  const level = pawLevel(value, thresholds);
  if (level === thresholds.length) return level;
  const from = level ? thresholds[level - 1] : 0;
  return level + Math.max(0, Math.min(1, (num(value) - from) / (thresholds[level] - from)));
}

function equippedPetId(inventory) {
  const presets = inventory?.LoadOutPresets?.SENTINEL;
  if (!Array.isArray(presets)) return '';
  const currentIds = new Set((Array.isArray(inventory.CurrentLoadOutIds) ? inventory.CurrentLoadOutIds : []).map(oid).filter(Boolean));
  const preset = presets.find(row => currentIds.has(oid(row?.ItemId))) || presets[0];
  return oid(preset?.s?.ItemId);
}

function restDate(value) {
  const raw = value?.$date?.$numberLong ?? value?.$date;
  if (raw === null || raw === undefined || raw === '') return null;
  const time = Number(raw);
  return Number.isFinite(time) && time >= 0 && time <= 8640000000000000 ? time : null;
}

function inventoryWolves(value, catalog = null) {
  const inventory = plain(value?.inventory) && !value.KubrowPets ? value.inventory : value;
  const progression = normalizeProgression(catalog?.progression);
  const labels = { ...ENGLISH_LABELS, ...(catalog?.labels || {}) };
  const equipped = equippedPetId(inventory);
  const seen = new Set();
  const rows = [];
  let unreadablePets = inventory?.KubrowPets != null && !Array.isArray(inventory.KubrowPets) ? 1 : 0;
  for (const pet of Array.isArray(inventory?.KubrowPets) ? inventory.KubrowPets : []) {
    const id = oid(pet?.ItemId);
    if (!id || id.length > 128 || !plain(pet?.Details)) { unreadablePets++; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const details = pet.Details;
    const bond = typeof details.Bond === 'number' && Number.isFinite(details.Bond) && details.Bond >= 0 ? details.Bond : null;
    const temperament = String(details.Temperment || '').replace(/^TEMPERMENT_/, '').toLowerCase();
    const temperamentKey = temperament ? `${PREFIX}PetTemperment_${temperament[0].toUpperCase()}${temperament.slice(1)}` : '';
    let rank = 1;
    while (rank <= progression.bondThresholds.length && bond !== null && bond >= progression.bondThresholds[rank - 1]) rank++;
    const bondKey = bond !== null && progression.bondThresholds.length ? Object.keys(labels).find(key => key.startsWith(`${PREFIX}PetRank${rank}_`)) : null;
    const stats = TRAINED_STATS.map(stat => {
      const xp = num(details[stat.field]);
      const level = pawLevel(xp, progression.skillThresholds);
      return {
        key: stat.key, label: labels[`${PREFIX}PetStat_${stat.field}`], xp, level,
        progress: pawProgress(xp, progression.skillThresholds),
        allocated: Math.min(progression.skillThresholds.length, Math.floor(num(details[`${stat.field}Skill`]))),
        nextThreshold: progression.skillThresholds[level] ?? null,
        approximate: progression.estimated && level >= progression.confirmedSkillLevels,
      };
    });
    rows.push({
      id, name: typeof details.Name === 'string' ? labels[details.Name] || null : null,
      temperament: labels[temperamentKey] || null, temperamentLabel: labels[`${PREFIX}PetStat_Temperament`],
      bond, bondLabel: bondKey ? labels[bondKey] : null, bondStatLabel: labels[`${PREFIX}PetStat_Bond`],
      energy: num(details.Energy), energyLabel: labels[`${PREFIX}PetStat_Energy`], maxEnergy: progression.maxEnergy,
      needsRest: details.NeedsRest === true, restDate: restDate(details.RestDate), equipped: id === equipped,
      stats, trainedPaws: stats.reduce((sum, stat) => sum + stat.level, 0),
      availablePaws: stats.reduce((sum, stat) => sum + Math.max(0, stat.level - stat.allocated), 0),
    });
  }
  return { rows, activePetId: (rows.find(row => row.equipped) || rows[0])?.id || null,
    progression, unreadablePets };
}

class WolfTraining extends EventEmitter {
  constructor({ getSession, getLanguage = () => 'en' }) {
    super(); this.getSession = getSession; this.getLanguage = getLanguage;
    this.previous = null; this.session = null; this.lastValue = '';
    this.snapshot = { status: 'connect', catalogStatus: 'unavailable', progressionSource: 'verified-default',
      ...inventoryWolves(null), updatedAt: null };
  }
  update() {
    const session = this.getSession();
    const valid = session && !session.isNonceExpired();
    const raw = valid ? session.getRawInventory() : null;
    const status = !valid ? 'connect' : !raw ? 'waiting' : session.isInventoryCached() ? 'cached' : 'live';
    const language = locale(this.getLanguage());
    const catalog = catalogs.get(language) || catalogs.get('en') || null;
    const updatedAt = raw && typeof session.getLastSuccessfulPollAt === 'function' ? session.getLastSuccessfulPollAt() || null : null;
    if (raw === this.previous && session === this.session && status === this.status && catalog === this.catalog
      && language === this.language && updatedAt === this.snapshot.updatedAt) return;
    this.previous = raw; this.session = session; this.status = status; this.catalog = catalog; this.language = language;
    const tally = inventoryWolves(raw, catalog);
    this.snapshot = { status, catalogStatus: catalog ? 'ready' : 'unavailable',
      progressionSource: tally.progression.estimated ? 'estimated' : catalog ? 'catalog' : 'verified-default', ...tally, updatedAt };
    const serialized = JSON.stringify(this.snapshot);
    if (serialized !== this.lastValue) { this.lastValue = serialized; this.emit('changed', this.snapshot); }
  }
  getSnapshot() { this.update(); return this.snapshot; }
}

module.exports = { WolfTraining, setWolfTrainingCatalog, validWolfTrainingCatalog, inventoryWolves,
  equippedPetId, pawLevel, pawProgress, normalizeProgression, DEFAULT_PROGRESSION, TRAINED_STATS };
