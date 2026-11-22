'use strict';

const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { profileDisplayName } = require('./playerIdentity');

const { services } = require('./serviceConfig');
const API = services.accountApi;
const PORTAL = services.accountPortal;
const HEARTBEAT_MS = 45_000;
const LIVE_SESSION_MS = 90_000;
const ACCOUNT_REFRESH_MS = 5 * 60_000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const offline = () => ({ online: false, accountId: '', displayName: '' });
const failure = (code, message) => Object.assign(new Error(message), { code });

// Credentials stay in the main process, encrypted for the current OS user.
class AvakotTokenStore {
  constructor({ directory, safeStorage }) { this.file = path.join(directory, 'avakot-account-session.bin'); this.safeStorage = safeStorage; }
  available() { return this.safeStorage.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
  load() {
    try {
      const token = this.available() ? this.safeStorage.decryptString(fs.readFileSync(this.file)) : null;
      return tokenPattern.test(token || '') ? token : null;
    } catch { return null; }
  }
  save(token) {
    if (!this.available()) return false;
    const encrypted = this.safeStorage.encryptString(token);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return true;
  }
  clear() { fs.rmSync(this.file, { force: true }); }
}

function trustedOrigin(value, production) {
  if (!value) return '';
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.origin !== production && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('avakot.dev account must use its production origin or a local development server.');
  }
  return url.origin;
}

class AvakotAccountService extends EventEmitter {
  constructor({ getSession, tokenStore, openExternal, fetchImpl = globalThis.fetch, now = Date.now, apiBase = API, portalBase = PORTAL }) {
    super();
    Object.assign(this, { getSession, tokenStore, openExternal, fetchImpl, now });
    this.apiBase = trustedOrigin(apiBase, API);
    this.portalBase = trustedOrigin(portalBase, PORTAL);
    this.token = null; this.account = null; this.game = offline(); this.sessionPersistent = false; this.marketSignIn = false;
    this.busy = false; this.authorizing = false; this.error = ''; this.generation = 0;
    this.session = null; this.name = ''; this.nameAt = 0; this.namePending = null;
    this.pollTimer = null; this.heartbeat = null; this.authorization = null;
    this.syncing = null; this.resync = false; this.sent = ''; this.sentAt = 0;
    this.accountCheckedAt = 0;
    this.disposed = false; this.initialized = false; this.lastState = '';
  }
  snapshot() {
    return { signedIn: !!this.account && !!this.token, hasCredential: !!this.token, busy: this.busy, authorizing: this.authorizing,
      account: this.account ? { email: this.account.email, displayName: this.account.displayName } : null,
      game: { ...this.game }, sessionPersistent: this.sessionPersistent, marketSignIn: this.marketSignIn, error: this.error };
  }
  publish() {
    const state = this.snapshot(), serialized = JSON.stringify(state);
    if (serialized !== this.lastState) { this.lastState = serialized; this.emit('changed', state); }
  }
  async request(route, { method = 'GET', body, token = this.token } = {}) {
    if (!this.apiBase) throw failure('not_configured', 'Account access is unavailable in this build.');
    let response, data;
    try {
      response = await this.fetchImpl(`${this.apiBase}/v1/overlay/${route}`, {
        method, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const raw = await response.text();
      if (raw.length > 64 * 1024) throw new Error('Response too large');
      try { data = JSON.parse(raw); }
      catch (error) { if (response.status !== 429) throw error; }
    } catch { throw failure('network_error', 'Could not reach avakot.dev account. Check your connection and try again.'); }
    if (response.status === 429) {
      // A gateway throttle can arrive before the account service supplies its error envelope.
      const retryAfter = response.headers?.get('retry-after');
      const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - this.now();
      throw Object.assign(failure(data?.error?.code || 'rate_limited',
        String(data?.error?.message || 'avakot.dev account is busy. Please try again shortly.').slice(0, 300)),
        { status: 429, retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay) : 0 });
    }
    if (!response.ok) throw Object.assign(failure(data.error?.code || 'request_failed',
      String(data.error?.message || 'avakot.dev account could not complete this request.').slice(0, 300)), { status: response.status });
    return data;
  }
  async initialize() {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    if (!this.apiBase) return;
    this.token = this.tokenStore.load();
    this.sessionPersistent = !!this.token;
    this.heartbeat = setInterval(() => {
      // Refresh an online lease every tick, independent of response latency.
      if (this.game.online) this.sentAt = 0;
      this.update(); void this.sync();
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.update();
    await this.sync();
  }
  clearCredential() {
    this.token = null; this.account = null; this.sessionPersistent = false; this.marketSignIn = false; this.sent = ''; this.sentAt = 0;
    this.accountCheckedAt = 0;
    try { this.tokenStore.clear(); } catch { this.error = 'Could not remove the saved sign-in from this computer.'; }
  }
  async signIn() {
    if (!this.apiBase || !this.portalBase) return { ok: false, message: 'Account sign-in is unavailable in this build.' };
    if (this.disposed || this.busy || this.authorizing || (this.token && this.account)) return { ok: false, message: 'A sign-in is already active.' };
    if (this.token) {
      const generation = this.generation;
      this.busy = true; this.error = ''; this.publish();
      try {
        await this.sync();
        return { ok: !!this.account, state: this.snapshot(), ...(!this.account ? { message: this.error || 'Could not restore your avakot.dev sign-in. Try again.' } : {}) };
      } finally { if (generation === this.generation) { this.busy = false; this.publish(); } }
    }
    const generation = ++this.generation;
    this.busy = true; this.authorizing = true; this.error = ''; this.publish();
    try {
      const result = await this.request('authorizations', { method: 'POST', body: {}, token: null });
      if (generation !== this.generation || this.disposed) return { ok: false };
      const url = new URL(result.verificationUri);
      if (url.origin !== this.portalBase || url.username || url.password || url.pathname !== '/'
        || url.searchParams.get('overlay') !== result.authorizationId || !tokenPattern.test(result.deviceCode || '')
        || !tokenPattern.test(result.authorizationId || '')) throw failure('invalid_response', 'Avakot returned an invalid sign-in link.');
      this.authorization = { authorizationId: result.authorizationId, deviceCode: result.deviceCode,
        deadline: this.now() + Math.min(600, Number(result.expiresIn) || 600) * 1000,
        interval: Math.max(5, Math.min(30, Number(result.interval) || 5)) * 1000 };
      await this.openExternal(url.href);
      if (generation !== this.generation || this.disposed) return { ok: false };
      this.schedulePoll(generation);
      return { ok: true, state: this.snapshot() };
    } catch (error) {
      if (generation === this.generation) { this.authorizing = false; this.authorization = null; this.error = error.message; }
      return { ok: false, message: error.message };
    } finally { if (generation === this.generation) { this.busy = false; this.publish(); } }
  }
  schedulePoll(generation, delay = this.authorization?.interval) {
    clearTimeout(this.pollTimer);
    if (!this.authorization || generation !== this.generation || this.disposed) return;
    this.pollTimer = setTimeout(() => { void this.pollAuthorization(generation); },
      Math.min(delay, Math.max(0, this.authorization.deadline - this.now())));
    this.pollTimer.unref?.();
  }
  async pollAuthorization(generation) {
    const authorization = this.authorization;
    if (!authorization || generation !== this.generation || this.disposed) return;
    try {
      if (this.now() >= authorization.deadline) throw failure('authorization_expired', 'Sign-in expired. Start again from Settings.');
      const result = await this.request('token', { method: 'POST', token: null,
        body: { authorizationId: authorization.authorizationId, deviceCode: authorization.deviceCode } });
      if (generation !== this.generation || this.disposed) {
        if (tokenPattern.test(result.accessToken || '')) await this.request('session', { method: 'DELETE', body: {}, token: result.accessToken }).catch(() => {});
        return;
      }
      if (result.status === 'pending') { this.error = ''; this.publish(); this.schedulePoll(generation); return; }
      if (!tokenPattern.test(result.accessToken || '') || !result.account?.email) throw failure('invalid_response', 'Avakot returned an invalid sign-in response.');
      this.token = result.accessToken; this.account = result.account; this.marketSignIn = result.overlay?.marketSignIn === true;
      this.authorizing = false; this.authorization = null;
      this.accountCheckedAt = this.now();
      this.error = ''; this.sent = ''; this.sentAt = 0;
      try { this.sessionPersistent = this.tokenStore.save(this.token); } catch { this.sessionPersistent = false; }
      this.update(); this.publish();
      await this.sync();
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.error = error.message;
      if (error.status === 429 && this.now() < authorization.deadline) {
        this.error = 'avakot.dev account is busy. Overkot will retry this sign-in automatically.';
        authorization.interval = Math.min(30_000, authorization.interval * 2);
        this.schedulePoll(generation, Math.max(authorization.interval, error.retryAfterMs));
      } else if (error.code === 'network_error' && this.now() < authorization.deadline) this.schedulePoll(generation);
      else { this.authorizing = false; this.authorization = null; }
      this.publish();
    }
  }
  cancelSignIn() {
    ++this.generation; clearTimeout(this.pollTimer); this.pollTimer = null;
    this.authorizing = false; this.busy = false; this.authorization = null; this.error = ''; this.publish();
    return { ok: true, state: this.snapshot() };
  }
  async signOut() {
    const token = this.token;
    this.cancelSignIn(); this.busy = true; this.clearCredential(); this.publish();
    try {
      await this.syncing;
      if (token) await this.request('session', { method: 'DELETE', body: {}, token });
      return { ok: true };
    } catch (error) {
      this.error = error.status === 401 ? '' : 'Signed out on this computer. Remote status will expire shortly; revoke Overkot in your account to end remote access immediately.';
      return { ok: true, message: this.error };
    } finally { this.busy = false; this.publish(); }
  }
  async openAccount() {
    if (!this.portalBase) return { ok: false, message: 'The account portal is unavailable in this build.' };
    try { await this.openExternal(this.portalBase + '/'); return { ok: true }; }
    catch { return { ok: false, message: 'Could not open your browser.' }; }
  }
  async reconnect() {
    if (this.busy || this.authorizing || this.disposed) return { ok: false, message: 'A sign-in is already active.' };
    const generation = this.generation + 1;
    await this.signOut();
    if (generation !== this.generation || this.disposed) return { ok: false, message: 'Sign-in cancelled.' };
    return this.signIn();
  }
  liveSession() {
    const session = this.getSession();
    if (!session || !/^[a-f0-9]{24}$/i.test(session.accountId || '') || !session._running
      || session.isNonceExpired() || session.isInventoryCached() || !session.getRawInventory()
      || !session.getLastSuccessfulPollAt() || this.now() - session.getLastSuccessfulPollAt() > LIVE_SESSION_MS) return null;
    return session;
  }
  update() {
    if (this.disposed) return;
    const session = this.liveSession();
    if (session !== this.session) { this.session = session; this.name = ''; this.nameAt = 0; this.namePending = null; }
    const next = session && this.name ? { online: true, accountId: session.accountId, displayName: this.name } : offline();
    const changed = JSON.stringify(next) !== JSON.stringify(this.game);
    this.game = next;
    if (changed) { this.publish(); void this.sync(); }
    if (session && this.token && !this.namePending && this.now() >= this.nameAt) {
      this.nameAt = this.now() + 60_000;
      const work = Promise.resolve().then(() => session.api.fetchProfile(session.accountId)).then(profile => {
        if (this.disposed || this.session !== session || this.liveSession() !== session) return;
        const name = profileDisplayName(profile, session.accountId);
        if (name) { this.name = name; this.nameAt = this.now() + 15 * 60_000; }
      }).catch(() => {}).finally(() => {
        if (this.namePending === work) { this.namePending = null; this.update(); }
      });
      this.namePending = work;
    }
  }
  sync() {
    if (this.syncing) { this.resync = true; return this.syncing; }
    if (!this.token) return Promise.resolve();
    this.syncing = (async () => {
      do {
        this.resync = false;
        const token = this.token, generation = this.generation;
        if (!token) break;
        try {
          if (!this.account || this.now() - this.accountCheckedAt >= ACCOUNT_REFRESH_MS) {
            const result = await this.request('me', { token });
            if (token !== this.token || generation !== this.generation) continue;
            if (!result.account?.email) throw failure('invalid_response', 'Avakot returned an invalid account response.');
            this.account = result.account; this.marketSignIn = result.overlay?.marketSignIn === true;
            this.accountCheckedAt = this.now(); this.error = ''; this.publish(); this.update();
          }
          const body = this.game.online ? { ...this.game } : { online: false };
          const signature = JSON.stringify(body);
          if (signature === this.sent && (!body.online || this.now() - this.sentAt < HEARTBEAT_MS)) continue;
          await this.request('presence', { method: 'POST', body, token });
          if (token !== this.token || generation !== this.generation) continue;
          this.sent = signature; this.sentAt = this.now(); this.error = ''; this.publish();
        } catch (error) {
          if (token !== this.token || generation !== this.generation) continue;
          if (error.status === 401) this.clearCredential();
          this.error = error.status === 401 ? 'Your avakot.dev sign-in expired or was revoked. Sign in again.' : error.message;
          this.publish();
          // Retry outages on the heartbeat, rather than spinning on frequent game updates.
          if (!this.resync) break;
        }
      } while (this.resync);
    })().finally(() => {
      this.syncing = null;
      // A profile result can queue work between the loop finishing and this
      // cleanup microtask. Drain it before resolving the original caller.
      if (this.resync) { this.resync = false; return this.sync(); }
    });
    return this.syncing;
  }
  async dispose() {
    this.disposed = true; clearInterval(this.heartbeat); clearTimeout(this.pollTimer);
    this.authorization = null; this.authorizing = false; this.game = offline(); this.sent = '';
    await this.sync();
  }
}

module.exports = { AvakotAccountService, AvakotTokenStore, HEARTBEAT_MS, LIVE_SESSION_MS };
