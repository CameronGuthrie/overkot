/**
 * Reads Soulframe login and logout records from the current EE.log.
 */

const fs = require('fs');
const { getGamePathResolver } = require('./gamePaths');

// The session marker must begin the log message; other records can quote login text.
const sessionEvents = /^[ \t]*(?:\d+(?:\.\d+)?[ \t]+)?(?:\w+[ \t]+\[Info\]:[ \t]*)?(Logged in\b|Logging in as\b|QUIT :Logged out of game\b|MainMenu\.lua: Main menu - LogOut\(\))([^\r\n]*)/gim;
const loggedInPlayer = /^[ \t]+(.{1,128}?)[ \t]+\(([a-f0-9]{24})\)(?=[ \t]|$)/i;

function loginFromEvent(event) {
  const player = event[1].toLowerCase() === 'logged in' && loggedInPlayer.exec(event[2]);
  return player ? { accountId: player[2].toLowerCase(), name: player[1] } : null;
}

function readLogBytes(fd, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  if (fs.readSync(fd, buffer, 0, length, offset) !== length) throw new Error('Log changed during read');
  return buffer;
}

function lastBytes(fd, end) {
  const start = Math.max(0, end - 512);
  return readLogBytes(fd, start, end - start);
}

function latestLogin(fd, lowerBound, end, previousRecord) {
  let suffix = '';
  while (end > lowerBound) {
    const start = Math.max(lowerBound, end - 64 * 1024);
    // Include the preceding byte so the start of a block cannot impersonate a line start.
    const offset = Math.max(0, start - 1);
    const bytes = readLogBytes(fd, offset, end - offset);
    const block = bytes.toString('latin1') + suffix;
    let latest;
    for (const event of block.matchAll(sessionEvents)) {
      if (event.index >= start - offset && event.index < bytes.length) latest = event;
    }
    if (latest) {
      const login = loginFromEvent(latest);
      return login && { login, offset: offset + latest.index };
    }
    // Keep enough of the following block for a login record split across reads.
    suffix = block.slice(start - offset, start - offset + 512);
    end = start;
  }
  return previousRecord;
}

function sameLog(snapshot, file, stat) {
  return snapshot?.file === file && snapshot.ino === stat.ino && snapshot.birthtimeMs === stat.birthtimeMs;
}

function checkpointOffset(checkpoint, file, stat) {
  if (!checkpoint) return 0;
  if (sameLog(checkpoint, file, stat)) {
    // A truncated file may retain its old header. Trust appends beyond the observed end.
    checkpoint.offset = Math.min(checkpoint.offset, stat.size);
  } else {
    // A newly created file belongs to this observation window. A pre-existing replacement
    // or a file we could not stat at attach needs a new login beyond its current end.
    const newFile = checkpoint.attachedAt !== null && stat.birthtimeMs > checkpoint.attachedAt;
    Object.assign(checkpoint, { file, ino: stat.ino, birthtimeMs: stat.birthtimeMs, offset: newFile ? 0 : stat.size });
  }
  return checkpoint.offset;
}

class LogWatcher {
  constructor(debug = false) {
    this.debug = debug;
    this._logoutSignal = false;
    this._loginSignal = false;
    this._pollStat = null;
    this._partialLine = null;
    this._filePath = null;
    this._pos = 0;
  }

  _log(...args) {
    if (!this.debug) return;
    const d = new Date(); const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    console.log(`[${ts}][LOG]`, ...args);
  }

  // ─── Candidate EE.log paths (mirrors Rust + Linux/Proton) ──
  static candidatePaths() {
    return getGamePathResolver().logCandidates();
  }

  /** Find the first existing EE.log file on disk. */
  _findLog(onError) {
    for (const p of LogWatcher.candidatePaths()) {
      try {
        if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.R_OK); return p; }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') onError?.();
      }
    }
    return null;
  }

  /** Capture file identity and size at process attachment without reading any records. */
  loginCheckpoint() {
    const checkpoint = { file: null, attachedAt: Date.now() };
    try {
      const file = this._findLog(() => { checkpoint.attachedAt = null; });
      if (file) {
        const stat = fs.statSync(file);
        Object.assign(checkpoint, { file, ino: stat.ino, birthtimeMs: stat.birthtimeMs, offset: stat.size });
      }
    } catch { checkpoint.attachedAt = null; }
    return checkpoint;
  }

  /** Only the latest confirmed login in the active game log identifies the account. */
  extractAccountId() {
    return this.currentLogin()?.accountId || '';
  }

  static _isValid24Hex(s) {
    return s.length === 24 && /^[a-f0-9]{24}$/.test(s);
  }

  /**
   * Extract the player display name from EE.log.
   * Looks for lines like: "Logged in PlayerName (accountId)"
   * @returns {string} display name or empty string
   */
  extractDisplayName(accountId) {
    if (!LogWatcher._isValid24Hex((accountId || '').toLowerCase())) return '';
    for (const p of LogWatcher.candidatePaths()) {
      if (!fs.existsSync(p)) continue;

      let content;
      try { content = fs.readFileSync(p, 'utf-8'); } catch { continue; }

      // Match patterns like "Logged in SomePlayer (hexId)" — take the last match
      const rx = /Logged in (\S+) \(([a-f0-9]{24})\)/gi;
      let lastMatch = null;
      let m;
      while ((m = rx.exec(content)) !== null) {
        if (m[2].toLowerCase() === accountId.toLowerCase()) lastMatch = m[1];
      }

      if (lastMatch) {
        this._log(`Extracted display name: ${lastMatch}`);
        return lastMatch;
      }
    }
    return '';
  }

  // Read back to the most recent login or logout, including when the game
  // has already been running for hours. Later calls only inspect new bytes.
  currentLogin(minimumWriteTime = 0, checkpoint = null) {
    const file = this._findLog();
    if (!file) { this._loginScan = null; return null; }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      const { size, ino, birthtimeMs, mtimeMs, ctimeMs } = stat;
      const minimumOffset = checkpointOffset(checkpoint, file, stat);
      if (mtimeMs < minimumWriteTime) return null;
      const previous = this._loginScan;
      const sameFile = sameLog(previous, file, stat);
      if (sameFile && previous.size === size && previous.mtimeMs === mtimeMs && previous.ctimeMs === ctimeMs) {
        return previous.record?.offset >= minimumOffset ? previous.record.login : null;
      }
      const tail = lastBytes(fd, size);
      // An unfinished record could be the beginning of a logout or account change.
      if (size && tail.at(-1) !== 10) return null;
      const appended = sameFile && previous.size < size && lastBytes(fd, previous.size).equals(previous.tail);
      const record = latestLogin(fd, appended ? previous.size : 0, size, appended ? previous.record : null);
      const after = fs.statSync(file);
      if (after.ino !== ino || after.birthtimeMs !== birthtimeMs || after.size !== size ||
        after.mtimeMs !== mtimeMs || after.ctimeMs !== ctimeMs) return null;
      this._loginScan = { file, size, ino, birthtimeMs, mtimeMs, ctimeMs, tail, record };
      return record?.offset >= minimumOffset ? record.login : null;
    } catch { /* The game may replace its log while open. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return null;
  }

  // ─── Log tailing (mirrors Rust start_log_watcher) ──────
  start() {
    if (this._interval) return;
    this._log('Log watcher started. Candidate paths:');
    for (const p of LogWatcher.candidatePaths()) {
      this._log(`  ${p} ${fs.existsSync(p) ? '(EXISTS)' : '(not found)'}`);
    }
    this._poll(); // kick off immediately
    this._interval = setInterval(() => this._poll(), 500);
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    this._filePath = null;
    this._loginScan = null;
    this._pollStat = null;
    this._partialLine = null;
    this._pos = 0;
    this._loginSignal = false;
    this._logoutSignal = false;
  }

  _poll() {
    const file = this._findLog();
    const changedPath = file !== this._filePath;
    if (changedPath) {
      this._filePath = file;
      this._pollStat = null;
      this._loginSignal = false;
      this._logoutSignal = false;
    }
    if (!file) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      const previous = this._pollStat;
      this._pollStat = stat;
      if (!previous) {
        // Start tailing at EOF without treating a continuation as a new record.
        this._pos = stat.size;
        const tail = lastBytes(fd, stat.size).toString('latin1');
        const newline = tail.lastIndexOf('\n');
        this._partialLine = newline >= 0 || stat.size === tail.length ? tail.slice(newline + 1) : null;
        return;
      }
      if (stat.ino !== previous.ino || stat.birthtimeMs !== previous.birthtimeMs || stat.size < previous.size ||
        (stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs)) {
        this._pos = 0;
        this._partialLine = '';
        this._loginSignal = false;
        this._logoutSignal = false;
      }
      if (stat.size <= this._pos) return;

      const bytes = readLogBytes(fd, this._pos, Math.min(stat.size - this._pos, 65536));
      this._pos += bytes.length;
      const lines = bytes.toString('latin1').split('\n');
      if (this._partialLine === null) {
        lines.shift();
        if (!lines.length) return;
      } else {
        lines[0] = this._partialLine + lines[0];
      }
      const unfinished = lines.pop();
      this._partialLine = unfinished.length <= 1024 ? unfinished : null;
      for (const event of lines.join('\n').matchAll(sessionEvents)) {
        if (/^Log/i.test(event[1])) {
          this._loginSignal = true;
          this._log('Login event detected in EE.log');
        } else {
          this._loginSignal = false;
          this._logoutSignal = true;
          this._log('Logout event detected in EE.log');
        }
      }
    } catch {
      this._pollStat = null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // ─── Atomic-style signal consumers ─────────────────────
  consumeLogoutSignal() {
    if (this._logoutSignal) { this._logoutSignal = false; return true; }
    return false;
  }

  consumeLoginSignal() {
    if (this._loginSignal) { this._loginSignal = false; return true; }
    return false;
  }
}

module.exports = { LogWatcher };
