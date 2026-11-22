'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WolfTraining, inventoryWolves, equippedPetId, pawLevel, pawProgress, normalizeProgression,
  DEFAULT_PROGRESSION, validWolfTrainingCatalog, setWolfTrainingCatalog } = require('../src/modules/wolfTraining');
const { wolfInventory, wolfCatalog, id } = require('./fixtures/wolf-inventory');

test('projects every wolf with separate trained, fractional and allocated paw values', () => {
  const snapshot = inventoryWolves(wolfInventory(), wolfCatalog());
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.activePetId, 'wolf-fixture-pet-1');
  assert.equal(snapshot.unreadablePets, 0);
  const [active, resting] = snapshot.rows;
  assert.equal(active.name, 'Ciar'); assert.equal(active.temperament, 'Clever'); assert.equal(active.equipped, true);
  assert.equal(resting.equipped, false); assert.equal(resting.needsRest, true); assert.equal(resting.restDate, 1789781861000);
  assert.equal(active.energy, 95); assert.equal(active.maxEnergy, 150);
  assert.deepEqual(active.stats.map(row => [row.key, row.level, row.allocated]),
    [['guard', 0, 0], ['speed', 1, 1], ['stamina', 0, 0], ['search', 1, 0], ['support', 2, 1]]);
  assert.equal(active.stats[0].progress, .25);
  assert.equal(active.stats[1].progress, 1 + 750 / 1400);
  assert.equal(active.trainedPaws, 4); assert.equal(active.availablePaws, 2);
  assert.equal(active.stats[1].approximate, false); assert.equal(active.stats[4].approximate, false);
  assert.equal(active.bondLabel, 'Wild');
});

test('selects the current SENTINEL preset and tolerates stale or absent loadout ids', () => {
  const inventory = wolfInventory();
  assert.equal(equippedPetId(inventory), 'wolf-fixture-pet-1');
  inventory.KubrowPets.reverse();
  assert.equal(inventoryWolves(inventory).activePetId, 'wolf-fixture-pet-1', 'the current pet wins over inventory order');
  inventory.CurrentLoadOutIds = [id('stale')];
  assert.equal(equippedPetId(inventory), 'wolf-fixture-pet-2');
  assert.equal(inventoryWolves(inventory).activePetId, 'wolf-fixture-pet-2');
  delete inventory.CurrentLoadOutIds;
  assert.equal(equippedPetId(inventory), 'wolf-fixture-pet-2');
  delete inventory.LoadOutPresets;
  assert.equal(inventoryWolves(inventory).activePetId, 'wolf-fixture-pet-2', 'the first readable pet is the fallback');
  assert.equal(equippedPetId({}), '');
  assert.equal(inventoryWolves({}).activePetId, null);
});

test('clamps negative and malformed training values, skips malformed pets and deduplicates identities', () => {
  const inventory = wolfInventory();
  const details = inventory.KubrowPets[0].Details;
  details.Guard = -2; details.Speed = Infinity; details.Support = '2000'; details.SpeedSkill = 100;
  details.SearchSkill = 1.9; details.Energy = NaN; details.RestDate = { $date: 'invalid' };
  details.Bond = '3481';
  inventory.KubrowPets.push(inventory.KubrowPets[0], null, { ItemId: id('empty') }, { Details: {} });
  const snapshot = inventoryWolves(inventory);
  assert.equal(snapshot.rows.length, 2); assert.equal(snapshot.unreadablePets, 3);
  assert.equal(snapshot.rows[0].energy, 0); assert.equal(snapshot.rows[0].restDate, null);
  assert.equal(snapshot.rows[0].bond, null); assert.equal(snapshot.rows[0].bondLabel, null, 'malformed bond cannot imply an initial type');
  assert.equal(snapshot.rows[0].stats[0].xp, 0); assert.equal(snapshot.rows[0].stats[1].allocated, 5);
  assert.equal(snapshot.rows[0].stats[3].allocated, 1); assert.equal(snapshot.rows[0].stats[4].xp, 0);
  assert.equal(inventoryWolves({ KubrowPets: {} }).unreadablePets, 1);
  assert.deepEqual(inventoryWolves(null).rows, []);
});

test('supports the inventory response wrapper without leaking internal label ids', () => {
  const inventory = wolfInventory();
  inventory.KubrowPets[0].Details.Name = '/SF/Language/Quests/UnreleasedPupName';
  inventory.KubrowPets[0].Details.Temperment = 'TEMPERMENT_UNRELEASED';
  const snapshot = inventoryWolves({ inventory });
  assert.equal(snapshot.rows[0].name, null); assert.equal(snapshot.rows[0].temperament, null);
  assert.equal(JSON.stringify(snapshot).includes('/SF/'), false);
});

test('paw progress interpolates between thresholds and saturates exactly at the cap', () => {
  for (const [xp, level, progress] of [[-1, 0, 0], [0, 0, 0], [300, 0, .5], [600, 1, 1], [1300, 1, 1.5], [2000, 2, 2], [9000, 5, 5], [1e9, 5, 5]]) {
    assert.equal(pawLevel(xp), level); assert.equal(pawProgress(xp), progress);
  }
  assert.equal(pawProgress(25, [50, 200]), .5);
});

test('the offline curve uses the verified native rule and accepts explicit legacy estimates', () => {
  assert.equal(normalizeProgression(null).estimated, false);
  assert.equal(normalizeProgression({ skillThresholds: [0, 100] }).confirmedSkillLevels, 5);
  assert.deepEqual(DEFAULT_PROGRESSION.bondThresholds, [125000, 421900, 1000000, 1953100]);
  assert.equal(normalizeProgression({ skillThresholds: [100, 500], estimated: true, confirmedSkillLevels: 1 }).confirmedSkillLevels, 1);
  const authoritative = normalizeProgression({ maxEnergy: 120, skillThresholds: [100, 500], bondThresholds: [30, 80] });
  assert.equal(authoritative.estimated, false); assert.equal(authoritative.confirmedSkillLevels, 2);
  assert.equal(authoritative.maxEnergy, 120);
});

test('bond names follow the verified rank transitions while unknown catalogues remain explicit', () => {
  const inventory = wolfInventory(); const details = inventory.KubrowPets[0].Details;
  for (const [points, name] of [[3481, 'Wild'], [15600, 'Wild'], [124999, 'Wild'], [125000, 'Tame'], [421900, 'Loyal'], [1000000, 'Loving'], [1953100, 'Soulbound']]) {
    details.Bond = points;
    const row = inventoryWolves(inventory).rows[0];
    assert.equal(row.bondLabel, name); assert.equal(row.bond, points);
  }
  const unknown = wolfCatalog(); unknown.progression.bondThresholds = [];
  assert.equal(inventoryWolves(inventory, unknown).rows[0].bondLabel, null, 'an explicitly unknown curve cannot invent a rank');
});

test('a cached first-preview catalogue upgrades offline while keeping its localized labels', () => {
  const legacy = wolfCatalog('fr');
  legacy.progression = { maxEnergy: 100, maxMaturity: 15, skillThresholds: [600, 2000, 3829, 6156, 8896],
    bondThresholds: [], estimated: true, confirmedSkillLevels: 2 };
  assert.equal(validWolfTrainingCatalog(legacy), true);
  const snapshot = inventoryWolves(wolfInventory(), legacy);
  assert.equal(snapshot.rows[0].bondLabel, 'Sauvage'); assert.equal(snapshot.rows[0].bond, 3481);
  assert.deepEqual(snapshot.progression.skillThresholds, [600, 2000, 3900, 6300, 9000]);
  assert.equal(snapshot.progression.estimated, false);
  assert.equal(snapshot.rows[0].stats[0].label, 'Cran');
  assert.equal(snapshot.rows[0].maxEnergy, 150, 'old preview caps use the current extracted game maximum');
  const unrelated = structuredClone(legacy); unrelated.progression.skillThresholds[4] = 9000;
  assert.equal(normalizeProgression(unrelated.progression).estimated, true);
  assert.deepEqual(normalizeProgression(unrelated.progression).bondThresholds, [], 'future unknown curves are not overwritten');
});

test('the previous verified feed upgrades energy from the game snapshot without replacing custom curves', () => {
  const old = wolfCatalog('fr'); old.progression.maxEnergy = 100;
  const snapshot = inventoryWolves(wolfInventory(), old);
  assert.equal(snapshot.rows[0].maxEnergy, 150);
  assert.equal(snapshot.rows[0].energy, 95, 'saved energy is not rewritten');
  assert.equal(snapshot.rows[0].stats[0].label, 'Cran');
  const changed = structuredClone(old); changed.progression.skillThresholds = [100, 500];
  assert.equal(normalizeProgression(changed.progression).maxEnergy, 100, 'unrecognised explicit progression stays authoritative');
  const future = structuredClone(old); future.progression.maxEnergy = 180;
  assert.equal(inventoryWolves(wolfInventory(), future).rows[0].maxEnergy, 180);
  assert.equal(inventoryWolves(wolfInventory()).rows[0].maxEnergy, 150, 'offline startup uses the extracted package');
});

test('catalog validation rejects unsafe labels and invalid curves before replacing data', () => {
  const catalog = wolfCatalog(); assert.equal(validWolfTrainingCatalog(catalog), true);
  for (const mutate of [value => { value.schema = 2; }, value => { value.labels['/SF/Types/Pets/RawId'] = 'Raw'; },
    value => { delete value.labels['/SF/Language/Pets/PetStat_Guard']; }, value => { value.progression.skillThresholds = [100, 90]; },
    value => { value.progression.bondThresholds = [-1]; }, value => { value.progression.estimated = 'true'; },
    value => { value.progression.confirmedSkillLevels = 6; }]) {
    const invalid = structuredClone(catalog); mutate(invalid);
    assert.equal(validWolfTrainingCatalog(invalid), false); assert.equal(setWolfTrainingCatalog(invalid, 'test-invalid'), false);
  }
  assert.equal(setWolfTrainingCatalog(catalog, 'test-valid'), true);
  assert.equal(setWolfTrainingCatalog(structuredClone(catalog), 'test-valid'), false);
});

test('localized metadata resolves names, stats and verified bond ranks', () => {
  const catalog = wolfCatalog('fr'); catalog.progression.bondThresholds = [30];
  const row = inventoryWolves(wolfInventory(), catalog).rows[0];
  assert.equal(row.stats[0].label, 'Cran'); assert.equal(row.stats[3].label, 'Curiosité');
  assert.equal(row.energyLabel, 'Énergie'); assert.equal(row.bondLabel, 'Apprivoisé');
});

test('session snapshots update live inventory, caching, language and expired-session clearing', () => {
  let inventory = null, cached = false, expired = false, active = null, language = 'en', polledAt = 0;
  const session = { getRawInventory: () => inventory, isNonceExpired: () => expired,
    isInventoryCached: () => cached, getLastSuccessfulPollAt: () => polledAt };
  const tracker = new WolfTraining({ getSession: () => active, getLanguage: () => language });
  let events = 0; tracker.on('changed', () => events++);
  assert.equal(tracker.getSnapshot().status, 'connect');
  active = session; assert.equal(tracker.getSnapshot().status, 'waiting');
  inventory = wolfInventory(); polledAt = 10; assert.equal(tracker.getSnapshot().status, 'live');
  const sameEvents = events; tracker.update(); assert.equal(events, sameEvents, 'identical inventory does not rebroadcast');
  cached = true; assert.equal(tracker.getSnapshot().status, 'cached');
  cached = false; inventory = structuredClone(inventory); inventory.KubrowPets[0].Details.Guard = 600;
  assert.equal(tracker.getSnapshot().rows[0].stats[0].level, 1);
  setWolfTrainingCatalog(wolfCatalog('fr'), 'fr'); language = 'fr';
  assert.equal(tracker.getSnapshot().rows[0].stats[0].label, 'Cran');
  assert.equal(tracker.getSnapshot().catalogStatus, 'ready');
  expired = true; assert.equal(tracker.getSnapshot().status, 'connect'); assert.deepEqual(tracker.getSnapshot().rows, []);
});
