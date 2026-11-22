'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { readEncryptedJSON, writeEncryptedJSON } = require('./fileEncryption');
const MAX_SESSIONS = 100, MAX_SAMPLES = 120;
const MAX_HISTORY_BYTES = 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const xp = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
const rank = value => Number.isInteger(value) && value >= 0 && value <= 65535;
const nullableRank = value => value === null || rank(value);
const time = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const scopeName = value => ['complete', 'known-discoveries', 'equipment-only'].includes(value) ? value : 'equipment-only';
const hashAccount = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 ? createHash('sha256').update(value).digest('hex') : null;

function sanitizeHistory(value) {
  const history = { schema: 1, accounts: {} }, all = [];
  if (!plain(value) || value.schema !== 1 || !plain(value.accounts)) return history;
  for (const [account, entry] of Object.entries(value.accounts).slice(0, 100)) {
    if (!/^[a-f0-9]{64}$/.test(account) || !Array.isArray(entry?.sessions)) continue;
    for (const item of entry.sessions.slice(-MAX_SESSIONS)) {
      if (!plain(item) || !time(item.start) || !time(item.end) || item.end < item.start
        || !xp(item.baselineXP) || !xp(item.lastXP) || !xp(item.gained) || item.gained < Math.max(0, item.lastXP - item.baselineXP)
        || !nullableRank(item.baselineRank) || !nullableRank(item.lastRank)
        || !(item.rankUps === null || Number.isSafeInteger(item.rankUps) && item.rankUps >= 0 && item.rankUps <= 1e7)
        || !['total', 'equipment'].includes(item.basis) || !Array.isArray(item.samples) || !item.samples.length) continue;
      const samples = item.samples.slice(-MAX_SAMPLES).filter(sample => plain(sample) && time(sample.at) && xp(sample.xp) && nullableRank(sample.rank));
      if (samples.length < 2 || samples.length !== Math.min(MAX_SAMPLES, item.samples.length) || samples.some((sample, index) => sample.at < item.start || sample.at > item.end || index && sample.at <= samples[index - 1].at)) continue;
      if (samples[0].at !== item.start || samples[0].xp !== item.baselineXP || samples[0].rank !== item.baselineRank) continue;
      if (samples.at(-1).at !== item.end || samples.at(-1).xp !== item.lastXP) continue;
      const inventoryRanks = item.rankBasis === 'inventory' && rank(item.baselineRank) && rank(item.lastRank)
        && Number.isSafeInteger(item.rankUps) && samples.every(sample => rank(sample.rank));
      all.push({ account, item: { start: item.start, end: item.end, baselineXP: item.baselineXP, lastXP: item.lastXP,
        baselineRank: inventoryRanks ? item.baselineRank : null, lastRank: inventoryRanks ? item.lastRank : null,
        gained: item.gained, rankUps: inventoryRanks ? item.rankUps : null,
        basis: item.basis, scope: scopeName(item.scope), rankBasis: inventoryRanks ? 'inventory' : 'unavailable',
        source: item.source === 'catalog' ? 'catalog' : 'reference',
        dataVersion: typeof item.dataVersion === 'string' ? item.dataVersion.slice(0, 128) : '',
        samples: samples.map(sample => ({ at: sample.at, xp: sample.xp, rank: inventoryRanks ? sample.rank : null })), closed: true } });
    }
  }
  all.sort((a, b) => b.item.end - a.item.end);
  for (const { account, item } of all.slice(0, MAX_SESSIONS).reverse()) {
    if (!history.accounts[account]) history.accounts[account] = { sessions: [] };
    history.accounts[account].sessions.push(item);
  }
  return history;
}

function masterySample(snapshot) {
  if (!plain(snapshot) || snapshot.historicalAvailable === false) return null;
  const basis = xp(snapshot.totalXP) ? 'total' : xp(snapshot.equipmentXP) ? 'equipment' : null;
  if (!basis) return null;
  const value = basis === 'total' ? snapshot.totalXP : snapshot.equipmentXP;
  const currentRank = snapshot.rankSource === 'inventory-mastery' && rank(snapshot.currentRank) ? snapshot.currentRank : null;
  const scope = basis === 'equipment' ? 'equipment-only' : scopeName(snapshot.scope);
  const source = snapshot.masteryDataSource === 'catalog' ? 'catalog' : 'reference';
  const dataVersion = typeof snapshot.dataVersion === 'string' ? snapshot.dataVersion.slice(0, 128) : '';
  const rankBasis = currentRank === null ? 'unavailable' : 'inventory';
  // A partial historical section changing shape must start a fresh comparison.
  const signature = JSON.stringify([basis, scope, source, dataVersion, rankBasis, 'inventory-mastery-v1', snapshot.rankIsExact === true, snapshot.progressionAvailable === true,
    snapshot.unreadableRecords || 0, snapshot.summary?.estimated || 0, snapshot.summary?.ownedFallbacks || 0]);
  return { value, currentRank, basis, scope, source, dataVersion, rankBasis, signature };
}

function createMasterySessionsModel({ getMastery = () => null, load = () => null, save = () => {} } = {}) {
  let loaded, storageError = false, wallNow = Date.now();
  try { loaded = load(); } catch { loaded = null; storageError = true; }
  let history = sanitizeHistory(loaded), account = null, epoch = null, active = null, signature = null;

  function prune() {
    const all = Object.entries(history.accounts).flatMap(([key, value]) => value.sessions.map(item => ({ key, item })));
    all.sort((a, b) => b.item.end - a.item.end);
    const kept = new Set(all.slice(0, MAX_SESSIONS).map(row => row.item));
    for (const [key, value] of Object.entries(history.accounts)) {
      value.sessions = value.sessions.filter(item => kept.has(item));
      if (!value.sessions.length) delete history.accounts[key];
    }
  }
  function persist() {
    prune();
    try { save(JSON.parse(JSON.stringify(history))); storageError = false; } catch { storageError = true; }
  }
  function close() {
    if (!active) return false;
    active.closed = true;
    // A single baseline carries no observed interval, so it is not a historical session.
    if (active.samples.length < 2 && account && history.accounts[account]) {
      history.accounts[account].sessions = history.accounts[account].sessions.filter(item => item !== active);
    }
    active = null; signature = null; return true;
  }
  function project(status, unavailable = false) {
    const sessions = (account ? history.accounts[account]?.sessions || [] : []).map(item => {
      const elapsedHours = Math.max(0, item.end - item.start) / 3600000, net = item.lastXP - item.baselineXP;
      // Older history combined reported levels with calculated ranks. Keep
      // its observed XP, but do not present those old levels as inventory ER.
      const inventoryRanks = item.rankBasis === 'inventory';
      const samples = item.samples.map(sample => ({ at: sample.at, xp: sample.xp - item.baselineXP,
        rank: inventoryRanks ? sample.rank : null }));
      return { start: item.start, end: item.end, isCurrent: item === active, basis: item.basis, scope: item.scope, rankBasis: item.rankBasis,
        gained: item.gained, net, rankUps: inventoryRanks ? item.rankUps : null,
        rankFrom: inventoryRanks ? item.baselineRank : null, rankTo: inventoryRanks ? item.lastRank : null,
        elapsedHours, perHour: elapsedHours > 0 ? net / elapsedHours : null,
        samples };
    }).sort((a, b) => b.end - a.end);
    return { sessions, current: sessions.find(item => item.isCurrent) || null, tracking: !!active && status === 'live',
      storageError, persistenceError: storageError, unavailable, now: wallNow };
  }

  return { read(inventory, context = {}) {
    wallNow = time(context.now) ? context.now : Date.now();
    const nextAccount = hashAccount(context.accountId), changed = nextAccount !== account || context.sessionEpoch !== epoch;
    let dirty = false;
    if (changed) { dirty = close() || dirty; account = nextAccount; epoch = context.sessionEpoch; }
    if (context.status !== 'live' || !account || !plain(inventory)) {
      dirty = close() || dirty; if (dirty) persist(); return project(context.status);
    }
    let snapshot;
    try { snapshot = masterySample(getMastery(inventory, context)); } catch { snapshot = null; }
    if (!snapshot) { dirty = close() || dirty; if (dirty) persist(); return project(context.status, true); }
    const at = time(context.updatedAt) ? context.updatedAt : time(context.now) ? context.now : Date.now();
    if (active && signature !== snapshot.signature) dirty = close() || dirty;
    if (!active) {
      active = { start: at, end: at, basis: snapshot.basis, scope: snapshot.scope, source: snapshot.source,
        dataVersion: snapshot.dataVersion, rankBasis: snapshot.rankBasis, baselineXP: snapshot.value, lastXP: snapshot.value,
        baselineRank: snapshot.currentRank, lastRank: snapshot.currentRank, gained: 0, rankUps: snapshot.currentRank === null ? null : 0,
        closed: false, samples: [{ at, xp: snapshot.value, rank: snapshot.currentRank }] };
      signature = snapshot.signature;
      if (!history.accounts[account]) history.accounts[account] = { sessions: [] };
      history.accounts[account].sessions.push(active); dirty = true;
    } else if (at > active.end) {
      active.gained += Math.max(0, snapshot.value - active.lastXP);
      if (snapshot.currentRank !== null && active.lastRank !== null) active.rankUps += Math.max(0, snapshot.currentRank - active.lastRank);
      active.lastXP = snapshot.value; active.lastRank = snapshot.currentRank; active.end = at;
      active.samples.push({ at, xp: snapshot.value, rank: snapshot.currentRank });
      // Keep the original baseline plus the latest observations; cumulative metrics are retained separately.
      if (active.samples.length > MAX_SAMPLES) active.samples.splice(1, active.samples.length - MAX_SAMPLES);
      dirty = true;
    }
    if (dirty) persist();
    return project(context.status);
  } };
}

/** Private atomic encrypted cache; its contents never enter the broadcast preference object. */
function createMasteryHistoryStore({ filename } = {}) {
  if (typeof filename !== 'string' || !filename.trim()) throw new Error('A mastery history filename is required');
  const target = path.resolve(filename);
  return { load() {
    if (!fs.existsSync(target)) return null;
    if (fs.statSync(target).size > MAX_HISTORY_BYTES) throw new Error('Mastery session history exceeds its size limit');
    return readEncryptedJSON(target);
  }, save(history) {
    const sanitized = sanitizeHistory(history);
    if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_HISTORY_BYTES - 28) throw new Error('Mastery session history exceeds its size limit');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try { writeEncryptedJSON(temporary, sanitized); fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  } };
}

module.exports = { createMasterySessionsModel, createMasteryHistoryStore, sanitizeHistory, masterySample, MAX_SESSIONS, MAX_SAMPLES, MAX_HISTORY_BYTES };
