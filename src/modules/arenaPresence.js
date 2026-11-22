'use strict';

const ARENA_ROOM = 'UnderCityArena';
// The Glades reuses UnderCityArena.lua in a differently named room. Tile image
// numbers are export-order details; match the exact decoded room in its set.
const ARENA_ROOMS = Object.freeze({ underCityMidrath: ARENA_ROOM, gladesofAndurin: 'GoAxDeadendGarrenRood' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const field = value => typeof value === 'string' ? value : null;

function instanceId(state) {
  return JSON.stringify([state?.active === true, field(state?.status), field(state?.key),
    field(state?.levelPath), field(state?.layoutCode), field(state?.instanceId)]);
}

function readyState(state) {
  return state?.active === true && state.status === 'ready'
    && typeof state.key === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(state.key)
    && typeof state.levelPath === 'string' && /^\/?SF\/Levels\/Procs\/[A-Za-z0-9_/-]{1,512}$/.test(state.levelPath)
    && !state.levelPath.split('/').some(part => part === '.' || part === '..')
    && typeof state.layoutCode === 'string' && /^[A-Za-z0-9+\-]{1,16384}$/.test(state.layoutCode);
}

/** Keep the log watcher informed by the current instance's decoded room list. */
class ArenaPresence {
  constructor({ arenaWatcher, dungeonMap, getState, getVersion = () => '', retryMs = 10000, now = Date.now }) {
    Object.assign(this, { arenaWatcher, dungeonMap, getState, getVersion, now });
    this.retryMs = Number.isFinite(retryMs) && retryMs >= 0 ? retryMs : 10000;
    this.epoch = 0; this.scope = null; this.version = null;
    this.pending = null; this.lastResult = null; this.ready = false; this.retryAt = 0;
    this.interval = null; this.stopped = false;
  }

  _version() {
    try { return String(this.getVersion() ?? ''); } catch { return ''; }
  }

  _state() {
    try { return this.getState(); } catch { return { status: 'unknown', active: false }; }
  }

  _current(scope, epoch) {
    if (this.stopped || epoch !== this.epoch || scope !== this.scope) return false;
    return instanceId(this._state()) === scope;
  }

  update(state = this._state()) {
    if (this.stopped) return Promise.resolve(null);
    const captured = plain(state) ? { ...state } : { status: 'unknown', active: false };
    // Location invalidation happens synchronously, before any metadata request.
    this.arenaWatcher.setDungeonState?.(captured);
    const scope = instanceId(captured), version = this._version();
    if (scope !== this.scope || version !== this.version) {
      this.epoch++; this.scope = scope; this.version = version;
      this.pending = null; this.lastResult = null; this.ready = false; this.retryAt = 0;
      this.arenaWatcher.setTilePresence?.(null);
    }
    if (!readyState(captured)) {
      this.arenaWatcher.setTilePresence?.(null);
      return Promise.resolve(null);
    }
    if (this.ready || this.now() < this.retryAt) return Promise.resolve(this.lastResult);
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const task = Promise.resolve().then(() => this.dungeonMap.getLayoutSnapshot(captured)).then(result => {
      if (!this._current(scope, epoch)) return null;
      const currentVersion = this._version();
      if (currentVersion && String(result?.version ?? '') !== currentVersion) {
        this.ready = false; this.lastResult = null; this.retryAt = 0;
        this.arenaWatcher.setTilePresence?.(null);
        return null;
      }
      this.version = currentVersion;
      const complete = result?.status === 'ready' && instanceId(result.state) === scope
        && Array.isArray(result.rooms) && result.rooms.length > 0
        && result.rooms.every(room => plain(room) && typeof room.room === 'string' && room.room.length > 0);
      this.ready = complete; this.lastResult = result || null;
      this.retryAt = complete ? 0 : this.now() + this.retryMs;
      const arenaRoom = ARENA_ROOMS[result?.setKey || captured.key];
      this.arenaWatcher.setTilePresence?.(complete ? result.rooms.some(room => room.room === arenaRoom) : null);
      return this.lastResult;
    }).catch(() => {
      if (this._current(scope, epoch)) {
        this.ready = false; this.lastResult = null; this.retryAt = this.now() + this.retryMs;
        this.arenaWatcher.setTilePresence?.(null);
      }
      return null;
    }).finally(() => { if (this.pending === task) this.pending = null; });
    this.pending = task;
    return task;
  }

  start() {
    if (this.interval !== null) return;
    this.stopped = false;
    void this.update();
    this.interval = setInterval(() => { void this.update(); }, 2000);
    this.interval.unref?.();
  }

  stop() {
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null; this.stopped = true; this.epoch++;
    this.scope = null; this.version = null; this.pending = null; this.ready = false; this.lastResult = null; this.retryAt = 0;
    this.arenaWatcher.setDungeonState?.({ status: 'unknown', active: false });
    this.arenaWatcher.setTilePresence?.(null);
  }
}

module.exports = { ArenaPresence, ARENA_ROOM, ARENA_ROOMS, instanceId };
