'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMarketInventory } = require('../src/modules/marketInventory');
const { buildInventory, id } = require('./fixtures/build-inventory');

const path = '/SF/Types/Items/Resources/TestResource';
const runePath = '/SF/Upgrades/Runes/Weapon/StarterRune';
const motePath = '/SF/Upgrades/Totems/TestMote';
const weaponPath = '/SF/Weapons/Melee/TestWeapon';
const resource = (overrides = {}) => ({ id: 'resource-server-id', unique_name: 'TestResource', path,
  name: 'Test resource', slug: 'test-resource', category: 'Resource', tradeable: true,
  image_path: '/SF/Interface/Graphics/Test.png', ...overrides });
const rune = { id: 'rune-server-id', unique_name: 'StarterRune', path: runePath, name: 'Starter rune', category: 'Mote', tradeable: true };
const mote = { id: 'mote-server-id', unique_name: 'TestMote', path: motePath, name: 'Test mote', category: 'Mote', tradeable: true };
const weapon = { id: 'weapon-server-id', unique_name: 'TestWeapon', path: weaponPath, name: 'Test weapon', category: 'Weapons', tradeable: true,
  possible_tempers: [
    { unique_name: 'AspectBlocking', tag: 'BlockingLessStaggerMod' },
    { unique_name: 'AspectHeavy', tag: 'HeavyAttackDamageAndStaggerMod' },
    { unique_name: 'AspectStaggerCrit', tag: 'OdeReduceDefenseMod', icon: '/SF/Interface/Graphics/Aspects/Ode/Crush.png' },
  ] };
const stockWeapon = (number, overrides = {}) => ({ ItemId: id(number), ItemType: weaponPath, Quality: 'IQ_WORN', ...overrides });

test('maps physical inventory by the exact path and preserves the server item ID', () => {
  const raw = { AccountId: 'private-account', Nonce: 'private-nonce', MiscItems: [
    { ItemType: path, ItemCount: 10 }, { ItemType: path, ItemCount: '2' },
  ], XPInfo: [{ ItemType: path, XP: 100 }], PendingRecipes: [{ ItemType: path, ItemCount: 4 }],
  Melee: [{ ItemType: '/SF/Weapons/Unlisted', UpgradeType: path }] };
  const result = buildMarketInventory(raw, [resource()]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].itemId, 'resource-server-id');
  assert.equal(result.rows[0].quantity, 12);
  assert.equal(result.rows[0].availableQuantity, 12);
  assert.equal(result.rows[0].imageUrl, 'overkot-game-data://images/SF/Interface/Graphics/Test.png');
  assert.equal(result.rows[0].category, 'resource');
  assert.equal(result.rows[0].canList, true);
  assert.equal(result.summary.scannedEntries, 3);
  assert.equal(result.summary.unmatchedEntries, 1);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('never guesses between duplicate unique names, conflicting paths, or display names', () => {
  const catalogue = [resource(), resource({ id: 'resource-server-id--other', path: '/SF/Other/TestResource', name: 'Another item' })];
  const matched = buildMarketInventory({ MiscItems: [{ ItemType: '/SF/Other/TestResource', ItemCount: 1 }] }, catalogue);
  assert.equal(matched.rows[0].itemId, 'resource-server-id--other');
  const ambiguous = buildMarketInventory({ MiscItems: [{ ItemType: 'TestResource', ItemCount: 1 }] }, catalogue);
  assert.equal(ambiguous.rows.length, 0);
  assert.equal(ambiguous.summary.ambiguousEntries, 1);
  for (const type of ['/SF/Unreleased/TestResource', 'Test resource', path.toLowerCase()]) {
    assert.equal(buildMarketInventory({ MiscItems: [{ ItemType: type, ItemCount: 1 }] }, [resource()]).rows.length, 0);
  }
});

test('allows unambiguous legacy leaf identities but never fabricates catalogue IDs', () => {
  assert.equal(buildMarketInventory({ MiscItems: [{ ItemType: 'TestResource', ItemCount: 1 }] }, [resource()]).rows[0].itemId, 'resource-server-id');
  assert.equal(buildMarketInventory({ MiscItems: [{ ItemType: path, ItemCount: 1 }] }, [resource({ path: null })]).rows.length, 1);
  assert.equal(buildMarketInventory({ MiscItems: [{ ItemType: path, ItemCount: 1 }] }, [resource({ id: undefined })]).rows.length, 0);
  const duplicate = buildMarketInventory({ MiscItems: [{ ItemType: path, ItemCount: 1 }] }, [resource(), resource({ id: 'other-id' })]);
  assert.equal(duplicate.summary.ambiguousEntries, 1);
});

test('matches production store definitions to physical game paths across tradeable inventory sections', () => {
  // These namespaces and paths come from the market feed and game inventory.
  // The IDs stand in for the authoritative IDs supplied by the market API.
  const definitions = [
    ['onyx-id', 'MiscItems', '/SF/Types/PickUps/Resources/Inorganics/CorruptOnyxResource', 'Resource'],
    ['sword-id', 'Melee', '/SF/Weapons/Melee/OneHand/FennJotarSword/FennJotarSwordMeleeWeapon', 'Weapon'],
    ['dagger-id', 'LongGuns', '/SF/Weapons/Melee/OneHand/SecondaryDagger/SecondaryDaggerMeleeWeapon', 'Weapon'],
    ['armour-id', 'WeaponSkins', '/SF/Upgrades/Skins/Helmets/FennJotarHelmet', 'Armor'],
    ['joinery-id', 'RawUpgrades', '/SF/Types/Items/Kintsugi/KintsugiUpgradeA', 'Kintsugi'],
    ['mote-id', 'Upgrades', '/SF/Upgrades/Totems/BlindReveal', 'Mote'],
    ['chordstone-id', 'Recipes', '/SF/Types/Recipes/WeaponQuality/ChaosRerollBlueprint', 'Blueprint'],
  ];
  const catalogue = definitions.map(([id, , path, category]) => ({ id, path: path.replace('/SF/', '/SF/StoreItems/'),
    unique_name: path.split('/').pop(), category, tradeable: true }));
  const inventory = {};
  for (const [, section, ItemType, category] of definitions) {
    (inventory[section] ||= []).push({ ItemType, ItemCount: 2,
      ...(category === 'Weapon' ? { Quality: 'IQ_WORN' } : {}),
      ...(category === 'Mote' ? { UpgradeFingerprint: '{"lvl":1,"pol":"AP_SPIRIT","compat":"/SF/Types/Game/SFSkillTree"}' } : {}) });
  }
  // Fragment blueprints cannot turn into phantom copies of the finished gear.
  inventory.Recipes.push({ ItemType: '/SF/Types/Recipes/Weapons/FennJotarSwordBlueprint', ItemCount: 5 });
  const result = buildMarketInventory(inventory, catalogue);
  assert.equal(result.summary.matchedEntries, definitions.length);
  assert.equal(result.summary.unmatchedEntries, 1);
  assert.equal(result.summary.ambiguousEntries, 0);
  for (const [id, , ItemType] of definitions) {
    const row = result.rows.find(row => row.itemId === id);
    assert.equal(row.itemType, ItemType);
    assert.equal(row.quantity, 2);
    assert.equal(row.canList, true);
  }
});

test('store aliases retain full rune paths and never merge identical leaf names across grips', () => {
  const bow = '/SF/Upgrades/Runes/Weapon/Bow/StarterRune';
  const dagger = '/SF/Upgrades/Runes/Weapon/Dagger/StarterRune';
  const catalogue = [
    { ...rune, id: 'approved-bow-rune', path: bow.replace('/SF/', '/SF/StoreItems/') },
    { ...rune, id: 'approved-dagger-rune', path: dagger.replace('/SF/', '/SF/StoreItems/') },
  ];
  const result = buildMarketInventory({ RawUpgrades: [
    { ItemType: bow, ItemCount: 3 }, { ItemType: dagger, ItemCount: 4 },
    { ItemType: 'StarterRune', ItemCount: 5 },
    { ItemType: '/SF/Upgrades/Runes/Weapon/Unreleased/StarterRune', ItemCount: 6 },
  ] }, catalogue);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find(row => row.itemId === 'approved-bow-rune').quantity, 3);
  assert.equal(result.rows.find(row => row.itemId === 'approved-dagger-rune').quantity, 4);
  assert.ok(result.rows.every(row => row.category === 'rune' && row.attributes.rune.upgradeLevel === 0));
  assert.equal(result.summary.ambiguousEntries, 2);
});

test('exact identities take priority over store aliases and conflicting aliases stay ambiguous', () => {
  const catalogue = [resource(), resource({ id: 'store-id', path: path.replace('/SF/', '/SF/StoreItems/') })];
  const row = buildMarketInventory({ MiscItems: [{ ItemType: path, ItemCount: 2 }] }, catalogue).rows[0];
  assert.equal(row.itemId, resource().id);
  const ambiguous = buildMarketInventory({ MiscItems: [{ ItemType: path, ItemCount: 2 }] },
    [catalogue[1], { ...catalogue[1], id: 'duplicate-store-id' }]);
  assert.equal(ambiguous.rows.length, 0);
  assert.equal(ambiguous.summary.ambiguousEntries, 1);
  for (const ItemType of [path.toLowerCase(), path.replace('/SF/', '/SF/Unreleased/'), path.replace('/SF/', '/SF/Types/StoreItems/')]) {
    assert.equal(buildMarketInventory({ MiscItems: [{ ItemType, ItemCount: 2 }] }, [catalogue[1]]).rows.length, 0);
  }
});

test('catalogue overrides and JSON API records map using their source identities', () => {
  const override = { id: 'approved-override', sourcePath: path, sourceUniqueName: 'TestResource', displayName: 'Renamed resource',
    category: 'resource', tradability: 'TRADABLE', imageUrl: 'https://cdn.example.com/icon.png' };
  const inventory = { inventory: { MiscItems: [{ ItemType: path, ItemCount: 2 }] } };
  for (const catalogue of [[override], [{ id: override.id, attributes: override }]]) {
    const row = buildMarketInventory(inventory, catalogue).rows[0];
    assert.equal(row.itemId, 'approved-override');
    assert.equal(row.name, 'Renamed resource');
    assert.equal(row.imageUrl, override.imageUrl);
  }
});

test('untradeable and inactive catalogue entries cannot be quick-listed', () => {
  const inventory = { MiscItems: [{ ItemType: path, ItemCount: 2 }] };
  assert.equal(buildMarketInventory(inventory, [resource({ isActive: false })]).rows.length, 0);
  for (const item of [resource({ tradeable: false }), resource({ tradability: 'NOT_TRADABLE' })]) {
    const row = buildMarketInventory(inventory, [item]).rows[0];
    assert.equal(row.canList, false);
    assert.match(row.warnings.join(' '), /not tradeable/);
  }
});

test('invalid counts do not become phantom stock, while absent instance counts mean one', () => {
  const entries = [null, {}, { ItemType: path, ItemCount: -1 }, { ItemType: path, ItemCount: 1.5 },
    { ItemType: path, ItemCount: 'many' }, { ItemType: path, ItemCount: Number.MAX_SAFE_INTEGER + 1 },
    { ItemType: path, ItemCount: 0 }, { ItemType: path, ItemCount: NaN }];
  const result = buildMarketInventory({ MiscItems: entries, RawUpgrades: [{ ItemType: runePath }], Melee: [stockWeapon(1)] }, [resource(), rune, weapon]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].quantity, 1);
  assert.equal(result.summary.invalidEntries, 7);
  assert.equal(result.rows[0].canList, true);
});

test('separates weapon variants and translates quality, moonsteel, and stacked tempers', () => {
  const rolled = stockWeapon(1, { Quality: 'IQ_NOBLE', Shiny: true,
    AspectFingerprint: JSON.stringify({ buffs: [{ Tag: 'BlockingLessStaggerMod', Value: 2147483647 },
      { Tag: 'BlockingLessStaggerMod' }, { Tag: 'HeavyAttackDamageAndStaggerMod' }], curses: [{ Tag: 'UnknownCurse' }] }) });
  const result = buildMarketInventory({ Melee: [rolled, { ...rolled, ItemId: id(2) }, stockWeapon(3)] }, [weapon]);
  assert.equal(result.rows.length, 2);
  const noble = result.rows.find(row => row.attributes.weapon.quality === 'NOBLE');
  assert.equal(noble.quantity, 2);
  assert.equal(noble.canList, true);
  assert.deepEqual(noble.attributes.weapon, { quality: 'NOBLE', moonsteel: true, tempers: ['AspectBlocking', 'AspectBlocking', 'AspectHeavy'] });
  const reversed = buildMarketInventory({ Melee: [stockWeapon(3), rolled, { ...rolled, ItemId: id(2) }] }, [weapon]);
  assert.deepEqual(reversed, result);
  assert.equal(JSON.stringify(result).includes('000000000000000000000001'), false);
});

test('honours the market Bypass temper correction setting', () => {
  const inventory = { Melee: [stockWeapon(1, { AspectFingerprint: { buffs: [{ Tag: 'OdeReduceDefenseMod' }] } })] };
  assert.deepEqual(buildMarketInventory(inventory, [weapon]).rows[0].attributes.weapon.tempers, ['AspectReduceArmour']);
  assert.deepEqual(buildMarketInventory(inventory, [weapon], { temperBypassOverrideEnabled: false }).rows[0].attributes.weapon.tempers, ['AspectStaggerCrit']);
});

test('unknown or incomplete weapon attributes stay visible without enabling incorrect listings', () => {
  for (const overrides of [
    { Quality: 'IQ_NEW' }, { Shiny: 12 }, { AspectFingerprint: '{invalid' },
    { AspectFingerprint: { buffs: [{ Tag: 'UnknownMod' }] } },
    { Quality: 'IQ_LEGENDARY', AspectFingerprint: { buffs: [] } },
    { Quality: 'IQ_NOBLE', AspectFingerprint: { buffs: Array.from({ length: 3 }, () => ({ Tag: 'BlockingLessStaggerMod' })) } },
  ]) {
    const row = buildMarketInventory({ Melee: [stockWeapon(1, overrides)] }, [weapon]).rows[0];
    assert.equal(row.quantity, 1);
    assert.equal(row.canList, false);
    assert.ok(row.warnings.length > 0);
  }
});

test('runes use rank zero stacks and separate ranked instances without double counting', () => {
  const ranked = { ItemId: id(1), ItemType: runePath, UpgradeFingerprint: '{"lvl":3}' };
  const result = buildMarketInventory({ RawUpgrades: [{ ItemType: runePath, ItemCount: 7 }], Upgrades: [ranked, ranked] }, [rune]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find(row => row.attributes.rune.upgradeLevel === 0).quantity, 7);
  assert.equal(result.rows.find(row => row.attributes.rune.upgradeLevel === 3).quantity, 1);
  assert.equal(result.summary.totalQuantity, 8);
  assert.ok(result.rows.every(row => row.category === 'rune' && row.canList));
});

test('motes retain rank, virtue, and the exact grip independently of display names', () => {
  const inventory = { Upgrades: [
    { ItemType: motePath, ItemId: id(1), UpgradeFingerprint: { lvl: 2, pol: 'AP_SPIRIT', compat: ['/SF/Upgrades/Techniques/GreatswordSkillTree'] } },
    { ItemType: motePath, ItemId: id(2), UpgradeFingerprint: '{"lvl":1,"pol":"AP_GRACE","compat":"/SF/Types/Game/SFSkillTree"}' },
  ] };
  const result = buildMarketInventory(inventory, [mote]);
  assert.ok(result.rows.every(row => row.canList));
  assert.deepEqual(result.rows.find(row => row.attributes.mote.virtue === 'SPIRIT').attributes.mote,
    { virtue: 'SPIRIT', upgradeLevel: 2, gripType: 'HeavySkill' });
  assert.deepEqual(result.rows.find(row => row.attributes.mote.virtue === 'GRACE').attributes.mote,
    { virtue: 'GRACE', upgradeLevel: 1, gripType: 'UNIVERSAL' });
});

test('unranked individual motes use their valid fingerprint without requiring an explicit zero rank', () => {
  const inventory = { Upgrades: [
    { ItemType: motePath, ItemId: id(1), UpgradeFingerprint: '{"compat":"/SF/Types/Game/SFSkillTree","pol":"AP_SPIRIT"}' },
    { ItemType: motePath, ItemId: id(2), UpgradeFingerprint: { lvl: 0, compat: '/SF/Types/Game/SFSkillTree', pol: 'AP_SPIRIT' } },
    { ItemType: motePath, ItemId: id(3), UpgradeFingerprint: { lvl: 1, compat: '/SF/Types/Game/SFSkillTree', pol: 'AP_SPIRIT' } },
  ] };
  const result = buildMarketInventory(inventory, [mote]);
  assert.equal(result.rows.length, 2);
  const unranked = result.rows.find(row => row.attributes.mote.upgradeLevel === 0);
  assert.equal(unranked.quantity, 2);
  assert.equal(unranked.canList, true);
  assert.deepEqual(unranked.attributes.mote, { virtue: 'SPIRIT', upgradeLevel: 0, gripType: 'UNIVERSAL' });
  for (const lvl of [null, -1, 4, 'unknown']) {
    const row = buildMarketInventory({ Upgrades: [{ ItemType: motePath,
      UpgradeFingerprint: { lvl, compat: '/SF/Types/Game/SFSkillTree', pol: 'AP_SPIRIT' } }] }, [mote]).rows[0];
    assert.equal(row.canList, false);
    assert.equal(row.attributes.mote.upgradeLevel, null);
  }
});

test('unknown upgrade rank, virtue, and grip never become the market default values', () => {
  for (const entry of [
    { ItemType: runePath }, { ItemType: runePath, UpgradeFingerprint: '{"lvl":9}' },
    { ItemType: motePath, UpgradeFingerprint: '{"lvl":0}' },
    { ItemType: motePath, UpgradeFingerprint: '{"lvl":0,"pol":"AP_GRACE","compat":"/SF/FutureSkill"}' },
    { ItemType: motePath, UpgradeFingerprint: '{invalid' },
  ]) {
    const row = buildMarketInventory({ Upgrades: [entry] }, [rune, mote]).rows[0];
    assert.equal(row.canList, false);
    assert.ok(row.warnings.length > 0);
  }
});

test('uses the active preset and protects installed items across all gear configs', () => {
  const inventory = buildInventory();
  inventory.Melee.push({ ...inventory.Melee[0], ItemId: id(99), Quality: 'IQ_WORN', Configs: [], AspectFingerprint: '' });
  const catalogue = [
    { ...weapon, path: inventory.Melee[0].ItemType },
    { ...rune, path: inventory.Upgrades[0].ItemType },
    { ...resource(), id: 'helmet-id', path: inventory.WeaponSkins[0].ItemType, category: 'armour' },
  ];
  const result = buildMarketInventory(inventory, catalogue);
  const equipped = result.rows.find(row => row.attributes.weapon?.quality === 'NOBLE');
  assert.equal(equipped.equippedQuantity, 1);
  assert.equal(equipped.availableQuantity, 0);
  assert.equal(result.rows.find(row => row.attributes.weapon?.quality === 'WORN').availableQuantity, 1);
  assert.equal(result.rows.find(row => row.itemId === rune.id).equippedQuantity, 1);
  assert.equal(result.rows.find(row => row.itemId === 'helmet-id').equippedQuantity, 1);
});

test('path-based installed copies are counted once across configs and never assigned an arbitrary variant', () => {
  const inventory = { Melee: [{ ItemType: '/SF/Unlisted/Weapon', Configs: [{ Upgrades: [runePath] }, { Upgrades: [runePath] }] }],
    RawUpgrades: [{ ItemType: runePath, ItemCount: 4 }] };
  const row = buildMarketInventory(inventory, [rune]).rows[0];
  assert.equal(row.equippedQuantity, 1);
  assert.equal(row.availableQuantity, 3);
  inventory.Upgrades = [{ ItemType: runePath, ItemId: id(1), UpgradeFingerprint: '{"lvl":2}' }];
  const ambiguous = buildMarketInventory(inventory, [rune]);
  assert.ok(ambiguous.rows.every(value => !value.canList && value.availableQuantity === 0));
  assert.ok(ambiguous.rows.every(value => value.warnings.some(warning => warning.includes('variants'))));
});

test('locked copies are reserved and conflicting duplicate instance data is excluded', () => {
  const inventory = { MiscItems: [{ ItemType: path, ItemCount: 4, Locked: true }, { ItemType: path, ItemCount: 2 }],
    Melee: [stockWeapon(1), stockWeapon(1, { Quality: 'IQ_MILITARY' })] };
  const result = buildMarketInventory(inventory, [resource(), weapon]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].quantity, 6);
  assert.equal(result.rows[0].protectedQuantity, 4);
  assert.equal(result.rows[0].availableQuantity, 2);
  assert.equal(result.summary.invalidEntries, 2);
  const inconsistentProtection = buildMarketInventory({ Melee: [stockWeapon(1), stockWeapon(1, { Locked: true })] }, [weapon]);
  assert.equal(inconsistentProtection.rows.length, 0);
});

test('missing inventories and unsafe image URLs fail closed without exceptions', () => {
  for (const input of [undefined, null, [], 'invalid']) {
    const result = buildMarketInventory(input, []);
    assert.equal(result.summary.inventoryAvailable, false);
    assert.deepEqual(result.rows, []);
  }
  for (const icon of ['javascript:alert(1)', 'file:///private/icon.png', '//other.example/icon.png', 'https://user:password@cdn.example/icon.png']) {
    assert.equal(buildMarketInventory({ MiscItems: [{ ItemType: path, ItemCount: 1 }] }, [resource({ image_path: icon })]).rows[0].imageUrl, '');
  }
});
