'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { categoryLabel, resolveCatalogueDisplay } = require('../src/modules/marketDisplay');

test('market category labels distinguish totems, talismans, runes and joinery without changing category IDs', () => {
  const source = ['mote', 'totem', 'rune', 'kintsugi', 'blueprint', 'cosmetic', 'key-item', 'quest-item']
    .map(category => Object.freeze({ id: category, category, name: category }));
  const resolved = resolveCatalogueDisplay(source);
  assert.deepEqual(resolved.map(item => item.categoryLabel), ['Totems', 'Talisman', 'Runes', 'Joinery', 'Chaos Chordstone', 'Accessories', 'Keys', 'Miscellaneous']);
  assert.deepEqual(resolved.map(item => item.category), source.map(item => item.category));
  assert.equal(categoryLabel('weapon', { '/SF/Language/Categories/Weapons': 'Waffen' }), 'Waffen');
});

test('language projection resolves item and temper names while preserving exact trading identity and icon', () => {
  const temper = Object.freeze({ unique_name: 'AspectAttackSpeed', lang_key: '/SF/Language/Upgrades/AspectAttackSpeedName',
    name: 'AspectAttackSpeed', tag: 'AttackSpeedMod', icon: '/SF/Interface/Graphics/Aspects/Speed.png' });
  const source = Object.freeze({ id: 'weapon-123', category: 'weapon', name: 'InternalWeapon', lang_name_key: '/SF/Language/Weapons/Test',
    possible_tempers: Object.freeze([temper]) });
  const [resolved] = resolveCatalogueDisplay([source], {
    '/SF/Language/Weapons/Test': 'Blitzel', '/SF/Language/Upgrades/AspectAttackSpeedName': 'Swift',
  });
  assert.equal(resolved.name, 'Blitzel');
  assert.equal(resolved.possible_tempers[0].displayName, 'Swift');
  assert.deepEqual({ ...resolved.possible_tempers[0], name: temper.name, displayName: undefined }, { ...temper, displayName: undefined });
  assert.equal(source.possible_tempers[0].name, 'AspectAttackSpeed');
});

test('legacy feeds resolve canonical temper keys and language failures retain readable labels', () => {
  const item = { category: 'weapon', possible_tempers: [
    { unique_name: 'AspectAttackSpeed' }, { unique_name: 'future-temper', name: 'Future Temper' },
    { unique_name: 'AspectHeavyAttack', name: '/SF/Language/Upgrades/AspectHeavyAttackName' },
  ] };
  const [resolved] = resolveCatalogueDisplay([item], { '/SF/Language/Upgrades/AspectAttackSpeedName': 'Swift' });
  assert.deepEqual(resolved.possible_tempers.map(temper => temper.name), ['Swift', 'Future Temper', 'Heavy Attack']);
  assert.equal(resolveCatalogueDisplay([item], null)[0].categoryLabel, 'Weapons');
});
