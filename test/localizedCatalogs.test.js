'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { localizedCatalog, catalogAsset } = require('../src/modules/localizedCatalogs');
const { getCollectionCatalog } = require('../src/modules/collectionCatalog');
const { wolfCatalog } = require('./fixtures/wolf-inventory');

test('display catalogues follow each game language on v2 and reuse verified data offline', () => {
  const guard = '/SF/Language/Pets/PetStat_Guard';
  const temper = '/SF/Language/Upgrades/AspectFearName';
  const description = '/SF/Language/Upgrades/AspectFearDamageDesc';
  const weapon = getCollectionCatalog().items.find(row => row.category === 'Weapon' && row.langKey);
  const english = { schema: 1, tempers: [{ id: temper, name: 'English temper', description: 'English description', origin: 'Universal', icon: 'temper.webp' }],
    weapons: { [weapon.id]: { name: 'English weapon', origin: '', art: '' } }, weaponAliases: {}, aliases: {} };
  const wolf = wolfCatalog();
  const files = { 'tempers/en.json': english, 'wolf-training/en.json': wolf };
  const manager = { manifest: { files }, readJSON: key => files[key], cachedPath: key => files[key] && key };
  const dictionary = code => ({ [guard]: `Guard ${code}`, [temper]: `Temper ${code}`, [description]: `Description ${code}`, [weapon.langKey]: `Weapon ${code}` });
  for (const locale of ['tc', 'th', 'uk']) {
    assert.equal(catalogAsset(manager, 'tempers', locale), 'tempers/en.json');
    const localized = localizedCatalog(manager, 'tempers', locale, dictionary);
    assert.equal(localized.tempers[0].name, `Temper ${locale}`);
    assert.equal(localized.tempers[0].description, `Description ${locale}`);
    assert.equal(localized.weapons[weapon.id].name, `Weapon ${locale}`);
    assert.equal(localizedCatalog(manager, 'wolf-training', locale, dictionary).labels[guard], `Guard ${locale}`);
  }
  assert.equal(english.tempers[0].name, 'English temper');
  manager.manifest = null;
  assert.equal(localizedCatalog(manager, 'tempers', 'uk', () => ({})).tempers[0].name, 'English temper');
  assert.equal(localizedCatalog(manager, 'wolf-training', 'th', dictionary).labels[guard], 'Guard th');
  files['tempers/uk.json'] = { ...english, tempers: [{ ...english.tempers[0], name: 'Compact local name' }] };
  assert.equal(localizedCatalog(manager, 'tempers', 'uk', () => { throw Error('Unexpected dictionary load'); }), files['tempers/uk.json']);
});
