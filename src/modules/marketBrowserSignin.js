'use strict';

const { services } = require('./serviceConfig');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const failure = message => Object.assign(new Error(message), { code: 'SIGN_IN_FAILED' });

// Browser approval uses a public request ID; the exchange secret stays in main.
class MarketBrowserSignin {
  constructor(market, now = Date.now) {
    this.market = market; this.now = now; this.revision = 0; this.timer = null;
    this.authorization = null; this.busy = false; this.error = '';
  }
  get active() { return this.busy || !!this.authorization; }
  snapshot() { return { pending: this.active, userCode: this.authorization?.userCode || '', error: this.error }; }
  async request(action, authorization) {
    return this.market.request(`auth/desktop/${action}`, { method: 'POST', token: null,
      body: authorization ? { authorizationId: authorization.authorizationId, deviceCode: authorization.deviceCode } : {} });
  }
  cancel() {
    ++this.revision; clearTimeout(this.timer); this.timer = null;
    const authorization = this.authorization;
    this.authorization = null; this.busy = false; this.error = ''; this.market.update();
    if (authorization) void this.request('cancel', authorization).catch(() => {});
    return { ok: true, state: this.market.snapshot() };
  }
  async start() {
    const revision = ++this.revision, generation = this.market.generation;
    this.busy = true; this.error = ''; this.market.update();
    try {
      const response = await this.request('authorizations');
      const value = response.data?.attributes;
      if (!value || !tokenPattern.test(value.authorizationId || '') || !tokenPattern.test(value.deviceCode || '')
        || !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(value.userCode || '')
        || !services.marketWebsite || value.verificationUri !== `${services.marketWebsite}/overkot-signin#${value.authorizationId}`
        || !Number.isFinite(value.expiresIn) || value.expiresIn <= 0) throw failure('The market returned an invalid sign-in link.');
      if (revision !== this.revision || this.market.disposed) {
        void this.request('cancel', value).catch(() => {}); return { ok: false };
      }
      this.authorization = { authorizationId: value.authorizationId, deviceCode: value.deviceCode, userCode: value.userCode,
        deadline: this.now() + Math.min(600, value.expiresIn) * 1000,
        interval: Math.max(5, Math.min(30, Number(value.interval) || 5)) * 1000 };
      this.market.update();
      await this.market.openExternal(value.verificationUri);
      if (revision !== this.revision || this.market.disposed) return { ok: false };
      this.schedule(revision, generation);
      return { ok: true, state: this.market.snapshot() };
    } catch (error) {
      if (revision === this.revision) {
        const authorization = this.authorization;
        this.authorization = null;
        if (authorization) void this.request('cancel', authorization).catch(() => {});
        this.error = error.code ? error.message : 'Could not open your browser. Try signing in again.';
      }
      return { ok: false, message: this.error };
    } finally { if (revision === this.revision) { this.busy = false; this.market.update(); } }
  }
  schedule(revision, generation) {
    clearTimeout(this.timer);
    if (revision !== this.revision || !this.authorization || this.market.disposed) return;
    this.timer = setTimeout(() => { void this.poll(revision, generation); }, this.authorization.interval);
    this.timer.unref?.();
  }
  async poll(revision = this.revision, generation = this.market.generation) {
    const authorization = this.authorization;
    if (!authorization || revision !== this.revision || this.market.disposed) return;
    try {
      if (this.now() >= authorization.deadline) throw failure('Sign-in expired. Start again from the Market window.');
      const response = await this.request('token', authorization), value = response.data?.attributes;
      if (revision !== this.revision || this.market.disposed) {
        if (tokenPattern.test(value?.sessionToken || '')) await this.market.revokeToken(value.sessionToken);
        return;
      }
      if (value?.status === 'pending' || value?.status === 'slow_down') {
        if (value.status === 'slow_down') authorization.interval = Math.min(30_000, authorization.interval + 5000);
        this.error = ''; this.schedule(revision, generation); this.market.update(); return;
      }
      if (value?.status !== 'approved' || !tokenPattern.test(value.sessionToken || '')) throw failure('The market returned an invalid sign-in response.');
      this.authorization = null; this.busy = true; this.error = '';
      const result = await this.market.acceptSessionToken(value.sessionToken, generation);
      if (revision === this.revision && !result.ok) this.error = result.message;
    } catch (error) {
      if (revision !== this.revision) return;
      const retry = ['NETWORK_ERROR', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE'].includes(error.code) && this.now() < authorization.deadline;
      this.error = retry ? 'Waiting for the market. Check your connection; sign-in will retry automatically.'
        : error.code ? error.message : 'Sign-in could not be completed. Try again.';
      if (retry) {
        authorization.interval = Math.min(30_000, authorization.interval + 5000);
        this.schedule(revision, generation);
      } else {
        this.authorization = null;
        void this.request('cancel', authorization).catch(() => {});
      }
    } finally { if (revision === this.revision) { this.busy = false; this.market.update(); } }
  }
}

module.exports = { MarketBrowserSignin };
