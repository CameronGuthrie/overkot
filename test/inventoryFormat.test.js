'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Format = require('../src/renderer/inventory-format');
const { buildInventory } = require('./fixtures/build-inventory');
const { titleInventory, epithets } = require('./fixtures/title-inventory');
const { wolfInventory, wolfCatalog } = require('./fixtures/wolf-inventory');
const tempers = require('../src/data/tempers.json');

const section = (sections, key) => sections.find(row => row.key === key);

test('build inventory is grouped, sorted and preserves each original entry and path', () => {
  const inventory = buildInventory();
  inventory.EmptyBlock = [];
  inventory.UnknownNewField = { SomeFutureKey: { flags: [false, 0, null, ''] } };
  const original = JSON.stringify(inventory);
  const names = Format.collectInventoryNames(inventory, tempers);
  const sections = Format.buildSections(inventory, names);
  assert.equal(sections[0].label, 'Overview');
  const melee = section(sections, 'Melee');
  assert.equal(melee.label, 'Melee weapons');
  assert.equal(melee.entries[0].label, 'Bog & Myrtle');
  assert.equal(melee.entries[0].subtitle, 'Noble · XP 225,000');
  assert.equal(melee.entries[0].path, '$.Melee[0]');
  assert.strictEqual(melee.entries[0].value, inventory.Melee[0]);
  assert.equal(section(sections, 'EmptyBlock').count, 0);
  assert.strictEqual(section(sections, 'UnknownNewField').entries[0].value, inventory.UnknownNewField.SomeFutureKey);
  assert.deepEqual(new Set(sections.filter(row => row.key !== '$overview').map(row => row.key)),
    new Set(Object.keys(inventory).filter(key => inventory[key] !== null && typeof inventory[key] === 'object')));
  assert.equal(JSON.stringify(inventory), original, 'formatting must not modify the snapshot');
});

test('names resolve catalog aliases, owned item references and details inside fingerprint JSON', () => {
  const inventory = buildInventory();
  const names = Format.collectInventoryNames(inventory, tempers);
  assert.equal(names[inventory.Melee[0].ItemType], 'Bog & Myrtle');
  assert.equal(names[inventory.Melee[0].ItemId.$oid], 'Bog & Myrtle');
  assert.equal(names.BlockingLessStaggerMod, 'Fortified');
  assert.equal(names.AttackSpeedMod, 'Swift Strike');
  assert.equal(Format.formatPrimitive(inventory.Melee[0].ItemId, names), 'Bog & Myrtle');
  assert.equal(Format.resolveName('/SF/StoreItems/Weapons/Melee/OneHand/DendritSwordAndBoard/DendritSwordAndBoardMeleeWeapon',
    { [inventory.Melee[0].ItemType.toLowerCase()]: 'Bog & Myrtle' }), 'Bog & Myrtle');
  assert.equal(Object.hasOwn(names, '/SF/Language/Upgrades/AspectPoisonName'), false, 'unused catalog names stay out of IPC');
  const scoped = Format.collectInventoryNames({ Tag: 'SharedTag' }, {
    labels: { '/SF/Language/A': 'One', '/SF/Language/B': 'Two' },
    weaponAliases: { '/SF/Weapons/A': { SharedTag: '/SF/Language/A' }, '/SF/Weapons/B': { SharedTag: '/SF/Language/B' } },
  });
  assert.equal(Object.hasOwn(scoped, 'SharedTag'), false, 'weapon-specific overrides cannot invent a global name');
});

test('search matches friendly names, multiple terms, raw keys and nested IDs without losing duplicate rows', () => {
  const inventory = buildInventory();
  inventory.Melee.push({ ...inventory.Melee[0], ItemId: { $oid: 'duplicate-weapon' } });
  const sections = Format.buildSections(inventory, Format.collectInventoryNames(inventory, tempers));
  assert.equal(section(Format.filterSections(sections, 'bog noble'), 'Melee').entries.length, 2);
  assert.equal(section(Format.filterSections(sections, 'fortified melee'), 'Melee').entries.length, 2);
  assert.equal(section(Format.filterSections(sections, 'BlockingLessStaggerMod'), 'Melee').entries.length, 2);
  assert.equal(section(Format.filterSections(sections, 'duplicate-weapon'), 'Melee').entries.length, 1);
  assert.equal(Format.filterSections(sections, 'missing-name').length, 0);
  assert.strictEqual(Format.filterSections(sections, '  '), sections);
});

test('title challenges and wolf names resolve from their actual catalog shapes', () => {
  const titles = titleInventory();
  const names = Format.collectInventoryNames(titles, epithets());
  assert.equal(names.CogahTitleChallenge, 'Of The Sleeve challenge');
  const challenge = section(Format.buildSections(titles, names), 'ChallengeProgress');
  assert.ok(challenge.entries.some(row => row.label === 'Of The Sleeve challenge' && row.subtitle === 'Progress 3'));
  const wolves = wolfInventory();
  const wolfNames = Format.collectInventoryNames(wolves, wolfCatalog());
  const wolfRows = section(Format.buildSections(wolves, wolfNames), 'KubrowPets').entries;
  assert.deepEqual(wolfRows.map(row => row.label), ['Cathal', 'Ciar']);
  assert.equal(wolfNames['wolf-fixture-pet-1'], 'Ciar');
});

test('local language names infer unique item stems and recipes while respecting exact names and namespaces', () => {
  const item = '/SF/Types/Items/Consumables/WevetSeed';
  const armour = '/SF/Upgrades/Skins/Armour/Shared';
  const ambiguous = '/SF/Types/Items/Unknown/Shared';
  const recipe = '/SF/Types/Items/Recipes/BromiusHelmRecipeItem';
  const inventory = { Items: [item, armour, ambiguous, recipe, '/SF/Weapons/LeafMeleeWeapon', '/SF/Items/NoMatch'] };
  const names = Format.collectInventoryNames(inventory, {
    '/SF/Language/Items/WevetSeedConsumableName': 'Wevet seed',
    '/SF/Language/Weapons/SharedName': 'Shared weapon',
    '/SF/Language/Armour/SharedName': 'Shared armour',
    '/SF/Language/Items/NoMatchDescription': 'This description is not a name',
    '/SF/Language/Weapons/LeafName': 'A named blade',
    'PendingRecipe:BromiusHelm': 'Bromius helmet',
  });
  assert.equal(names[item], 'Wevet seed');
  assert.equal(names[armour], 'Shared armour');
  assert.equal(Object.hasOwn(names, ambiguous), false, 'conflicting names require an exact or namespace match');
  assert.equal(Object.hasOwn(names, '/SF/Items/NoMatch'), false, 'descriptions cannot be presented as names');
  assert.equal(names[recipe], 'Bromius helmet');
  assert.equal(names['/SF/Weapons/LeafMeleeWeapon'], 'A named blade');
  assert.equal(Format.collectInventoryNames(inventory, { '/SF/Language/Consumables/WevetSeedName': 'Seed' })[item], 'Seed');
  assert.equal(Format.collectInventoryNames(inventory, { ...names, [item]: 'Exact item label' },
    { '/SF/Language/Items/WevetSeedConsumableName': 'Inferred label' })[item], 'Exact item label');
});

test('Mongo extended JSON wrappers, quality and blank primitive values remain readable and accurate', () => {
  assert.equal(Format.formatPrimitive({ $numberLong: '9223372036854775807' }), '9,223,372,036,854,775,807');
  assert.equal(Format.formatPrimitive({ $date: { $numberLong: '1789781861000' } }), '2026-09-19 01:37:41 UTC');
  assert.equal(Format.formatPrimitive({ $date: '1789781861000' }), '2026-09-19 01:37:41 UTC');
  assert.equal(Format.formatPrimitive({ $date: 'invalid date' }), 'invalid date');
  assert.equal(Format.formatPrimitive({ $date: null }), 'None');
  assert.equal(Format.formatPrimitive({ $oid: 'unknown-reference' }), 'unknown-reference');
  assert.equal(Format.formatPrimitive(0), '0');
  assert.equal(Format.formatPrimitive(false), 'No');
  assert.equal(Format.formatPrimitive(null), 'None');
  assert.equal(Format.formatPrimitive(''), '(empty)');
  assert.equal(Format.formatPrimitive('IQ_MASTERWORK'), 'Sovereign');
  assert.equal(Format.valueKind({ $oid: 'id', newField: false }), 'object', 'extra fields must remain visible');
  const wrappers = Format.buildSections({ At: { $date: 0 }, ID: { $oid: 'id' }, Number: { $numberLong: '0' } });
  assert.equal(wrappers.length, 1);
  assert.equal(wrappers[0].entries.length, 3);
});

test('unknown data, primitive roots, escaped paths and valid fingerprints can be inspected', () => {
  assert.equal(Format.resolveName('/SF/Types/Items/NewItem/FutureResourceItem'), 'Future Resource Item');
  assert.equal(Format.humanize('XPInfo'), 'Item experience');
  assert.deepEqual(Format.parseStructured('{"lvl":3}'), { lvl: 3 });
  assert.equal(Format.parseStructured('{not-json}'), '{not-json}');
  assert.equal(Format.parseStructured('42'), '42');
  assert.strictEqual(Format.buildSections(false)[0].entries[0].value, false);
  assert.deepEqual(Format.buildSections({}), []);
  assert.equal(Format.buildSections({ 'odd.key': [0] })[0].entries[0].path, '$["odd.key"][0]');
  const inventory = { Resources: { '/SF/Items/SpecialLeaf': 12 } };
  assert.equal(Format.buildSections(inventory, { '/SF/Items/SpecialLeaf': 'A green leaf' })[0].entries[0].label, 'A green leaf');
});

test('the browser receives the same pure API without Node globals', () => {
  const context = vm.createContext({ Intl });
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/inventory-format'), 'utf8'), context);
  assert.equal(context.InventoryFormat.humanize('ChallengeProgress'), 'Challenge progress');
  assert.equal(context.InventoryFormat.buildSections({ Count: 0 })[0].entries[0].subtitle, '0');
});
