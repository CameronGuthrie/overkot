'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getCollectionCatalog, validateCollectionCatalog, normalizeItemType, itemId, validIcon } = require('../src/modules/collectionCatalog');
const { projectCollectionData: project, validateCatalogAvailability } = require('../scripts/build-collection-data');
const { validFile } = require('../scripts/overlay-feed/source');

const source = { buildId: 'test-build', generatedAt: '2026-11-05T20:06:14Z', sha256: 'a'.repeat(64), masterySha256: 'b'.repeat(64), availabilitySha256: 'c'.repeat(64) };
const availability = { schema: 1, items: ['/SF/Weapons/Melee/Sword', '/SF/Types/Items/Iron', '/SF/Types/Items/Steel', '/SF/Types/Recipes/Sword'].map(itemType => ({ itemType })) };
const projectCollectionData = (raw, mastery, provenance, approved = availability) => project(raw, mastery, provenance, approved);
const mastery = () => ({ formula: { level_xp: [0, 1300, 5000], item_rank_xp: { weapon: [0, 300, 1000], pact: [0, 500, 2000] } },
  sources: { items: { entries: [{ type: '/SF/Weapons/Melee/Sword', kind: 'weapon', name: 'Sword', name_key: '/SF/Language/Weapons/SwordName',
    mastery_per_rank: 100, max_rank: 2, max_mastery: 200, xp_for_max_rank: 1000 }], excluded: [] },
  location_lore: { entries: [{ type: '/SF/Types/Quests/LocationLoreQuests/Fort', name: 'Fort', name_key: '/SF/Language/Locations/Fort', threshold: 4, mastery: 5000 }] },
  world_trees: { counts_in_client_formula: false, entries: [{ bit: 0, name: 'Tree', name_key: '/SF/Language/Locations/MapTreeNameA', mastery: 0 }] },
  player_skills: { mastery_per_rank: 1500 } } });
const item = changes => ({ path: '/SF/StoreItems/Weapons/Melee/Sword', name: 'Sword', lang_key: '/SF/Language/Weapons/SwordName',
  lang_desc_key: '/SF/Language/Weapons/SwordDesc', category: 'Weapon', subcategory: 'Melee',
  icon: '/SF/Interface/Graphics/StoreItems/Weapons/Sword.png', ...changes });

test('bundled collection snapshot includes verifiable S3 provenance and offline mastery/discovery data', () => {
  const value = getCollectionCatalog();
  assert.equal(validateCollectionCatalog(value), value);
  assert.match(value.source.buildId, /^\d{4}-\d{2}-\d{2}T[A-Za-z0-9._-]+$/);
  assert.match(value.source.masterySha256, /^[a-f0-9]{64}$/);
  assert.match(value.source.availabilitySha256, /^[a-f0-9]{64}$/);
  assert.ok(value.items.length > 300);
  assert.ok(value.items.some(row => row.name === "Goody's Edge"));
  assert.ok(value.items.some(row => row.name === 'Ode Shrike'));
  assert.ok(value.mastery.items.length > 60);
  assert.equal(value.mastery.excludedItemTypes.length, 0);
  assert.equal(validateCatalogAvailability(value, require('../scripts/data/collection-availability.json')), value);
  assert.equal(value.mastery.itemRankXP.weapon[30], 112500);
  assert.equal(value.mastery.itemRankXP.pact[30], 450000);
  assert.equal(value.discoveries.filter(row => row.kind === 'tree').length, 16);
  assert.ok(value.discoveries.filter(row => row.kind === 'tree').every(row => !row.masteryEligible && row.mastery === 0));
  assert.ok(value.discoveries.some(row => row.required === 9));
});

test('projection filters internal definitions and strips raw source data while preserving recipe alternatives', () => {
  const raw = { items: [item({ internalOffset: 123, ingredients: [{ item_path: '/SF/StoreItems/Types/Items/Iron', item: 'Iron', count: 12 }],
    crafting_recipe: '/SF/StoreItems/Types/Recipes/Sword', ingredient_alternatives: { Iron: ['/SF/Types/Items/Steel', '../unsafe'] } }),
  item({ path: '/SF/Weapons/Melee/Sword' }), // Canonical and store aliases are one item.
  item({ path: '/SF/Types/Items/Iron', name: 'Iron', category: 'Resource', lang_key: '/SF/Language/Materials/IronName' }),
  item({ path: '/SF/Types/Items/Internal', lang_key: null }),
  item({ path: '/SF/Souls/SomeAbilityMod', category: 'Soul' }),
  item({ path: '/SF/Types/Items/Bundle', category: 'Bundle' })] };
  // Put the richer store row last to verify normalized IDs also resolve ingredients.
  [raw.items[0], raw.items[1]] = [raw.items[1], raw.items[0]];
  const value = projectCollectionData(raw, mastery(), source);
  assert.equal(value.items.length, 2);
  const sword = value.items.find(row => row.category === 'Weapon');
  assert.equal(sword.itemType, '/SF/Weapons/Melee/Sword');
  assert.equal(sword.internalOffset, undefined);
  assert.deepEqual(sword.recipe.ingredients[0], { itemType: '/SF/Types/Items/Iron', name: 'Iron', langKey: '/SF/Language/Materials/IronName',
    count: 12, alternatives: ['/SF/Types/Items/Steel'] });
  assert.equal(value.mastery.levelXP[1], 1300);
  assert.equal(value.discoveries.find(row => row.kind === 'location').required, 4);
  assert.equal(value.discoveries.find(row => row.kind === 'tree').bit, 0);
});

test('unreadable ingredient requirements are not published as an apparently complete recipe', () => {
  for (const count of [-1, 0, 1.5, '12', Infinity]) {
    const result = projectCollectionData({ items: [item({ crafting_recipe: '/SF/Types/Recipes/Sword',
      ingredients: [{ item_path: '/SF/Types/Items/Iron', item: 'Iron', count }] })] }, mastery(), source);
    assert.equal(result.items[0].recipe, null);
  }
});

test('reviewed appearance defaults survive projection without granting equipment or arbitrary catalogue rows', () => {
  const cosmeticType = '/SF/Types/Items/DefaultHair';
  const approved = { schema: 1, items: [
    { itemType: '/SF/Weapons/Melee/Sword', defaultOwned: true },
    { itemType: cosmeticType, defaultOwned: true },
  ] };
  const value = projectCollectionData({ items: [item(), item({ path: cosmeticType, name: 'Default hair', category: 'Cosmetic' })] }, mastery(), source, approved);
  assert.equal(value.items.find(row => row.itemType === cosmeticType).defaultOwned, true);
  assert.equal(value.items.find(row => row.category === 'Weapon').defaultOwned, undefined);
  const unapprovedDefaults = structuredClone(approved);
  delete unapprovedDefaults.items[1].defaultOwned;
  assert.throws(() => validateCatalogAvailability(value, unapprovedDefaults), /unapproved default ownership/);
  for (const invalid of ['true', 1, null]) {
    const malformed = structuredClone(approved); malformed.items[1].defaultOwned = invalid;
    assert.throws(() => projectCollectionData({ items: [item()] }, mastery(), source, malformed), /allowlist/);
    const invalidCatalog = structuredClone(value); invalidCatalog.items.find(row => row.itemType === cosmeticType).defaultOwned = invalid;
    assert.throws(() => validateCollectionCatalog(invalidCatalog), /Invalid collection catalogue/);
  }
  const equipmentDefault = structuredClone(value); equipmentDefault.items.find(row => row.category === 'Weapon').defaultOwned = true;
  assert.throws(() => validateCollectionCatalog(equipmentDefault), /Invalid collection catalogue/);
});

test('catalogue rejects path traversal, unsafe image URLs, duplicate rows and contradictory XP data', () => {
  assert.equal(normalizeItemType('/SF/StoreItems/Weapons/Melee/Sword'), '/SF/Weapons/Melee/Sword');
  assert.equal(itemId('/SF/StoreItems/Weapons/Melee/Sword'), '/sf/weapons/melee/sword');
  assert.equal(itemId('/sf/storeitems/weapons/melee/sword'), '/sf/weapons/melee/sword');
  for (const value of ['/SF/../Secrets', 'https://example.com/a', '/SF/Weapons/./Sword']) assert.equal(normalizeItemType(value), null);
  for (const value of ['https://example.com/icon.png', '/SF/Interface/Graphics/../x.png', '/SF/Interface/Graphics/x.svg']) assert.equal(validIcon(value), false);
  const original = projectCollectionData({ items: [item()] }, mastery(), source);
  const mutations = [
    value => { value.items.push(value.items[0]); },
    value => { value.items[0].icon = 'https://example.com/x.png'; },
    value => { value.items[0].itemType = '/SF/../Secrets'; },
    value => { value.mastery.itemRankXP.weapon[1] = -5; },
    value => { value.mastery.items[0].xpForMaxRank = 999; },
    value => { value.discoveries[0].required = -1; },
    value => { value.discoveries[1].mastery = 5000; },
    value => { value.source.availabilitySha256 = null; },
    value => { value.mastery.excludedItemTypes.push('/SF/Weapons/Melee/Forbidden'); },
  ];
  for (const change of mutations) {
    const value = structuredClone(original); change(value);
    assert.throws(() => validateCollectionCatalog(value), /Invalid collection catalogue/);
  }
});

test('projection requires explicit approval and withholds unavailable items and all nested references', () => {
  const forbidden = '/SF/Types/Items/Forbidden';
  const raw = { items: [item({ crafting_recipe: '/SF/Types/Recipes/Sword',
    ingredients: [{ item_path: '/SF/Types/Items/Iron', item: 'Iron', count: 2 }],
    ingredient_alternatives: { Iron: [forbidden, '/SF/Types/Items/Steel'] } }),
    item({ path: forbidden, name: 'Forbidden item', category: 'Cosmetic' })] };
  const definitions = mastery();
  definitions.sources.items.entries.push({ ...definitions.sources.items.entries[0], type: forbidden, name: 'Forbidden item' });
  definitions.sources.items.excluded.push({ type: forbidden });
  assert.throws(() => project(raw, definitions, source), /explicit obtainable-item allowlist/);
  const value = projectCollectionData(raw, definitions, source);
  assert.doesNotMatch(JSON.stringify(value), /Forbidden/);
  assert.deepEqual(value.items[0].recipe.ingredients[0].alternatives, ['/SF/Types/Items/Steel']);
  raw.items[0].ingredients[0].item_path = forbidden;
  assert.equal(projectCollectionData(raw, definitions, source).items[0].recipe, null);
  raw.items[0].ingredients[0].item_path = '/SF/Types/Items/Iron';
  raw.items[0].crafting_recipe = forbidden;
  assert.equal(projectCollectionData(raw, definitions, source).items[0].recipe, null);
  const poisoned = structuredClone(value);
  poisoned.items[0].recipe.ingredients[0].alternatives.push(forbidden);
  assert.throws(() => validateCatalogAvailability(poisoned, availability), /outside the obtainable-item allowlist/);
});

test('authoring S3 allowlist adds only the two published mastery locations', () => {
  assert.equal(validFile('Artifacts/mastery.json'), true);
  assert.equal(validFile('map/mastery.json'), true);
  assert.equal(validFile('Artifacts/other-raw-data.json'), false);
  assert.equal(validFile('map/raw_entities.json'), false);
});
