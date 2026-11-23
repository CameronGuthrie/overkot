/**
 * API client for Soulframe credential validation.
 * Port of Rust api.rs
 */

const axios = require('axios');
const { profilePlayer } = require('./playerIdentity');

const BASE = 'https://api.soulframe.com/api';
const PROFILE_TTL_MS = 15 * 60_000;
const PROFILE_RETRY_MS = 60_000;

// Pollers are replaced on reconnect. All clients in the main process share the CDN cache and cooldown.
const profiles = new Map();
let profileBlockedUntil = 0;
let profileBackoffMs = 0;

function applyProfileRateLimit(headers, now) {
  if (now >= profileBlockedUntil) {
    profileBackoffMs = Math.min(60 * 60_000, profileBackoffMs ? profileBackoffMs * 2 : PROFILE_TTL_MS);
  }
  const value = headers?.['retry-after'] ?? headers?.get?.('Retry-After') ?? headers?.['Retry-After'];
  const serverDeadline = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  profileBlockedUntil = Math.max(profileBlockedUntil, now + profileBackoffMs,
    Number.isFinite(serverDeadline) ? serverDeadline : 0);
}

async function requestProfile(accountId, entry, stillCurrent) {
  let response;
  try {
    response = await axios.get('https://api.soulframe.com/cdn/getProfileViewingData.php', {
      params: { playerId: accountId }, timeout: 10_000, maxContentLength: 2 * 1024 * 1024,
      headers: { Accept: 'application/json' },
    });
  } catch (error) { response = error?.response; }

  const now = Date.now();
  // A throttle belongs to the endpoint even if the player logged out while the request was in flight.
  if (response?.status === 429) applyProfileRateLimit(response.headers, now);
  if (!stillCurrent()) return null;
  if (response?.status === 200 && profilePlayer(response.data, accountId)) {
    entry.data = response.data;
    entry.fetchedAt = now;
    entry.retryAt = 0;
    if (now >= profileBlockedUntil) profileBackoffMs = 0;
    return entry.data;
  }
  entry.retryAt = now + PROFILE_RETRY_MS;
  return null;
}

// Mimic the real game client to blend in with normal traffic
const SPOOFED_HEADERS = {
  'User-Agent': 'Soulframe.x64.exe',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

class ApiClient {
  constructor({ canReadProfile = () => false } = {}) {
    this.canReadProfile = canReadProfile;
  }

  _confirmedProfileAccount(accountId) {
    if (typeof accountId !== 'string' || !/^[a-f0-9]{24}$/i.test(accountId)) return null;
    const key = accountId.toLowerCase();
    try { return this.canReadProfile(key) === true ? key : null; }
    catch { return null; }
  }

  getProfileFetchedAt(accountId) {
    return profiles.get(this._confirmedProfileAccount(accountId))?.fetchedAt ?? null;
  }

  /** Public profile lookup: no inventory session nonce is sent to the CDN. */
  async fetchProfile(accountId, { maxAgeMs = PROFILE_TTL_MS, force = false } = {}) {
    const key = this._confirmedProfileAccount(accountId);
    if (!key) return null;
    const now = Date.now();
    let entry = profiles.get(key);
    if (!entry?.pending) {
      if (!force && entry?.data && now - entry.fetchedAt < Math.min(maxAgeMs, PROFILE_TTL_MS)) return entry.data;
      if (now < profileBlockedUntil || now < (entry?.retryAt ?? 0)) return null;

      if (!entry) {
        for (const [id, old] of profiles) {
          if (!old.pending && now >= old.retryAt && (!old.data || now - old.fetchedAt >= PROFILE_TTL_MS)) profiles.delete(id);
        }
        entry = { pending: null, data: null, fetchedAt: null, retryAt: 0 };
        profiles.set(key, entry);
      }
      entry.pending = requestProfile(key, entry, () => this._confirmedProfileAccount(key))
        .finally(() => { entry.pending = null; });
    }
    const result = await entry.pending;
    return result && this._confirmedProfileAccount(key) ? result : null;
  }

  /**
   * Call inventory endpoint to validate nonce.
   * Returns true only if the server returns real inventory data
   * (rejects INVALID_NONCE / Log-in expired / tiny stub responses).
   * @param {string} accountId
   * @param {string} nonce
   * @returns {Promise<boolean>}
   */
  async testInventoryAccess(accountId, nonce) {
    const url = `${BASE}/inventory.php?accountId=${accountId}&nonce=${nonce}&ct=MSI`;
    try {
      const res = await axios.get(url, { timeout: 10000, headers: SPOOFED_HEADERS, transformResponse: [(d) => d] });
      if (res.status === 200 && res.data) {
        const body = typeof res.data === 'string' ? res.data : String(res.data);
        if (body.includes('INVALID_NONCE') || body.includes('Log-in expired') || body.length <= 10) {
          return false;
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Helper for robust scanner – test a single nonce candidate.
   * @param {string} accountId
   * @param {string} nonce
   * @returns {Promise<boolean>}
   */
  async testSingleNonce(accountId, nonce) {
    return this.testInventoryAccess(accountId, nonce);
  }

  /**
   * Fetch full inventory data.
   * Returns { data, nonceExpired } — data is the inventory object,
   * nonceExpired is true if the server says the nonce/session is dead.
   * @param {string} accountId
   * @param {string} nonce
   * @returns {Promise<{data: object|null, nonceExpired: boolean}>}
   */
  async fetchInventory(accountId, nonce) {
    const url = `${BASE}/inventory.php?accountId=${accountId}&nonce=${nonce}&ct=MSI`;
    try {
      const res = await axios.get(url, { timeout: 15000, headers: SPOOFED_HEADERS, transformResponse: [(d) => d] });
      if (res.status === 200 && res.data) {
        const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        // Check for nonce/session expiry signals
        if (body.includes('INVALID_NONCE') || body.includes('Log-in expired') || body.length <= 10) {
          return { data: null, nonceExpired: true };
        }
        return { data: JSON.parse(body), nonceExpired: false };
      }
    } catch (e) {
      // swallow – caller handles null
    }
    return { data: null, nonceExpired: false };
  }
}

module.exports = { ApiClient };
