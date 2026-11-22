/**
 * API client for Soulframe credential validation.
 * Port of Rust api.rs
 */

const axios = require('axios');

const BASE = 'https://api.soulframe.com/api';

// Mimic the real game client to blend in with normal traffic
const SPOOFED_HEADERS = {
  'User-Agent': 'Soulframe.x64.exe',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

class ApiClient {
  /** Public profile lookup: no inventory session nonce is sent to the CDN. */
  async fetchProfile(accountId) {
    if (!/^[a-f0-9]{24}$/i.test(accountId || '')) return null;
    try {
      const response = await axios.get('https://api.soulframe.com/cdn/getProfileViewingData.php', {
        params: { playerId: accountId }, timeout: 10_000, maxContentLength: 2 * 1024 * 1024,
        headers: { Accept: 'application/json' },
      });
      return response.status === 200 && typeof response.data === 'object' ? response.data : null;
    } catch { return null; }
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
