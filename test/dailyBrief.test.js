'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DailyBrief, DailyBriefSchedule, utcDate, profilePlayedSeconds, nextEncounters } = require('../src/modules/dailyBrief');
const day = Date.UTC(2026, 10, 11), DAY = 86400000;
const turn = () => new Promise(resolve => setImmediate(resolve));
const publicProfile = (accountId, seconds) => ({ Results: [{ AccountId: { $oid: accountId }, DisplayName: 'Private Envoy' }],
  Stats: { TimePlayedSec: seconds, OtherPrivateStat: 'private' } });

function scheduleFixture(now = day + 12 * 3600000) {
  const schedule = new DailyBriefSchedule(now);
  const session = { accountId: 'fixture-account' };
  const state = { session, live: false, now };
  return { schedule, session, state, observe(patch = {}) { Object.assign(state, patch); return schedule.observe(state); } };
}

test('only the first live-ready observation of each login opens, never cached inventory or repeated polls', () => {
  const f = scheduleFixture();
  assert.equal(f.observe(), null); assert.equal(f.observe(), null);
  assert.equal(f.observe({ live: true }), 'login');
  assert.equal(f.observe(), null); assert.equal(f.observe({ live: false }), null); assert.equal(f.observe({ live: true }), null);
});

test('disabled widgets and automatic preferences suppress triggers without replaying past logins', () => {
  const f = scheduleFixture();
  assert.equal(f.observe({ live: true, enabled: false }), null);
  assert.equal(f.observe({ enabled: true }), null);
  assert.equal(f.observe({ now: day + DAY, autoReset: false }), null);
  assert.equal(f.observe({ autoReset: true }), null);
  const noLogin = scheduleFixture();
  assert.equal(noLogin.observe({ live: true, autoLogin: false }), null);
  assert.equal(noLogin.observe({ autoLogin: true }), null);
  assert.equal(noLogin.observe({ now: day + DAY }), 'reset');
});

test('hidden triggers remain pending until visible, but opt-out and logout cancel them', () => {
  const f = scheduleFixture();
  assert.equal(f.observe({ live: true, canShow: false }), null);
  assert.equal(f.observe(), null); assert.equal(f.observe({ canShow: true }), 'login');
  assert.equal(f.observe({ now: day + DAY, canShow: false }), null);
  assert.equal(f.observe({ autoReset: false, canShow: true }), null);
  const pending = scheduleFixture(); pending.observe({ live: true, canShow: false });
  assert.equal(pending.observe({ session: null, live: false }), null);
  assert.equal(pending.schedule.pending, null);
  assert.equal(pending.observe({ session: pending.session, live: true, canShow: true }), 'login');
});

test('UTC reset and wake after skipped days open once for the latest day', () => {
  const f = scheduleFixture(day + DAY - 1000);
  assert.equal(f.observe({ live: true }), 'login');
  assert.equal(f.observe({ now: day + DAY }), 'reset');
  assert.equal(f.observe({ now: day + DAY + 1 }), null);
  assert.equal(f.observe({ now: day + 5 * DAY }), 'reset');
  assert.equal(f.observe(), null);
});

test('clock rollback and returning to a seen UTC day do not replay daily reset', () => {
  const f = scheduleFixture(); f.observe({ live: true });
  assert.equal(f.observe({ now: day + DAY }), 'reset');
  assert.equal(f.observe({ now: day }), null);
  assert.equal(f.observe({ now: day + DAY }), null);
  assert.equal(f.observe({ now: day + 2 * DAY }), 'reset');
  f.observe({ now: day + 3 * DAY, canShow: false });
  assert.equal(f.observe({ now: day + 2 * DAY, canShow: true }), null, 'a pending future date waits for the clock');
  assert.equal(f.observe({ now: day + 3 * DAY }), 'reset');
});

test('cached rollover is held for an established session until live, while a new session still gets login', () => {
  const f = scheduleFixture(); f.observe({ live: true });
  assert.equal(f.observe({ now: day + DAY, live: false }), null);
  assert.equal(f.observe(), null);
  assert.equal(f.observe({ live: true }), 'reset');
  assert.equal(f.observe(), null);
  const cachedFirst = scheduleFixture(); cachedFirst.observe();
  assert.equal(cachedFirst.observe({ now: day + DAY }), null);
  assert.equal(cachedFirst.observe({ live: true }), 'login');
});

test('poller or account changes discard the old pending event and require a live snapshot', () => {
  const f = scheduleFixture(); f.observe({ live: true, canShow: false });
  const replacement = { accountId: 'other-account' };
  assert.equal(f.observe({ session: replacement, live: false, canShow: true }), null);
  assert.equal(f.schedule.pending, null); assert.equal(f.observe({ live: true }), 'login');
  replacement.accountId = 'third-account';
  assert.equal(f.observe({ live: false }), null); assert.equal(f.observe({ live: true }), 'login');
  assert.equal(f.observe({ session: { accountId: replacement.accountId } }), 'login', 'another poller represents another login');
});

function serviceFixture() {
  let now = day + 12 * 3600000, raw = null, savedAt = now, cached = true, expired = false, visible = true;
  const values = { widgetVisibility: { daily: true }, dailyAutoLogin: true, dailyAutoReset: true };
  const session = { accountId: 'fixture-account', isNonceExpired: () => expired, isInventoryCached: () => cached,
    getRawInventory: () => raw, getInventorySavedAt: () => savedAt };
  let active = session;
  const calendarCalls = [], opens = [], changes = [];
  const calendar = { getDay(date) { calendarCalls.push(date); return { date, ancestor: 'Fixture ancestor', offers: [] }; }, refresh: async () => {} };
  const vendors = { getSnapshot: () => ({ status: 'ready', avakot: [], factions: [] }), refresh: async () => {} };
  const service = new DailyBrief({ config: { get: (key, fallback) => values[key] ?? fallback }, calendar, vendors,
    getSession: () => active, canShow: () => visible, now: () => now });
  service.on('open', reason => opens.push(reason)); service.on('changed', snapshot => changes.push(snapshot));
  return { service, session, values, calendar, vendors, opens, changes, calendarCalls,
    set(patch) {
      if ('now' in patch) now = patch.now;
      if ('raw' in patch) raw = patch.raw;
      if ('savedAt' in patch) savedAt = patch.savedAt;
      if ('cached' in patch) cached = patch.cached;
      if ('expired' in patch) expired = patch.expired;
      if ('visible' in patch) visible = patch.visible;
      if ('active' in patch) active = patch.active;
    } };
}

test('snapshot reads and explicit refresh never auto-open; normal updates open once after cache becomes live', async () => {
  const f = serviceFixture();
  f.set({ raw: { DailyAffiliation: 14000, DailyAffiliationOde: 5000, TradesRemaining: 3 } });
  assert.equal(f.service.getSnapshot().status, 'cached'); f.service.update(); assert.deepEqual(f.opens, []);
  f.set({ cached: false });
  assert.equal(f.service.getSnapshot().status, 'live'); assert.deepEqual(f.opens, []);
  await f.service.refresh(); assert.deepEqual(f.opens, []);
  f.service.update(); f.service.update(); assert.deepEqual(f.opens, ['login']);
  const count = f.changes.length; f.service.getSnapshot(); assert.equal(f.changes.length, count, 'unchanged snapshots do not rebroadcast');
});

test('allowances use exact reported remaining values without deriving a cap or treating missing as zero', () => {
  const f = serviceFixture(); f.set({ cached: false, raw: { DailyAffiliation: 25000, DailyAffiliationOde: 0, TradesRemaining: 0, Nonce: 'private' } });
  let snapshot = f.service.getSnapshot();
  assert.deepEqual(snapshot.allowances, { affiliation: 25000, trades: 0 });
  assert.equal(Object.hasOwn(snapshot.allowances, 'ode'), false);
  assert.equal(Object.hasOwn(snapshot.allowances, 'maximum'), false);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  f.set({ raw: { DailyAffiliation: -1, DailyAffiliationOde: '200', TradesRemaining: Infinity } });
  snapshot = f.service.getSnapshot(); assert.deepEqual(snapshot.allowances, { affiliation: null, trades: null });
});

test('total played time reads only the requested account’s exact profile seconds', () => {
  const account = 'a'.repeat(24);
  assert.equal(profilePlayedSeconds(publicProfile(account, 1605154.4256579936), account), 1605154.4256579936);
  assert.equal(profilePlayedSeconds(publicProfile(account, 0), account), 0);
  assert.equal(profilePlayedSeconds(publicProfile(account.toUpperCase(), 12), account), 12);
  for (const value of [null, undefined, -1, Infinity, NaN, '600', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(profilePlayedSeconds(publicProfile(account, value), account), null);
  }
  assert.equal(profilePlayedSeconds(publicProfile('b'.repeat(24), 600), account), null);
  assert.equal(profilePlayedSeconds({ Results: [], Stats: { TimePlayedSec: 600 } }, account), null);
  assert.equal(profilePlayedSeconds({ Results: [{ AccountId: account }], TimePlayedSec: 600 }, account), null);
});

test('profile requests deduplicate, refresh on a bounded cadence and expose no profile identity or nonce', async () => {
  const f = serviceFixture(), requests = [];
  f.session.accountId = 'a'.repeat(24); f.session.nonce = 'private-session';
  let seconds = 7500.25, fail = false;
  f.session.api = { async fetchProfile(...args) { requests.push(args); if (fail) return null; return publicProfile(args[0], seconds); } };
  f.set({ raw: { DailyAffiliation: 3, TimePlayedSec: 999999, DailyAffiliationOde: 999 }, cached: false });
  f.service.getSnapshot(); f.service.getSnapshot();
  await f.service.refresh();
  assert.deepEqual(requests, [[f.session.accountId]], 'Only the public player ID is sent, never inventory credentials');
  let value = f.service.getSnapshot();
  assert.deepEqual(value.playtime, { seconds: 7500.25, status: 'live', updatedAt: day + 12 * 3600000 });
  assert.equal(JSON.stringify(value).includes('private-session'), false);
  assert.equal(JSON.stringify(value).includes('Private Envoy'), false);
  assert.equal(JSON.stringify(value).includes('OtherPrivateStat'), false);
  f.set({ now: day + 12 * 3600000 + 14 * 60000 }); f.service.update(); await turn();
  assert.equal(requests.length, 1);
  fail = true; f.set({ now: day + 12 * 3600000 + 15 * 60000 }); await f.service.refresh();
  value = f.service.getSnapshot(); assert.equal(requests.length, 2);
  assert.equal(value.playtime.seconds, 7500.25); assert.equal(value.playtime.status, 'cached');
  f.service.update(); await turn(); assert.equal(requests.length, 2, 'Failures cannot trigger per-tick requests');
  fail = false; seconds = 8000; await f.service.refresh({ force: true });
  assert.equal(requests.length, 3); assert.equal(f.service.getSnapshot().playtime.seconds, 8000);
  f.set({ now: day + DAY, savedAt: day });
  assert.equal(f.service.getSnapshot().playtime.seconds, 8000, 'Cumulative playtime is not a daily-reset allowance');
});

test('late profile results from a replaced account or disconnected session never fill another brief', async () => {
  const f = serviceFixture(), pending = [];
  f.session.accountId = 'a'.repeat(24);
  const api = { fetchProfile: account => new Promise(resolve => pending.push({ account, resolve })) };
  f.session.api = api; f.service.getSnapshot(); await turn();
  const replacement = { ...f.session, accountId: 'b'.repeat(24), api };
  f.set({ active: replacement }); f.service.getSnapshot(); await turn();
  assert.equal(pending.length, 2);
  pending[0].resolve(publicProfile(pending[0].account, 777)); await turn();
  assert.equal(f.service.getSnapshot().playtime.seconds, null);
  pending[1].resolve(publicProfile(pending[1].account, 888)); await turn();
  assert.equal(f.service.getSnapshot().playtime.seconds, 888);
  f.set({ active: null });
  assert.deepEqual(f.service.getSnapshot().playtime, { seconds: null, status: 'connect', updatedAt: null });
});

test('upcoming encounters use future UTC calendar entries with locked and missing schedules distinguished', () => {
  const date = utcDate(day), calls = [];
  const calendar = { getSettings: () => ({ ancestors: [{ name: 'Tuvalkane', unlocked: true }] }),
    getDay(date) { calls.push(date); return { date, ancestor: date === utcDate(day + DAY) ? 'Tuvalkane'
      : date === utcDate(day + 3 * DAY) ? 'Zenith' : 'Bromius' }; } };
  const current = { ancestor: 'Zenith', inventoryReady: true, lastDate: utcDate(day + 20 * DAY) };
  assert.deepEqual(nextEncounters(calendar, date, current), {
    tuvalkane: { date: '2026-11-12', days: 1, status: 'ready' }, zenith: { date: '2026-11-14', days: 3, status: 'ready' } });
  assert.equal(calls.includes(date), false, 'Today is not presented as the next encounter');
  assert.equal(calls.length, 3);
  calendar.getSettings = () => ({ ancestors: [{ name: 'Tuvalkane', unlocked: false }] });
  assert.equal(nextEncounters(calendar, date, current).tuvalkane.status, 'locked');
  assert.equal(nextEncounters(calendar, date, { ...current, inventoryReady: false }).zenith.status, 'unavailable');
  calls.length = 0; calendar.getDay = date => { calls.push(date); return { date, ancestor: 'Bromius' }; };
  const missing = nextEncounters(calendar, date, { ...current, lastDate: utcDate(day + 700 * DAY) });
  assert.equal(missing.zenith.status, 'unavailable'); assert.equal(calls.length, 366, 'Lookahead is bounded by one year');
});

test('yesterday and unavailable timestamps withhold allowances at rollover while calendar advances', () => {
  const f = serviceFixture(); f.set({ cached: false, raw: { DailyAffiliation: 9000, TradesRemaining: 4 } });
  f.service.update(); f.set({ now: day + DAY });
  let snapshot = f.service.update();
  assert.equal(snapshot.date, '2026-11-12'); assert.equal(snapshot.calendar.date, '2026-11-12');
  assert.equal(snapshot.allowanceStatus, 'stale'); assert.deepEqual(snapshot.allowances, { affiliation: null, trades: null });
  assert.equal(snapshot.resetAt, day + 2 * DAY); assert.deepEqual(f.opens, ['login', 'reset']);
  f.set({ savedAt: day + DAY + 1000 }); snapshot = f.service.getSnapshot(); assert.equal(snapshot.allowances.trades, 4);
  for (const savedAt of [null, NaN, -1, 1e20]) {
    f.set({ savedAt }); snapshot = f.service.getSnapshot(); assert.equal(snapshot.updatedAt, null); assert.equal(snapshot.allowanceStatus, 'stale');
  }
});

test('waiting, malformed inventory and expired/logged-out sessions cannot open a live brief', () => {
  const f = serviceFixture();
  assert.equal(f.service.update().status, 'waiting');
  f.set({ raw: [], cached: false }); assert.equal(f.service.update().status, 'waiting');
  f.set({ raw: { TradesRemaining: 1 }, expired: true }); assert.equal(f.service.update().status, 'connect');
  f.set({ expired: false, active: null }); assert.equal(f.service.update().status, 'connect');
  assert.deepEqual(f.opens, []);
  f.set({ active: f.session }); assert.equal(f.service.update().status, 'live'); assert.deepEqual(f.opens, ['login']);
});

test('service preserves hidden pending login, honors opt-out, and clears logout before reconnect', () => {
  const f = serviceFixture(); f.set({ cached: false, raw: { TradesRemaining: 2 }, visible: false });
  f.service.update(); assert.deepEqual(f.opens, []);
  f.set({ visible: true }); f.service.update(); assert.deepEqual(f.opens, ['login']);
  f.set({ now: day + DAY }); f.values.dailyAutoReset = false; f.service.update(); assert.deepEqual(f.opens, ['login']);
  f.set({ active: null }); f.service.update();
  f.values.widgetVisibility.daily = false; f.set({ active: f.session }); f.service.update();
  f.values.widgetVisibility.daily = true; f.service.update(); assert.deepEqual(f.opens, ['login']);
});

test('refresh settles both synchronous and asynchronous feed failures and keeps a usable snapshot', async () => {
  const f = serviceFixture(); let vendorRefreshes = 0;
  f.calendar.refresh = () => { throw new Error('calendar offline'); };
  f.vendors.refresh = async () => { vendorRefreshes++; throw new Error('vendor offline'); };
  const snapshot = await f.service.refresh(); assert.equal(snapshot.date, '2026-11-11'); assert.equal(vendorRefreshes, 1);
  assert.deepEqual(f.opens, []); assert.equal(utcDate(day), '2026-11-11');
});
