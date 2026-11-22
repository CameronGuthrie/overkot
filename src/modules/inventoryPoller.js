/**
 * Inventory poller – fetches timer data from the Soulframe API.
 * Port of Rust inventory.rs
 */

const { ApiClient } = require('./apiClient');
const fs = require('fs');
const os = require('os');
const { INVENTORY_CACHE_PATH } = require('./appPaths');
const { deriveCacheKey, encryptData, decryptData } = require('./fileEncryption');
const { dailyAffiliationProgress } = require('./affiliationProgress');

class InventoryPoller {
  /**
   * @param {string} accountId
   * @param {string} nonce
   * @param {boolean} debug
   */
  constructor(accountId, nonce, debug = false) {
    this.accountId = accountId;
    this.nonce = nonce;
    this.debug = debug;
    this.api = new ApiClient();
    /** @type {Array<{tag: string, expiryTime: number}>} */
    this._timers = [];
    /** @type {{earned: number|null, remaining: number, cap: number|null}|null} */
    this._dailyAffiliation = null;
    /** @type {{earned: number|null, remaining: number, cap: number|null}|null} */
    this._dailyAffiliationOde = null;
    /** @type {Array<{tag: string, standing: number, title: number, initiated: boolean}>|null} */
    this._factions = null;
    /** @type {object|null} Full raw inventory response for future feature use */
    this._rawInventory = null;
    this._inventoryFromCache = false;
    this._running = false;
    this._timeoutId = null;
    this._nonceExpired = false;
    this._lastSuccessfulPollAt = 0;
    this._inventorySavedAt = 0;
    this._pendingPoll = null;
    this._cacheKey = deriveCacheKey();

    // Try to restore cached timers from disk
    this._loadCache();
  }

  _log(...args) {
    if (!this.debug) return;
    const d = new Date(); const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    console.log(`[${ts}][POLLER]`, ...args);
  }

  /** Generate a random polling interval between 2 and 7 seconds (in ms). */
  _randomInterval() {
    return (2 + Math.random() * 5) * 1000;
  }

  /** Start polling in the background. */
  start() {
    this._running = true;
    this._log(`Starting (account=${this.accountId.slice(0,8)}..., randomised interval 2-7s)`);
    this._tick(); // immediate first poll
  }

  /** Stop polling. */
  stop() {
    this._running = false;
    if (this._timeoutId) clearTimeout(this._timeoutId);
  }

  /** Get a snapshot of current timers. */
  getTimers() {
    return [...this._timers];
  }

  /** Get daily affiliation progress, including the exact server balance. */
  getDailyAffiliation() {
    return this._dailyAffiliation;
  }

  /** Get daily Ode progress, with its independent server balance. */
  getDailyAffiliationOde() {
    return this._dailyAffiliationOde;
  }

  /** Get processed faction standings (only initiated factions). */
  getFactions() {
    return this._factions;
  }

  /** Returns true if the API reported the nonce is no longer valid. */
  isNonceExpired() {
    return this._nonceExpired;
  }

  getLastSuccessfulPollAt() {
    return this._lastSuccessfulPollAt;
  }

  /** Timestamp of the displayed inventory, including a restored disk snapshot. */
  getInventorySavedAt() {
    return this._inventorySavedAt;
  }

  /** One explicit refresh, shared with an in-flight background poll. */
  refreshNow() {
    if (!this._running || this._nonceExpired) {
      return Promise.resolve({ ok: false, reason: 'session-unavailable' });
    }
    return this._requestInventory();
  }

  _requestInventory() {
    if (this._pendingPoll) return this._pendingPoll;
    this._pendingPoll = this._fetchInventory().finally(() => { this._pendingPoll = null; });
    return this._pendingPoll;
  }

  async _fetchInventory() {
    try {
      const result = await this.api.fetchInventory(this.accountId, this.nonce);
      // A response belonging to a stopped session must not overwrite the cache.
      if (!this._running) return { ok: false, reason: 'session-unavailable' };
      if (result?.nonceExpired) {
        this._nonceExpired = true;
        this.stop();
        this._log('Nonce expired (INVALID_NONCE / Log-in expired) -- stopping poller');
        return { ok: false, reason: 'session-expired' };
      }
      if (result?.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
        this._processInventory(result.data);
        this._lastSuccessfulPollAt = this._inventorySavedAt;
        this._log(`Poll OK -- ${this._timers.length} timer(s) active`);
        return { ok: true };
      }
      this._log('Poll returned null/empty inventory');
    } catch (e) {
      this._log(`Poll error: ${e.message}`);
    }
    return { ok: false, reason: 'refresh-failed' };
  }

  // ─── Internal ──────────────────────────────────────────
  async _tick() {
    if (!this._running) return;
    await this._requestInventory();

    if (this._running) {
      const interval = this._randomInterval();
      this._log(`Next poll in ${(interval / 1000).toFixed(1)}s`);
      this._timeoutId = setTimeout(() => this._tick(), interval);
    }
  }

  /**
   * Process an inventory response into timer entries.
   * Mirrors Rust start_inventory_polling() logic.
   * @param {object} inv
   */
  _processInventory(inv) {
    // Store the full raw inventory for future features
    this._rawInventory = inv;
    this._inventoryFromCache = false;
    this._inventorySavedAt = Date.now();

    const nowSecs = Math.floor(Date.now() / 1000);
    const timers = [];

    // Tags to ignore (not useful as visible timers)
    const IGNORED_TAGS = new Set([
      'OrengallQuest',
    ]);

    // 1. ExpiryTimeTrackers (server-provided timers)
    //    Only keep timers that haven't expired yet (+ 60s grace so "Ready"
    //    is briefly visible before the entry disappears on the next poll).
    if (Array.isArray(inv.ExpiryTimeTrackers)) {
      for (const t of inv.ExpiryTimeTrackers) {
        if (IGNORED_TAGS.has(t.Tag)) continue;
        if (t.ExpiryTime > nowSecs - 60) {
          timers.push({ tag: t.Tag, expiryTime: t.ExpiryTime });
        }
      }
    }

    // 2. WevetSeed cooldown from Consumables array
    if (Array.isArray(inv.Consumables)) {
      for (const item of inv.Consumables) {
        if (item.ItemType === '/SF/Types/Items/Consumables/WevetSeed') {
          const oid = item.LastAdded?.$oid;
          if (oid) {
            const pickupTime = InventoryPoller._extractTimestampFromOid(oid);
            if (pickupTime) {
              const expiry = pickupTime + (12 * 3600); // 12-hour cooldown
              if (expiry > nowSecs) {
                timers.push({ tag: 'NextRefill', expiryTime: expiry });
              }
            }
          }
          break;
        }
      }
    }

    // 3. LastSyndicateSwapTime
    if (inv.LastSyndicateSwapTime?.$date?.$numberLong) {
      const tsMs = parseInt(inv.LastSyndicateSwapTime.$date.$numberLong, 10);
      if (!isNaN(tsMs)) {
        const expiry = Math.floor(tsMs / 1000) + 1; // 1 second (reduced from 7 days)
        if (expiry > nowSecs) {
          timers.push({ tag: 'LastSyndicateSwapTime', expiryTime: expiry });
        }
      }
    }

    // 4. PendingRecipes (foundry crafts)
    if (Array.isArray(inv.PendingRecipes)) {
      for (const recipe of inv.PendingRecipes) {
        const rawName = recipe.ItemType || '';
        const baseName = rawName.split('/').pop() || rawName;
        const itemName = baseName
          .replace(/RecipeItem$/, '')
          .replace(/Blueprint$/, '')
          .replace(/Recipe$/, '');

        const tsMs = recipe.CompletionDate?.$date?.$numberLong;
        if (tsMs) {
          const expiry = Math.floor(parseInt(tsMs, 10) / 1000);
          if (expiry > nowSecs) {
            timers.push({ tag: `PendingRecipe:${itemName}`, expiryTime: expiry });
          }
        }
      }
    }

    this._timers = timers;

    // 5. Both server values are REMAINING balances. The allowance depends on
    // the player's rank; keep the exact balance even when the rank is missing.
    this._dailyAffiliation = dailyAffiliationProgress(inv);
    this._dailyAffiliationOde = dailyAffiliationProgress(inv, 'DailyAffiliationOde');

    // 6. Affiliations (faction standing). Keep all entries so non-initiated
    //    syndicates (e.g. OdeSyndicate / Ode Infamy) can be tracked too.
    //    Renderers filter by tag.
    if (Array.isArray(inv.Affiliations)) {
      this._factions = inv.Affiliations.map(a => ({
        tag: a.Tag,
        standing: a.Standing || 0,
        title: a.Title || 0,
        initiated: a.Initiated === true,
      }));
    }

    // Persist to disk for cross-restart recovery
    this._saveCache();
  }

  /** Save current timers to disk (encrypted) */
  _saveCache() {
    try {
      const data = {
        timers: this._timers,
        dailyAffiliation: this._dailyAffiliation,
        dailyAffiliationOde: this._dailyAffiliationOde,
        factions: this._factions,
        rawInventory: this._rawInventory,
        accountId: this.accountId,
        savedAt: this._inventorySavedAt || Date.now(),
      };
      const plaintext = JSON.stringify(data);
      const encrypted = encryptData(plaintext, this._cacheKey);
      fs.writeFileSync(INVENTORY_CACHE_PATH, encrypted);
    } catch (e) {
      this._log(`Cache save failed: ${e.message}`);
    }
  }

  /** Load timers from encrypted disk cache (if still valid) */
  _loadCache() {
    try {
      if (!fs.existsSync(INVENTORY_CACHE_PATH)) return;
      const encrypted = fs.readFileSync(INVENTORY_CACHE_PATH);
      const plaintext = decryptData(encrypted, this._cacheKey);
      if (!plaintext) {
        this._log('Cache decryption failed (wrong machine or corrupted)');
        return;
      }
      const data = JSON.parse(plaintext);
      if (data.accountId && data.accountId !== this.accountId) return;
      if (Array.isArray(data.timers)) {
        const nowSecs = Math.floor(Date.now() / 1000);
        // Only restore timers that haven't expired
        this._timers = data.timers.filter(t => t.expiryTime > nowSecs);
        if (this._timers.length > 0) {
          this._log(`Restored ${this._timers.length} cached timer(s) from encrypted cache`);
        }
      }
      if (Array.isArray(data.factions)) {
        this._factions = data.factions;
      }
      if (data.accountId === this.accountId && data.rawInventory && typeof data.rawInventory === 'object') {
        this._rawInventory = data.rawInventory;
        // Old cached earned totals used a fixed cap. Recalculate from the
        // original server balances rather than restoring those stale totals.
        this._dailyAffiliation = dailyAffiliationProgress(data.rawInventory);
        this._dailyAffiliationOde = dailyAffiliationProgress(data.rawInventory, 'DailyAffiliationOde');
        this._inventoryFromCache = true;
        this._inventorySavedAt = Number.isFinite(data.savedAt) ? data.savedAt : 0;
      }
    } catch (e) {
      this._log(`Cache load failed: ${e.message}`);
    }
  }

  /** @returns {object|null} Full raw inventory response */
  getRawInventory() {
    return this._rawInventory;
  }

  isInventoryCached() {
    return this._inventoryFromCache;
  }

  /**
   * Extract Unix timestamp from a MongoDB ObjectId string.
   * First 8 hex chars encode creation time.
   * @param {string} oid
   * @returns {number|null}
   */
  static _extractTimestampFromOid(oid) {
    if (!oid || oid.length < 8) return null;
    const ts = parseInt(oid.substring(0, 8), 16);
    return isNaN(ts) ? null : ts;
  }
}

/**
 * Load cached timers from disk without needing an account/nonce.
 * Used at app startup to show stale-but-valid timers before login.
 * @returns {object} Timers and progress recalculated from the saved inventory.
 */
function loadCachedTimers() {
  const empty = { timers: [], dailyAffiliation: null, dailyAffiliationOde: null, factions: null, rawInventory: null };
  try {
    if (!fs.existsSync(INVENTORY_CACHE_PATH)) return empty;
    const key = deriveCacheKey();
    const encrypted = fs.readFileSync(INVENTORY_CACHE_PATH);
    const plaintext = decryptData(encrypted, key);
    if (!plaintext) return empty;
    const data = JSON.parse(plaintext);
    const result = { ...empty, accountId: typeof data.accountId === 'string' ? data.accountId : null };
    if (Array.isArray(data.timers)) {
      const nowSecs = Math.floor(Date.now() / 1000);
      result.timers = data.timers.filter(t => t.expiryTime > nowSecs);
    }
    if (Array.isArray(data.factions)) {
      result.factions = data.factions;
    }
    if (data.rawInventory && typeof data.rawInventory === 'object') {
      result.rawInventory = data.rawInventory;
      result.dailyAffiliation = dailyAffiliationProgress(data.rawInventory);
      result.dailyAffiliationOde = dailyAffiliationProgress(data.rawInventory, 'DailyAffiliationOde');
    }
    return result;
  } catch { /* ignore corrupt/missing cache */ }
  return empty;
}

module.exports = { InventoryPoller, loadCachedTimers };
