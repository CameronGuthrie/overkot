'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { LogWatcher } = require('./logWatcher');

const SETS = {
  FallenFortress: { key: 'fallenFortress', name: 'Fallen Fortress' },
  GladesofAndurin: { key: 'gladesofAndurin', name: 'Glades of Andurin' },
  UnderCity: { key: 'underCityMidrath', name: 'Undercity' },
  UnderCityMidrath: { key: 'underCityMidrath', name: 'Undercity' },
  UnderCityAlleys: { key: 'underCityMidrath', name: 'Undercity' },
  Undercity: { key: 'underCityMidrath', name: 'Undercity' },
  Crypt: { key: 'crypt', name: 'Crypt' },
  Mines: { key: 'mines', name: 'Mines' },
  Neathuns: { key: 'neathuns', name: "Neath'uns" },
  Osc: { key: 'osc', name: 'Dungeon' },
  OdeSkyCastle: { key: 'odeSkyCastle', name: 'Ode Sky Castle' },
};
// Generators do not always live in their room-set directory. These fallbacks
// cover the current extracted index even before the remote index is cached.
const UNDERCITY_GENERATORS = new Set(['UnderCityAllTiles', 'UnderCityAlleys', 'UnderCityBaseShort', 'UnderCityCliffCave',
  'UnderCityCliffTown', 'UnderCityForge', 'UnderCityGaol', 'UnderCityGauntlet', 'UnderCityGranary', 'UnderCityManor',
  'UnderCityMill', 'UnderCityNeighbourhood', 'UnderCityTestOne', 'UnderCityTheater', 'UnderCityTreasury']);
const LAYOUT = /(\/SF\/Levels\/Procs\/[^\s]+?)\/([A-Za-z0-9+\-]+)\.lp\b/;
const GENERATED_LAYOUT = /(?:^|\b(?:Sys|Game)\s+\[Info\]:\s*)(\/SF\/Levels\/Procs\/[^\s]+?)\/([A-Za-z0-9+\-]+)\.lp\s*$/;
const TRANSITION = /STATS (ENTER|EXIT)_LEVEL\s+(\/SF\/Levels\/\S+)/;
const LOGOUT = /MainMenu\.lua: Main menu - LogOut\(\)|QUIT :Logged out of game|Game session has ended/;
const levelPathOf = path => {
  const clean = String(path || '').replace(/[.,]$/, '');
  // Connected sessions and some ENTER events identify the generated .lp
  // resource rather than its generator. Keep its fingerprint separate.
  return LAYOUT.exec(clean)?.[1] || clean.replace(/\.(?:level|lp)$/, '');
};

function dungeonSet(levelPath, index = null) {
  levelPath = levelPathOf(levelPath);
  const indexed = Array.isArray(index?.sets) ? index.sets.find(entry => entry && typeof entry.key === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.key)
    && Array.isArray(entry.level_paths) && entry.level_paths.some(path => levelPathOf(path) === levelPath)) : null;
  if (indexed) {
    const known = Object.values(SETS).find(info => info.key === indexed.key);
    return { set: indexed.set || indexed.key, key: indexed.key, name: known?.name || indexed.set || 'Dungeon' };
  }
  const set = /\/SF\/Levels\/Procs\/([^/\s]+)/.exec(levelPath)?.[1];
  if (UNDERCITY_GENERATORS.has(set) || /^\/SF\/Levels\/Procs\/Tales\/UnderCityTales[^/\s]+$/.test(levelPath)
      || levelPath === '/SF/Levels/Procs/Quest/OrengallPupRescueUCMill') return { set: 'UnderCityMidrath', ...SETS.UnderCityMidrath };
  if (/^\/SF\/Levels\/Procs\/Tales\/GladesTales(?:Corrupted)?$/.test(levelPath)) return { set: 'GladesofAndurin', ...SETS.GladesofAndurin };
  return set && SETS[set] ? { set, ...SETS[set] } : null;
}

class DungeonWatcher {
  constructor({ onChange = () => {}, debug = false, candidates = () => LogWatcher.candidatePaths(), getIndex = () => null } = {}) {
    this.onChange = onChange; this.debug = debug; this.candidates = candidates;
    this.getIndex = getIndex; this._index = null;
    this._interval = null; this._drainTimer = null; this._filePath = null;
    this._state = { status: 'unknown', active: false };
    this._resetLog();
  }
  getState() { return this._replayTarget !== null ? { status: 'unknown', active: false } : { ...this._state }; }
  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._poll(), 500);
    this._poll();
  }
  stop() {
    if (this._interval) clearInterval(this._interval);
    if (this._drainTimer) clearImmediate(this._drainTimer);
    this._interval = null; this._drainTimer = null; this._filePath = null;
    this._resetLog(); this._setState({ status: 'unknown', active: false });
  }
  _resetLog() {
    this._pos = 0; this._tail = ''; this._head = Buffer.alloc(0); this._fileIdentity = null;
    this._decoder = new StringDecoder('utf8'); this._replayTarget = null; this._batching = false; this._dirty = false;
    this._fingerprints = new Map(); this._entryIntent = null; this._location = null;
    this._entryOrdinal = 0; this._logIncarnation = 'parser-fixture';
  }
  _nextInstanceId() {
    return createHash('sha256').update(`${this._logIncarnation}:${++this._entryOrdinal}`).digest('hex').slice(0, 32);
  }
  setIndex(index) { this._index = index && Array.isArray(index.sets) ? index : null; }
  _classify(path) {
    let index = this._index;
    try { index = this.getIndex() || index; } catch { /* Cached aliases still work while the feed is unavailable. */ }
    return dungeonSet(path, index);
  }
  _setState(state) {
    if (JSON.stringify(this._state) === JSON.stringify(state)) return;
    this._state = state; this._dirty = true;
    if (!this._batching && this._replayTarget === null) this._emit();
  }
  _emit() {
    this._dirty = false;
    try { this.onChange(this.getState()); } catch { /* A renderer may have closed. */ }
  }
  _enter(info, levelPath, reset = false) {
    if (!info) return;
    const generated = levelPath && LAYOUT.exec(levelPath);
    levelPath = levelPath ? levelPathOf(levelPath) : null;
    if (generated) this._rememberLayout(levelPath, generated[2]);
    const layoutCode = generated?.[2] || (levelPath ? this._fingerprints.get(levelPath) || null : null);
    if (!reset && this._state.active && this._state.key === info.key && (!levelPath || (this._state.levelPath === levelPath
        && (!layoutCode || layoutCode === this._state.layoutCode)))) return;
    // Streaming intent, the generator path and its fingerprint arrive in separate
    // log events. Refining that destination must not start another discovery map.
    const sameEntry = !reset && this._state.active
      && ((!this._state.levelPath && this._state.key === info.key)
        || (this._state.levelPath === levelPath && (!this._state.layoutCode || !layoutCode || this._state.layoutCode === layoutCode)));
    const instanceId = sameEntry ? this._state.instanceId : this._nextInstanceId();
    this._entryIntent = info.key;
    this._setState({ status: layoutCode ? 'ready' : 'waiting', active: true, ...info, levelPath, layoutCode, instanceId });
  }
  _rememberLayout(levelPath, layoutCode) {
    this._fingerprints.set(levelPath, layoutCode);
    if (this._fingerprints.size > 128) this._fingerprints.delete(this._fingerprints.keys().next().value);
  }
  _leave(levelPath = null) {
    if (this._state.levelPath && this._fingerprints.get(this._state.levelPath) === this._state.layoutCode) this._fingerprints.delete(this._state.levelPath);
    this._entryIntent = null; this._location = null;
    const context = levelPath ? { levelPath: levelPathOf(levelPath), instanceId: !this._state.active && this._state.levelPath === levelPathOf(levelPath)
      ? this._state.instanceId : this._nextInstanceId() } : {};
    this._setState({ status: 'outside', active: false, ...context });
  }
  _processLine(line) {
    if (!line) return;
    if (LOGOUT.test(line)) { this._fingerprints.clear(); this._leave(); return; }
    // Destruction and prefetch messages repeat .lp paths. They are not new
    // generation events and must never bring a completed dungeon back.
    const destroyed = LAYOUT.exec(line);
    if (destroyed && /fully destroyed|Destreaming complete on level/.test(line)) {
      if (this._fingerprints.get(destroyed[1]) === destroyed[2]) this._fingerprints.delete(destroyed[1]);
      if (this._state.active && this._state.levelPath === destroyed[1] && this._state.layoutCode === destroyed[2]) this._leave();
      return;
    }
    const layout = GENERATED_LAYOUT.exec(line);
    if (layout) {
      const info = this._classify(layout[1]);
      if (!info) return;
      this._rememberLayout(layout[1], layout[2]);
      // Preserve a generated fingerprint for a later ENTER. Only an already
      // selected player destination may consume it while streaming in.
      if (this._state.active && this._state.status === 'waiting' && this._state.levelPath === layout[1]) this._setState({ ...this._state, status: 'ready', layoutCode: layout[2] });
      return;
    }
    const transition = TRANSITION.exec(line);
    if (transition) {
      const path = levelPathOf(transition[2]), info = this._classify(path);
      const layoutCode = LAYOUT.exec(transition[2])?.[2];
      if (transition[1] === 'ENTER') {
        if (info) this._enter(info, transition[2]);
        else this._leave(transition[2]);
      } else if (info && (!this._state.active || ((this._state.levelPath === path || (!this._state.levelPath && this._state.key === info.key))
          && (!layoutCode || !this._state.layoutCode || layoutCode === this._state.layoutCode)))) this._leave();
      else if (!info && !this._state.active && this._state.levelPath === path) this._leave();
      return;
    }
    // Background room preloads and Spot-building alone do not identify the
    // player's destination. Bind a streamed generator only after entry intent.
    const stream = /(?:Spot-building|Streaming started on level)\s+(\/SF\/Levels\/Procs\/\S+)/.exec(line);
    if (stream) {
      const path = levelPathOf(stream[1]), info = this._classify(path);
      if (info && this._state.active && !this._state.levelPath && this._entryIntent === info.key) this._enter(info, stream[1]);
      return;
    }
    const connected = /Game successfully connected to:\s*(\/SF\/Levels\/[^\]\s]+)/.exec(line);
    if (connected) {
      const info = this._classify(connected[1]);
      if (info) this._enter(info, connected[1]);
      else this._leave(connected[1]);
      return;
    }
    // Location changes signal a fresh trip before its fingerprint is printed.
    const location = /LoadTriggers\.lua: (?:StreamTrigger location is|SetCurrentLocation:)\s+([A-Za-z0-9_]+)/.exec(line)?.[1];
    if (location) {
      const set = Object.keys(SETS).find(set => location.toLowerCase().startsWith(set.toLowerCase()));
      if (set && (location !== this._location || !this._state.active)) {
        this._location = location; this._enter({ set, ...SETS[set] }, null, true);
      }
    }
  }
  _poll() {
    const candidates = this.candidates();
    if (this._filePath && (!candidates.includes(this._filePath) || !fs.existsSync(this._filePath))) {
      this._filePath = null; this._resetLog(); this._setState({ status: 'unknown', active: false });
    }
    if (!this._filePath) {
      this._filePath = candidates.find(filename => fs.existsSync(filename)) || null;
      if (!this._filePath) return;
    }
    let fd, stat, buf, bytesRead;
    try {
      fd = fs.openSync(this._filePath, 'r'); stat = fs.fstatSync(fd);
      const identity = [stat.dev, stat.ino, stat.birthtimeMs].join(':');
      const head = Buffer.alloc(Math.min(128, stat.size));
      const headBytes = fs.readSync(fd, head, 0, head.length, 0);
      const common = Math.min(headBytes, this._head.length);
      if (stat.size < this._pos || !head.subarray(0, common).equals(this._head.subarray(0, common))
          || (this._fileIdentity !== null && this._fileIdentity !== identity)) {
        this._resetLog(); this._replayTarget = stat.size; this._setState({ status: 'unknown', active: false });
      }
      if (this._fileIdentity === null || this._replayTarget !== null) this._replayTarget = stat.size;
      this._fileIdentity = identity; this._head = head.subarray(0, headBytes);
      // The first header line is immutable while EE.log grows. Include file
      // identity so replacement logs cannot reuse a previous run's entry IDs.
      // Read this before parsing the first entry; replay uses the same ordinal.
      if (!this._entryOrdinal) this._logIncarnation = createHash('sha256').update(identity).update(this._head.subarray(0,
        this._head.indexOf(10) >= 0 ? this._head.indexOf(10) : this._head.length)).digest('hex');
      const toRead = Math.min(Math.max(0, stat.size - this._pos), 262144);
      buf = Buffer.alloc(toRead); bytesRead = fs.readSync(fd, buf, 0, toRead, this._pos);
    } catch { return; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    this._pos += bytesRead;
    const chunk = this._tail + this._decoder.write(buf.subarray(0, bytesRead));
    const newline = chunk.lastIndexOf('\n');
    this._tail = newline >= 0 ? chunk.slice(newline + 1) : chunk;
    // Keep a corrupt log line from growing without limit.
    if (this._tail.length > 65536) this._tail = '';
    this._batching = true;
    if (newline >= 0) for (const line of chunk.slice(0, newline).split('\n')) this._processLine(line.trimEnd());
    this._batching = false;
    if (this._replayTarget !== null && this._pos >= this._replayTarget) this._replayTarget = null;
    if (this._dirty && this._replayTarget === null) this._emit();
    if (this._interval && !this._drainTimer && this._pos < stat.size && bytesRead) {
      this._drainTimer = setImmediate(() => { this._drainTimer = null; this._poll(); });
    }
  }
}

module.exports = { DungeonWatcher, dungeonSet };
