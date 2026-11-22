'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMasteryTrackerModel, discoveryProgress, totalXPForRank, itemXPForRank, itemRankFromXP, rankProgress,
  normalizeMasteryData, masteryTargetForItem, WEAPON_MAX_XP, PACT_MAX_XP } = require('../src/modules/masteryTracker');
const sword = '/SF/Weapons/Melee/FixtureSword';
const bow = '/SF/Weapons/Bows/FixtureBow';
const pact = '/SF/Souls/FixtureSoul';
const owned = { Melee: [], LongGuns: [], Pistols: [], Suits: [] };
const fixtureCatalog = { mastery: { items: [sword, bow, pact].map(itemType => ({ itemType })) } };
const read = (inventory, context, options) => createMasteryTrackerModel({ getCatalog: () => fixtureCatalog, ...options }).read(inventory, context);
const mastery = {
  levelXP: Array.from({ length: 41 }, (_, rank) => totalXPForRank(rank)),
  itemRankXP: { weapon: Array.from({ length: 31 }, (_, rank) => itemXPForRank(rank)),
    pact: Array.from({ length: 31 }, (_, rank) => itemXPForRank(rank, true)) },
  items: [{ itemType: sword, kind: 'weapon', maxRank: 30, masteryPerRank: 100 },
    { itemType: pact, kind: 'pact', maxRank: 30, masteryPerRank: 200 }],
  excludedItemTypes: [], playerSkillsPerRank: 1500,
};

test('P17 halves weapon XP while preserving rank 30, Envoy and Pact boundaries', () => {
  assert.deepEqual(Array.from({ length: 21 }, (_, rank) => totalXPForRank(rank)),
    [0, 1300, 5000, 11300, 20000, 31300, 45000, 61300, 80000, 101300, 125000,
      151300, 180000, 211300, 245000, 281300, 320000, 361300, 405000, 451300, 500000]);
  assert.equal(totalXPForRank(30), 1125000);
  assert.equal(totalXPForRank(31), 1198700);
  assert.equal(totalXPForRank(32) - totalXPForRank(31), 73700);
  assert.equal(WEAPON_MAX_XP, 112500); assert.equal(PACT_MAX_XP, 450000);
  for (const soul of [false, true]) {
    for (let rank = 1; rank <= 30; rank++) {
      const threshold = itemXPForRank(rank, soul);
      assert.equal(itemRankFromXP(threshold - 1, soul), rank - 1);
      assert.equal(itemRankFromXP(threshold, soul), rank);
    }
  }
  assert.equal(itemRankFromXP(225000, true), 21);
  assert.equal(itemRankFromXP(45872, true), 9);
  assert.equal(itemRankFromXP(101155), 28);
  assert.equal(itemRankFromXP(Number.MAX_SAFE_INTEGER), 30);
});

test('rank progress uses the actual level interval and remains finite for malformed XP', () => {
  assert.deepEqual(rankProgress(327200), { rank: 16, currentRankXP: 7200, nextRankXP: 41300,
    progressPercent: 17.4, totalXPForCurrentRank: 320000, totalXPForNextRank: 361300 });
  assert.equal(rankProgress(1299).rank, 0); assert.equal(rankProgress(1300).rank, 1);
  for (const invalid of [null, '1300', -1, NaN, Infinity, 1.5]) {
    assert.equal(rankProgress(invalid), null); assert.equal(itemRankFromXP(invalid), null);
  }
});

test('known legacy weapon tables upgrade with client rounding and current tables are not halved twice', () => {
  const f = Math.fround;
  const weapon = Array.from({ length: 31 }, (_, rank) => 100 * Math.ceil(f(f(f(rank ** 2) * 250) * f(f(0.01)))));
  const legacy = { ...mastery, itemRankXP: { ...mastery.itemRankXP, weapon },
    items: mastery.items.map(item => ({ ...item, xpForMaxRank: item.kind === 'weapon' ? 225000 : 450000 })) };
  const original = JSON.stringify(legacy), current = normalizeMasteryData(legacy);
  assert.deepEqual(current.itemRankXP.weapon.slice(0, 6), [0, 200, 500, 1200, 2000, 3200]);
  assert.equal(current.itemRankXP.weapon[30], 112500);
  assert.equal(current.items[0].xpForMaxRank, 112500); assert.equal(current.items[0].maxRank, 30);
  assert.equal(current.items[1].xpForMaxRank, 450000);
  assert.strictEqual(current.levelXP, legacy.levelXP); assert.strictEqual(current.itemRankXP.pact, legacy.itemRankXP.pact);
  assert.equal(JSON.stringify(legacy), original); assert.strictEqual(normalizeMasteryData(current), current);
  assert.equal(masteryTargetForItem(sword, legacy), 112500);
  const value = read({ ...owned, XPInfo: [{ ItemType: sword, XP: 112500 }] }, {}, { getCatalog: () => ({ mastery: legacy }) });
  assert.equal(value.rows[0].rank, 30); assert.equal(value.rows[0].masteryXP, 3000);
  const future = { ...mastery, itemRankXP: { ...mastery.itemRankXP, weapon: weapon.map(xp => xp * 2) } };
  assert.strictEqual(normalizeMasteryData(future), future);
});

test('unapproved equipment never reaches mastery output and prevents a complete calculation', () => {
  const unreleased = '/SF/Weapons/Melee/PrivateFixture';
  const value = read({ ...owned, XPInfo: [{ ItemType: sword, XP: 112500 }, { ItemType: unreleased, XP: 999999 }],
    Melee: [{ ItemType: unreleased, XP: 999999 }] }, { names: { [unreleased]: 'Private name' } }, {
    getCatalog: () => ({ mastery }), getDiscoveries: () => ({ available: true, complete: 0, completeCatalog: true }),
  });
  assert.deepEqual(value.rows.map(row => row.itemType), [sword]);
  assert.equal(value.untrackedEquipment, 1); assert.equal(value.equipmentXP, 3000);
  assert.equal(value.scope, 'known-discoveries'); assert.doesNotMatch(JSON.stringify(value), /PrivateFixture|Private name/);
  const unavailable = createMasteryTrackerModel().read({ ...owned, XPInfo: [{ ItemType: unreleased, XP: 999999 }] });
  assert.deepEqual(unavailable.rows, []); assert.equal(unavailable.untrackedEquipment, 1);
});

test('XPInfo duplicates and store aliases count once; historical XP survives selling or resetting copies', () => {
  const inventory = { ...owned, PlayerLevel: 16, AccountId: 'private-account', Nonce: 'private-nonce',
    XPInfo: [{ ItemType: sword, XP: WEAPON_MAX_XP }, { ItemType: sword.toLowerCase(), XP: 500 },
      { ItemType: sword.replace('/SF/', '/SF/StoreItems/'), XP: 1000 }, { ItemType: pact, XP: 450000 },
      { ItemType: '/SF/Types/Game/Pets/Wolf', XP: 500000 }, { ItemType: '/SF/Types/Items/MiscItems/Ore', XP: 999999 }],
    Melee: [{ ItemType: sword, ItemId: { $oid: 'private-instance' }, XP: 0 }] };
  const before = JSON.stringify(inventory);
  const value = read(inventory, { names: { [sword]: 'Localized sword' }, accountId: 'private-account' });
  assert.equal(value.rows.length, 2); assert.equal(value.equipmentXP, 9000);
  const weapon = value.rows.find(row => row.category === 'melee');
  assert.equal(weapon.name, 'Localized sword'); assert.equal(weapon.xp, WEAPON_MAX_XP);
  assert.equal(weapon.rank, 30); assert.equal(weapon.masteryXP, 3000); assert.equal(weapon.nextXP, null);
  assert.equal(weapon.owned, true); assert.equal(weapon.xpSource, 'history');
  assert.equal(value.rows.find(row => row.category === 'pact').owned, false);
  assert.equal(value.currentRank, null); assert.equal(value.scope, 'equipment-only');
  assert.equal(value.totalXP, null); assert.equal(value.discoveryXP, null); assert.equal(value.rankIsExact, false);
  assert.equal(value.computedRank, 2, 'Equipment-only progress remains a lower-bound diagnostic');
  assert.equal(JSON.stringify(inventory), before); assert.doesNotMatch(JSON.stringify(value), /private-/);
});

test('owned XP is a marked fallback and malformed records never fabricate mastery', () => {
  const value = read({ ...owned, XPInfo: [null, { ItemType: sword, XP: '112500' },
    { ItemType: bow, XP: Infinity }, { ItemType: pact, XP: -1 }, { ItemType: '/SF/Weapons/../Bad', XP: 50 }],
    Melee: [{ ItemType: sword, XP: 100 }, { ItemType: sword, XP: 5000 }],
    Suits: [{ ItemType: pact }, { ItemType: '/SF/Types/Game/Pets/Wolf', XP: 450000 }] });
  assert.equal(value.rows.length, 3);
  assert.equal(value.rows.find(row => row.itemType === sword).xpSource, 'owned-fallback');
  assert.equal(value.rows.find(row => row.itemType === sword).xp, 5000);
  assert.equal(value.rows.find(row => row.itemType === pact).rank, null);
  assert.equal(value.rows.find(row => row.itemType === bow).masteryXP, null);
  assert.equal(value.summary.ownedFallbacks, 1); assert.equal(value.summary.unknownXP, 2);
  assert.equal(value.unreadableRecords, 4);
});

test('catalog rows expose unstarted gear without counting an absent catalog as a complete collection', () => {
  const options = { getCatalog: () => ({ items: [{ itemType: sword, name: 'Catalog sword' },
    { itemType: bow }, { itemType: pact }, { itemType: '/SF/Types/Game/Pets/Wolf' }] }) };
  const value = read({ ...owned, XPInfo: [{ ItemType: sword, XP: WEAPON_MAX_XP }] }, {}, options);
  assert.equal(value.rows.length, 3); assert.equal(value.summary.mastered, 1);
  assert.equal(value.summary.unstarted, 2); assert.equal(value.summary.remainingMasteryXP, 9000);
  assert.equal(value.rows.find(row => row.itemType === bow).catalogOnly, true);
  assert.equal(value.rows.find(row => row.itemType === bow).owned, false);
  assert.equal(value.rows.find(row => row.itemType === sword).name, 'Catalog sword');
  const unknown = read({ ...owned }, {}, options);
  assert.equal(unknown.summary.unknownXP, 3); assert.equal(unknown.summary.unstarted, 0);
});

test('only explicit verified discovery completion contributes XP; partial catalogs retain limited scope', () => {
  const inventory = { ...owned, PlayerLevel: 3, XPInfo: [{ ItemType: sword, XP: WEAPON_MAX_XP }] };
  const options = { getDiscoveries: () => ({ available: true, complete: 2, total: 5, completeCatalog: true }),
    getCatalog: () => ({ mastery }) };
  const value = read(inventory, {}, options);
  assert.equal(value.equipmentXP, 3000); assert.equal(value.discoveryXP, 10000);
  assert.equal(value.totalXP, 13000); assert.equal(value.computedRank, 3);
  assert.equal(value.scope, 'complete'); assert.equal(value.currentRank, 3); assert.equal(value.rankIsExact, true);
  const partial = read(inventory, {}, { getDiscoveries: () => ({ available: true, complete: 2 }) });
  assert.equal(partial.totalXP, 13000); assert.equal(partial.scope, 'known-discoveries');
  assert.equal(partial.currentRank, 3); assert.equal(partial.rankIsExact, false);
  for (const discoveries of [{ available: true, complete: '2' }, { available: true, complete: -1 },
    { available: false, complete: 2 }, { available: true, complete: 10001 }]) {
    assert.equal(read(inventory, {}, { getDiscoveries: () => discoveries }).totalXP, null);
  }
  assert.equal(read({ ...inventory, XPInfo: undefined }, {}, options).scope, 'known-discoveries');
});

test('downloaded progression overrides the reference curve and unknown configs stay estimated', () => {
  const f = Math.fround;
  const weapon = Array.from({ length: 31 }, (_, rank) => 100 * Math.ceil(f(f(f(rank ** 2) * 125) * f(f(0.01)))));
  const catalog = { items: [{ itemType: bow }], mastery: { ...mastery, itemRankXP: { ...mastery.itemRankXP, weapon } } };
  const value = read({ ...owned, PlayerLevel: 3, XPInfo: [{ ItemType: sword, XP: 112500 }, { ItemType: bow, XP: 5000 }] }, {},
    { getCatalog: () => catalog, getDiscoveries: () => ({ available: true, complete: 2, completeCatalog: true }) });
  assert.equal(value.rows.find(row => row.itemType === sword).target, 112500);
  assert.equal(value.rows.find(row => row.itemType === sword).rank, 30);
  assert.equal(value.rows.find(row => row.itemType === sword).estimated, false);
  assert.equal(value.rows.find(row => row.itemType === bow).estimated, true);
  assert.equal(value.masteryDataSource, 'catalog'); assert.equal(value.scope, 'known-discoveries');
  assert.equal(value.summary.estimated, 1);
  const fallback = read({ ...owned, XPInfo: [{ ItemType: sword, XP: 112500 }] });
  assert.equal(fallback.rows[0].target, 112500); assert.equal(fallback.rows[0].rank, 30);
  assert.equal(fallback.rows[0].estimated, true); assert.equal(fallback.masteryDataSource, 'reference');
  const unstarted = read({ ...owned, PlayerLevel: 3, XPInfo: [{ ItemType: sword, XP: 112500 }] }, {}, {
    getCatalog: () => ({ ...catalog, items: [{ itemType: sword, category: 'Weapon' }, { itemType: bow, category: 'Weapon' }] }),
    getDiscoveries: () => ({ available: true, complete: 2, completeCatalog: true }),
  });
  assert.equal(unstarted.rows.find(row => row.itemType === bow).estimated, true);
  assert.equal(unstarted.rows.find(row => row.itemType === bow).masteryXP, 0);
  assert.equal(unstarted.scope, 'complete', 'An unknown configuration at zero XP does not change the computed total');
});

test('inventory mastery determines rank independently of PlayerLevel and unknown PlayerSkills prevent an exact total', () => {
  const inventory = { ...owned, PlayerLevel: 4, XPInfo: [{ ItemType: sword, XP: WEAPON_MAX_XP }], PlayerSkills: { A: 1, B: 2 } };
  const options = { getCatalog: () => ({ mastery }), getDiscoveries: () => ({ available: true, complete: 2, completeCatalog: true }) };
  const value = read(inventory, {}, options);
  assert.equal(value.skillXP, 4500); assert.equal(value.totalXP, 17500);
  assert.equal(value.currentRank, 3); assert.equal(value.computedRank, 3); assert.equal(value.rankIsExact, true);
  const unknown = read({ ...inventory, PlayerSkills: [{ Rank: 2 }] }, {}, options);
  assert.equal(unknown.skillXP, null); assert.equal(unknown.totalXP, null); assert.equal(unknown.scope, 'known-discoveries');
  assert.equal(unknown.currentRank, null); assert.equal(unknown.rankIsExact, false);
});

test('rank follows inventory XP beyond 19 and endpoint level changes cannot overwrite it', () => {
  const inventory = { ...owned, PlayerLevel: 19, Stats: { PlayerLevel: 21 }, XPInfo: [{ ItemType: sword, XP: 112500 }] };
  const options = { getCatalog: () => ({ mastery }),
    getDiscoveries: () => ({ available: true, complete: 110, masteryXP: totalXPForRank(21) - 3000, completeCatalog: true }) };
  const baseline = read(inventory, { status: 'cached' }, options);
  assert.equal(baseline.currentRank, 21); assert.equal(baseline.rankIsExact, true);
  const before = JSON.stringify(inventory);
  for (const rank of [undefined, 0, 5, 18, 19, 21, 40]) {
    const value = read({ ...inventory, PlayerLevel: rank }, { status: 'live' }, options);
    assert.equal(value.currentRank, 21); assert.equal(value.computedRank, 21);
    assert.equal(value.progress.rank, 21); assert.equal(value.rankSource, 'inventory-mastery');
    assert.equal(value.rankIsExact, true);
    for (const obsolete of ['reportedRank', 'rawReportedRank', 'rankCapped', 'maxAttainableRank', 'isMaxRank']) {
      assert.equal(Object.hasOwn(value, obsolete), false, `${obsolete} cannot restore endpoint rank authority or a release cap`);
    }
  }
  assert.equal(JSON.stringify(inventory), before, 'Rank calculation never edits account inventory');
});

test('discovery caps and tree bitmasks are separate; duplicates never add lore progress or mastery', () => {
  const location = '/SF/Types/Quests/LocationLoreQuests/Fixture';
  const tree = '/SF/Types/Lore/MapTreeLoreFragmentMidrath';
  const catalog = { discoveries: [{ id: location, itemType: location, name: 'Fixture location', kind: 'location', required: 9, masteryEligible: true, mastery: 5000 },
    ...[0, 1, 2].map(bit => ({ id: `${tree}:${bit}`, itemType: tree, name: `Tree ${bit}`, kind: 'tree', bit, required: 1, masteryEligible: false, mastery: 0 }))] };
  const inventory = { LoreFragmentScans: [{ ItemType: location, Progress: 4 }, { ItemType: location, Progress: 5 },
    { ItemType: tree, Progress: 1 }, { ItemType: tree, Progress: 4 }] };
  const partial = discoveryProgress(inventory, catalog);
  assert.equal(partial.complete, 0); assert.equal(partial.total, 1); assert.equal(partial.rows[0].current, 5);
  assert.equal(partial.rows.filter(row => row.kind === 'tree' && row.complete).length, 2);
  assert.equal(partial.completeCatalog, true);
  const complete = discoveryProgress({ LoreFragmentScans: [...inventory.LoreFragmentScans, { ItemType: location, Progress: 99 }] }, catalog);
  assert.equal(complete.complete, 1); assert.equal(complete.rows[0].current, 9);
  const unavailable = discoveryProgress({}, catalog);
  assert.equal(unavailable.available, false); assert.equal(unavailable.rows[0].current, null);
  assert.equal(unavailable.rows[0].complete, null); assert.equal(unavailable.completeCatalog, false);
  const invalid = discoveryProgress({ LoreFragmentScans: [null, { ItemType: location, Progress: '9' },
    { ItemType: '/SF/Types/Quests/LocationLoreQuests/New', Progress: 5 }] }, catalog);
  assert.equal(invalid.unreadableRecords, 2); assert.equal(invalid.untrackedLocations, 1); assert.equal(invalid.completeCatalog, false);
});

test('ownership remains unknown for missing or malformed buckets and model does not retain previous accounts', () => {
  const model = createMasteryTrackerModel({ getCatalog: () => fixtureCatalog });
  assert.equal(model.read({ XPInfo: [{ ItemType: sword, XP: 100 }] }).rows[0].owned, null);
  assert.equal(model.read({ XPInfo: [{ ItemType: sword, XP: 100 }], Melee: [null] }).rows[0].owned, null);
  assert.equal(model.read({ XPInfo: [{ ItemType: sword, XP: 100 }], Melee: [] }).rows[0].owned, false);
  assert.deepEqual(model.read(null, { status: 'connect' }).rows, []);
  assert.equal(model.read({ PlayerLevel: 16 }, { status: 'waiting' }).currentRank, null);
  assert.equal(model.read({ PlayerLevel: 16, Stats: { PlayerLevel: 19 } }).currentRank, null);
  assert.equal(model.read({ PlayerLevel: 16 }).computedRank, null);
  assert.deepEqual(model.read({}, { status: 'cached' }).rows, []);
});

test('selected language names override English catalog labels and ability upgrades are not extra Pacts', () => {
  const swordKey = '/SF/Language/Weapons/FixtureSwordName';
  const tree = '/SF/Types/Lore/MapTreeLoreFragmentMidrath';
  const treeKey = '/SF/Language/Locations/MapTreeNameA';
  const catalog = { items: [{ itemType: sword, name: 'English sword', langKey: swordKey, category: 'Weapon', icon: '/SF/Interface/Graphics/Sword.png' },
    { itemType: '/SF/Souls/Common/Virtues/FixtureUpgrade', category: 'Pact Upgrade', name: 'Pact ability' }],
    discoveries: [{ id: tree + ':bit:0', itemType: tree, name: 'English tree', langKey: treeKey, kind: 'tree', bit: 0, required: 1 }] };
  const alias = '/SF/Language/Weapons/LocalizedSwordName';
  const names = { [swordKey]: alias, [alias]: 'Épée', [treeKey]: 'Arbre de Fuirlands', [tree]: 'Arbre du monde' };
  const value = read({ ...owned, XPInfo: [] }, { names }, { getCatalog: () => catalog });
  assert.equal(value.rows.length, 1); assert.equal(value.rows[0].name, 'Épée');
  assert.equal(value.rows[0].icon, '/SF/Interface/Graphics/Sword.png');
  const discoveries = discoveryProgress({ LoreFragmentScans: [{ ItemType: tree, Progress: 1 }] }, catalog, names);
  assert.equal(discoveries.rows[0].name, 'Arbre de Fuirlands'); assert.equal(discoveries.rows[0].complete, true);
});
