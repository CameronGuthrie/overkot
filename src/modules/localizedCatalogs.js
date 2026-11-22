'use strict';

const { normalizeLocale } = require('./gameLocales');
const { getCollectionCatalog } = require('./collectionCatalog');
const { validTemperCatalog } = require('./catalogData');
const { validWolfTrainingCatalog } = require('./wolfTraining');

// The v2 feed predates some game languages. Its English pack still supplies
// the shared progression, item identifiers and artwork for those languages.
function catalogAsset(manager, section, language) {
  const key = `${section}/${normalizeLocale(language)}.json`;
  const englishKey = `${section}/en.json`;
  if (manager.manifest?.files[key] || manager.cachedPath?.(key)) return key;
  return manager.manifest?.files[englishKey] || manager.cachedPath?.(englishKey) ? englishKey : key;
}

const temperDescriptionKeys = {
  '/SF/Language/Upgrades/AspectReduceArmourName': '/SF/Language/Upgrades/AspectAspectReduceArmourDesc',
  '/SF/Language/Upgrades/AspectFearName': '/SF/Language/Upgrades/AspectFearDamageDesc',
};

function localizedCatalog(manager, section, language, loadDictionary) {
  const key = catalogAsset(manager, section, language);
  const catalog = manager.readJSON(key);
  if (!catalog || key === `${section}/${normalizeLocale(language)}.json`) return catalog;
  const entries = loadDictionary(language, { compact: false });
  const text = (id, fallback, limit = 200) => {
    const value = entries[id];
    return typeof value === 'string' && value.trim() && value.length <= limit ? value : fallback;
  };
  if (section === 'wolf-training') {
    if (!validWolfTrainingCatalog(catalog)) return null;
    return { ...catalog, labels: Object.fromEntries(Object.entries(catalog.labels).map(([id, label]) => [id, text(id, label, 2000)])) };
  }
  if (!validTemperCatalog(catalog)) return null;
  const weapons = { ...catalog.weapons };
  for (const { id, langKey } of getCollectionCatalog().items) {
    if (weapons[id]) weapons[id] = { ...weapons[id], name: text(langKey, weapons[id].name) };
  }
  const tempers = catalog.tempers.map(row => ({
    ...row,
    name: text(row.id, row.name),
    description: text(temperDescriptionKeys[row.id] || row.id.replace(/Name$/, 'Desc'), row.description, 4000),
  }));
  return { ...catalog, tempers, weapons };
}

module.exports = { catalogAsset, localizedCatalog };
