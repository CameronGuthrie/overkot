'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollectionTrackerModel } = require('../src/modules/collectionTracker');
const sword = '/SF/Weapons/Melee/Sword', skin = '/SF/Upgrades/Skins/Body/Armour';
const catalog = { source: { buildId: 'fixture' }, items: [
  { itemType: sword, name: 'Sword', langKey: '/SF/Language/Items/Sword', category: 'Weapon' },
  { itemType: skin, name: 'Armour', category: 'Armor' },
  { itemType: '/SF/Types/Items/Cosmetics/Hat', name: 'Hat', category: 'Cosmetic' },
], discoveries: [] };
const inventory = { Melee: [], LongGuns: [], Pistols: [], Suits: [], WeaponSkins: [], FlavourItems: [], MiscItems: [], Consumables: [], RawUpgrades: [], Upgrades: [], XPInfo: [], LoreFragmentScans: [] };
const model = options => createCollectionTrackerModel({ getCatalog: () => catalog, ...options });

test('collection merges StoreItems aliases and separates historical acquisition from ownership', () => {
  const value = model().read({ ...inventory, Melee: [{ ItemType: sword, XP: 5 }], XPInfo: [{ ItemType: sword, XP: 25 }],
    WeaponSkins: [{ ItemType: skin.replace('/SF/', '/SF/StoreItems/') }] }, { status: 'live' });
  assert.equal(value.rows.find(row => row.itemType === sword).owned, true);
  assert.equal(value.rows.find(row => row.itemType === skin).owned, true);
  const sold = model().read({ ...inventory, XPInfo: [{ ItemType: sword, XP: 25 }] }, { status: 'cached' }).rows.find(row => row.itemType === sword);
  assert.equal(sold.owned, false); assert.equal(sold.acquired, true); assert.equal(sold.historical, true);
});
test('missing or malformed ownership sections remain unknown and localized names take precedence', () => {
  const row = model().read({ ...inventory, Melee: [{ ItemType: sword, ItemCount: -1 }] },
    { status: 'live', names: { '/SF/Language/Items/Sword': 'Schwert' } }).rows.find(row => row.itemType === sword);
  assert.equal(row.owned, null); assert.equal(row.name, 'Schwert');
  assert.ok(model().read(null, { status: 'connect' }).rows.every(row => row.owned === null));
});
test('cosmetics scope uses only catalogue cosmetics; private inventory fields do not escape', () => {
  const value = model({ cosmeticsOnly: true }).read({ ...inventory, AccountId: 'private-account', Nonce: 'private-nonce' }, { status: 'live' });
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].name, 'Hat');
  assert.doesNotMatch(JSON.stringify(value), /private-/);
});

test('Armory projects individual quality, XP, Moonsteel and Tempers without instance IDs', () => {
  const value = model().read({ ...inventory, Melee: [{ ItemType: sword, ItemId: { $oid: 'private-instance' },
    Quality: 'IQ_OFFICER', XP: 125, Shiny: true, AspectFingerprint: JSON.stringify({ buffs: [{ Tag: 'DamageMod' }] }) }] }, { status: 'live' });
  const copies = value.rows.find(row => row.itemType === sword).copies;
  assert.equal(copies.length, 1); assert.equal(copies[0].quality, 'Officer'); assert.equal(copies[0].xp, 125);
  assert.equal(copies[0].moonsteel, true); assert.deepEqual(copies[0].tempers, ['Damage Mod']);
  assert.doesNotMatch(JSON.stringify(value), /private-instance/);
});

test('collection never projects unapproved owned items, historical equipment or lore scans', () => {
  const unapproved = '/SF/Weapons/Melee/UnapprovedFixtureWeapon', hiddenLore = '/SF/Types/Lore/UnapprovedFixtureLore';
  const approvedLore = '/SF/Types/Quests/LocationLoreQuests/FixturePublicLocation';
  const getCatalog = () => ({ ...catalog, discoveries: [{ itemType: approvedLore, id: approvedLore.toLowerCase(), name: 'Public location',
    kind: 'location', required: 3, masteryEligible: true, mastery: 5000 }] });
  const value = createCollectionTrackerModel({ getCatalog }).read({ ...inventory,
    Melee: [{ ItemType: unapproved, XP: 100 }, { ItemType: sword, XP: 10 }],
    XPInfo: [{ ItemType: unapproved, XP: 100 }],
    LoreFragmentScans: [{ ItemType: hiddenLore, Progress: 1 }, { FragmentType: approvedLore, Progress: 2 }, { LoreFragment: skin, Progress: 1 }],
  }, { status: 'live', names: { [unapproved]: 'Unapproved fixture weapon', [hiddenLore]: 'Unapproved fixture lore' } });
  assert.equal(value.rows.find(row => row.itemType === sword).owned, true);
  assert.deepEqual(value.scans.map(row => row.id).sort(), [approvedLore.toLowerCase(), skin.toLowerCase()].sort());
  assert.doesNotMatch(JSON.stringify(value), /unapproved/i);
});

test('reviewed default appearances are owned with live or saved inventory, including omitted sections', () => {
  const getCatalog = () => ({ ...catalog, items: catalog.items.map(row => ({ ...row, defaultOwned: true })) });
  for (const status of ['live', 'cached']) {
    const tracker = createCollectionTrackerModel({ getCatalog });
    const value = tracker.read({ Melee: [] }, { status });
    for (const row of value.rows.filter(row => row.category !== 'Weapon')) {
      assert.equal(row.owned, true); assert.equal(row.count, 1); assert.equal(row.acquired, true);
      assert.equal(row.historical, false); assert.deepEqual(row.copies, []);
      assert.equal(value.summary[row.category].owned, 1); assert.equal(value.summary[row.category].unknown, 0);
    }
    assert.equal(value.rows.find(row => row.itemType === sword).owned, false, 'default appearances never imply equipment ownership');
    assert.ok(tracker.read(null, { status: 'connect' }).rows.every(row => row.owned === null));
    assert.ok(tracker.read({}, { status: 'waiting' }).rows.every(row => row.owned === null));
  }
});

test('applied skins and transmogs establish appearance ownership without inventing extra copies', () => {
  const hat = catalog.items.find(row => row.category === 'Cosmetic').itemType;
  const configured = { ...inventory, Suits: [{ ItemType: '/SF/Souls/FixtureSoul', Configs: [
    { Skins: [hat, hat], Transmog: [skin] },
    { Skins: [hat.replace('/SF/', '/SF/StoreItems/')], Transmog: [skin] },
  ] }] };
  for (const cosmeticsOnly of [false, true]) {
    const tracker = model({ cosmeticsOnly });
    const value = tracker.read(configured, { status: 'live' });
    for (const row of value.rows.filter(row => row.category !== 'Weapon')) {
      assert.equal(row.owned, true); assert.equal(row.count, 1); assert.deepEqual(row.copies, []);
    }
    const withCopies = tracker.read({ ...configured, WeaponSkins: [{ ItemType: hat }, { ItemType: hat }] }, { status: 'cached' });
    assert.equal(withCopies.rows.find(row => row.itemType === hat).count, 2, 'configs reuse existing copies');
    assert.equal(tracker.read(inventory, { status: 'live' }).rows.find(row => row.itemType === hat).owned, false,
      'applied evidence is recalculated for each inventory');
  }
});

test('current companion, mother and avatar customizations can own approved appearances', () => {
  const hat = catalog.items.find(row => row.category === 'Cosmetic').itemType;
  const sources = [
    { MotherCustomization: { Skins: [hat] } },
    { SparrowCustomization: { Skins: [hat] } },
    { ActiveAvatarImageType: hat },
    { KubrowPets: [{ ItemType: '/SF/Types/Pets/FixturePet', Configs: [{ Skins: [hat] }] }] },
    { Melee: [{ ItemType: sword, Configs: [{ Skins: [hat] }] }] },
    { LongGuns: [{ ItemType: '/SF/Weapons/Ranged/FixtureBow', Configs: [{ Transmog: [hat] }] }] },
    { Pistols: [{ ItemType: '/SF/Weapons/Sidearm/FixtureSidearm', Configs: [{ Skins: [hat] }] }] },
  ];
  for (const source of sources) {
    const value = model({ cosmeticsOnly: true }).read({ ...inventory, ...source }, { status: 'live' });
    assert.equal(value.rows[0].owned, true); assert.equal(value.rows[0].count, 1);
    assert.ok(model().read({ ...inventory, ...source }, { status: 'connect' }).rows.every(row => row.owned === null));
  }
});

test('appearance evidence ignores unrelated references, malformed configs and non-held equipment', () => {
  const hat = catalog.items.find(row => row.category === 'Cosmetic').itemType;
  const hidden = '/SF/Upgrades/Skins/Hair/UnapprovedFixtureHair';
  const sources = [
    { Melee: [{ ItemType: sword, Configs: [{ Upgrades: [hat], Skins: [sword, hidden, { $oid: 'private-instance' }, null, 1] }] }] },
    { Suits: [{ ItemType: '/SF/Souls/FixtureSoul', ItemCount: 0, Configs: [{ Skins: [hat] }] }] },
    { Suits: [{ ItemType: '/SF/Souls/FixtureSoul', ItemCount: -1, Configs: [{ Transmog: [hat] }] }] },
    { Suits: [{ Configs: [{ Skins: [hat] }] }] },
    { Suits: [{ ItemType: '/SF/Souls/FixtureSoul', Configs: [null, { Skins: hat, Transmog: {} }] }] },
    { MotherCustomization: { Skins: [hidden] }, RecentVendorPurchases: [{ ItemType: hat }], Recipes: [{ ItemType: hat }] },
  ];
  for (const source of sources) {
    const value = model().read({ ...inventory, ...source }, { status: 'live' });
    assert.notEqual(value.rows.find(row => row.itemType === hat).owned, true);
    assert.doesNotMatch(JSON.stringify(value), /UnapprovedFixtureHair|private-instance/);
  }
});

test('appearance evidence preserves zero, missing and historical equipment states', () => {
  const value = model().read({ ...inventory, Suits: [{ ItemType: '/SF/Souls/FixtureSoul',
    Configs: [{ Skins: [sword], Transmog: [skin] }] }], XPInfo: [{ ItemType: sword, XP: 100 }] }, { status: 'live' });
  const weapon = value.rows.find(row => row.itemType === sword);
  assert.equal(weapon.owned, false); assert.equal(weapon.historical, true); assert.equal(weapon.count, 0);
  assert.equal(value.rows.find(row => row.itemType === skin).owned, true);
});
