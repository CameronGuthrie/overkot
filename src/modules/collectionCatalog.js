'use strict';

const CATEGORIES = Object.freeze(['Weapon', 'Armor', 'Soul', 'Rune', 'Totem', 'Cosmetic', 'Resource',
  'Consumable', 'Blueprint', 'Kintsugi', 'Mote', 'Pact Upgrade', 'Technique', 'Key Item']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = (value, max = 400) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008]/.test(value);
const gamePath = value => label(value, 300) && /^\/SF\/[A-Za-z0-9_./-]+$/i.test(value)
  && !value.split('/').some(part => part === '.' || part === '..');
const languageKey = value => value === null || gamePath(value) && value.startsWith('/SF/Language/');
const integer = (value, max = 1000000000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const validIcon = value => value === null || gamePath(value) && /^\/SF\/Interface\/Graphics\/.+\.png$/.test(value);

function normalizeItemType(value) {
  return gamePath(value) ? value.replace(/^\/SF\/StoreItems\//i, '/SF/').replace(/^\/SF\//i, '/SF/') : null;
}
function itemId(value) { return normalizeItemType(value)?.toLowerCase() || null; }
function validIngredient(value) {
  return plain(value) && gamePath(value.itemType) && label(value.name) && languageKey(value.langKey)
    && integer(value.count) && value.count > 0
    && Array.isArray(value.alternatives) && value.alternatives.length <= 32 && value.alternatives.every(gamePath);
}
function validItem(value) {
  return plain(value) && gamePath(value.itemType) && value.id === itemId(value.itemType) && label(value.name)
    && languageKey(value.langKey) && languageKey(value.descriptionKey) && CATEGORIES.includes(value.category)
    && typeof value.subcategory === 'string' && value.subcategory.length <= 160 && validIcon(value.icon)
    && (value.defaultOwned === undefined || typeof value.defaultOwned === 'boolean' && ['Armor', 'Cosmetic'].includes(value.category))
    && (value.recipe === null || plain(value.recipe) && gamePath(value.recipe.itemType)
      && Array.isArray(value.recipe.ingredients) && value.recipe.ingredients.length <= 64
      && value.recipe.ingredients.every(validIngredient));
}
function validCurve(value) {
  return Array.isArray(value) && value.length >= 2 && value.length <= 128 && value[0] === 0
    && value.every((number, index) => integer(number) && (index === 0 || number > value[index - 1]));
}
function validMastery(value) {
  return plain(value) && validCurve(value.levelXP) && plain(value.itemRankXP)
    && validCurve(value.itemRankXP.weapon) && validCurve(value.itemRankXP.pact)
    && integer(value.playerSkillsPerRank) && Array.isArray(value.excludedItemTypes)
    && value.excludedItemTypes.length <= 128 && value.excludedItemTypes.every(gamePath)
    && Array.isArray(value.items) && value.items.length <= 512
    && new Set(value.items.map(row => itemId(row?.itemType))).size === value.items.length
    && value.items.every(row => plain(row) && gamePath(row.itemType) && ['weapon', 'pact'].includes(row.kind)
      && label(row.name) && languageKey(row.langKey) && typeof row.subcategory === 'string'
      && integer(row.masteryPerRank) && integer(row.maxRank, 127) && row.maxRank > 0
      && row.maxRank < value.itemRankXP[row.kind].length && integer(row.maxMastery)
      && row.maxMastery === row.masteryPerRank * row.maxRank
      && row.xpForMaxRank === value.itemRankXP[row.kind][row.maxRank]);
}
function validDiscovery(row) {
  return plain(row) && gamePath(row.itemType) && label(row.id) && label(row.name)
    && languageKey(row.langKey) && integer(row.required, 1000) && row.required > 0
    && ['location', 'tree'].includes(row.kind) && typeof row.masteryEligible === 'boolean'
    && integer(row.mastery) && (row.kind !== 'tree' || integer(row.bit, 52))
    && (row.masteryEligible || row.mastery === 0);
}
function validateCollectionCatalog(value) {
  if (!plain(value) || value.schema !== 1 || !plain(value.source) || !label(value.source.buildId, 128)
      || !label(value.source.generatedAt, 80) || !/^[a-f0-9]{64}$/.test(value.source.sha256)
      || !/^[a-f0-9]{64}$/.test(value.source.masterySha256)
      || !/^[a-f0-9]{64}$/.test(value.source.availabilitySha256)
      || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 5000
      || new Set(value.items.map(row => row?.id)).size !== value.items.length || !value.items.every(validItem)
      || !validMastery(value.mastery) || value.mastery.excludedItemTypes.length !== 0
      || value.mastery.items.some(row => !value.items.some(item => item.id === itemId(row.itemType)))
      || !Array.isArray(value.discoveries) || value.discoveries.length > 1000
      || new Set(value.discoveries.map(row => row?.id)).size !== value.discoveries.length
      || !value.discoveries.every(validDiscovery)) throw new Error('Invalid collection catalogue');
  return value;
}

let catalog;
function getCollectionCatalog() {
  if (!catalog) catalog = validateCollectionCatalog(require('../data/collection-catalog.json'));
  return catalog;
}

module.exports = { CATEGORIES, normalizeItemType, itemId, validIcon, validateCollectionCatalog, getCollectionCatalog };
