/**
 * Memory scanner – searches Soulframe process memory for nonce values.
 * Port of Rust scanner.rs
 *
 * Supported inventory integration:
 *   Windows: Pre-compiled C# scanner EXE (bundled at build time)
 *            Runs directly from the bundled resources directory.
 *   Linux: Bundled game-session helper, with an ordinary-permission /proc
 *          scanner fallback for development or unavailable helpers.
 *   macOS: Companion features only; no automatic memory scans.
 *
 * Speed optimisations vs previous PS-based version:
 *   - C# compiled to .exe once, no more PowerShell startup + Add-Type on each scan
 *   - 512KB read chunks (8x larger)
 *   - Skips regions < 4KB
 *   - Scans PAGE_READWRITE first (heap data), then others
 *   - Early exit on first nonce found (EXIT_EARLY flag)
 *   - UTF-16LE collapse scanning
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ApiClient } = require('./apiClient');
const { scanLinuxMemory } = require('./linuxMemoryScanner');

const execFileAsync = promisify(execFile);

const IS_WIN = os.platform() === 'win32';
const IS_LINUX = os.platform() === 'linux';

const NONCE_MIN_LEN = 5;
const NONCE_MAX_LEN = 20;
const MAX_REPEATED_DIGITS = 5;

// Bundled scanner EXE (built without obfuscation at build time via build-scanner.js)
// In production: lives under resources/bin/hostservice.exe
// In dev: lives under assets/bin/hostservice.exe
const IS_PACKAGED = !!(process.defaultApp === undefined && process.resourcesPath);
const BUNDLED_SCANNER_EXE = IS_PACKAGED
  ? path.join(process.resourcesPath, 'bin', 'hostservice.exe')
  : path.join(__dirname, '..', '..', 'assets', 'bin', 'hostservice.exe');
const BUNDLED_LINUX_SCANNER = IS_PACKAGED
  ? path.join(process.resourcesPath, 'bin', 'overkot-session-scanner')
  : path.join(__dirname, '..', '..', '.build', 'bin', 'overkot-session-scanner');

function parseLinuxHelperOutput(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 65536) throw new Error('Invalid helper response');
  const value = JSON.parse(output);
  const validCursor = cursor => Number.isSafeInteger(cursor) && cursor >= 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.accountIds) || value.accountIds.length > 16
    || !value.accountIds.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id))
    || !Array.isArray(value.nonces) || value.nonces.length > 32
    || !value.nonces.every(nonce => typeof nonce === 'string' && /^\d{5,20}$/.test(nonce))
    || !['', 'permission-denied', 'process-gone', 'wrong-process', 'scan-failed'].includes(value.error)
    || !validCursor(value.nextRegion) || !validCursor(value.nextOffset)) throw new Error('Invalid helper response');
  return { accountIds: [...new Set(value.accountIds.map(id => id.toLowerCase()))], nonces: [...new Set(value.nonces)],
    error: value.error === 'wrong-process' ? 'process-gone' : value.error,
    nextRegion: value.nextRegion, nextOffset: value.nextOffset };
}

class MemoryScanner {
  constructor(debug = false) {
    this.debug = debug;
    this.api = new ApiClient();
    this._seenNonces = new Set();
    this._foundAccountIds = new Set();
    this._scanAttempts = 0;
    this._exeReady = false;
    this._lastScanError = '';
    this._linuxScanState = null;
  }

  _log(...args) {
    if (!this.debug) return;
    const d = new Date(); const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    console.log(`[${ts}][SCANNER]`, ...args);
  }

  /**
   * Scan process memory for a working nonce (memory scan only).
   */
  async scanForWorkingNonce(pid, accountId) {
    if (!scannerSupported() || !accountId) return '';
    this._scanAttempts++;

    // Clear seen sets each attempt so candidates are always re-tested
    this._seenNonces.clear();
    this._foundAccountIds.clear();

    const extended = this._scanAttempts > 3;
    if (extended && this._scanAttempts === 4) {
      this._log('Switching to extended mode (larger regions)...');
    }
    this._log(`Memory scan (PID ${pid}, attempt #${this._scanAttempts}, mode=${extended ? 'extended' : 'normal'})...`);

    const memNonces = await this._scanProcessMemory(pid, extended);
    this._log(`  Found ${memNonces.length} candidate(s)`);

    if (memNonces.length > 0) {
      const result = await this._testNonces(memNonces, accountId);
      if (result) {
        this._log('  Valid session nonce found');
        return result;
      }
    }

    this._log('No valid nonce found this pass.');
    return '';
  }

  /**
   * Scan process memory for both accountId and nonce in one pass.
   * Uses memory-found accountId preferentially; falls back to fallbackAccountId.
   * @param {number} pid - Game process ID
   * @param {string} [fallbackAccountId=''] - AccountId from EE.log or other source
   * @returns {Promise<{accountId: string, nonce: string}>}
   */
  async scanForAccountAndNonce(pid, fallbackAccountId = '') {
    if (!scannerSupported()) return { accountId: fallbackAccountId, nonce: '' };
    this._scanAttempts++;
    this._seenNonces.clear();
    this._foundAccountIds.clear();

    const extended = this._scanAttempts > 3;
    if (extended && this._scanAttempts === 4) {
      this._log('Switching to extended mode (larger regions)...');
    }
    this._log(`Combined scan (PID ${pid}, attempt #${this._scanAttempts}, mode=${extended ? 'extended' : 'normal'})...`);

    const memNonces = await this._scanProcessMemory(pid, extended);

    // Prefer memory-found accountId, fall back to provided one
    const accountId = this._foundAccountIds.size > 0
      ? [...this._foundAccountIds][0]
      : fallbackAccountId;

    this._log(`  Found ${memNonces.length} nonce(s), ${this._foundAccountIds.size} account(s)${accountId ? ` [${accountId}]` : ''}`);

    if (memNonces.length > 0 && accountId) {
      const nonce = await this._testNonces(memNonces, accountId);
      if (nonce) {
        this._log('  Valid account/session pair found');
        return { accountId, nonce };
      }
    }

    return { accountId, nonce: '', ...(this._lastScanError ? { scanError: this._lastScanError } : {}) };
  }

  /**
   * Get account IDs found during the last memory scan.
   * @returns {string[]}
   */
  getFoundAccountIds() {
    return [...this._foundAccountIds];
  }

  // ═══════════════════════════════════════════════════════
  // Memory scanning (cross-platform dispatch)
  // ═══════════════════════════════════════════════════════

  async _scanProcessMemory(pid, extended = false) {
    this._lastScanError = '';
    if (IS_WIN) return this._scanMemoryWindows(pid, extended);
    if (IS_LINUX) return this._scanMemoryLinux(pid, extended);
    this._log(`Memory scanning not supported on ${os.platform()}`);
    return [];
  }

  // ═══════════════════════════════════════════════════════
  // Windows: Pre-compiled C# EXE scanner
  // ═══════════════════════════════════════════════════════

  async _ensureScannerExe() {
    if (this._exeReady) return true;
    this._exeReady = scannerAvailableSync();
    return this._exeReady;
  }

  async _scanMemoryWindows(pid, extended) {
    const candidates = [];
    const maxRegionMB = extended ? 64 : 4;

    // Run the build-time helper directly from the installed resources.
    if (!(await this._ensureScannerExe())) {
      return candidates;
    }

    try {
      const t0 = Date.now();
      const { stdout: output } = await execFileAsync(
        BUNDLED_SCANNER_EXE, [String(pid), String(maxRegionMB)],
        { encoding: 'utf-8', windowsHide: true, timeout: extended ? 60000 : 30000, maxBuffer: 10 * 1024 * 1024 }
      );

      this._parseNonceOutput(output, candidates);
      this._extractNoncesFromText(output, candidates);

      const elapsed = Date.now() - t0;
      const lines = output.trim().split('\n').filter(l => l.trim());
      this._log(`  Scan completed in ${elapsed}ms (${lines.length} output lines)`);
    } catch (e) {
      this._log(`Scanner EXE error: ${e.message?.slice(0, 200)}`);
      // Invalidate EXE cache on failure
      this._exeReady = false;
    }
    return candidates;
  }

  // ═══════════════════════════════════════════════════════
  // Linux: experimental /proc/PID/maps + /proc/PID/mem implementation.
  // ═══════════════════════════════════════════════════════

  async _scanMemoryLinux(pid, extended) {
    if (!Number.isSafeInteger(pid) || pid <= 0) { this._lastScanError = 'process-gone'; return []; }
    if (this._linuxScanState?.pid !== pid) this._linuxScanState = { pid };
    let helperAvailable = false;
    try { helperAvailable = fs.statSync(BUNDLED_LINUX_SCANNER).isFile(); } catch { /* Direct scanner remains available. */ }
    if (helperAvailable) {
      try {
        const { stdout } = await execFileAsync(BUNDLED_LINUX_SCANNER,
          [String(pid), extended ? 'extended' : 'normal', String(this._linuxScanState.helperNextRegion || 0), String(this._linuxScanState.helperNextOffset || 0)],
          { encoding: 'utf8', timeout: extended ? 17000 : 12000, maxBuffer: 65536 });
        const result = parseLinuxHelperOutput(stdout);
        this._lastScanError = result.error;
        this._linuxScanState.helperNextRegion = result.nextRegion;
        this._linuxScanState.helperNextOffset = result.nextOffset;
        if (result.error) return [];
        for (const id of result.accountIds) this._foundAccountIds.add(id);
        return result.nonces.filter(nonce => this._isValidNonce(nonce));
      } catch (error) {
        // A missing helper or a filesystem/capability execution restriction may
        // still permit direct access. Malformed output and timeouts are errors.
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) {
          this._lastScanError = 'scan-failed';
          return [];
        }
      }
    }
    const candidates = [];
    const found = new Set();
    // A bounded batch prevents corrupt/noisy memory from creating unlimited API
    // requests. The native cursor resumes later mappings on the following pass.
    const candidateLimit = 32;
    const result = await scanLinuxMemory(pid, text => {
      const extracted = [];
      this._extractNoncesFromText(text, extracted);
      for (const nonce of extracted) {
        if (!found.has(nonce)) { found.add(nonce); candidates.push(nonce); }
        if (found.size >= candidateLimit) return false;
      }
      return true;
    }, { extended, state: this._linuxScanState });
    this._lastScanError = result.error;
    this._log(`  Linux scan: ${result.regionsScanned} regions, ${result.bytesRead} bytes${result.limited ? ' (scan limit reached)' : ''}${result.error ? ` (${result.error})` : ''}`);
    return candidates;
  }

  // ═══════════════════════════════════════════════════════
  // Nonce extraction & validation
  // ═══════════════════════════════════════════════════════

  _parseNonceOutput(text, out) {
    // Parse nonce lines
    const nonceRx = /^NONCE:(\d{5,20})$/gm;
    let m;
    while ((m = nonceRx.exec(text)) !== null) {
      const nonce = m[1];
      if (this._isValidNonce(nonce) && !this._seenNonces.has(nonce)) {
        out.push(nonce);
      }
    }
    // Parse account ID lines from C# scanner output
    const acctRx = /^ACCOUNT:([a-f0-9]{24})$/gm;
    while ((m = acctRx.exec(text)) !== null) {
      this._foundAccountIds.add(m[1].toLowerCase());
    }
  }

  _extractNoncesFromText(text, out) {
    // Try full pattern with accountId first
    const fullRx = /accountId=([a-f0-9]{24})&nonce=(\d{5,20})&ct=MSI/gi;
    let m;
    while ((m = fullRx.exec(text)) !== null) {
      this._foundAccountIds.add(m[1].toLowerCase());
      const nonce = m[2];
      if (this._isValidNonce(nonce) && !this._seenNonces.has(nonce)) {
        out.push(nonce);
      }
    }
    // Also catch nonces without accountId prefix (standalone &nonce= or ?nonce=)
    const nonceRx = /[&?]nonce=(\d{5,20})&ct=MSI/gi;
    while ((m = nonceRx.exec(text)) !== null) {
      const nonce = m[1];
      if (this._isValidNonce(nonce) && !this._seenNonces.has(nonce)) {
        out.push(nonce);
      }
    }
  }

  _isValidNonce(nonce) {
    if (nonce.length < NONCE_MIN_LEN || nonce.length > NONCE_MAX_LEN) return false;
    if (!/^\d+$/.test(nonce)) return false;
    let run = 1;
    for (let i = 1; i < nonce.length; i++) {
      if (nonce[i] === nonce[i - 1]) {
        run++;
        if (run >= MAX_REPEATED_DIGITS) return false;
      } else {
        run = 1;
      }
    }
    return true;
  }

  async _testNonces(nonces, accountId) {
    const BATCH_SIZE = 3;
    for (let i = 0; i < nonces.length; i += BATCH_SIZE) {
      const batch = nonces.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (nonce) => {
          const ok = await this.api.testSingleNonce(accountId, nonce);
          return { nonce, ok };
        })
      );
      for (const { nonce, ok } of results) {
        this._log(`  Session candidate => ${ok ? 'VALID' : 'invalid'}`);
        if (ok) return nonce;
        // Track failed nonces so they aren't re-tested within this scan pass
        this._seenNonces.add(nonce);
      }
    }
    return '';
  }
}

/** Platforms with an inventory scanner implementation; Linux remains experimental. */
function scannerSupported() { return IS_WIN || IS_LINUX; }

/** Detect the scanner backend without changing process-memory permissions. */
function scannerAvailableSync() {
  if (IS_LINUX) return fs.existsSync('/proc/self/maps');
  try { return IS_WIN && fs.statSync(BUNDLED_SCANNER_EXE).isFile(); }
  catch { return false; }
}

module.exports = { MemoryScanner, scannerAvailableSync, scannerSupported, parseLinuxHelperOutput };
