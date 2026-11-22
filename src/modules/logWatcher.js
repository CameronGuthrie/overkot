/**
 * EE.log watcher – detects login/logout events and extracts account ID.
 * Port of Rust log_watcher.rs + memory.rs extract_account_id_from_ee_log()
 */

const fs = require('fs');
const { getGamePathResolver } = require('./gamePaths');

class LogWatcher {
  constructor(debug = false) {
    this.debug = debug;
    this._logoutSignal = false;
    this._loginSignal = false;
    this._watcher = null;
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
  _findLog() {
    for (const p of LogWatcher.candidatePaths()) {
      try {
        if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.R_OK); return p; }
      } catch { /* Try the next discovered file. */ }
    }
    return null;
  }

  // ─── Account ID extraction (mirrors Rust patterns) ─────
  /**
   * Read EE.log and extract the most common 24-hex account id.
   * @returns {string} account id or empty string
   */
  extractAccountId() {
    for (const p of LogWatcher.candidatePaths()) {
      if (!fs.existsSync(p)) continue;

      let content;
      try { content = fs.readFileSync(p, 'utf-8'); } catch { continue; }

      this._log(`Scanning ${p} (${(content.length/1024).toFixed(0)} KB) for account IDs...`);

      const patterns = [
        /AccountId:\s*([a-f0-9]{24})/gi,
        /Logged in \w+ \(([a-f0-9]{24})\)/gi,
        /account[_\s]*id[:\s=]*([a-f0-9]{24})/gi,
        /\(([a-f0-9]{24})\)/gi,
      ];

      /** @type {Map<string, number>} */
      const candidates = new Map();

      for (const rx of patterns) {
        let m;
        while ((m = rx.exec(content)) !== null) {
          const id = m[1].toLowerCase();
          if (LogWatcher._isValid24Hex(id)) {
            candidates.set(id, (candidates.get(id) || 0) + 1);
          }
        }
      }

      if (candidates.size > 0) {
        // Return the id with the highest count
        let best = '';
        let bestCount = 0;
        for (const [id, count] of candidates) {
          if (count > bestCount) { best = id; bestCount = count; }
        }
        this._log(`Found ${candidates.size} candidate(s), best: ${best} (seen ${bestCount}x)`);
        return best;
      }
    }
    this._log('No account ID found in any EE.log path.');
    return '';
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
  currentLogin() {
    const file = this._filePath || this._findLog();
    if (!file) return null;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const { size, ino, birthtimeMs, mtimeMs } = fs.fstatSync(fd);
      const previous = this._loginScan;
      const sameFile = previous?.file === file && previous.ino === ino && previous.birthtimeMs === birthtimeMs;
      if (sameFile && previous.size === size && previous.mtimeMs === mtimeMs) return previous.login;
      const appended = sameFile && previous.size < size;
      const lowerBound = appended ? Math.max(0, previous.size - 256) : 0;
      let login = appended ? previous.login : null;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let overlap = '';
      for (let end = size; end > lowerBound;) {
        const start = Math.max(lowerBound, end - buffer.length);
        const bytes = fs.readSync(fd, buffer, 0, end - start, start);
        const block = buffer.toString('latin1', 0, bytes) + overlap;
        const events = block.matchAll(/Logged in (?:([^\s]{1,128}) \(([a-f0-9]{24})\))?|QUIT :Logged out of game|\[Info\]: Logging in as /gi);
        let last;
        for (const event of events) if (event.index < bytes) last = event;
        if (last) {
          login = last[1] ? { accountId: last[2].toLowerCase(), name: last[1] } : null;
          break;
        }
        overlap = block.slice(0, 256);
        end = start;
      }
      this._loginScan = { file, size, ino, birthtimeMs, mtimeMs, login };
      return login;
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
    this._pos = 0;
    this._loginSignal = false;
    this._logoutSignal = false;
  }

  _poll() {
    if (this._filePath && !LogWatcher.candidatePaths().includes(this._filePath)) {
      this._filePath = null;
      this._pos = 0;
      this._loginSignal = false;
      this._logoutSignal = false;
    }
    // Find or re-find the log
    if (!this._filePath || !fs.existsSync(this._filePath)) {
      this._filePath = this._findLog();
      this._pos = 0;
      if (!this._filePath) return;

      // Start at end (only process new lines)
      try {
        const stat = fs.statSync(this._filePath);
        this._pos = stat.size;
      } catch { return; }

      if (this._filePath) {
        this._log(`EE.log detected at ${this._filePath}`);
      }
    }

    // Read new data
    try {
      const stat = fs.statSync(this._filePath);

      // Handle truncation/rotation
      if (stat.size < this._pos) this._pos = 0;

      if (stat.size <= this._pos) return;

      const fd = fs.openSync(this._filePath, 'r');
      const toRead = Math.min(stat.size - this._pos, 65536);
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, this._pos);
      fs.closeSync(fd);
      this._pos += toRead;

      const chunk = buf.toString('utf-8');
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.includes('QUIT :Logged out of game')) {
          this._logoutSignal = true;
          this._log('Logout event detected in EE.log');
        }
        if (trimmed.includes('[Info]: Logging in as ') || trimmed.includes('[Info]: Logged in ')) {
          this._loginSignal = true;
          this._log('Login event detected in EE.log');
        }
      }
    } catch {
      // File may have disappeared
      this._filePath = null;
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
