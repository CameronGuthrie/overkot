'use strict';

const { EventEmitter } = require('node:events');
const GRANT = /^[A-Za-z0-9_-]{43}$/;

// The central credential and one-use grant never cross the renderer boundary.
class MarketAccountConnection extends EventEmitter {
  constructor({ account, market, retryMs = 30_000, now = Date.now }) {
    super();
    Object.assign(this, { account, market, retryMs, now });
    this.key = null; this.revision = 0; this.busy = false; this.error = '';
    this.requiresReconnect = false; this.requiresLink = false; this.timer = null; this.work = null; this.disposed = false;
    this.renewalTimer = null; this.renewalNeeded = false;
    this.onAccount = () => { void this.sync(); };
    account.on('changed', this.onAccount);
    this.onMarket = () => {
      if (this.key && this.key === account.token && market.user && market.token && !this.busy
        && !this.renewalNeeded && account.snapshot().marketSignIn === true && (this.error || this.timer)) {
        clearTimeout(this.timer); this.timer = null;
        this.error = ''; this.requiresReconnect = false; this.requiresLink = false;
        this.publish();
      }
      if (this.key && !market.token && !this.busy) queueMicrotask(() => { void this.sync(); });
    };
    market.on('changed', this.onMarket);
    this.onExpiry = () => this.scheduleRenewal();
    market.on('session-expiry', this.onExpiry);
  }
  snapshot() {
    return { busy: this.busy, error: this.error, requiresReconnect: this.requiresReconnect,
      requiresLink: this.requiresLink, connected: !!this.key && !!this.market.user && !!this.market.token };
  }
  publish() { this.emit('changed', this.snapshot()); }
  scheduleRenewal() {
    clearTimeout(this.renewalTimer); this.renewalTimer = null;
    const expiry = this.market.sessionExpiresAt;
    if (this.disposed || !this.key || !this.market.token || !Number.isFinite(expiry) || this.renewalNeeded) return;
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = null; this.renewalNeeded = true;
      void this.sync();
    }, Math.max(0, expiry - this.now() - 60_000));
    this.renewalTimer.unref?.();
  }
  sync() {
    if (this.disposed || this.market.apiBase === '') return Promise.resolve();
    const state = this.account.snapshot();
    const key = state.signedIn ? this.account.token : null;
    if (key !== this.key) {
      ++this.revision; clearTimeout(this.timer); this.timer = null;
      clearTimeout(this.renewalTimer); this.renewalTimer = null; this.renewalNeeded = false;
      this.key = key; this.busy = false; this.error = ''; this.requiresReconnect = false; this.requiresLink = false;
      // Drop an old identity immediately, including during an in-flight exchange.
      const oldToken = this.market.token;
      this.market.clearSession();
      if (oldToken) void this.market.revokeToken(oldToken);
      this.publish();
    }
    if (!key || this.timer || (this.work?.revision === this.revision)) return this.work?.promise || Promise.resolve();
    if (state.marketSignIn !== true) {
      if (this.market.token) {
        const oldToken = this.market.token;
        this.market.clearSession(); void this.market.revokeToken(oldToken);
      }
      this.requiresReconnect = true;
      this.error = 'Reconnect your avakot.dev account to allow Overkot to sign in to Market.';
      this.publish(); return Promise.resolve();
    }
    if (this.market.user && this.market.token && !this.renewalNeeded) { this.scheduleRenewal(); return Promise.resolve(); }
    if (this.requiresLink || this.requiresReconnect) return Promise.resolve();
    const revision = this.revision;
    const renewing = !!this.market.user && !!this.market.token;
    this.busy = true; this.error = ''; this.publish();
    const current = () => !this.disposed && revision === this.revision && key === this.account.token && this.account.snapshot().signedIn;
    const promise = (async () => {
      let requestingGrant = true;
      try {
        const authorization = await this.account.request('market-authorization', { method: 'POST', body: {}, token: key });
        requestingGrant = false;
        if (!current()) return;
        if (!GRANT.test(authorization.grant || '')) throw new Error('Invalid authorization');
        const result = await this.market.loginWithAccountGrant(authorization.grant, { renew: renewing });
        if (!current()) return;
        // /me can confirm the account before a public catalogue refresh fails.
        if (!result?.ok && (renewing || !(this.market.user && this.market.token))) {
          throw Object.assign(new Error(result?.message || 'Market sign-in failed.'), { code: result?.error, status: result?.status });
        }
        this.renewalNeeded = false;
      } catch (error) {
        if (!current()) return;
        if (error.status === 401 && requestingGrant) {
          this.account.clearCredential();
          this.account.error = 'Your avakot.dev sign-in expired or was revoked. Sign in again.';
          this.account.publish();
          return;
        }
        this.requiresReconnect = error.code === 'scope_required';
        this.requiresLink = ['market_connection_required', 'ACCOUNT_CONNECTION_REQUIRED'].includes(error.code);
        const blocked = ['SIGN_IN_UNAVAILABLE', 'APP_ACCESS_REQUIRED'].includes(error.code);
        this.error = this.requiresReconnect
          ? 'Reconnect your avakot.dev account to allow Overkot to sign in to Market.'
          : this.requiresLink ? 'Open Manage account and connect your Market account, then retry.'
            : blocked ? error.message : 'Could not connect Market. Check your connection; Overkot will retry automatically.';
        if (!this.requiresReconnect && !this.requiresLink && !blocked) {
          this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, this.retryMs);
          this.timer.unref?.();
        }
      } finally {
        if (current()) { this.busy = false; this.scheduleRenewal(); this.publish(); }
      }
    })();
    this.work = { revision, promise };
    void promise.finally(() => { if (this.work?.promise === promise) this.work = null; });
    return promise;
  }
  retry() {
    clearTimeout(this.timer); this.timer = null; this.requiresLink = false; this.requiresReconnect = false;
    return this.sync();
  }
  dispose() {
    this.disposed = true; ++this.revision; clearTimeout(this.timer);
    clearTimeout(this.renewalTimer);
    this.account.removeListener('changed', this.onAccount);
    this.market.removeListener('changed', this.onMarket);
    this.market.removeListener('session-expiry', this.onExpiry);
  }
}

module.exports = { MarketAccountConnection };
