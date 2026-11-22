'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMasterySessionsModel, createMasteryHistoryStore, sanitizeHistory, MAX_HISTORY_BYTES } = require('../src/modules/masterySessions');

const hour = 3600000, start = 1000000;
const context = (updatedAt, overrides = {}) => ({ accountId: 'private-account-alpha', sessionEpoch: 1, status: 'live', updatedAt, now: updatedAt, ...overrides });
const mastery = (totalXP = 1000, overrides = {}) => ({ totalXP, equipmentXP: 500, currentRank: 2, computedRank: 2, rankSource: 'inventory-mastery', rankIsExact: true,
  scope: 'complete', historicalAvailable: true, progressionAvailable: true, masteryDataSource: 'catalog', dataVersion: 'a'.repeat(64), ...overrides });
const create = options => createMasterySessionsModel({ getMastery: value => value, ...options });

test('sessions track mastery gained, net, inventory-calculated rank increases and rate over observed time', () => {
  const model = create();
  let result = model.read(mastery(), context(start));
  assert.equal(result.current.gained, 0); assert.equal(result.current.perHour, null);
  result = model.read(mastery(1500, { currentRank: 3 }), context(start + hour));
  assert.equal(result.current.gained, 500); assert.equal(result.current.net, 500);
  assert.equal(result.current.perHour, 500); assert.equal(result.current.rankUps, 1);
  assert.equal(result.current.basis, 'total'); assert.equal(result.current.scope, 'complete');
  result = model.read(mastery(1200, { currentRank: 3 }), context(start + 2 * hour));
  assert.equal(result.current.gained, 500); assert.equal(result.current.net, 200); assert.equal(result.current.perHour, 100);
  assert.deepEqual(result.current.samples.map(sample => sample.xp), [0, 500, 200]);
  assert.doesNotMatch(JSON.stringify(result), /private-account|accountId|Nonce|[a-f0-9]{64}/);
});

test('cache never starts a session and disconnect/session change excludes offline gaps', () => {
  const model = create();
  assert.equal(model.read(mastery(), context(start, { status: 'cached' })).sessions.length, 0);
  model.read(mastery(), context(start));
  model.read(mastery(1500), context(start + hour));
  const closed = model.read(null, context(start + 10 * hour, { status: 'waiting' }));
  assert.equal(closed.current, null); assert.equal(closed.sessions[0].end, start + hour); assert.equal(closed.sessions[0].elapsedHours, 1);
  let result = model.read(mastery(5000), context(start + 20 * hour, { sessionEpoch: 2 }));
  assert.equal(result.current.gained, 0); assert.equal(result.sessions.length, 2);
  result = model.read(mastery(5200), context(start + 21 * hour, { sessionEpoch: 2 }));
  assert.equal(result.current.gained, 200); assert.equal(result.current.perHour, 200);
});

test('scope, XP basis, inventory rank availability and catalogue changes restart the baseline', () => {
  const model = create();
  model.read(mastery(), context(start)); model.read(mastery(1500), context(start + hour));
  let result = model.read(mastery(50000, { scope: 'known-discoveries' }), context(start + 2 * hour));
  assert.equal(result.current.gained, 0); assert.equal(result.sessions.filter(item => !item.isCurrent).length, 1);
  result = model.read(mastery(null, { equipmentXP: 600 }), context(start + 3 * hour));
  assert.equal(result.current.basis, 'equipment'); assert.equal(result.current.scope, 'equipment-only'); assert.equal(result.current.gained, 0);
  result = model.read(mastery(null, { equipmentXP: 700 }), context(start + 4 * hour)); assert.equal(result.current.gained, 100);
  result = model.read(mastery(null, { equipmentXP: 90000, dataVersion: 'b'.repeat(64) }), context(start + 5 * hour)); assert.equal(result.current.gained, 0);
  result = model.read(mastery(null, { equipmentXP: 91000, dataVersion: 'b'.repeat(64), currentRank: null }), context(start + 6 * hour));
  assert.equal(result.current.gained, 0); assert.equal(result.current.rankBasis, 'unavailable');
});

test('inventory mastery reaches rank 20 without a release ceiling and raw level changes never create rank-ups', () => {
  const model = create();
  model.read(mastery(472000, { currentRank: 19, PlayerLevel: 19, reportedRank: 19 }), context(start));
  let result = model.read(mastery(472000, { currentRank: 19, PlayerLevel: 21, reportedRank: 21 }), context(start + hour));
  assert.equal(result.current.rankFrom, 19); assert.equal(result.current.rankTo, 19);
  assert.equal(result.current.rankUps, 0); assert.equal(result.current.gained, 0);
  result = model.read(mastery(501000, { currentRank: 20, PlayerLevel: 1, reportedRank: 1 }), context(start + 2 * hour));
  assert.equal(result.current.rankFrom, 19); assert.equal(result.current.rankTo, 20);
  assert.equal(result.current.rankUps, 1); assert.equal(result.current.gained, 29000);
  assert.deepEqual(result.current.samples.map(sample => sample.rank), [19, 19, 20]);
  assert.equal(result.current.rankBasis, 'inventory');
});

test('reported and diagnostic ranks cannot replace an unavailable inventory rank', () => {
  const model = create();
  model.read(mastery(null, { equipmentXP: 1000, currentRank: null, reportedRank: 21, computedRank: 21 }), context(start));
  const result = model.read(mastery(null, { equipmentXP: 1500, currentRank: null, reportedRank: 30, computedRank: 30 }), context(start + hour));
  assert.equal(result.current.gained, 500); assert.equal(result.current.rankFrom, null);
  assert.equal(result.current.rankTo, null); assert.equal(result.current.rankUps, null);
  assert.equal(result.current.rankBasis, 'unavailable');
});

test('legacy reported or mixed-policy rank history keeps its XP but cannot present those old levels as inventory ER', () => {
  let saved;
  const old = create({ save: value => { saved = value; } });
  old.read(mastery(450000, { currentRank: 18 }), context(start));
  old.read(mastery(500000, { currentRank: 20 }), context(start + hour));
  for (const rankBasis of ['reported', 'calculated']) {
    const legacy = structuredClone(saved);
    const session = Object.values(legacy.accounts)[0].sessions[0];
    session.rankBasis = rankBasis; session.baselineRank = 19; session.lastRank = 21; session.rankUps = 2;
    session.samples[0].rank = 19; session.samples[1].rank = 21;
    const migrated = Object.values(sanitizeHistory(legacy).accounts)[0].sessions[0];
    assert.equal(migrated.baselineRank, null); assert.equal(migrated.lastRank, null); assert.equal(migrated.rankUps, null);
    assert.ok(migrated.samples.every(sample => sample.rank === null));
    const restored = create({ load: () => legacy });
    const result = restored.read(mastery(501000, { currentRank: 20 }), context(start + 2 * hour));
    const history = result.sessions.find(item => !item.isCurrent);
    assert.equal(history.gained, 50000); assert.equal(history.net, 50000);
    assert.equal(history.rankFrom, null); assert.equal(history.rankTo, null); assert.equal(history.rankUps, null);
    assert.ok(history.samples.every(sample => sample.rank === null));
    assert.equal(result.current.rankFrom, 20); assert.equal(result.current.rankUps, 0);
  }
});

test('account history is internally hashed, isolated in projections and restored as completed observations', () => {
  let stored;
  const model = create({ save: value => { stored = value; } });
  model.read(mastery(), context(start)); model.read(mastery(1400), context(start + hour));
  assert.equal(Object.keys(stored.accounts).length, 1); assert.match(Object.keys(stored.accounts)[0], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(stored), /private-account-alpha/);
  let result = model.read(mastery(9999), context(start + 2 * hour, { accountId: 'private-account-beta' }));
  assert.equal(result.sessions.length, 1); assert.equal(result.current.gained, 0);
  result = model.read(null, context(start + 3 * hour, { accountId: null, status: 'connect' })); assert.equal(result.sessions.length, 0);
  const restored = create({ load: () => stored });
  result = restored.read(mastery(80000), context(start + 10 * hour));
  assert.equal(result.sessions.filter(item => !item.isCurrent).length, 1); assert.equal(result.current.gained, 0);
});

test('missing historical totals stop observations; stale/duplicate snapshots do not roll back rates or add gains', () => {
  const model = create();
  model.read(mastery(), context(start)); model.read(mastery(2000), context(start + hour));
  let result = model.read(mastery(90000), context(start + hour)); assert.equal(result.current.gained, 1000);
  result = model.read(mastery(2), context(start + 10)); assert.equal(result.current.net, 1000);
  result = model.read(mastery(90000, { historicalAvailable: false }), context(start + 2 * hour));
  assert.equal(result.current, null); assert.equal(result.unavailable, true);
  result = model.read(mastery(95000), context(start + 3 * hour)); assert.equal(result.current.gained, 0);
});

test('bounded samples preserve original baseline and cumulative gains', () => {
  const model = create();
  for (let index = 0; index < 200; index++) model.read(mastery(1000 + index * 10), context(start + index * 1000));
  const result = model.read(mastery(2990), context(start + 199000));
  assert.equal(result.current.samples.length, 120); assert.equal(result.current.samples[0].at, start);
  assert.equal(result.current.samples.at(-1).xp, 1990); assert.equal(result.current.gained, 1990); assert.equal(result.current.net, 1990);
});

test('history keeps at most100 sessions across accounts and drops baseline-only connections', () => {
  let stored;
  const model = create({ save: value => { stored = value; } });
  for (let index = 0; index < 105; index++) {
    model.read(mastery(), context(start + index * 10000, { sessionEpoch: index }));
    model.read(mastery(1100), context(start + index * 10000 + 1000, { sessionEpoch: index }));
  }
  assert.equal(Object.values(stored.accounts).reduce((sum, account) => sum + account.sessions.length, 0), 100);
  const empty = create(); empty.read(mastery(), context(start));
  assert.equal(empty.read(null, context(start + 1000, { status: 'cached' })).sessions.length, 0);
});

test('failed persistence is visible and next observed sample retries saving', () => {
  let fail = true;
  const model = create({ save: () => { if (fail) throw new Error('read only'); } });
  assert.equal(model.read(mastery(), context(start)).persistenceError, true);
  fail = false; assert.equal(model.read(mastery(1100), context(start + 1000)).persistenceError, false);
});

test('private history store encrypts, atomically replaces and bounds file reads', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-mastery-history-')), filename = path.join(directory, 'history.json');
  try {
    const store = createMasteryHistoryStore({ filename }); let history;
    const model = create({ save: value => { history = value; } });
    model.read(mastery(), context(start)); model.read(mastery(1500), context(start + hour));
    store.save(history);
    assert.notEqual(fs.readFileSync(filename).subarray(0, 1).toString(), '{');
    assert.equal(JSON.stringify(store.load()), JSON.stringify(sanitizeHistory(history)));
    store.save(history); assert.deepEqual(fs.readdirSync(directory), ['history.json']);
    fs.writeFileSync(filename, Buffer.alloc(MAX_HISTORY_BYTES + 1)); assert.throws(() => store.load(), /size limit/);
    fs.writeFileSync(filename, 'broken'); assert.equal(store.load(), null);
  } finally { if (fs.existsSync(filename)) fs.unlinkSync(filename); fs.rmdirSync(directory); }
});

test('equipment-only XP history with unavailable ranks survives the encrypted store and reopening', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-mastery-history-')), filename = path.join(directory, 'history.json');
  try {
    const store = createMasteryHistoryStore({ filename });
    const model = create({ save: value => store.save(value) });
    model.read(mastery(null, { equipmentXP: 1000, currentRank: null }), context(start));
    model.read(mastery(null, { equipmentXP: 1500, currentRank: null }), context(start + hour));
    const stored = store.load(), session = Object.values(stored.accounts)[0].sessions[0];
    assert.equal(session.baselineRank, null); assert.equal(session.lastRank, null); assert.equal(session.rankUps, null);
    assert.deepEqual(session.samples.map(sample => sample.rank), [null, null]);
    const restored = create({ load: () => stored });
    const result = restored.read(mastery(null, { equipmentXP: 1600, currentRank: null }), context(start + 2 * hour));
    const history = result.sessions.find(item => !item.isCurrent);
    assert.equal(history.gained, 500); assert.equal(history.rankFrom, null); assert.equal(history.rankUps, null);
  } finally { if (fs.existsSync(filename)) fs.unlinkSync(filename); fs.rmdirSync(directory); }
});

test('malformed persisted history cannot create events or project another identity', () => {
  assert.deepEqual(sanitizeHistory({ schema: 1, accounts: { 'not-a-hash': { sessions: [{}] } } }), { schema: 1, accounts: {} });
  const model = create({ load: () => ({ schema: 1, accounts: { ['a'.repeat(64)]: { sessions: [{ baselineXP: -1 }] } } }) });
  assert.equal(model.read(mastery(), context(start)).current.gained, 0);
});
