/** Arena presence uses current decoded dungeon tiles, with EE.log diagnostics as fallback.
 * Wave numbers and tiers continue to come from the arena script's log messages.
 */

const fs = require('fs');
const { LogWatcher } = require('./logWatcher');
const { DungeonWatcher } = require('./dungeonWatcher');

const pathOf = value => typeof value === 'string' ? value.replace(/^\//, '').replace(/\.(?:level|lp)$/, '') : null;
const scopeOf = state => JSON.stringify([state?.active === true, state?.key || null, pathOf(state?.levelPath), state?.layoutCode || null]);

const GLADES_MARKER = 'GladesofAndurin';
// Total waves in a full arena run. Wave 21 never spawns — the game stops at
// 20 and the run ends. Used as the cap shown in the wave counter.
const ARENA_TOTAL_WAVES = 20;
// The Lua arena script logs a multi-line block on every new wave:
//   UnderCityArena.lua: New wave:
//   \tWave Number: N
//   \tTier: T
// We pick up the wave number and tier and surface them through onWaveChange.
const ARENA_NEW_WAVE_MARKER = 'UnderCityArena.lua: New wave:';
const ARENA_WAVE_NUMBER_RE  = /Wave Number:\s*(\d+)/;
const ARENA_TIER_RE         = /Tier:\s*(\d+)/;
const ARENA_PHYSICS_PATH = '/Layer8/Prefab7/';
// EE.log physics diagnostics can use the physics channel or be reported by
// Sys with "physics" in the message. Ordinary Script/ResourceLoader lines
// containing the same entity path are not evidence of an arena.
const PHYSICS_DIAGNOSTIC_RE = /\b(?:Phys(?:ics)?\s+\[(?:Error|Warning)\]:|Sys\s+\[(?:Error|Warning)\]:[^\r\n]*\bphysics\b)/i;

class ArenaWatcher {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.debug]
   * @param {() => object|null} [opts.getDungeonIndex]
   * @param {(state: string, detection: {state: string, source: string}) => void} [opts.onChange]
   * @param {(wave: {wave: number, tier: number, total: number}|null) => void} [opts.onWaveChange]
   */
  constructor(opts = {}) {
    this.debug = !!opts.debug;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this.onWaveChange = typeof opts.onWaveChange === 'function' ? opts.onWaveChange : () => {};

    this._state = 'unknown';
    this._logState = 'unknown';
    this._tileState = null;
    this._dungeon = null;
    this._source = 'none';
    this._filePath = null;
    this._pos = 0;
    this._interval = null;
    this._tail = ''; // partial line carry-over
    // Reuse the destination parser without starting another file watcher. This
    // cursor sees transitions in the same order as physics and wave messages.
    this._scopeWatcher = new DungeonWatcher({ getIndex: typeof opts.getDungeonIndex === 'function' ? opts.getDungeonIndex : () => null });
    this._bindingScope = null;
    this._eofScope = null;
    this._pendingWaveScope = null;
    this._retainWaveWhilePending = false;
    // Wave tracker. `_pendingWave` flips true the moment we see
    // `UnderCityArena.lua: New wave:` and stays true until both the wave
    // number and tier on the following lines are captured.
    this._wave = null;
    this._tier = null;
    this._pendingWave = false;
  }

  _log(...args) {
    if (!this.debug) return;
    const d = new Date(); const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    console.log(`[${ts}][ARENA]`, ...args);
  }

  getState() { return this._state; }

  getDetection() { return { state: this._state, source: this._source }; }

  /** Bind evidence to the player's current instance, independently of map visibility. */
  setDungeonState(state) {
    const next = state && typeof state === 'object' ? { ...state } : { status: 'unknown', active: false };
    const previous = this._dungeon;
    const changed = !previous || !!previous.active !== !!next.active
      || (!next.active && previous.status !== next.status)
      || (next.active && (previous.key !== next.key
        || previous.instanceId !== next.instanceId
        || (previous.levelPath && previous.levelPath !== next.levelPath)
        || (previous.layoutCode && previous.layoutCode !== next.layoutCode)));
    this._dungeon = next;
    if (changed) {
      this._tileState = null;
      this._logState = next.active ? 'no_arena' : next.status === 'outside' ? 'not_in_glades' : 'unknown';
      this._retainWaveWhilePending = false;
      this._resetWave();
    }
    const binding = scopeOf(next);
    if (changed || binding !== this._bindingScope) {
      this._bindingScope = binding;
      this._eofScope = next.active && this._canTrustEOF() ? binding : null;
    }
    if (!next.active) this._tileState = next.status === 'outside' ? 'not_in_dungeon' : null;
    this._resolveState();
  }

  setTilePresence(present) {
    // A delayed decoder must never restore a room after its dungeon has closed.
    if (!this._dungeon?.active) return;
    this._tileState = typeof present === 'boolean' ? present ? 'arena' : 'no_arena' : null;
    this._retainWaveWhilePending = typeof present !== 'boolean';
    this._resolveState();
  }

  _resolveState() {
    // Entering a dungeon is not evidence that its generated arena is absent.
    // Linux/Wine logs can omit the backup physics diagnostic entirely. Keep
    // the current instance pending until its decoded tiles or a diagnostic
    // confirm the result, rather than presenting a false negative.
    const fallback = this._dungeon?.active && this._logState !== 'arena' ? 'unknown' : this._logState;
    const next = this._tileState ?? fallback;
    const source = this._tileState !== null ? 'tiles' : fallback === 'unknown' ? 'none' : 'log';
    if (next === this._state && source === this._source) return;
    this._log(`State: ${this._state} -> ${next} (${source})`);
    this._state = next; this._source = source;
    if (next !== 'arena') {
      if (!this._retainWaveWhilePending) this._resetWave();
      else { this._pendingWave = false; this._pendingWaveScope = null; }
    }
    try { this.onChange(next, this.getDetection()); } catch { /* Renderer may have closed. */ }
  }

  /** Current wave info, or null when not actively in an arena run. */
  getWave() {
    if (this._state !== 'arena' || this._wave == null) return null;
    return { wave: this._wave, tier: this._tier ?? 0, total: ARENA_TOTAL_WAVES };
  }

  _resetWave() {
    if (this._wave == null && this._tier == null && !this._pendingWave) return;
    this._wave = null;
    this._tier = null;
    this._pendingWave = false;
    this._pendingWaveScope = null;
    try { this.onWaveChange(null); } catch { /* ignore */ }
  }

  _emitWave() {
    try { this.onWaveChange(this.getWave()); } catch { /* ignore */ }
  }

  start() {
    if (this._interval) return;
    this._log('Arena watcher started.');
    this._poll();
    this._interval = setInterval(() => this._poll(), 750);
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    this._dungeon = null; this._tileState = null; this._logState = 'unknown';
    this._resetLogScope();
    this._resetWave(); this._resolveState();
  }

  _rawScopeKnown() {
    const state = this._scopeWatcher.getState();
    return state.active === true || state.status === 'outside';
  }

  _canTrustEOF() {
    if (this._rawScopeKnown() || !this._filePath || this._tail) return false;
    try { return fs.statSync(this._filePath).size <= this._pos; } catch { return false; }
  }

  _acceptsLogEvidence() {
    if (this._dungeon === null) return true; // Legacy log-only use remains supported.
    if (!this._dungeon.active) return false;
    if (this._rawScopeKnown()) return scopeOf(this._scopeWatcher.getState()) === scopeOf(this._dungeon);
    return this._eofScope === scopeOf(this._dungeon);
  }

  _observeLogScope(line) {
    this._scopeWatcher._processLine(line);
    if (!this._rawScopeKnown()) return;
    this._eofScope = null;
    if (!this._dungeon || this._acceptsLogEvidence()) return;
    const raw = this._scopeWatcher.getState(), primary = this._dungeon;
    // A newly learned fingerprint can refine a waiting instance without
    // discarding its complete buffered wave. Different destinations cannot.
    const conflict = !raw.active || !primary.active || raw.key !== primary.key
      || (primary.levelPath && pathOf(raw.levelPath) !== pathOf(primary.levelPath))
      || (primary.layoutCode && raw.layoutCode !== primary.layoutCode);
    this._pendingWave = false; this._pendingWaveScope = null;
    if (conflict) {
      this._logState = primary.active ? 'no_arena' : 'unknown';
      this._resetWave(); this._resolveState();
    }
  }

  _resetLogScope() {
    this._scopeWatcher.stop();
    this._bindingScope = null; this._eofScope = null;
    this._retainWaveWhilePending = false;
    this._resetWave();
  }

  _setLogState(next) {
    this._logState = next;
    this._resolveState();
  }

  _findLog() {
    for (const p of LogWatcher.candidatePaths()) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  _poll() {
    const candidates = LogWatcher.candidatePaths();
    const candidateKey = JSON.stringify(candidates);
    if (this._candidateKey !== undefined && this._candidateKey !== candidateKey
      && this._filePath && !candidates.includes(this._filePath)) {
      this._filePath = null;
      this._pos = 0;
      this._tail = '';
      this._resetLogScope();
      this._setLogState('unknown');
    }
    this._candidateKey = candidateKey;
    if (!this._filePath || !fs.existsSync(this._filePath)) {
      this._resetLogScope();
      this._setLogState('unknown');
      this._filePath = this._findLog();
      this._pos = 0;
      this._tail = '';
      if (!this._filePath) return;
      // Start at end (only process new lines)
      try {
        this._pos = fs.statSync(this._filePath).size;
      } catch { return; }
      this._log(`EE.log detected at ${this._filePath}`);
    }

    let stat;
    try { stat = fs.statSync(this._filePath); } catch { return; }

    // Handle truncation/rotation
    if (stat.size < this._pos) {
      this._pos = 0;
      this._tail = '';
      this._resetLogScope();
      this._setLogState('unknown');
    }
    if (stat.size <= this._pos) return;

    const toRead = Math.min(stat.size - this._pos, 262144); // up to 256KB per tick
    let buf;
    try {
      const fd = fs.openSync(this._filePath, 'r');
      buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, this._pos);
      fs.closeSync(fd);
    } catch { return; }
    this._pos += toRead;

    const chunk = this._tail + buf.toString('utf-8');
    const lastNl = chunk.lastIndexOf('\n');
    const consumable = lastNl >= 0 ? chunk.slice(0, lastNl) : '';
    this._tail = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;

    if (!consumable) return;

    for (const line of consumable.split('\n')) {
      this._processLine(line);
    }
  }

  /** The arena path and a physics diagnostic must occur on the same line. */
  _isArenaPhysicsDiagnostic(line) {
    return line.includes(ARENA_PHYSICS_PATH) && PHYSICS_DIAGNOSTIC_RE.test(line);
  }

  /**
   * Level paths establish location only; they never confirm an arena.
   * @param {string} levelPath
   */
  _classifyLevel(levelPath) {
    if (!levelPath || !levelPath.includes(GLADES_MARKER)) return 'other';
    return 'glades';
  }

  _processLine(line) {
    if (!line) return;
    this._observeLogScope(line);
    if (!this._acceptsLogEvidence()) return;

    // Wave-counter parsing. The arena script logs a 3-line block whenever a
    // new wave begins; the first line is the marker, the next two carry the
    // wave number and tier (in either order, in practice). We accept any
    // line containing them while `_pendingWave` is set so a single dropped
    // newline doesn't desync the counter. Joining mid-arena: the first wave
    // number we see (e.g. 7) is what we display — we don't assume runs
    // start at 1.
    if (this._state === 'arena' && line.includes(ARENA_NEW_WAVE_MARKER)) {
      this._pendingWave = true;
      this._pendingWaveScope = this._dungeon ? scopeOf(this._dungeon) : null;
      return;
    }
    if (this._pendingWave) {
      if (this._dungeon && this._pendingWaveScope !== scopeOf(this._dungeon)) {
        this._pendingWave = false; this._pendingWaveScope = null;
        return;
      }
      const wm = line.match(ARENA_WAVE_NUMBER_RE);
      if (wm) {
        const next = parseInt(wm[1], 10);
        if (Number.isFinite(next) && next > 0 && next !== this._wave) {
          this._wave = next;
          // Waves are accepted only after room-tile or backup diagnostic
          // confirmation; wave messages alone never establish presence.
          this._emitWave();
        }
      }
      const tm = line.match(ARENA_TIER_RE);
      if (tm) {
        const t = parseInt(tm[1], 10);
        if (Number.isFinite(t) && t !== this._tier) {
          this._tier = t;
          this._emitWave();
        }
        // Tier is the second of the two trailing lines, so close the block.
        this._pendingWave = false;
        this._pendingWaveScope = null;
      }
      // Don't return — the same chunk may also contain arena-pattern hits
      // we still want to honor below.
    }

    // 0. Backup confirmation after the raw cursor has reached this instance.
    //    Current decoded tile evidence still takes precedence in _resolveState.
    if (this._isArenaPhysicsDiagnostic(line)) {
      this._setLogState('arena');
      return;
    }

    // 1. Multiplayer/host: connect line. Fires for solo entries and squad
    //    joins, but for squad joins this points at MidrathProc (Tower) first
    //    — the actual region streams in later via Spot-building (see #4).
    //    Format: ===[ Game successfully connected to: <levelPath> ]===
    //    NB: a Glades→Glades connect (e.g. migrating from a friend's party
    //    to your own while still in the same arena tile) must NOT downgrade
    //    `arena` → `no_arena` — the same instance persists across migration.
    const connectIdx = line.indexOf('Game successfully connected to:');
    if (connectIdx !== -1) {
      const tail = line.slice(connectIdx + 'Game successfully connected to:'.length);
      const end = tail.indexOf(']===');
      const levelPath = (end !== -1 ? tail.slice(0, end) : tail).trim();
      const kind = this._classifyLevel(levelPath);
      if (kind === 'glades') {
        if (this._logState !== 'arena') this._setLogState('no_arena');
      } else this._setLogState('not_in_glades');
      return;
    }

    // 2. Host's own EXIT_LEVEL — leave the in-Glades states.
    if (line.includes('STATS EXIT_LEVEL') && line.includes(GLADES_MARKER)) {
      this._setLogState('not_in_glades');
      return;
    }

    // 3. Host's own ENTER_LEVEL — solo / first-load fallback.
    //    Same anti-downgrade rule as #1.
    const enterIdx = line.indexOf('STATS ENTER_LEVEL');
    if (enterIdx !== -1) {
      const levelPath = line.slice(enterIdx + 'STATS ENTER_LEVEL'.length).trim();
      const kind = this._classifyLevel(levelPath);
      if (kind === 'glades') {
        if (this._logState !== 'arena') this._setLogState('no_arena');
      } else this._setLogState('not_in_glades');
      return;
    }

    // 4. Region stream-in detector. When joining a friend's Glades session,
    //    no STATS ENTER_LEVEL fires for the player — the region just streams
    //    in. `Spot-building /SF/Levels/Procs/GladesofAndurin/<level>` is the
    //    earliest reliable signal of that. Only promote out of
    //    not_in_glades / unknown so we don't thrash on the many sub-asset
    //    Spot-* lines that follow.
    if ((this._logState === 'not_in_glades' || this._logState === 'unknown')
        && line.includes('Spot-building /SF/Levels/Procs/')
        && line.includes(GLADES_MARKER)) {
      this._setLogState('no_arena');
    }
  }
}

ArenaWatcher.ARENA_PHYSICS_PATH = ARENA_PHYSICS_PATH;
ArenaWatcher.GLADES_MARKER = GLADES_MARKER;
ArenaWatcher.TOTAL_WAVES = ARENA_TOTAL_WAVES;

module.exports = { ArenaWatcher };
