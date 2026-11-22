'use strict';
const { isTemperIconKey } = require('./gameDataImages');
// Public review archives can omit the game-derived fallback. A live or
// previously verified catalog still supplies all current rows and aliases.
let compatibility = { temperById: {}, aliases: {}, weaponAliases: {} };
try { compatibility = require('../generated/temper-compatibility.json'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const legacyRows = new Map(Object.entries(compatibility.temperById));
const legacyAliases = new Map(Object.entries(compatibility.aliases));
for (const id of legacyRows.keys()) {
  legacyAliases.set(id.toLowerCase(), id);
  legacyAliases.set(id.split('/').pop().replace(/Name$/, '').toLowerCase(), id);
}
const legacyTemperIcon = value => typeof value === 'string' && /^[A-Za-z0-9_-]+\.webp$/.test(value);

// Older catalogues used local filenames. Preserve their translated labels
// and match artwork by the stable game ID across locales and renamed icons.
function resolveTemperIcon(id, icon) {
  if (isTemperIconKey(icon)) return icon;
  const key = legacyRows.get(id)?.icon;
  return isTemperIconKey(key) ? key : '';
}

function temperAlias(catalog, value, weaponKey) {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  const alias = catalog?.weaponAliases[weaponKey]?.[key] || catalog?.aliases[key]
    || compatibility.weaponAliases[weaponKey]?.[key] || legacyAliases.get(key) || legacyAliases.get(key.split('#').pop());
  return typeof alias === 'string' ? alias : '';
}

// Market uses game identifiers and vendor tags from its own API. Resolve
// them against the same catalog the widgets use, including weapon-specific
// aliases where a default tag describes more than one temper.
function marketTemperIcons(catalog) {
  const rows = new Map(catalog?.tempers.map(row => [row.id, row.icon]));
  return (temper, uniqueName, weapon) => {
    const weaponKey = typeof weapon === 'string' ? weapon.toLowerCase().replace('/sf/storeitems/', '/sf/') : '';
    const identifiers = uniqueName !== temper.unique_name ? [uniqueName] : [temper.lang_key, temper.path, uniqueName, temper.tag];
    const candidates = identifiers.filter(Boolean).map(value => temperAlias(catalog, value, weaponKey) || value);
    candidates.push(`/SF/Language/Upgrades/${uniqueName}Name`);
    const id = candidates.find(key => rows.has(key)) || candidates.find(key => legacyRows.has(key));
    const current = rows.get(id);
    return isTemperIconKey(current) ? current : resolveTemperIcon(id, temper.icon);
  };
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const label = (value, max = 200) => typeof value === 'string' && value.length <= max;
const id = value => label(value) && /^\/SF\/Language\/[A-Za-z0-9_/-]+$/.test(value);
function aliases(value) {
  return plain(value) && Object.keys(value).length <= 10000 && Object.entries(value).every(([key, value]) => label(key) && id(value));
}
function weaponAliases(value) {
  return plain(value) && Object.keys(value).length <= 2000 && Object.entries(value).every(([key, value]) => label(key) && /^\/sf\/[a-z0-9_/-]+$/.test(key) && aliases(value));
}
function validTemperCatalog(value) {
  return value?.schema === 1 && Array.isArray(value.tempers) && value.tempers.length > 0 && value.tempers.length <= 128
    && new Set(value.tempers.map(row => row?.id)).size === value.tempers.length
    && value.tempers.every(row => id(row?.id) && label(row.name) && row.name && label(row.description, 4000) && label(row.origin)
      && (isTemperIconKey(row.icon) || legacyTemperIcon(row.icon)))
    && plain(value.weapons) && Object.keys(value.weapons).length <= 2000
    && Object.entries(value.weapons).every(([key, row]) => /^\/sf\/[a-z0-9_/-]+$/.test(key) && plain(row) && label(row.name) && label(row.art) && label(row.origin))
    && aliases(value.aliases) && weaponAliases(value.weaponAliases);
}
function validBuildCatalog(value) { return value?.schema === 1 && aliases(value.tempers) && Object.keys(value.tempers).length > 0 && weaponAliases(value.weaponTempers); }
module.exports = { validTemperCatalog, validBuildCatalog, resolveTemperIcon, marketTemperIcons, temperAlias, legacyTemperName: id => legacyRows.get(id)?.name };
