'use strict';

// Match avakot-market/frontend/src/lib/categoryLabels.ts. Display labels never
// replace category or temper IDs used for matching inventory and listing writes.
const CATEGORIES = {
  armor: ['/SF/Language/Categories/Armour', 'Armour'],
  blueprint: ['/SF/Language/Materials/ChaosChordstoneName', 'Chaos Chordstone'],
  cosmetic: ['/SF/Language/Categories/Accessories', 'Accessories'],
  'key-item': [null, 'Keys'],
  kintsugi: ['/SF/Language/Menu/Kintsugi', 'Joinery'],
  'quest-item': ['/SF/Language/Categories/Misc', 'Miscellaneous'],
  resource: ['/SF/Language/Codex/Resource', 'Resources'],
  mote: ['/SF/Language/Categories/MotesPassive', 'Totems'],
  rune: ['/SF/Language/Categories/MotesActive', 'Runes'],
  totem: ['/SF/Language/Categories/Totem', 'Talisman'],
  weapon: ['/SF/Language/Categories/Weapons', 'Weapons'],
  weapons: ['/SF/Language/Categories/Weapons', 'Weapons'],
};
const text = value => typeof value === 'string' ? value.trim() : '';
const titleCase = value => text(value).replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
const translation = (pack, key) => key && Object.hasOwn(pack, key) ? text(pack[key]) : '';

function categoryLabel(category, pack = {}) {
  const key = text(category).toLowerCase();
  const definition = CATEGORIES[key];
  return definition ? translation(pack, definition[0]) || definition[1] : titleCase(key);
}

function resolveTemper(temper, pack) {
  if (!temper || typeof temper !== 'object' || Array.isArray(temper)) return temper;
  const id = text(temper.unique_name);
  // Older feeds omitted lang_key but still used the canonical Aspect* ID.
  const key = text(temper.lang_key) || (/^Aspect[A-Za-z0-9]+$/.test(id) ? `/SF/Language/Upgrades/${id}Name` : '');
  const readableName = [temper.displayName, temper.name].map(text)
    .find(name => name && name !== id && !/^\/?SF\//i.test(name) && !/^Aspect[A-Z]/.test(name));
  const name = translation(pack, key) || readableName
    || titleCase(id.replace(/^Aspect(?=[A-Z])/, '')) || 'Unknown temper';
  return { ...temper, name, displayName: name };
}

function resolveCatalogueDisplay(items, languagePack = {}) {
  const pack = languagePack && typeof languagePack === 'object' && !Array.isArray(languagePack) ? languagePack : {};
  return items.map(item => ({ ...item,
    name: translation(pack, item.lang_name_key || item.lang_key) || item.name,
    categoryLabel: categoryLabel(item.category, pack),
    possible_tempers: Array.isArray(item.possible_tempers) ? item.possible_tempers.map(temper => resolveTemper(temper, pack)) : [],
  }));
}

module.exports = { categoryLabel, resolveCatalogueDisplay };
