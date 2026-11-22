/**
 * Tracks active Gods & Ghosts encounters from EE.log. The encounter position is
 * a world-space hint position; the minimap applies its normal world transform.
 * A nearby BoonNPC resource load identifies the ancestor, as in minimap.py.
 */
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { LogWatcher } = require('./logWatcher');

const ANCESTOR_ENCOUNTER_TOKEN = 'DynamicGodsAndGhostEncounter';
const NUMBER = '([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)';
const RE_START = new RegExp('ENCMGR: Encounter (.*?) started at (.*?) at pos \\[\\(' + NUMBER + ',\\s*' + NUMBER + ',\\s*' + NUMBER + ',');
const RE_END = /ENCMGR: Encounter (.*?) (?:was abandoned|has completed) on hint (.*?)(?: at | with |$)/;
const RE_BOON = /ResourceLoader\b.*?\(\/SF\/Types\/Npcs\/BoonNPC\/([^()]+BoonNpc)\)/i;
const RE_LEVEL_CHANGE = /(?:ProcLevelSetup|LoginScripts)\.lua: STATS (?:ENTER|EXIT)_LEVEL/;
const RE_LOGOUT = /MainMenu\.lua: Main menu - LogOut\(\)|QUIT :Logged out of game/;
const RE_TIMESTAMP = /^\s*(\d+(?:\.\d+)?)\s/;
const READ_CHUNK_BYTES = 262144;
const MAX_BOON_LINES = 64;
const MAX_BOON_SECONDS = 5;

function unwrap(value) {
  return value.trim().replace(/^\[(.*)\]$/, '$1');
}

class AncestorWatcher {
  /** @param {{debug?: boolean, onChange?: (ancestors: Array<object>) => void}} [opts] */
  constructor(opts = {}) {
    this.debug = !!opts.debug;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this._filePath = null;
    this._fileIdentity = null;
    this._head = Buffer.alloc(0);
    this._pos = 0;
    this._interval = null;
    this._drainTimer = null;
    this._tail = '';
    this._decoder = new StringDecoder('utf8');
    this._pendingBoon = null;
    this._encounters = new Map();
    this._replayTarget = null;
    this._batching = false;
    this._dirty = false;
  }

  _log(...args) {
    if (this.debug) console.log('[ANCESTOR]', ...args);
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._poll(), 500);
    this._poll();
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    if (this._drainTimer) clearImmediate(this._drainTimer);
    this._interval = null;
    this._drainTimer = null;
    this._resetLog();
    this._filePath = null;
  }

  getAncestors() {
    // Do not expose encounters from the beginning of an existing log before
    // their later completion/logout lines have been replayed.
    if (this._replayTarget !== null) return [];
    return Array.from(this._encounters.values(), (e) => ({
      id: e.hint,
      hint: e.hint,
      encounterName: e.name,
      ancestorName: e.ancestorName,
      ancestorRaw: e.ancestorRaw,
      x: e.x,
      y: e.y,
      z: e.z,
      startedAt: e.startedAt,
    }));
  }

  _emit() {
    this._dirty = true;
    if (this._batching || this._replayTarget !== null) return;
    this._dirty = false;
    try { this.onChange(this.getAncestors()); } catch { /* Keep tailing if a window closes. */ }
  }

  _clear() {
    this._pendingBoon = null;
    if (!this._encounters.size) return;
    this._encounters.clear();
    this._emit();
  }

  _resetLog() {
    this._replayTarget = null;
    this._clear();
    this._pos = 0;
    this._tail = '';
    this._head = Buffer.alloc(0);
    this._fileIdentity = null;
    this._decoder = new StringDecoder('utf8');
  }

  _findLog() {
    return LogWatcher.candidatePaths().find(p => fs.existsSync(p)) || null;
  }

  _poll() {
    const candidates = LogWatcher.candidatePaths();
    const candidateKey = JSON.stringify(candidates);
    if (this._candidateKey !== undefined && this._candidateKey !== candidateKey
      && this._filePath && !candidates.includes(this._filePath)) {
      this._resetLog();
      this._filePath = null;
    }
    this._candidateKey = candidateKey;
    if (!this._filePath || !fs.existsSync(this._filePath)) {
      this._resetLog();
      this._filePath = this._findLog();
      if (!this._filePath) return;
      this._log('Reading ' + this._filePath);
    }

    let fd;
    let stat;
    let buf;
    let bytesRead;
    try {
      fd = fs.openSync(this._filePath, 'r');
      stat = fs.fstatSync(fd);
      const identity = [stat.dev, stat.ino, stat.birthtimeMs].join(':');
      const head = Buffer.alloc(Math.min(128, stat.size));
      const headBytes = fs.readSync(fd, head, 0, head.length, 0);
      const common = Math.min(headBytes, this._head.length);
      const headerChanged = !head.subarray(0, common).equals(this._head.subarray(0, common));
      if (stat.size < this._pos || headerChanged ||
          (this._fileIdentity !== null && this._fileIdentity !== identity)) {
        this._resetLog();
      }
      if (this._fileIdentity === null || this._replayTarget !== null) this._replayTarget = stat.size;
      this._fileIdentity = identity;
      this._head = head.subarray(0, headBytes);
      const toRead = Math.min(Math.max(0, stat.size - this._pos), READ_CHUNK_BYTES);
      buf = Buffer.alloc(toRead);
      bytesRead = fs.readSync(fd, buf, 0, toRead, this._pos);
    } catch {
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    this._pos += bytesRead;
    const chunk = this._tail + this._decoder.write(buf.subarray(0, bytesRead));
    const lastNl = chunk.lastIndexOf('\n');
    this._tail = lastNl >= 0 ? chunk.slice(lastNl + 1) : chunk;
    this._batching = true;
    if (lastNl >= 0) {
      for (const line of chunk.slice(0, lastNl).split('\n')) this._processLine(line.trimEnd());
    }
    this._batching = false;
    if (this._replayTarget !== null && this._pos >= this._replayTarget) this._replayTarget = null;
    if (this._dirty) this._emit();

    // Catch up in bounded chunks, yielding to Electron between each read.
    if (this._interval && !this._drainTimer && this._pos < stat.size && bytesRead) {
      this._drainTimer = setImmediate(() => {
        this._drainTimer = null;
        this._poll();
      });
    }
  }

  _processLine(line) {
    if (!line) return;
    if (RE_LOGOUT.test(line) || RE_LEVEL_CHANGE.test(line)) {
      this._clear();
      return;
    }

    const timestamp = line.match(RE_TIMESTAMP);
    const seconds = timestamp ? Number(timestamp[1]) : null;
    if (this._pendingBoon) {
      const pending = this._pendingBoon;
      pending.lines++;
      const elapsed = seconds !== null && pending.seconds !== null
        ? seconds - pending.seconds : (Date.now() - pending.at) / 1000;
      if (pending.lines > MAX_BOON_LINES || elapsed > MAX_BOON_SECONDS || elapsed < 0) {
        this._pendingBoon = null;
      }
    }

    const start = line.match(RE_START);
    if (start) {
      const [, rawName, rawHint, x, y, z] = start;
      const name = unwrap(rawName);
      const hint = unwrap(rawHint);
      if (!name.includes(ANCESTOR_ENCOUNTER_TOKEN)) {
        // A hint can be reused by another encounter after its ancestor leaves.
        if (this._encounters.delete(hint)) this._emit();
        if (this._pendingBoon?.hint === hint) this._pendingBoon = null;
        return;
      }
      const entry = {
        hint, name, x: Number(x), y: Number(y), z: Number(z),
        ancestorName: null, ancestorRaw: null, startedAt: Date.now(),
      };
      if (![entry.x, entry.y, entry.z].every(Number.isFinite)) return;
      this._encounters.set(hint, entry);
      this._pendingBoon = { hint, seconds, lines: 0, at: Date.now() };
      this._log('Ancestor encounter at X ' + entry.x + ', Z ' + entry.z);
      this._emit();
      return;
    }

    // Match NPC resources, not helpers in the same folder (CameraSpot,
    // ConversationAction, etc.). The nearby-load bound avoids naming an old
    // unpaired marker after an unrelated preload much later in the session.
    const boon = line.match(RE_BOON);
    if (boon) {
      const entry = this._encounters.get(this._pendingBoon?.hint);
      this._pendingBoon = null;
      if (entry) {
        entry.ancestorRaw = boon[1];
        entry.ancestorName = cleanAncestorName(boon[1]);
        this._log('Ancestor identified: ' + entry.ancestorName);
        this._emit();
      }
      return;
    }

    const end = line.match(RE_END);
    if (end && unwrap(end[1]).includes(ANCESTOR_ENCOUNTER_TOKEN)) {
      const hint = unwrap(end[2]);
      if (this._pendingBoon?.hint === hint) this._pendingBoon = null;
      if (this._encounters.delete(hint)) this._emit();
    }
  }
}

function cleanAncestorName(raw) {
  if (!raw) return 'Unknown Ancestor';
  const last = String(raw).split(/[\\/]/).pop();
  return last.replace(/^BoonNPC/i, '').replace(/BoonNPC$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim() || 'Unknown Ancestor';
}

AncestorWatcher.ENCOUNTER_TOKEN = ANCESTOR_ENCOUNTER_TOKEN;
AncestorWatcher.cleanAncestorName = cleanAncestorName;
module.exports = { AncestorWatcher };
