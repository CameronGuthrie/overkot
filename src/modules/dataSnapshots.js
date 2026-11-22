'use strict';

const fs = require('node:fs/promises');
const { INVENTORY_CACHE_PATH } = require('./appPaths');
const { decryptData, deriveCacheKey } = require('./fileEncryption');
const { getGamePathResolver } = require('./gamePaths');

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_RECORDS = 2000;
const MAX_INVENTORY_BYTES = 32 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isFinite(value) && value > 0 ? value : null;
const KINDS = new Map([['inventory', 'inventory'], ['data-inventory', 'inventory'], ['ee-log', 'ee-log'],
  ['ee.log', 'ee-log'], ['data-ee-log', 'ee-log']]);
const kindOf = value => KINDS.get(value) || null;
const issue = (code, message) => ({ code, message });

function severityOf(value) {
  return ({ warning: 'warning', warn: 'warning', error: 'error', fatal: 'error', assert: 'error',
    debug: 'debug', trace: 'debug', info: 'info', information: 'info' })[String(value || '').toLowerCase()] || 'plain';
}

/** Parse real EE.log headers while preserving unknown lines and original text. */
function parseLogRecords(text, { maxRecords = MAX_LOG_RECORDS } = {}) {
  const records = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() && !records.length) continue;
    if (!raw && i === lines.length - 1) continue;
    // Soulframe normally uses elapsed seconds, a subsystem, then [Info]:.
    const header = /^(?:(\d+(?:\.\d+)?|\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s+)?([^\[\]\r\n]{1,120}?)\s*\[(Info|Information|Warn|Warning|Error|Fatal|Assert|Debug|Trace)\]\s*:?\s*(.*)$/i.exec(raw.trim());
    const simple = !header && /^(?:\[(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*)?\[(Info|Warn|Warning|Error|Fatal|Debug|Trace)\]\s*:?\s*(.*)$/i.exec(raw.trim());
    const previous = records[records.length - 1];
    const continuation = !header && !simple && previous && (/^\s/.test(raw)
      || /^[}\]],?\s*$/.test(raw) || /^at\s/.test(raw.trim()) || previous._jsonState?.depth > 0);
    if (continuation || (!raw.trim() && previous)) {
      previous.raw += '\n' + raw;
      previous.message += '\n' + raw;
      previous.lineEnd = i + 1;
      if (previous._jsonState) advanceJSON(previous._jsonState, '\n' + raw);
      continue;
    }
    const time = header?.[1] || simple?.[1] || null;
    const message = header ? header[4] : simple ? simple[3] : raw;
    records.push({ id: i + 1, lineStart: i + 1, lineEnd: i + 1,
      timestamp: time, elapsedSeconds: time && /^\d+(?:\.\d+)?$/.test(time) ? Number(time) : null,
      category: header?.[2]?.trim() || 'General', severity: severityOf(header?.[3] || simple?.[2]),
      message, raw, detail: null, json: null, _jsonState: initialJSONState(message) });
  }
  const discardedRecords = Math.max(0, records.length - maxRecords);
  const selected = records.slice(discardedRecords);
  for (const record of selected) {
    delete record._jsonState;
    const json = extractJSON(record.message);
    if (json) { record.json = json.value; record.detail = JSON.stringify(json.value, null, 2); }
  }
  return { records: selected, discardedRecords, totalRecords: records.length, linesRead: lines.length - (lines.at(-1) === '' ? 1 : 0) };
}

function extractJSON(message) {
  const trimmed = message.trim();
  const start = trimmed.search(/[\[{]/);
  if (start < 0) return null;
  try {
    const value = JSON.parse(trimmed.slice(start));
    return value && typeof value === 'object' ? { value } : null;
  } catch { return null; }
}

function initialJSONState(message) {
  const start = message.search(/[\[{]/);
  if (start < 0) return null;
  // Continuations are accepted only after plausible JSON, not arbitrary [tags].
  const value = message.slice(start).trim();
  if (!/^\{\s*(?:"[^"\n]*"(?:\s*:)?|$)/.test(value)
      && !/^\[\s*(?:\{|"|-?\d|true|false|null|$)/.test(value)) return null;
  const state = { depth: 0, quoted: false, escaped: false };
  advanceJSON(state, value);
  return state;
}

function advanceJSON(state, value) {
  for (const char of value) {
    if (state.quoted) {
      if (state.escaped) state.escaped = false;
      else if (char === '\\') state.escaped = true;
      else if (char === '"') state.quoted = false;
    } else if (char === '"') state.quoted = true;
    else if (char === '{' || char === '[') state.depth++;
    else if (char === '}' || char === ']') state.depth = Math.max(0, state.depth - 1);
  }
}

async function defaultNames(inventory, language) {
  const { ensureNamesForLanguage, loadLanguageData } = require('./languageNames');
  const { collectInventoryNames } = require('../renderer/inventory-format');
  return collectInventoryNames(inventory, await ensureNamesForLanguage(language, { network: false }),
    loadLanguageData(language, { compact: false }));
}

/** On-demand snapshots. Reading never starts a game/API/file watcher. */
class DataSnapshots {
  constructor({ getSession = () => null, getLogPath = () => getGamePathResolver().status().eeLog.path,
    getLanguage = () => 'en', getNames = defaultNames, cachePath = INVENTORY_CACHE_PATH,
    fsImpl = fs, now = Date.now, maxLogBytes = MAX_LOG_BYTES, maxLogRecords = MAX_LOG_RECORDS,
    maxInventoryBytes = MAX_INVENTORY_BYTES } = {}) {
    Object.assign(this, { getSession, getLogPath, getLanguage, getNames, cachePath, fs: fsImpl, now,
      maxLogBytes, maxLogRecords, maxInventoryBytes });
    this.pendingReads = new Map(); this.pendingRefreshes = new Map();
  }

  read(kind) {
    const key = kindOf(kind);
    if (!key) return Promise.resolve(this._empty(String(kind), issue('unknown-kind', 'Choose inventory or EE.log.')));
    if (this.pendingReads.has(key)) return this.pendingReads.get(key);
    const task = (key === 'inventory' ? this._inventory() : this._log())
      .finally(() => this.pendingReads.delete(key));
    this.pendingReads.set(key, task);
    return task;
  }

  refresh(kind) {
    const key = kindOf(kind);
    if (!key) return this.read(kind);
    if (this.pendingRefreshes.has(key)) return this.pendingRefreshes.get(key);
    const task = (key === 'inventory' ? this._refreshInventory() : this._refreshLog())
      .finally(() => this.pendingRefreshes.delete(key));
    this.pendingRefreshes.set(key, task);
    return task;
  }

  _empty(kind, error = null) {
    return { kind, ok: false, inventory: null, records: [], names: {}, invalidatePrevious: false,
      metadata: { source: 'none', accountId: null, path: null, savedAt: null, fetchedAt: null, fileModifiedAt: null,
        readAt: this.now(), cached: false, canRefresh: false, truncated: false,
        totalBytes: 0, bytesRead: 0, recordCount: 0 }, error,
      refresh: { requested: false, updated: false, message: '' } };
  }

  _sessionAvailable(session) {
    return !!session && session._running !== false && !session.isNonceExpired?.()
      && typeof session.refreshNow === 'function';
  }

  _changedInventory() {
    const result = this._empty('inventory', issue('session-changed', 'The Soulframe account changed. Refresh again.'));
    result.metadata.accountId = this.getSession()?.accountId || null;
    result.invalidatePrevious = true;
    return result;
  }

  async _inventory() {
    const result = this._empty('inventory');
    const session = this.getSession();
    result.metadata.accountId = session?.accountId || null;
    result.metadata.canRefresh = this._sessionAvailable(session);
    let inventory = session?.getRawInventory?.();
    result.invalidatePrevious = !!session && !plain(inventory);
    if (plain(inventory)) {
      result.metadata.source = session.isInventoryCached?.() ? 'cache' : 'session';
      result.metadata.cached = session.isInventoryCached?.() === true;
      result.metadata.savedAt = timestamp(session.getInventorySavedAt?.() || session.getLastSuccessfulPollAt?.());
      result.metadata.fetchedAt = timestamp(session.getLastSuccessfulPollAt?.());
      if (result.metadata.cached) result.metadata.path = this.cachePath;
    } else {
      try {
        const stat = await this.fs.stat(this.cachePath);
        if (!stat.isFile() || stat.size > this.maxInventoryBytes) {
          return { ...result, error: issue('cache-unreadable', 'The saved inventory is too large or cannot be read.') };
        }
        const bytes = await this.fs.readFile(this.cachePath);
        let data;
        try {
          const decrypted = decryptData(bytes, deriveCacheKey());
          if (decrypted !== null) data = JSON.parse(decrypted);
        } catch { /* Legacy plaintext caches are accepted without rewriting them. */ }
        if (!data) { try { data = JSON.parse(bytes.toString('utf8')); } catch {} }
        if (!plain(data?.rawInventory)) {
          return { ...result, error: issue('cache-unreadable', 'The saved inventory is unreadable. Open Soulframe and refresh it.') };
        }
        // Never substitute an older account's disk cache for the current login.
        if (session && (!data.accountId || data.accountId !== session.accountId)) {
          return { ...result, error: issue('inventory-waiting', 'Waiting for inventory from the current Soulframe account.') };
        }
        inventory = data.rawInventory;
        Object.assign(result.metadata, { source: 'cache', cached: true, path: this.cachePath,
          accountId: data.accountId || null, savedAt: timestamp(data.savedAt), fileModifiedAt: stat.mtimeMs,
          totalBytes: stat.size, bytesRead: bytes.length });
      } catch (error) {
        return { ...result, error: issue(error.code === 'ENOENT' ? 'inventory-missing' : 'cache-unreadable',
          error.code === 'ENOENT' ? 'No inventory has been saved yet. Open Soulframe, sign in, then refresh.'
            : 'The saved inventory cannot be read. Open Soulframe and refresh it.') };
      }
    }
    // An account switch during disk IO must not expose the previous account's data.
    if (session !== this.getSession()) return this._changedInventory();
    result.ok = true; result.inventory = inventory; result.invalidatePrevious = false;
    try { result.names = await this.getNames(inventory, this.getLanguage()) || {}; } catch { /* Readable fallbacks remain available. */ }
    if (session !== this.getSession()) return this._changedInventory();
    return result;
  }

  async _refreshInventory() {
    const session = this.getSession();
    let refreshed = { ok: false, reason: 'session-unavailable' };
    if (this._sessionAvailable(session)) {
      try { refreshed = await session.refreshNow(); }
      catch { refreshed = { ok: false, reason: 'refresh-failed' }; }
    }
    const result = await this._inventory();
    const changed = session !== this.getSession();
    const updated = !changed && refreshed?.ok === true;
    result.refresh = { requested: true, updated, message: updated ? 'Inventory refreshed from Soulframe.'
      : changed ? 'The Soulframe account changed. Refresh again.'
        : refreshed?.reason === 'session-expired' ? 'The Soulframe session expired. Sign in again to refresh.'
          : refreshed?.reason === 'refresh-failed' ? 'Soulframe did not return new inventory. The last snapshot is still shown.'
            : 'Showing the last saved inventory. Open Soulframe and sign in to fetch a new snapshot.' };
    if (!updated && !['session-unavailable'].includes(refreshed?.reason)) {
      result.error = issue(changed ? 'session-changed' : refreshed?.reason || 'refresh-failed', result.refresh.message);
    }
    return result;
  }

  async _refreshLog() {
    const result = await this._log();
    result.refresh = { requested: true, updated: result.ok,
      message: result.ok ? 'EE.log reloaded from disk.' : result.error?.message || 'EE.log could not be reloaded.' };
    return result;
  }

  async _log(attempt = 0) {
    const result = this._empty('ee-log');
    result.metadata.canRefresh = true;
    const filename = this.getLogPath();
    result.metadata.path = typeof filename === 'string' ? filename : null;
    if (!filename) return { ...result, error: issue('log-missing', 'EE.log was not found. Open Soulframe or choose its log in Settings → Game Files.') };
    let handle;
    try {
      handle = await this.fs.open(filename, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
      const start = Math.max(0, stat.size - this.maxLogBytes);
      const previous = start > 0 ? 1 : 0;
      const buffer = Buffer.alloc(Math.min(stat.size, this.maxLogBytes + previous));
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start - previous + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      const after = await handle.stat();
      let currentPath = null;
      try { currentPath = await this.fs.stat?.(filename); } catch { /* A log may be temporarily absent during rotation. */ }
      const replaced = currentPath && (currentPath.ino !== stat.ino || currentPath.dev !== stat.dev);
      if ((after.size < stat.size || replaced) && attempt < 1) {
        await handle.close(); handle = null; return this._log(attempt + 1);
      }
      let bytes = buffer.subarray(previous, filled);
      let omittedPartialLine = false;
      if (start > 0 && buffer[0] !== 10 && buffer[0] !== 13) {
        const newline = bytes.indexOf(10);
        if (newline >= 0) { bytes = bytes.subarray(newline + 1); omittedPartialLine = true; }
      }
      const parsed = parseLogRecords(bytes.toString('utf8'), { maxRecords: this.maxLogRecords });
      result.ok = true; result.records = parsed.records;
      Object.assign(result.metadata, { source: 'file', fileModifiedAt: stat.mtimeMs,
        totalBytes: stat.size, bytesRead: Math.max(0, filled - previous), recordCount: result.records.length,
        totalRecordsRead: parsed.totalRecords, linesRead: parsed.linesRead, discardedRecords: parsed.discardedRecords,
        truncated: start > 0 || parsed.discardedRecords > 0, omittedPartialLine,
        maxBytes: this.maxLogBytes, maxRecords: this.maxLogRecords,
        startsMidLine: start > 0 && !omittedPartialLine && buffer[0] !== 10 && buffer[0] !== 13,
        changedDuringRead: !!replaced || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs });
      return result;
    } catch (error) {
      return { ...result, error: issue(error.code === 'ENOENT' ? 'log-missing' : 'log-unreadable',
        error.code === 'ENOENT' ? 'EE.log was not found. Open Soulframe or choose its log in Settings → Game Files.'
          : 'EE.log cannot be read right now. Try Refresh after Soulframe has finished writing it.') };
    } finally { if (handle) await handle.close().catch(() => {}); }
  }
}

module.exports = { DataSnapshots, parseLogRecords, MAX_LOG_BYTES, MAX_LOG_RECORDS, MAX_INVENTORY_BYTES };
