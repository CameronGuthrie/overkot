'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMasteryTrackerModel, discoveryProgress, rankProgress } = require('../src/modules/masteryTracker');
const { getCollectionCatalog } = require('../src/modules/collectionCatalog');

// A synthetic inventory with the same 267,000 equipment + 205,000 discovery
// mastery totals as the reported character. All XP comes from actual history
// entries and lore scans; there is no injected player level or total XP.
function fixture() {
  const published = getCollectionCatalog().mastery;
  const items = Array.from({ length: 100 }, (_, index) => ({
    itemType: `/SF/Weapons/Melee/InventoryRankFixture${index}`, category: 'Weapon',
  }));
  const discoveries = Array.from({ length: 41 }, (_, index) => ({
    id: `inventory-rank-memory-${index}`, itemType: `/SF/Types/Quests/LocationLoreQuests/InventoryRankFixture${index}`,
    kind: 'location', required: 3, masteryEligible: true, mastery: 5000,
  }));
  const catalog = { items, discoveries, mastery: { ...published,
    items: items.map(item => ({ itemType: item.itemType, kind: 'weapon', maxRank: 30, masteryPerRank: 100 })),
  } };
  const inventory = { Melee: [], LongGuns: [], Pistols: [], Suits: [],
    XPInfo: items.map((item, index) => ({ ItemType: item.itemType, XP: index < 89 ? published.itemRankXP.weapon[30] : 0 })),
    LoreFragmentScans: discoveries.map(item => ({ ItemType: item.itemType, Progress: item.required })),
  };
  const model = createMasteryTrackerModel({ getCatalog: () => catalog,
    getDiscoveries: value => discoveryProgress(value, catalog) });
  return { catalog, inventory, model };
}

test('inventory equipment history and completed memories calculate Envoy Rank 19 without an endpoint level', () => {
  const { inventory, model } = fixture(), before = JSON.stringify(inventory);
  const value = model.read(inventory, { status: 'live' });
  assert.equal(value.equipmentXP, 267000); assert.equal(value.discoveryXP, 205000);
  assert.equal(value.totalXP, 472000); assert.equal(value.currentRank, 19);
  assert.equal(value.rankSource, 'inventory-mastery'); assert.equal(value.rankIsExact, true);
  assert.equal(value.progress.totalXPForCurrentRank, 451300);
  assert.equal(value.progress.totalXPForNextRank, 500000);
  assert.equal(JSON.stringify(inventory), before, 'The calculation never rewrites inventory');
});

test('PlayerLevel, Stats and Profile values cannot overwrite an unchanged inventory rank', () => {
  const { inventory, model } = fixture();
  for (const level of [undefined, null, 0, 5, 19, 21, 99]) {
    const value = model.read({ ...inventory, PlayerLevel: level, Stats: { PlayerLevel: 40 },
      Profile: { Stats: { PlayerLevel: 80 }, Results: [{ PlayerLevel: 100 }] } });
    assert.equal(value.currentRank, 19); assert.equal(value.totalXP, 472000);
    for (const obsolete of ['reportedRank', 'rawReportedRank', 'maxAttainableRank', 'rankCapSource', 'rankCapRelease', 'rankCapped', 'isMaxRank']) {
      assert.equal(Object.hasOwn(value, obsolete), false, `${obsolete} cannot restore a player-level or release-cap policy`);
    }
  }
});

test('earning more inventory mastery advances past rank 19 without a code or catalogue ceiling change', () => {
  const { inventory, catalog, model } = fixture();
  inventory.PlayerLevel = 21;
  assert.equal(model.read(inventory).currentRank, 19);
  for (const item of inventory.XPInfo.slice(89, 99)) item.XP = catalog.mastery.itemRankXP.weapon[30];
  const value = model.read(inventory);
  assert.equal(value.totalXP, 502000); assert.equal(value.currentRank, 20);
  assert.equal(value.progress.totalXPForCurrentRank, 500000);
  assert.equal(value.progress.totalXPForNextRank, 551300);
  assert.equal(value.rankIsExact, true);
});

test('rank changes at the published inventory mastery threshold and lower ranks are never floored to 19', () => {
  const { inventory, catalog, model } = fixture();
  for (const item of inventory.XPInfo.slice(0, 7)) item.XP = 0;
  inventory.XPInfo[0].XP = catalog.mastery.itemRankXP.weapon[2];
  let value = model.read(inventory);
  assert.equal(value.totalXP, 451200); assert.equal(value.currentRank, 18);
  inventory.XPInfo[0].XP = catalog.mastery.itemRankXP.weapon[3];
  value = model.read(inventory);
  assert.equal(value.totalXP, 451300); assert.equal(value.currentRank, 19);
  const fresh = model.read({ XPInfo: [], LoreFragmentScans: [], Melee: [], LongGuns: [], Pistols: [], Suits: [], PlayerLevel: 21 });
  assert.equal(fresh.currentRank, 0); assert.equal(fresh.totalXP, 0); assert.equal(fresh.rankIsExact, true);
});

test('missing or unreadable inventory contributions stay unavailable or explicitly partial without an endpoint fallback', () => {
  const { inventory, model } = fixture();
  for (const source of [null, {}, { PlayerLevel: 21, Stats: { PlayerLevel: 19 } },
    { XPInfo: [null], PlayerLevel: 21 }]) {
    const value = model.read(source);
    assert.equal(value.currentRank, null); assert.equal(value.computedRank, null);
    assert.equal(value.rankSource, null); assert.equal(value.rankIsExact, false);
  }
  for (const status of ['connect', 'waiting']) assert.equal(model.read(inventory, { status }).currentRank, null);
  const equipmentOnly = model.read({ ...inventory, LoreFragmentScans: undefined, PlayerLevel: 21 });
  assert.equal(equipmentOnly.currentRank, null); assert.equal(equipmentOnly.totalXP, null);
  assert.equal(equipmentOnly.computedRank, rankProgress(267000).rank);
  assert.equal(equipmentOnly.rankIsExact, false); assert.equal(equipmentOnly.scope, 'equipment-only');
  const partial = model.read({ ...inventory, XPInfo: [...inventory.XPInfo, { ItemType: '/SF/Weapons/Melee/UnknownInventoryRankFixture', XP: 999999 }] });
  assert.equal(partial.currentRank, 19); assert.equal(partial.rankIsExact, false);
  assert.equal(partial.scope, 'known-discoveries'); assert.equal(partial.untrackedEquipment, 1);
  const unreadableSkills = model.read({ ...inventory, PlayerSkills: [{ Rank: 20 }], PlayerLevel: 21 });
  assert.equal(unreadableSkills.currentRank, null); assert.equal(unreadableSkills.totalXP, null);
});
