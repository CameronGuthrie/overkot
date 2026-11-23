'use strict';

const { EventEmitter } = require('node:events');
const { dateAt, dateNumber } = require('./calendarData');
const { profilePlayer } = require('./playerIdentity');
const DAY_MS = 86400000;
const PROFILE_REFRESH_MS = 15 * 60000, PROFILE_RETRY_MS = 60000;
const utcDate = value => new Date(value).toISOString().slice(0, 10);
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : null;

/** Profile time is cumulative seconds, separate from daily inventory allowances. */
function profilePlayedSeconds(profile, accountId) {
  if (!profilePlayer(profile, accountId)) return null;
  const seconds = profile.Stats?.TimePlayedSec;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= Number.MAX_SAFE_INTEGER ? seconds : null;
}

function nextEncounters(calendar, date, day) {
  const result = { tuvalkane: { date: null, days: null, status: 'unavailable' },
    zenith: { date: null, days: null, status: 'unavailable' } };
  if (!day?.inventoryReady || typeof day.lastDate !== 'string') return result;
  let days;
  try { days = Math.min(366, dateNumber(day.lastDate) - dateNumber(date)); } catch { return result; }
  const ancestors = calendar.getSettings?.().ancestors;
  if (Array.isArray(ancestors) && ancestors.some(row => row.name === 'Tuvalkane' && row.unlocked === false)) {
    result.tuvalkane.status = 'locked';
  }
  for (let offset = 1; offset <= days; offset++) {
    const next = calendar.getDay(dateAt(date, offset));
    const key = next.ancestor === 'Tuvalkane' ? 'tuvalkane' : next.ancestor === 'Zenith' ? 'zenith' : null;
    if (key && result[key].status === 'unavailable') result[key] = { date: next.date, days: offset, status: 'ready' };
    if (result.tuvalkane.status !== 'unavailable' && result.zenith.status === 'ready') break;
  }
  return result;
}

/** Remember triggers independently of window visibility, so focus loss cannot lose a brief. */
class DailyBriefSchedule {
  constructor(now = Date.now()) {
    this.date = utcDate(now); this.session = null; this.account = null; this.ready = false; this.pending = null;
  }
  observe({ session, live, enabled = true, autoLogin = true, autoReset = true, canShow = true, now = Date.now() }) {
    const date = utcDate(now), changedDay = date > this.date;
    // Moving the clock backward and returning to a seen day is not another reset.
    if (changedDay) this.date = date;
    if (!session) {
      this.session = null; this.account = null; this.ready = false; this.pending = null; return null;
    }
    const account = session.accountId ?? null;
    if (session !== this.session || account !== this.account) {
      this.session = session; this.account = account; this.ready = false; this.pending = null;
    }
    const firstLive = live && !this.ready;
    const alreadyReady = this.ready;
    if (live) this.ready = true;
    if (!enabled) { this.pending = null; return null; }
    if (firstLive && autoLogin) this.pending = { reason: 'login', date, session, account };
    // A paused account still crosses the reset boundary. Hold it until live again.
    if (changedDay && alreadyReady && autoReset) this.pending = { reason: 'reset', date, session, account };
    if (this.pending && (this.pending.session !== session || this.pending.account !== account || this.pending.date < date
      || this.pending.reason === 'login' && !autoLogin || this.pending.reason === 'reset' && !autoReset)) this.pending = null;
    if (!canShow || !live || !this.pending || this.pending.date !== date) return null;
    const reason = this.pending.reason; this.pending = null; return reason;
  }
}

class DailyBrief extends EventEmitter {
  constructor({ config, calendar, vendors, getSession, canShow = () => true, now = Date.now }) {
    super(); Object.assign(this, { config, calendar, vendors, getSession, canShow, now });
    this.schedule = new DailyBriefSchedule(now()); this.serialized = ''; this.snapshot = null;
    this.playtimeSession = null; this.playtimeAccount = null; this.playtimePending = null; this.nextProfileAt = 0;
    this.playtime = { seconds: null, status: 'connect', updatedAt: null };
  }
  refreshPlaytime(session, { force = false } = {}) {
    const account = session?.accountId || null;
    if (session !== this.playtimeSession || account !== this.playtimeAccount) {
      this.playtimeSession = session; this.playtimeAccount = account; this.playtimePending = null; this.nextProfileAt = 0;
      this.playtime = { seconds: null, status: session ? 'unavailable' : 'connect', updatedAt: null };
    }
    if (!session || !/^[a-f0-9]{24}$/i.test(account || '') || typeof session.api?.fetchProfile !== 'function'
      || session.getLastSuccessfulPollAt?.() === 0 || this.playtimePending
      || !force && this.now() < this.nextProfileAt) return this.playtimePending;
    const retry = this.nextProfileAt > 0 && this.playtime.status !== 'live';
    this.nextProfileAt = this.now() + PROFILE_RETRY_MS;
    if (this.playtime.seconds === null) this.playtime.status = 'waiting';
    const current = () => this.playtimeSession === session && this.playtimeAccount === account
      && this.getSession() === session && session.accountId === account && !session.isNonceExpired();
    const work = Promise.resolve().then(() => force || retry
      ? session.api.fetchProfile(account, { maxAgeMs: PROFILE_RETRY_MS })
      : session.api.fetchProfile(account)).then(profile => {
      if (!current()) return;
      const seconds = profilePlayedSeconds(profile, account);
      if (seconds === null) throw new Error('Profile time unavailable');
      const updatedAt = session.api.getProfileFetchedAt?.(account) ?? this.now();
      this.playtime = { seconds, status: 'live', updatedAt };
      this.nextProfileAt = updatedAt + PROFILE_REFRESH_MS;
    }).catch(() => {
      if (current()) {
        this.nextProfileAt = this.now() + PROFILE_RETRY_MS;
        this.playtime.status = this.playtime.seconds === null ? 'unavailable' : 'cached';
      }
    }).finally(() => {
      if (this.playtimePending === work) this.playtimePending = null;
      if (current()) this.update({ autoOpen: false });
    });
    this.playtimePending = work;
    return work;
  }
  update({ autoOpen = true } = {}) {
    const now = this.now(), date = utcDate(now), resetAt = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    const candidate = this.getSession(), session = candidate && !candidate.isNonceExpired() ? candidate : null;
    void this.refreshPlaytime(session);
    const rawInventory = session?.getRawInventory();
    const inventory = record(rawInventory) ? rawInventory : null;
    const status = !session ? 'connect' : !inventory ? 'waiting' : session.isInventoryCached() ? 'cached' : 'live';
    const savedAt = inventory ? session.getInventorySavedAt?.() ?? session.getLastSuccessfulPollAt?.() : null;
    const updatedAt = timestamp(savedAt);
    const currentDay = updatedAt !== null && utcDate(updatedAt) === date;
    const settings = { autoLogin: this.config.get('dailyAutoLogin', true) !== false,
      autoReset: this.config.get('dailyAutoReset', true) !== false };
    const values = currentDay ? inventory : null;
    const calendar = this.calendar.getDay(date);
    const next = { date, resetAt, status, updatedAt,
      allowanceStatus: !inventory ? status : !currentDay ? 'stale' : status,
      allowances: { affiliation: amount(values?.DailyAffiliation), trades: amount(values?.TradesRemaining) },
      playtime: { ...this.playtime }, calendar, upcoming: nextEncounters(this.calendar, date, calendar),
      vendors: this.vendors.getSnapshot(), settings };
    const serialized = JSON.stringify(next);
    this.snapshot = next;
    if (serialized !== this.serialized) { this.serialized = serialized; this.emit('changed', next); }
    if (autoOpen) {
      const reason = this.schedule.observe({ session, live: status === 'live',
        enabled: this.config.get('widgetVisibility', {}).daily === true,
        autoLogin: settings.autoLogin, autoReset: settings.autoReset, canShow: this.canShow(), now });
      if (reason) this.emit('open', reason);
    }
    return this.snapshot;
  }
  getSnapshot() { return this.update({ autoOpen: false }); }
  async refresh({ force = false } = {}) {
    const candidate = this.getSession(), session = candidate && !candidate.isNonceExpired() ? candidate : null;
    await Promise.allSettled([Promise.resolve().then(() => this.calendar.refresh()),
      Promise.resolve().then(() => this.vendors.refresh({ force })), this.refreshPlaytime(session, { force })]);
    return this.getSnapshot();
  }
}

module.exports = { DailyBrief, DailyBriefSchedule, utcDate, profilePlayedSeconds, nextEncounters };
