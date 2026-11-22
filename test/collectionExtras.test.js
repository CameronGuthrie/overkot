'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourcesModel, createEnhancementsModel, createCraftingPlannerModel, createActivityModel, createCraftingLogModel } = require('../src/modules/collectionExtras');
const { computeCraftingPlan, readGoals } = require('../src/renderer/collection-extras');

const steel = '/SF/Types/PickUps/Resources/Steel', leather = '/SF/Types/PickUps/Resources/Leather';
const sword = '/SF/Weapons/Melee/TestSword', bow = '/SF/Weapons/Bows/TestBow';
const joinery = '/SF/Types/Items/Kintsugi/Weapons/TestUpgrade', rune = '/SF/Upgrades/Runes/TestRune';
const totem = '/SF/Upgrades/Totems/TestTotem', ancestor = '/SF/Types/Game/Ancestors/Tuvalkane/TuvalkaneAncestor';
const catalog = { items: [
  { itemType: steel, name: 'Steel', langKey: '/SF/Language/Steel', category: 'Resource', icon: '/SF/Interface/Graphics/Steel.png' },
  { itemType: leather, name: 'Leather', category: 'Resource' },
  { itemType: rune, name: 'Sharp', category: 'Mote' },
  { itemType: totem, name: 'Smite', category: 'Totem' },
  { itemType: joinery, name: 'Verite', category: 'Kintsugi' },
  { itemType: sword, name: 'Sword', category: 'Weapon', recipe: { itemType: '/SF/Types/Recipes/TestSwordBlueprint', ingredients: [{ itemType: steel, count: 5 }, { itemType: leather, count: 2 }] } },
  { itemType: bow, name: 'Bow', category: 'Weapon', recipe: { itemType: '/SF/Types/Recipes/TestBowBlueprint', ingredients: [{ itemType: steel, count: 4 }] } },
] };
const getCatalog = () => catalog;
const inventory = overrides => ({ AccountId: 'private-account', Nonce: 'private-nonce', MiscItems: [{ ItemType: steel, ItemCount: 6 }], Consumables: [], RawUpgrades: [], Upgrades: [],
  RegularCredits: 300, PremiumCredits: 2, FusionPoints: 10, Melee: [], LongGuns: [], Suits: [], WeaponSkins: [], FlavourItems: [], XPInfo: [], ...overrides });

test('resources use catalogue names, aggregate normalized stacks, retain zero and withhold unavailable counts', () => {
  const model = createResourcesModel({ getCatalog });
  const result = model.read(inventory({ MiscItems: [{ ItemType: steel, ItemCount: 2 }, { ItemType: steel.toLowerCase(), ItemCount: 4 }] }), { names: { '/SF/Language/Steel': 'Acier' } });
  const row = result.rows.find(row => row.itemType === steel);
  assert.equal(row.name, 'Acier'); assert.equal(row.count, 6); assert.match(row.icon, /^overkot-game-data:\/\/images/);
  assert.equal(result.rows.find(row => row.itemType === leather).count, 0);
  assert.equal(result.rows.find(row => row.itemType === 'FusionPoints').count, 10);
  assert.equal(result.rows.find(row => row.itemType === 'RegularCredits').icon, 'overkot-game-data://images/SF/Interface/Graphics/StoreItems/Currency/Coin1.png');
  assert.equal(result.rows.find(row => row.itemType === 'PremiumCredits').icon, 'overkot-game-data://images/SF/Interface/Graphics/StoreItems/Currency/PremiumCurrency.png');
  assert.equal(result.rows.find(row => row.itemType === 'FusionPoints').icon, null);
  const missing = model.read(inventory({ MiscItems: null }));
  assert.equal(missing.rows.find(row => row.itemType === steel).count, null);
  assert.deepEqual(missing.unavailableSections, ['MiscItems']);
  assert.doesNotMatch(JSON.stringify(result), /private-account|private-nonce/);
});

test('enhancements distinguish raw stacks, ranked copies, virtues and explicit malformed fingerprints', () => {
  const model = createEnhancementsModel({ getCatalog });
  const result = model.read(inventory({ RawUpgrades: [{ ItemType: rune, ItemCount: 3 }, { ItemType: joinery, ItemCount: 2 }], Upgrades: [
    { ItemType: rune, UpgradeFingerprint: '{"lvl":2}' },
    { ItemType: totem, UpgradeFingerprint: { lvl: 3, pol: 'AP_GRACE', compat: '/SF/Upgrades/Techniques/SwordSkillTree' } },
    { ItemType: rune, UpgradeFingerprint: '{broken' }, { ItemType: rune, UpgradeFingerprint: '{"lvl":99}' },
  ] }));
  assert.deepEqual(result.rows.find(row => row.itemType === rune).ranks, [3, 0, 1, 0]);
  assert.equal(result.rows.find(row => row.itemType === joinery).kind, 'joinery');
  assert.equal(result.rows.find(row => row.itemType === totem).virtue, 'GRACE');
  assert.equal(result.rows.find(row => row.itemType === totem).count, 1);
  assert.equal(result.unreadableRecords, 2);
  assert.doesNotMatch(JSON.stringify(result), /UpgradeFingerprint|ItemId|private-/);
  assert.equal(model.read(inventory({ RawUpgrades: [], Upgrades: [] })).rows.length, 0);
});

test('enhancement compatibility accepts strings and arrays and groups by stable paths rather than localized labels', () => {
  const swordGrip = '/SF/Upgrades/Techniques/SwordSkillTree';
  const bowGrip = '/SF/Upgrades/Techniques/ArcherySkillTree';
  const model = createEnhancementsModel({ getCatalog });
  const inv = inventory({ Upgrades: [
    { ItemType: rune, UpgradeFingerprint: { lvl: 1, compat: swordGrip } },
    { ItemType: rune, UpgradeFingerprint: { lvl: 2, compat: [swordGrip, swordGrip.toLowerCase()] } },
    { ItemType: rune, UpgradeFingerprint: { lvl: 3, Compat: [bowGrip] } },
  ] });
  const value = model.read(inv, { names: { [swordGrip]: 'Same translated grip', [bowGrip]: 'Same translated grip' } });
  assert.equal(value.rows.length, 2, 'Different bound game paths must stay distinct even when their labels match');
  assert.ok(value.rows.every(row => row.compat === 'Same translated grip'));
  assert.deepEqual(value.rows.find(row => row.id.includes('swordskilltree')).ranks, [0, 1, 1, 0]);
  assert.deepEqual(value.rows.find(row => row.id.includes('archeryskilltree')).ranks, [0, 0, 0, 1]);
  const relabeled = model.read(inv, { names: { [swordGrip]: 'Schwert', [bowGrip]: 'Bogen' } });
  assert.deepEqual(value.rows.map(row => row.id).sort(), relabeled.rows.map(row => row.id).sort());
  assert.ok(relabeled.rows.some(row => row.compat === 'Schwert'));
});

test('planner combines shared materials before subtracting holdings and persists only bounded goals', () => {
  const snapshot = createCraftingPlannerModel({ getCatalog }).read(inventory());
  const result = computeCraftingPlan(snapshot.rows, [{ itemType: sword, quantity: 2 }, { itemType: bow, quantity: 1 }]);
  const steelRow = result.materials.find(row => row.itemType === steel);
  assert.equal(steelRow.required, 14); assert.equal(steelRow.allocated, 6); assert.equal(steelRow.missing, 8);
  assert.equal(result.materials.find(row => row.itemType === leather).missing, 4);
  assert.equal(result.ready, false);
  const persisted = readGoals({ getItem: () => JSON.stringify([{ itemType: sword, quantity: 99999 }, { itemType: sword, quantity: 3 }, null]) });
  assert.deepEqual(persisted, [{ itemType: sword, quantity: 1 }]);
  assert.deepEqual(readGoals({ getItem: () => '{broken' }), []);
  const absent = computeCraftingPlan(snapshot.rows, [{ itemType: '/SF/Missing', quantity: 1 }]);
  assert.equal(absent.ready, false); assert.equal(absent.missingRecipes.length, 1);
});

test('planner withholds missing ownership and handles exact alternative ingredients without spending stock twice', () => {
  const incomplete = createCraftingPlannerModel({ getCatalog }).read(inventory({ MiscItems: undefined }));
  assert.equal(incomplete.rows.find(row => row.itemType === sword).ingredients[0].owned, null);
  assert.equal(computeCraftingPlan(incomplete.rows, [{ itemType: sword }]).materials[0].missing, null);
  const rows = [
    { itemType: sword, name: 'Sword', recipeComplete: true, ingredients: [{ itemType: 'a', name: 'A', required: 5, owned: 7, choices: [{ itemType: 'a', owned: 0 }, { itemType: 'shared', owned: 7 }] }] },
    { itemType: bow, name: 'Bow', recipeComplete: true, ingredients: [{ itemType: 'b', name: 'B', required: 5, owned: 7, choices: [{ itemType: 'b', owned: 0 }, { itemType: 'shared', owned: 7 }] }] },
  ];
  const plan = computeCraftingPlan(rows, [{ itemType: sword }, { itemType: bow }]);
  assert.equal(plan.materials.reduce((sum, row) => sum + row.allocated, 0), 7);
  assert.equal(plan.materials.reduce((sum, row) => sum + row.missing, 0), 3); assert.equal(plan.ready, false);
});

test('planner identifies a self-required reforge instead of promising item acquisition', () => {
  const model = createCraftingPlannerModel({ getCatalog: () => ({ items: [{ itemType: sword, name: 'Sword', recipe: { itemType: '/SF/ReforgeBlueprint', ingredients: [{ itemType: sword, count: 1 }] } }] }) });
  assert.equal(model.read(inventory()).rows[0].recipeKind, 'reforge');
});

test('activity records adjacent live deltas only, rejects stale snapshots, and clears on cache/account/session changes', () => {
  const model = createActivityModel({ getCatalog });
  let context = { status: 'cached', updatedAt: 100, accountId: 'a', sessionEpoch: 1 };
  assert.equal(model.read(inventory(), context).rows.length, 0);
  context = { ...context, status: 'live' };
  assert.equal(model.read(inventory(), context).rows.length, 0);
  let result = model.read(inventory({ MiscItems: [{ ItemType: steel, ItemCount: 9 }], RegularCredits: 280, XPInfo: [{ ItemType: sword, XP: 100 }] }), { ...context, updatedAt: 200 });
  assert.equal(result.rows.find(row => row.itemType === steel).delta, 3);
  assert.equal(result.rows.find(row => row.itemType === 'RegularCredits').delta, -20);
  assert.equal(result.rows.find(row => row.kind === 'xp').delta, 100);
  const count = result.rows.length;
  result = model.read(inventory(), { ...context, updatedAt: 150 }); assert.equal(result.rows.length, count);
  result = model.read(inventory(), { ...context, updatedAt: 201, accountId: 'b' }); assert.equal(result.rows.length, 0);
  result = model.read(inventory(), { ...context, updatedAt: 202, sessionEpoch: 2 }); assert.equal(result.rows.length, 0);
  result = model.read(inventory(), { ...context, updatedAt: 203, status: 'cached' }); assert.equal(result.rows.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-account|private-nonce/);
});

test('activity does not infer removals or pickups across incomplete observations and caps at100', () => {
  const model = createActivityModel({ getCatalog }), context = { status: 'live', accountId: 'a', sessionEpoch: 1 };
  model.read(inventory(), { ...context, updatedAt: 100 });
  model.read(inventory({ MiscItems: null }), { ...context, updatedAt: 101 });
  assert.equal(model.read(inventory({ MiscItems: [] }), { ...context, updatedAt: 102 }).rows.length, 0);
  for (let index = 0; index < 110; index++) model.read(inventory({ MiscItems: [{ ItemType: steel, ItemCount: index + 1 }] }), { ...context, updatedAt: 103 + index });
  const result = model.read(inventory({ MiscItems: [{ ItemType: steel, ItemCount: 110 }] }), { ...context, updatedAt: 213 });
  assert.equal(result.rows.length, 100);
  assert.ok(result.rows[0].at >= result.rows.at(-1).at);
});

test('activity thumbnails and localized labels follow canonical catalogue types and refresh retained events', () => {
  let source = catalog;
  const model = createActivityModel({ getCatalog: () => source });
  const context = { status: 'live', accountId: 'private-account', sessionEpoch: 1 };
  model.read(inventory(), { ...context, updatedAt: 100 });
  let result = model.read(inventory({ MiscItems: [{ ItemType: steel.toLowerCase(), ItemCount: 9 }], PremiumCredits: 3 }),
    { ...context, updatedAt: 101, names: { '/SF/Language/Steel': 'Acier' } });
  const resource = result.rows.find(row => row.itemType.toLowerCase() === steel.toLowerCase());
  assert.equal(resource.name, 'Acier'); assert.equal(resource.icon, 'overkot-game-data://images/SF/Interface/Graphics/Steel.png');
  assert.equal(result.rows.find(row => row.itemType === 'PremiumCredits').icon, 'overkot-game-data://images/SF/Interface/Graphics/StoreItems/Currency/PremiumCurrency.png');
  const retainedId = resource.id;
  source = { items: catalog.items.map(row => row.itemType === steel ? { ...row, icon: '/SF/Interface/Graphics/StoreItems/Materials/NewSteel.png' } : row) };
  result = model.read(inventory({ MiscItems: [{ ItemType: steel.toLowerCase(), ItemCount: 9 }], PremiumCredits: 3 }),
    { ...context, updatedAt: 101 });
  assert.equal(result.rows.find(row => row.id === retainedId).icon, 'overkot-game-data://images/SF/Interface/Graphics/StoreItems/Materials/NewSteel.png');
  assert.doesNotMatch(JSON.stringify(result), /private-account|private-nonce|ItemId/);
});

test('crafting log resolves recipe paths and distinct quality records without invented dates/repeat counts', () => {
  const model = createCraftingLogModel({ getCatalog });
  const result = model.read(inventory({ Ancestors: [{ ItemType: ancestor, Rank: 3, XP: 120, CompletedRecipes: [sword, `${sword}_IQ_OFFICER`, `${sword}_IQ_OFFICER`, '/SF/Types/Recipes/TestBowBlueprint'] }] }));
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows.find(row => row.quality === 'IQ_OFFICER').name, 'Sword');
  assert.ok(result.rows.some(row => row.name === 'Bow'));
  assert.equal(result.ancestors[0].rank, 3);
  assert.doesNotMatch(JSON.stringify(result), /ItemId|private-account|private-nonce|craftedAt/);
  assert.equal(model.read(inventory()).available, false);
});

test('collection tools omit unapproved raw inventory items even when names and ownership are present', () => {
  const unapproved = '/SF/Types/Items/UnapprovedFixtureItem', unapprovedRecipe = '/SF/Types/Recipes/UnapprovedFixtureRecipe';
  const value = inventory({ MiscItems: [{ ItemType: steel, ItemCount: 8 }, { ItemType: unapproved, ItemCount: 12 }],
    RawUpgrades: [{ ItemType: rune, ItemCount: 1 }, { ItemType: unapproved, ItemCount: 3 }],
    Upgrades: [{ ItemType: unapproved, UpgradeFingerprint: { lvl: 2 } }],
    Ancestors: [{ ItemType: ancestor, CompletedRecipes: [unapproved, unapprovedRecipe, sword] }] });
  const context = { status: 'live', accountId: 'fixture', sessionEpoch: 1, updatedAt: 2, names: { [unapproved]: 'Unapproved fixture item' } };
  for (const create of [createResourcesModel, createEnhancementsModel, createCraftingPlannerModel, createCraftingLogModel]) {
    const result = create({ getCatalog }).read(value, context);
    assert.doesNotMatch(JSON.stringify(result), /unapproved/i, `${create.name} withholds unknown item metadata`);
  }
  const activity = createActivityModel({ getCatalog });
  activity.read(inventory(), { ...context, updatedAt: 1 });
  const events = activity.read(value, context);
  assert.ok(events.rows.some(row => row.itemType === steel), 'approved resource activity remains visible');
  assert.doesNotMatch(JSON.stringify(events), /unapproved/i);
});

test('enhancement compatibility exposes only published grips and approved item paths, including in row IDs', () => {
  const unapproved = '/SF/Weapons/Melee/UnapprovedFixtureWeapon', grip = '/SF/Upgrades/Techniques/SwordSkillTree';
  const result = createEnhancementsModel({ getCatalog }).read(inventory({ Upgrades: [
    { ItemType: rune, UpgradeFingerprint: { lvl: 1, compat: [unapproved, grip, sword] } },
    { ItemType: rune, UpgradeFingerprint: { lvl: 2, compat: [grip, sword] } },
    { ItemType: totem, UpgradeFingerprint: { lvl: 1, compat: ['/SF/Types/Game/SFSkillTree', unapproved] } },
  ] }), { names: { [unapproved]: 'Unapproved fixture weapon', [grip]: 'Sword grip', [sword]: 'Fixture sword' } });
  const row = result.rows.find(row => row.itemType === rune);
  assert.deepEqual(row.ranks, [0, 1, 1, 0], 'withheld paths cannot create a separate row identity');
  assert.equal(row.compat, 'Sword grip, Fixture sword');
  assert.equal(result.rows.find(row => row.itemType === totem).compat, '', 'generic player skill tree is not a named equipment restriction');
  assert.doesNotMatch(JSON.stringify(result), /unapproved/i);
});
