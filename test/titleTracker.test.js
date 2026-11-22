'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TitleTracker, inventoryTitles, setTitleCatalog } = require('../src/modules/titleTracker');
const { projectEpithets } = require('../src/modules/epithetsData');
const { epithets, titleInventory } = require('./fixtures/title-inventory');
const row = (snapshot, name) => snapshot.rows.find(item => item.name === name);

function fixture() {
  let inventory = titleInventory(), cached = false, expired = false;
  let session = { getRawInventory: () => inventory, isInventoryCached: () => cached, isNonceExpired: () => expired };
  const tracker = new TitleTracker({ getSession: () => session });
  return { tracker, set: value => { inventory = value; }, cache: value => { cached = value; },
    expire: () => { expired = true; }, logout: () => { session = null; },
    login: () => { expired = false; inventory = null;
      session = { getRawInventory: () => inventory, isInventoryCached: () => cached, isNonceExpired: () => expired }; } };
}

test('missing title data has a distinct state before a catalog is supplied', () => {
  const f = fixture();
  assert.equal(f.tracker.getSnapshot().status, 'data');
  assert.deepEqual(f.tracker.getSnapshot().rows, []);
  assert.equal(setTitleCatalog(epithets()), true);
  assert.equal(f.tracker.getSnapshot().status, 'live');
});

test('tracks current and legacy challenge totals without adding them together', () => {
  const tally = inventoryTitles(titleInventory());
  assert.equal(tally.unreadableChallenges, 0);
  assert.equal(row(tally, 'Of The Sleeve').count, 3);
  assert.equal(row(tally, 'Of The Sleeve').target, 10);
  assert.equal(row(tally, 'Of The Sleeve').completed, false);
  assert.equal(row(tally, 'Gandura').count, 75);
  assert.equal(row(tally, 'Gandura').target, 500);
  assert.equal(tally.rows.length, 3);
  assert.deepEqual(tally.rows.map(item => item.name), ['Gandura', 'Of The Sleeve', 'Soul-bibber']);
});

test('Complete flags restore full counts when a legacy record reports one', () => {
  const tally = inventoryTitles(titleInventory());
  assert.equal(row(tally, 'Soul-bibber').count, 100);
  assert.equal(row(tally, 'Soul-bibber').completed, true);
  assert.equal(row(tally, 'Soul-bibber').owned, false);
});

test('owned title items independently establish completion, including store paths', () => {
  for (const prefix of ['/SF/Types', '/SF/StoreItems/Types']) {
    const tally = inventoryTitles({ FlavourItems: [{ ItemType: prefix + '/Items/Titles/CogahTitle' },
      { ItemType: '/SF/Types/Items/ColorPalettes/CogahTitle' }, null] });
    assert.equal(row(tally, 'Of The Sleeve').owned, true);
    assert.equal(row(tally, 'Of The Sleeve').completed, true);
    assert.equal(row(tally, 'Of The Sleeve').count, 10);
    assert.equal(row(tally, 'Gandura').count, 0);
  }
});

test('duplicate, path and case aliases take the highest count and clamp at the target', () => {
  const tally = inventoryTitles({ ChallengeProgress: [{ Name: 'CogahTitleChallenge', Progress: 3 },
    { Name: 'CogahTitleChallenge', Progress: 3 }, { Name: '/sf/types/challenges/titles/cogahtitlechallenge', Progress: 12 },
    { Name: '/SF/Types/Challenges/Titles/CastingSkillTreeKillsTitleChallenge', Progress: 40 }] });
  assert.equal(row(tally, 'Of The Sleeve').count, 10);
  assert.equal(row(tally, 'Of The Sleeve').completed, true);
  assert.equal(row(tally, 'Gandura').count, 40);
});

test('rejects malformed progress without inventing completion or new title rows', () => {
  const invalid = [-1, 0.5, '10', null, Infinity, Number.MAX_SAFE_INTEGER + 1];
  const tally = inventoryTitles({ ChallengeProgress: [...invalid.map(Progress => ({ Name: 'CogahTitleChallenge', Progress })),
    { Name: 'CastingSkillTreeKillsTitleChallengeFix', Progress: 1, Complete: 'true' },
    { Name: 'UnknownTitleChallenge', Progress: 100 }, { Name: 'x'.repeat(201), Progress: 1 }, null, { Progress: 5 }] });
  assert.equal(tally.unreadableChallenges, 10);
  assert.equal(row(tally, 'Of The Sleeve').count, 0);
  assert.equal(row(tally, 'Of The Sleeve').completed, false);
  assert.equal(row(tally, 'Gandura').completed, false);
  assert.equal(tally.rows.length, 3);
  assert.equal(inventoryTitles({ ChallengeProgress: {} }).unreadableChallenges, 1);
  assert.equal(inventoryTitles({}).unreadableChallenges, 0);
});

test('an explicit Complete flag remains authoritative when its count is unreadable', () => {
  const tally = inventoryTitles({ ChallengeProgress: [{ Name: 'CogahTitleChallenge', Complete: true }] });
  assert.equal(tally.unreadableChallenges, 1);
  assert.equal(row(tally, 'Of The Sleeve').count, 10);
  assert.equal(row(tally, 'Of The Sleeve').completed, true);
});

test('broadcasts changed progress once and clears progress on logout or expiry', () => {
  const f = fixture(); let events = 0;
  f.tracker.on('changed', () => events++);
  f.tracker.update(); assert.equal(events, 1);
  f.tracker.update(); assert.equal(events, 1);
  f.set(structuredClone(titleInventory())); f.tracker.update(); assert.equal(events, 1);
  const next = titleInventory(); next.ChallengeProgress[0].Progress = 6;
  f.set(next); f.tracker.update(); assert.equal(events, 2);
  assert.equal(row(f.tracker.getSnapshot(), 'Of The Sleeve').count, 6);
  f.cache(true); assert.equal(f.tracker.getSnapshot().status, 'cached');
  f.expire();
  assert.equal(f.tracker.getSnapshot().status, 'connect');
  assert.ok(f.tracker.getSnapshot().rows.every(item => item.count === 0 && !item.completed));
  f.logout(); assert.equal(f.tracker.getSnapshot().status, 'connect');
  f.login(); assert.equal(f.tracker.getSnapshot().status, 'waiting');
  f.set({ ChallengeProgress: [] }); assert.equal(f.tracker.getSnapshot().status, 'cached');
  assert.ok(f.tracker.getSnapshot().rows.every(item => item.count === 0));
});

test('validated catalog changes recompute progress and invalid updates preserve the current catalog', () => {
  const f = fixture(), next = projectEpithets(epithets());
  next.titles[0].target = 2;
  assert.equal(setTitleCatalog(next), true);
  assert.equal(row(f.tracker.getSnapshot(), 'Of The Sleeve').count, 2);
  assert.equal(row(f.tracker.getSnapshot(), 'Of The Sleeve').completed, true);
  assert.equal(setTitleCatalog({ schema: 1, titles: [] }), false);
  assert.equal(row(f.tracker.getSnapshot(), 'Of The Sleeve').target, 2);
  assert.equal(setTitleCatalog(structuredClone(next)), false);
  assert.equal(setTitleCatalog(epithets()), true);
});
