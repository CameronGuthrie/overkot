'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { buildMarketInventory } = require('./marketInventory');
const { resolveCatalogueDisplay } = require('./marketDisplay');
const { getPlatformSupport } = require('./platformSupport');
const { inventoryMatchesAccount, profileDisplayName } = require('./playerIdentity');
const { MarketBrowserSignin } = require('./marketBrowserSignin');
const { marketImageUrl: safeImage } = require('./gameDataImages');

const { marketTemperIcons } = require('./catalogData');
const { services } = require('./serviceConfig');
const API_BASE = services.marketApi;
const PUBLIC_API_BASE = services.marketPublicApi;
const WEBSITE = services.marketWebsite;
const PRESENCE_INTERVAL_MS = 60000;
const { normalizeLocale } = require('./gameLocales');
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const fail = (code, message) => Object.assign(new Error(message), { code });
function publicMarketRoute(route) {
  if (typeof route !== 'string' || route.length > 8192 || route.includes('#')) return false;
  let pathname;
  try { pathname = decodeURIComponent(route.split('?')[0]); } catch { return false; }
  if (/[\\%]/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(pathname)) return false;
  return [
    /^(?:public\/config|catalogue\/(?:feed|items|suggestions|languages\/[a-z]{2})|arc-values\/overview|fundraiser\/pride|prices|store\/packs)$/,
    /^items\/(?:slug\/[^/]+|[^/]+\/(?:listings|arc-values))$/,
    /^(?:listings\/(?:search|recent)|(?:listing|offer)\/[^/]+)$/,
    /^envoys(?:\/[^/]+(?:\/(?:listings|history))?)?$/,
  ].some(pattern => pattern.test(pathname));
}
const maxQuantity = item => text(item?.category).trim().toLowerCase() === 'resource' || text(item?.slug).trim().toLowerCase() === 'moonsteel-thread' ? 999 : 6;
const attributeType = item => ['weapon', 'weapons'].includes(item?.category) ? 'weapon'
  : item?.category === 'rune' || text(item?.path).includes('/Upgrades/Runes/') ? 'rune' : item?.category === 'mote' ? 'mote' : null;
const tradeable = item => item?.tradeable !== false && item?.tradability !== 'NOT_TRADABLE' && item?.isActive !== false;
const acceptedQuantityMax = item => maxQuantity(item) === 999 ? 999 : 1;
const QUALITY_LIMITS = { NONE: [0, 1], WORN: [0, 1], MILITARY: [1, 3], OFFICER: [2, 4], NOBLE: [3, 5], MASTERWORK: [4, 6], LEGENDARY: [4, 8] };
const MOTE_VIRTUES = ['COURAGE', 'GRACE', 'SPIRIT'];
const MOTE_GRIPS = ['UNIVERSAL', 'BowSkill', 'ThrowingKnivesSkill', 'HeavySkill', 'SwordSkill', 'CastSkill', 'PolearmSkill', 'ShieldsSkill', 'DaggerSkill'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function advancedListingParams(filters, query) {
  if (!record(filters)) throw fail('VALIDATION_FAILED', 'Choose valid advanced filters.');
  const params = new URLSearchParams({ itemKind: 'weapon', side: query.view === 'requests' ? 'give' : 'get',
    availability: query.availability === 'available' ? 'online' : query.availability === 'in-game' ? 'in-game' : 'any',
    sort: ['recent', 'lowest', 'highest'].includes(query.sort) ? query.sort : 'recent', limit: '50' });
  if (filters.q != null) {
    if (typeof filters.q !== 'string' || filters.q.length > 256) throw fail('VALIDATION_FAILED', 'Use a search of up to 256 characters.');
    if (filters.q.trim()) params.set('q', filters.q.trim());
  }
  const choices = { qualityMin: Object.keys(QUALITY_LIMITS), qualityMax: Object.keys(QUALITY_LIMITS),
    moonsteel: ['true', 'false'], weaponGripType: MOTE_GRIPS, temperMatch: ['all', 'any'] };
  for (const [key, allowed] of Object.entries(choices)) {
    const value = filters[key];
    if (value == null || value === '') continue;
    if (!allowed.includes(value)) throw fail('VALIDATION_FAILED', 'Choose valid advanced filters.');
    params.set(key, value);
  }
  const ranks = { NONE: 0, WORN: 0, MILITARY: 1, OFFICER: 2, NOBLE: 3, MASTERWORK: 4, LEGENDARY: 5 };
  if (filters.qualityMin && filters.qualityMax && ranks[filters.qualityMin] > ranks[filters.qualityMax]) {
    throw fail('VALIDATION_FAILED', 'Minimum quality cannot exceed maximum quality.');
  }
  if (filters.tempers != null) {
    if (!Array.isArray(filters.tempers) || filters.tempers.length > 8
      || filters.tempers.some(value => typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value))) {
      throw fail('VALIDATION_FAILED', 'Choose up to eight valid tempers.');
    }
    if (filters.tempers.length) params.set('tempers', [...new Set(filters.tempers)].join(','));
  }
  return params;
}
function possibleTempers(item, trading = {}, iconFor) {
  return list(item?.possible_tempers).filter(temper => record(temper) && typeof temper.unique_name === 'string').map(temper => {
    const bypass = trading.temperBypassOverrideEnabled !== false && temper.unique_name === 'AspectStaggerCrit'
      && (temper.tag === 'OdeReduceDefenseMod' || temper.icon === '/SF/Interface/Graphics/Aspects/Ode/Crush.png');
    const uniqueName = bypass ? 'AspectReduceArmour' : temper.unique_name;
    return { unique_name: uniqueName,
      name: bypass ? 'Bypass' : text(temper.name || temper.displayName || temper.unique_name),
      displayName: bypass ? 'Bypass' : text(temper.displayName || temper.name || temper.unique_name),
      icon: iconFor?.(temper, uniqueName, item.path) || safeImage(temper.icon), tag: text(temper.tag) };
  });
}
// Listing reads flatten attributes, while writes require nested variant blocks.
function acceptedItemInput(item) {
  if (item.type === 'ARCS') return { type: 'ARCS', amount: item.amount };
  return { type: 'ITEM', itemId: item.itemId, ...(item.quantity != null ? { quantity: item.quantity } : {}),
    ...(item.weapon || item.quality ? { weapon: item.weapon || { quality: item.quality, moonsteel: item.moonsteel ?? null,
      tempers: item.tempers ?? null, tempersAny: item.tempersAny ?? null } } : {}),
    ...(item.mote || item.moteVirtue ? { mote: item.mote || { virtue: item.moteVirtue, upgradeLevel: item.moteUpgradeLevel ?? 0,
      gripType: item.moteGripType || 'UNIVERSAL' } } : {}),
    ...(item.rune || item.runeUpgradeLevel != null ? { rune: item.rune || { upgradeLevel: item.runeUpgradeLevel } } : {}) };
}
function normalizeCatalogueItem(item) {
  const sourcePath = text(item.path || item.sourcePath);
  return { ...item, name: text(item.name || item.displayName || item.unique_name || item.sourceUniqueName),
    category: sourcePath.includes('/Upgrades/Runes/') ? 'rune' : text(item.category).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    path: sourcePath, unique_name: text(item.unique_name || item.sourceUniqueName),
    imageUrl: safeImage(item.imageUrl || item.image_path || item.icon),
    possible_tempers: list(item.possible_tempers || item.sourcePossibleTempers),
    can_be_shiny: item.can_be_shiny ?? item.sourceCanBeShiny };
}
function itemProjection(item) {
  return { id: text(item.id), slug: text(item.slug), name: text(item.name || item.displayName || item.unique_name),
    category: text(item.category), categoryLabel: text(item.categoryLabel),
    imageUrl: safeImage(item.imageUrl || item.image_path || item.icon), maxQuantity: maxQuantity(item) };
}
function listingProjection(value, catalogue = []) {
  const a = value.attributes || value;
  const source = catalogue.find(item => item.id === (a.itemId || a.item?.id));
  return { id: text(value.id), itemId: text(a.itemId || a.item?.id),
    item: itemProjection({ ...source, ...a.item, id: a.itemId || a.item?.id || source?.id,
      name: source?.name || a.item?.displayName || a.item?.name || a.itemDisplayName,
      category: a.item?.category || source?.category || a.itemCategory,
      categoryLabel: source?.categoryLabel || a.item?.categoryLabel,
      imageUrl: a.item?.imageUrl || source?.imageUrl || a.itemImageUrl }),
    type: a.type, status: a.status, quantity: a.quantity, platform: a.platform, terms: a.terms || {},
    quality: a.quality, moonsteel: a.moonsteel, tempers: a.tempers, moteVirtue: a.moteVirtue,
    moteUpgradeLevel: a.moteUpgradeLevel, moteGripType: a.moteGripType, runeUpgradeLevel: a.runeUpgradeLevel,
    expiresAt: a.expiresAt, seller: a.seller ? { handle: text(a.seller.handle), userId: text(a.seller.userId),
      availabilityStatus: a.seller.availabilityStatus, inGame: !!a.seller.inGame, platform: a.seller.platform } : null };
}
function variantMatches(row, listing) {
  if (row.itemId !== listing.itemId) return false;
  const { weapon, mote, rune } = row.attributes || {};
  if (weapon && ((weapon.quality || 'NONE') !== (listing.quality || 'NONE') || !!weapon.moonsteel !== !!listing.moonsteel
    || JSON.stringify([...list(weapon.tempers)].sort()) !== JSON.stringify([...list(listing.tempers)].sort()))) return false;
  if (mote && (mote.virtue !== listing.moteVirtue || (mote.upgradeLevel || 0) !== (listing.moteUpgradeLevel || 0)
    || (mote.gripType || 'UNIVERSAL') !== (listing.moteGripType || 'UNIVERSAL'))) return false;
  return !rune || (rune.upgradeLevel || 0) === (listing.runeUpgradeLevel || 0);
}

// Old website listings may omit variant fields. Such an offer could refer to
// any matching copy; reserve against each possible variant instead of treating
// missing values as a definite stock weapon or rank-zero upgrade.
function listingReservesVariant(row, listing) {
  if (row.itemId !== listing.itemId) return false;
  const { weapon, mote, rune } = row.attributes || {};
  const rankKnown = value => Number.isInteger(value) && value >= 0 && value <= 3;
  if (weapon) {
    if (['NONE', 'WORN', 'MILITARY', 'OFFICER', 'NOBLE', 'MASTERWORK', 'LEGENDARY'].includes(listing.quality)
      && weapon.quality !== listing.quality) return false;
    if (typeof listing.moonsteel === 'boolean' && weapon.moonsteel !== listing.moonsteel) return false;
    if (Array.isArray(listing.tempers) && listing.tempers.every(value => typeof value === 'string')
      && JSON.stringify([...list(weapon.tempers)].sort()) !== JSON.stringify([...listing.tempers].sort())) return false;
  }
  if (mote) {
    if (['COURAGE', 'GRACE', 'SPIRIT'].includes(listing.moteVirtue) && mote.virtue !== listing.moteVirtue) return false;
    if (rankKnown(listing.moteUpgradeLevel) && mote.upgradeLevel !== listing.moteUpgradeLevel) return false;
    if (['UNIVERSAL', 'BowSkill', 'ThrowingKnivesSkill', 'HeavySkill', 'SwordSkill', 'CastSkill', 'PolearmSkill', 'ShieldsSkill', 'DaggerSkill'].includes(listing.moteGripType)
      && mote.gripType !== listing.moteGripType) return false;
  }
  return !rune || !rankKnown(listing.runeUpgradeLevel) || rune.upgradeLevel === listing.runeUpgradeLevel;
}

function reservesInventory(listing, now) {
  if (listing.type !== 'OFFER' || !['ACTIVE', 'PAUSED', 'HIDDEN'].includes(listing.status)) return false;
  const expires = Date.parse(listing.expiresAt);
  // Missing or malformed dates cannot prove that the commitment has expired.
  return !Number.isFinite(expires) || expires > now;
}

// Session tokens are never part of config, renderer state, URLs, or logs.
// Windows safeStorage uses the signed-in Windows user's protected storage.
class MarketTokenStore {
  constructor({ directory, safeStorage }) { this.file = path.join(directory, 'market-session.bin'); this.safeStorage = safeStorage; }
  available() { return this.safeStorage.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
  load() {
    try { return this.available() ? this.safeStorage.decryptString(fs.readFileSync(this.file)) : null; } catch { return null; }
  }
  save(token) {
    if (!this.available()) return false;
    const encrypted = this.safeStorage.encryptString(token);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    try {
      // Preserve a working saved session if encryption or replacement fails.
      fs.writeFileSync(temp, encrypted, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
    return true;
  }
  clear() {
    fs.rmSync(this.file + '.tmp', { force: true });
    fs.rmSync(this.file, { force: true });
  }
}

class MarketService extends EventEmitter {
  constructor({ getSession, getTemperCatalog = () => undefined, tokenStore, rememberSession = true, sharedAccount = false, fetchImpl = globalThis.fetch, apiBase = API_BASE, publicApiBase, readLocalApiKey, copyText = () => {}, openExternal = () => {}, locale = () => 'en', now = Date.now }) {
    super();
    const url = apiBase ? new URL(apiBase) : null;
    const localApi = url?.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (url && !localApi && (!API_BASE || url.origin !== new URL(API_BASE).origin)) {
      throw new Error('Market API must use the production origin or a local development server.');
    }
    const publicBase = publicApiBase || (localApi ? apiBase : PUBLIC_API_BASE);
    const publicUrl = publicBase ? new URL(publicBase) : null;
    if (publicUrl && (!PUBLIC_API_BASE || publicUrl.origin !== new URL(PUBLIC_API_BASE).origin) && !(publicUrl.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(publicUrl.hostname))) {
      throw new Error('Market public reads must use the website gateway or a local development server.');
    }
    Object.assign(this, { getSession, getTemperCatalog, tokenStore, fetchImpl, apiBase: apiBase.replace(/\/$/, ''), publicApiBase: (publicUrl?.href || '').replace(/\/$/, ''), copyText, openExternal, locale, now });
    this.apiKey = localApi && readLocalApiKey ? readLocalApiKey() : '';
    this.token = null; this.user = null; this.generation = 0; this.catalogue = []; this.listings = [];
    this.sessionExpiresAt = null;
    this.retiredTokens = new Map();
    this.trading = {}; this.sessionPersistent = false; this.initialized = false; this.refreshing = null;
    this.rememberSession = rememberSession !== false;
    this.sharedAccount = sharedAccount;
    this.mutating = false; this.authenticating = false; this.browsed = new Map(); this.lastState = '';
    this.playerName = ''; this.playerSession = null; this.catalogueAt = 0; this.listingsComplete = true; this.catalogueFeed = [];
    this.languagePacks = new Map();
    this.enabled = false; this.disposed = false; this.presenceRevision = 0; this.presenceTimer = null;
    this.presenceStarted = false; this.presenceToken = null; this.presenceWork = Promise.resolve();
    this.browserSignin = new MarketBrowserSignin(this);
  }
  async request(route, { method = 'GET', body, token = this.token } = {}) {
    let response, payload;
    const publicRead = !token && !this.apiKey && ['GET', 'HEAD'].includes(method.toUpperCase());
    if (!(publicRead ? this.publicApiBase : this.apiBase)) throw fail('NOT_CONFIGURED', 'Market access is unavailable in this build.');
    if (publicRead && !publicMarketRoute(route)) throw fail('SIGN_IN_REQUIRED', 'Sign in to Avakot Market to continue.');
    try {
      response = await this.fetchImpl(`${publicRead ? this.publicApiBase : this.apiBase}/${route}`, { method, redirect: 'error',
        headers: { Accept: 'application/json', 'User-Agent': 'Overkot/market-integration',
          ...(!publicRead && this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
      const raw = await response.text();
      if (raw.length > 16 * 1024 * 1024) throw new Error('Response too large');
      payload = JSON.parse(raw);
    } catch { throw fail('NETWORK_ERROR', method === 'GET' ? 'Could not reach the market. Check your connection and try again.'
      : 'The market did not confirm the result. Refresh My listings before trying again.'); }
    if (!response.ok) {
      const code = text(payload?.error?.code) || 'MARKET_ERROR';
      if (/API_KEY/.test(code) || (code === 'UNAUTHORIZED' && /API key/i.test(text(payload?.error?.message)))) {
        throw fail('APP_ACCESS_REQUIRED', this.apiKey
          ? 'Market access for this version of Overkot is unavailable. Update Overkot or contact support.'
          : 'Market access is temporarily unavailable. Update Overkot or reconnect your avakot.dev account in Settings.');
      }
      if (response.status === 401 && token && token === this.token) this.clearSession();
      throw Object.assign(fail(code, text(payload?.error?.message).slice(0, 500) || 'The market could not complete this request.'), { status: response.status });
    }
    return payload;
  }
  requireUser() { if (!this.user || !this.token) throw fail('SIGN_IN_REQUIRED', 'Sign in to Avakot Market to continue.'); }
  checkGeneration(value) { if (this.generation !== value) throw fail('SESSION_CHANGED', 'The market account changed. Please try again.'); }
  acceptAccountResponse(me, generation, token) {
    this.checkGeneration(generation);
    if (!token || token !== this.token) throw fail('SESSION_CHANGED', 'The market account changed. Please try again.');
    const a = me?.data?.attributes;
    if (!record(a) || !text(me?.data?.id)) throw fail('INVALID_RESPONSE', 'Could not read your market account.');
    this.user = { id: me.data.id, displayHandle: text(a.displayHandle || a.handle), platform: text(a.platform) || 'PC',
      inGameVerified: !!a.inGameVerified, envoyNameReverificationRequired: !!a.envoyNameReverificationRequired,
      restrictionState: text(a.restrictionState) || 'NONE' };
    // Both the shared website and inventory use this confirmed account. A
    // recovered website read must also recover the desktop selling controls.
    this.update();
    void this.startPresence();
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean' || this.disposed) return;
    if (this.enabled === enabled) return this.presenceWork;
    this.enabled = enabled;
    if (!enabled) return this.stopPresence(true);
    // Restore a remembered account even when the market window stays closed.
    await this.initialize();
    if (!this.token) return { ok: true, state: this.snapshot() };
    const result = await this.refresh();
    await this.startPresence();
    return result;
  }
  queuePresence(task) {
    // Serialize writes so a late heartbeat cannot undo disabling or signing out.
    this.presenceWork = this.presenceWork.then(task).catch(() => {});
    return this.presenceWork;
  }
  startPresence() {
    if (!this.enabled || this.disposed || !this.token || this.presenceStarted) return this.presenceWork;
    if (!this.user) {
      // A temporary account-read failure must not require opening the window
      // before a remembered session can resume its background presence.
      if (!this.presenceTimer) {
        this.presenceTimer = setTimeout(() => {
          this.presenceTimer = null;
          void this.refresh();
        }, PRESENCE_INTERVAL_MS);
        this.presenceTimer.unref?.();
      }
      return this.presenceWork;
    }
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.presenceStarted = true;
    return this.heartbeat();
  }
  heartbeat() {
    const token = this.token, generation = this.generation, revision = this.presenceRevision;
    const current = () => this.enabled && !this.disposed && !!this.user && this.token === token
      && this.generation === generation && this.presenceRevision === revision;
    return this.queuePresence(async () => {
      if (!current()) return;
      // The availability endpoint refreshes activity as well as overlay state.
      // Reassert both fields after reconnects or changes made on the website.
      this.presenceToken = token;
      try {
        await this.request('me/availability', { method: 'PATCH', token,
          body: { status: 'ONLINE', inGame: true, inGameSource: 'overlay' } });
      } finally {
        if (current()) {
          this.presenceTimer = setTimeout(() => {
            this.presenceTimer = null;
            void this.heartbeat();
          }, PRESENCE_INTERVAL_MS);
          this.presenceTimer.unref?.();
        }
      }
    });
  }
  stopPresence(release = false) {
    this.presenceRevision++;
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null; this.presenceStarted = false;
    const token = this.presenceToken;
    this.presenceToken = null;
    if (release && token) {
      return this.queuePresence(() => this.request('me/availability', { method: 'PATCH', token,
        body: { status: null, inGame: false, inGameSource: 'overlay' } }));
    }
    return this.presenceWork;
  }
  dispose() {
    this.disposed = true; this.enabled = false;
    this.browserSignin.cancel();
    return this.stopPresence(true);
  }
  clearSession() {
    this.browserSignin.cancel();
    void this.stopPresence(true);
    this.generation++; this.token = null; this.user = null; this.listings = []; this.browsed.clear();
    this.sessionExpiresAt = null;
    this.emit('session-expiry', null);
    for (const token of this.retiredTokens.keys()) void this.revokeToken(token);
    this.retiredTokens.clear();
    this.listingsComplete = true;
    // Public catalogue data remains available for browsing after sign-out.
    this.sessionPersistent = false;
    try { this.tokenStore?.clear(); } catch { /* In-memory credentials are still removed. */ }
    this.update();
  }
  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.rememberSession || this.sharedAccount) {
      try { this.tokenStore?.clear(); } catch { /* Never restore an opted-out session. */ }
      return;
    }
    this.token = this.tokenStore?.load() || null;
    this.sessionPersistent = !!this.token;
  }
  setRememberSession(remember) {
    if (typeof remember !== 'boolean') return false;
    if (this.sharedAccount) {
      try { this.tokenStore?.clear(); } catch { return false; }
      this.rememberSession = remember; this.sessionPersistent = false; this.update(); return true;
    }
    try {
      if (!remember) this.tokenStore?.clear();
      else if (this.token && !this.tokenStore?.save(this.token)) return false;
    } catch { return false; }
    this.rememberSession = remember;
    this.sessionPersistent = remember && !!this.token;
    this.emit('remember-changed', remember);
    this.update();
    return true;
  }
  async result(task) {
    try { return await task(); } catch (error) { return { ok: false, error: error.code || 'MARKET_ERROR', ...(error.status ? { status: error.status } : {}), message: error.code ? error.message : 'The market could not complete this request. Please refresh and try again.' }; }
  }
  async login({ email, password, remember = this.rememberSession } = {}) {
    return this.result(async () => {
      if (this.sharedAccount) throw fail('ACCOUNT_CONNECTION_REQUIRED', 'Open Overkot Settings > Connections to sign in.');
      if (this.disposed || this.authenticating || this.browserSignin.active) throw fail('BUSY', 'Sign-in is already in progress.');
      if (typeof email !== 'string' || email.length > 254 || !email.includes('@') || typeof password !== 'string' || !password || password.length > 1024) throw fail('VALIDATION_FAILED', 'Enter your market email and password.');
      this.authenticating = true;
      this.clearSession(); this.initialized = true;
      this.rememberSession = remember === true;
      this.emit('remember-changed', this.rememberSession);
      const generation = this.generation;
      try {
        const response = await this.request('auth/sign-in', { method: 'POST', token: null, body: { email: email.trim(), password } });
        const token = response.data?.meta?.sessionToken;
        if (typeof token !== 'string' || !token || token.length > 4096) throw fail('INVALID_RESPONSE', 'The market did not return a valid session.');
        return await this.acceptSessionToken(token, generation, response.data?.attributes?.expiresAt);
      } finally { this.authenticating = false; }
    });
  }
  async loginWithAvakot({ remember = this.rememberSession } = {}) {
    return this.result(async () => {
      if (this.sharedAccount) throw fail('ACCOUNT_CONNECTION_REQUIRED', 'Open Overkot Settings > Connections to sign in.');
      if (this.disposed || this.authenticating || this.browserSignin.active) throw fail('BUSY', 'Sign-in is already in progress.');
      if (this.user) throw fail('SIGN_OUT_REQUIRED', 'Sign out of the current Market account first.');
      const previousToken = this.token;
      this.clearSession(); this.initialized = true;
      if (previousToken) void this.revokeToken(previousToken);
      this.rememberSession = remember === true; this.emit('remember-changed', this.rememberSession);
      return this.browserSignin.start();
    });
  }
  cancelAvakotLogin() {
    if (this.browserSignin.active) return this.logout();
    return { ok: true, state: this.snapshot() };
  }
  async loginWithAccountGrant(grant, { renew = false } = {}) {
    return this.result(async () => {
      if (this.disposed || this.authenticating) throw fail('BUSY', 'Sign-in is already in progress.');
      if (typeof grant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant)) throw fail('VALIDATION_FAILED', 'A new account authorization is required.');
      this.authenticating = true;
      const previousToken = this.token;
      const previousUser = renew && this.user && previousToken ? this.user : null;
      if (!previousUser) {
        this.clearSession(); this.initialized = true;
        if (previousToken) void this.revokeToken(previousToken);
      }
      const generation = this.generation;
      try {
        const response = await this.request('auth/desktop/avakot', { method: 'POST', token: null, body: { grant } });
        const token = response.data?.attributes?.sessionToken;
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('INVALID_RESPONSE', 'The market did not return a valid session.');
        const expiresAt = response.data?.attributes?.expiresAt;
        const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
        if (!Number.isFinite(expiry) || expiry <= this.now() || expiry - this.now() > 15 * 60_000 + 30_000) {
          void this.revokeToken(token);
          throw fail('INVALID_RESPONSE', 'The market did not return a valid session expiry.');
        }
        if (previousUser) {
          // Confirm the same identity before replacing a working credential.
          // Existing requests retain their original valid token until it expires.
          let me;
          try {
            me = await this.request('me', { token });
            this.checkGeneration(generation);
            if (this.disposed || this.token !== previousToken || me?.data?.id !== previousUser.id) {
              throw fail('SESSION_CHANGED', 'The market account changed. Please try again.');
            }
          } catch (error) { void this.revokeToken(token); throw error; }
          void this.stopPresence(false);
          for (const [old, expires] of this.retiredTokens) if (expires <= this.now()) this.retiredTokens.delete(old);
          this.retiredTokens.set(previousToken, this.sessionExpiresAt || this.now());
          this.token = token; this.sessionExpiresAt = expiry;
          this.emit('session-expiry', expiry);
          this.acceptAccountResponse(me, generation, token);
          return { ok: true, state: this.snapshot() };
        }
        return await this.acceptSessionToken(token, generation, expiresAt);
      } finally { this.authenticating = false; }
    });
  }
  revokeToken(token) { return this.request('auth/sign-out', { method: 'POST', token }).catch(() => {}); }
  async acceptSessionToken(token, generation, expiresAt = null) {
    if (this.disposed || generation !== this.generation) {
      await this.revokeToken(token);
      throw fail('SESSION_CHANGED', 'The market account changed. Please try again.');
    }
    this.token = token;
    const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    this.sessionExpiresAt = Number.isFinite(expiry) && expiry > this.now() ? expiry : null;
    this.emit('session-expiry', this.sessionExpiresAt);
    // Settings changes during either sign-in method take effect before saving.
    try { this.sessionPersistent = !this.sharedAccount && this.rememberSession && !!this.tokenStore?.save(token); } catch { this.sessionPersistent = false; }
    return this.refresh();
  }
  async logout() {
    const token = this.token;
    this.clearSession();
    await this.presenceWork;
    if (token) await this.request('auth/sign-out', { method: 'POST', token }).catch(() => {});
    return { ok: true, state: this.snapshot() };
  }
  refresh() {
    if (this.refreshing?.generation === this.generation) return this.refreshing.promise;
    const generation = this.generation;
    const promise = this.result(async () => {
      await this.initialize(); this.checkGeneration(generation);
      if (this.token) {
        const token = this.token;
        const me = await this.request('me', { token });
        // Keep an authenticated account visible even if a server rollout temporarily blocks the feed.
        this.acceptAccountResponse(me, generation, token);
      }
      const catalogueWasStale = !this.catalogueFeed.length || Date.now() - this.catalogueAt >= 300000;
      const locale = normalizeLocale(this.locale());
      const results = await Promise.allSettled([this.loadCatalogue(), this.user ? this.loadListings() : { rows: [], complete: true },
        this.request('public/config', { token: null }), this.loadLanguagePack(locale)]);
      this.checkGeneration(generation);
      for (const result of results.slice(0, 3)) if (result.status === 'rejected') throw result.reason;
      const config = results[2].value.data || {};
      this.catalogueFeed = results[0].value;
      const catalogue = new Map(this.catalogueFeed.map(item => [item.id, item]));
      for (const item of list(config.catalogueOverrides)) {
        if (typeof item?.id === 'string' && item.id && typeof item.slug === 'string') catalogue.set(item.id, normalizeCatalogueItem(item));
      }
      const languageEntry = results[3].status === 'fulfilled' ? results[3].value : this.languagePacks.get(locale);
      const languagePack = languageEntry?.pack || {};
      if (results[3].status === 'fulfilled') this.languagePacks.set(locale, languageEntry);
      this.catalogue = resolveCatalogueDisplay([...catalogue.values()], languagePack);
      if (catalogueWasStale) this.catalogueAt = Date.now();
      this.listings = results[1].value.rows.map(value => listingProjection(value, this.catalogue));
      this.listingsComplete = results[1].value.complete;
      this.trading = { tradingDisabled: !!config.tradingDisabled, tradingDisabledMessage: text(config.tradingDisabledMessage),
        arcsTradeDisabled: !!config.arcsTradeDisabled, temperBypassOverrideEnabled: config.temperBypassOverrideEnabled !== false };
      this.update(); return { ok: true, state: this.snapshot() };
    });
    this.refreshing = { generation, promise };
    void promise.finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = null;
      void this.startPresence();
    });
    return promise;
  }
  async loadCatalogue() {
    if (this.catalogueFeed.length && Date.now() - this.catalogueAt < 300000) return this.catalogueFeed;
    const response = await this.request('catalogue/feed', { token: null });
    if (!Array.isArray(response.items)) throw fail('INVALID_RESPONSE', 'The market catalogue could not be loaded.');
    return response.items.filter(item => typeof item?.id === 'string' && item.id && typeof item.slug === 'string').map(normalizeCatalogueItem);
  }
  async loadLanguagePack(locale) {
    const cached = this.languagePacks.get(locale);
    if (cached && Date.now() - cached.at < 300000) return cached;
    const pack = await this.request(`catalogue/languages/${locale}?projection=1`, { token: null });
    if (!record(pack)) throw fail('INVALID_RESPONSE', 'The market translations could not be loaded.');
    return { pack, at: Date.now() };
  }
  async loadListings() {
    // Recent history alone can hide old active offers once an account has
    // completed fifty trades. Load every open state independently so history
    // never consumes the capacity used to verify inventory commitments.
    const states = [null, 'active', 'paused', 'hidden'];
    const results = await Promise.allSettled(states.map(state => this.request(`me/listings?limit=50${state ? `&state=${state}` : ''}`)));
    const rows = new Map();
    let complete = true;
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') throw result.reason;
      const entries = result.value.data;
      if (!Array.isArray(entries)) throw fail('INVALID_RESPONSE', 'Your listings could not be loaded.');
      if (index > 0 && entries.length >= 50) complete = false;
      for (const entry of entries) {
        const projected = listingProjection(entry, this.catalogue);
        if (!projected.id) throw fail('INVALID_RESPONSE', 'A market listing could not be identified.');
        rows.set(projected.id, projected);
      }
    }
    return { rows: [...rows.values()], complete };
  }
  inventory(raw, excludingId = null) {
    const session = this.getSession();
    const available = !!session && !session.isNonceExpired() && !session.isInventoryCached() && !!session.getRawInventory();
    const mapped = buildMarketInventory(raw || (available ? session.getRawInventory() : null), this.catalogue, this.trading);
    const now = Date.now();
    const rows = mapped.rows.map(row => {
      const listedQuantity = this.listings.filter(l => l.id !== excludingId && reservesInventory(l, now)
        && listingReservesVariant(row, l)).reduce((sum, l) => {
          const quantity = Number.isSafeInteger(l.quantity) && l.quantity > 0 ? l.quantity : row.availableQuantity;
          return Math.min(Number.MAX_SAFE_INTEGER, sum + quantity);
        }, 0);
      const availableQuantity = Math.max(0, row.availableQuantity - listedQuantity);
      const item = this.catalogue.find(item => item.id === row.itemId);
      return { ...row, imageUrl: safeImage(row.imageUrl), availableQuantity, listedQuantity,
        categoryLabel: text(item?.categoryLabel), maxQuantity: maxQuantity(item), canList: row.canList && availableQuantity > 0 };
    });
    const summary = { ...mapped.summary, availableQuantity: rows.reduce((sum, row) => sum + row.availableQuantity, 0),
      listableRows: rows.filter(row => row.canList).length };
    return { ...mapped, summary, rows, available, reason: available ? '' : getPlatformSupport().inventoryUnavailableReason,
      playerName: session === this.playerSession ? this.playerName : '' };
  }
  snapshot() {
    const inventory = this.inventory();
    const iconFor = this.catalogue.length ? marketTemperIcons(this.getTemperCatalog()) : undefined;
    const canTrade = !!this.user && !!this.token && inventory.available && !this.trading.tradingDisabled
      && this.user.inGameVerified && !this.user.envoyNameReverificationRequired
      && !['LISTING_RESTRICTED', 'SUSPENDED', 'BANNED'].includes(this.user.restrictionState)
      && (!inventory.playerName || inventory.playerName.toLowerCase() === this.user.displayHandle.toLowerCase());
    return { authenticated: !!this.user, user: this.user, sessionPersistent: this.sessionPersistent,
      ...(this.getAccountConnection ? { accountConnection: this.getAccountConnection() } : {}),
      signIn: this.browserSignin.snapshot(),
      catalogue: this.catalogue.map(item => ({ ...itemProjection(item), tradeable: tradeable(item),
        acceptedQuantityMax: acceptedQuantityMax(item), attributeType: attributeType(item),
        possibleTempers: possibleTempers(item, this.trading, iconFor), canBeShiny: attributeType(item) === 'weapon' || item.can_be_shiny === true })),
      inventory, canTrade, listings: this.listings, trading: this.trading };
  }
  update() {
    // An unused module never maps inventory or performs network work.
    if (!this.listenerCount('changed')) return;
    const state = this.snapshot(), serialized = JSON.stringify(state);
    if (serialized !== this.lastState) { this.lastState = serialized; this.emit('changed', state); }
  }
  async browse(query = {}) {
    return this.result(async () => {
      const generation = this.generation;
      const view = query.view === 'requests' ? 'requests' : 'offers';
      const availability = ['any', 'available', 'in-game'].includes(query.availability) ? query.availability : 'any';
      let route, selectedItem;
      if (query.advanced != null) {
        route = `listings/search?${advancedListingParams(query.advanced, query)}`;
      } else if (query.slug) {
        const item = this.catalogue.find(item => item.slug === query.slug);
        if (!item) throw fail('UNKNOWN_ITEM', 'Choose an item from the market catalogue.');
        selectedItem = item;
        const params = new URLSearchParams({ view, availability, sort: ['best', 'lowest', 'recent', 'trusted'].includes(query.sort) ? query.sort : 'recent',
          page: String(Math.max(1, Math.min(100, Number(query.page) || 1))), limit: '25' });
        route = `items/${encodeURIComponent(item.slug)}/listings?${params}`;
      } else {
        const params = new URLSearchParams({ type: view, availability: availability === 'available' ? 'online' : availability, limit: '25' });
        if (typeof query.cursor === 'string' && query.cursor.length <= 512) params.set('cursor', query.cursor);
        if (typeof query.category === 'string' && /^[a-z0-9-]{1,64}$/.test(query.category)) params.set('categories', query.category);
        route = `listings/recent?${params}`;
      }
      // Optional authentication lets the market apply the signed-in user's blocks.
      const response = await this.request(route, { token: this.user ? this.token : null }); this.checkGeneration(generation);
      const listings = list(response.data).map(value => listingProjection(selectedItem
        ? { ...value, attributes: { ...value.attributes, itemId: selectedItem.id, item: selectedItem } } : value, this.catalogue));
      // The renderer appends pages; earlier visible cards must still be usable.
      for (const listing of listings) this.browsed.set(listing.id, listing);
      while (this.browsed.size > 2500) this.browsed.delete(this.browsed.keys().next().value);
      return { ok: true, listings, meta: response.meta || {} };
    });
  }
  acceptedItems(entries) {
    if (!Array.isArray(entries) || entries.length > 6) throw fail('VALIDATION_FAILED', 'Choose up to six accepted trade slots.');
    let arcsSeen = false;
    return entries.map(entry => {
      if (!record(entry)) throw fail('VALIDATION_FAILED', 'Choose a valid item or Arcs amount for each trade slot.');
      if (entry.type === 'ARCS') {
        if (arcsSeen) throw fail('VALIDATION_FAILED', 'Use one Arcs slot for the total amount.');
        arcsSeen = true;
        if (!Number.isInteger(entry.amount) || entry.amount < 1 || entry.amount > 100000) throw fail('VALIDATION_FAILED', 'Arcs must be a whole number from 1 to 100,000.');
        if (this.trading.arcsTradeDisabled) throw fail('ARCS_DISABLED', 'Arcs trading is currently disabled on the market.');
        return { type: 'ARCS', amount: entry.amount };
      }
      if (entry.type !== 'ITEM' || typeof entry.itemId !== 'string' || !entry.itemId || entry.itemId.length > 128) throw fail('VALIDATION_FAILED', 'Choose an accepted item from the market catalogue.');
      const item = this.catalogue.find(value => value.id === entry.itemId);
      if (!item) throw fail('UNKNOWN_ITEM', 'An accepted item is missing from the market catalogue. Choose it again.');
      if (!tradeable(item)) throw fail('ITEM_UNAVAILABLE', `${item.name} is not available for trading.`);
      const max = acceptedQuantityMax(item), quantity = entry.quantity === undefined ? 1 : entry.quantity;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) throw fail('VALIDATION_FAILED', `Choose an accepted quantity from 1 to ${max} for ${item.name}.`);
      const type = attributeType(item), out = { type: 'ITEM', itemId: item.id, ...(max > 1 ? { quantity } : {}) };
      for (const kind of ['weapon', 'mote', 'rune']) {
        if (entry[kind] != null && (kind !== type || !record(entry[kind]))) throw fail('VALIDATION_FAILED', `Choose valid ${type || 'item'} attributes for ${item.name}.`);
      }
      if (type === 'weapon') {
        const weapon = entry.weapon;
        if (!record(weapon) || !Object.hasOwn(QUALITY_LIMITS, weapon.quality)) throw fail('VALIDATION_FAILED', `Choose a weapon quality for ${item.name}.`);
        if (weapon.moonsteel != null && typeof weapon.moonsteel !== 'boolean'
          || weapon.tempersAny != null && typeof weapon.tempersAny !== 'boolean') throw fail('VALIDATION_FAILED', 'Choose valid Moonsteel and temper options.');
        const tempers = weapon.tempers ?? [];
        if (!Array.isArray(tempers) || tempers.length > 8 || tempers.some(value => typeof value !== 'string' || !value || value.length > 64)) throw fail('VALIDATION_FAILED', 'Choose up to eight valid weapon tempers.');
        const allowed = new Set(possibleTempers(item, this.trading).map(temper => temper.unique_name));
        for (const temper of new Set(tempers)) {
          if (tempers.filter(value => value === temper).length > 2) throw fail('VALIDATION_FAILED', 'A weapon temper can be selected at most twice.');
          if (allowed.size && !allowed.has(temper)) throw fail('VALIDATION_FAILED', `Choose a valid temper for ${item.name}.`);
        }
        const [minTempers, maxTempers] = QUALITY_LIMITS[weapon.quality];
        if (weapon.tempersAny !== true && (tempers.length < minTempers || tempers.length > maxTempers)) throw fail('VALIDATION_FAILED', `This weapon quality needs ${minTempers} to ${maxTempers} tempers, or choose Any tempers.`);
        out.weapon = { quality: weapon.quality, moonsteel: weapon.moonsteel ?? null,
          tempers: weapon.tempersAny === true || !tempers.length ? null : [...tempers], tempersAny: weapon.tempersAny === true ? true : null };
      } else if (type === 'mote') {
        const mote = entry.mote || {}, virtue = mote.virtue ?? 'COURAGE', gripType = mote.gripType ?? 'UNIVERSAL', upgradeLevel = mote.upgradeLevel ?? 0;
        if (!MOTE_VIRTUES.includes(virtue) || !MOTE_GRIPS.includes(gripType) || !Number.isInteger(upgradeLevel) || upgradeLevel < 0 || upgradeLevel > 3) throw fail('VALIDATION_FAILED', 'Choose a valid mote virtue, rank from 0 to 3, and grip.');
        out.mote = { virtue, upgradeLevel, gripType };
      } else if (type === 'rune') {
        const upgradeLevel = entry.rune?.upgradeLevel ?? 0;
        if (!Number.isInteger(upgradeLevel) || upgradeLevel < 0 || upgradeLevel > 3) throw fail('VALIDATION_FAILED', 'Choose a rune rank from 0 to 3.');
        out.rune = { upgradeLevel };
      }
      return out;
    });
  }
  terms(draft, existing = null) {
    const terms = { ...(existing || {}) };
    // Notes created on the website remain intact, but the app no longer creates or edits them.
    if (Array.isArray(terms.acceptedItems)) terms.acceptedItems = terms.acceptedItems.map(acceptedItemInput);
    if (Object.hasOwn(draft, 'acceptedItems')) {
      terms.acceptedItems = this.acceptedItems(draft.acceptedItems);
      terms.priceAmount = null; terms.priceUnit = null;
    } else if (Object.hasOwn(draft, 'priceAmount')) {
      const amount = draft.priceAmount;
      if (amount != null && amount !== '' && (!Number.isInteger(amount) || amount < 1 || amount > 100000)) throw fail('VALIDATION_FAILED', 'Price must be a whole number from 1 to 100,000 arcs.');
      if (amount && this.trading.arcsTradeDisabled) throw fail('ARCS_DISABLED', 'Arcs trading is currently disabled on the market.');
      terms.priceAmount = amount || null; terms.priceUnit = amount ? 'arcs' : null;
      // An explicit price edit replaces the price while preserving item barter terms.
      if (Array.isArray(terms.acceptedItems)) terms.acceptedItems = terms.acceptedItems.filter(item => item.type !== 'ARCS');
      if (amount) terms.acceptedItems = [...list(terms.acceptedItems), { type: 'ARCS', amount }];
    }
    if (Object.hasOwn(draft, 'acceptedItems') || Object.hasOwn(draft, 'priceAmount')) {
      const onlyArcs = terms.acceptedItems?.length === 1 && terms.acceptedItems[0].type === 'ARCS';
      terms.priceAmount = onlyArcs ? terms.acceptedItems[0].amount : null;
      terms.priceUnit = onlyArcs ? 'arcs' : null;
    }
    if (Array.isArray(terms.acceptedItems) && !terms.acceptedItems.length) terms.acceptedItems = null;
    if (list(terms.acceptedItems).length > 6) throw fail('VALIDATION_FAILED', 'Choose up to six accepted trade slots.');
    // POST terms are optional but not nullable; PATCH null explicitly clears a field.
    if (existing === null) for (const key of Object.keys(terms)) if (terms[key] == null) delete terms[key];
    return terms;
  }
  async freshInventory(generation) {
    const session = this.getSession();
    if (!session || session.isNonceExpired()) throw fail('GAME_REQUIRED', 'Connect to Soulframe before listing inventory items.');
    const accountId = session.accountId;
    const result = await session.api.fetchInventory(accountId, session.nonce);
    const checkSession = () => {
      this.checkGeneration(generation);
      if (session !== this.getSession() || session.accountId !== accountId || session.isNonceExpired() || result?.nonceExpired
        || (result?.data && !inventoryMatchesAccount(result.data, accountId))) {
        throw fail('GAME_SESSION_CHANGED', 'Your game session changed. Wait for the next inventory update.');
      }
    };
    checkSession();
    if (!result?.data) throw fail('INVENTORY_UNAVAILABLE', 'Could not refresh your inventory. Nothing was listed.');
    const profile = await session.api.fetchProfile(accountId, { force: true });
    checkSession();
    const playerName = profileDisplayName(profile, accountId);
    if (!playerName) throw fail('IDENTITY_UNAVAILABLE', 'Could not verify the current game character. Please try again.');
    this.playerName = playerName; this.playerSession = session;
    if (playerName.toLowerCase() !== this.user.displayHandle.toLowerCase()) throw fail('ACCOUNT_MISMATCH', `Soulframe is signed in as ${playerName}. Sign in to the matching market account before selling.`);
    return { data: result.data, session };
  }
  mutate(task) {
    return this.result(async () => {
      this.requireUser();
      if (this.mutating) throw fail('BUSY', 'A listing change is already in progress.');
      this.mutating = true; const generation = this.generation;
      try { return await task(generation); } finally { this.mutating = false; this.update(); }
    });
  }
  async afterMutation(generation) {
    this.checkGeneration(generation);
    try { const listings = await this.loadListings(); this.checkGeneration(generation); this.listings = listings.rows; this.listingsComplete = listings.complete; }
    catch { return { ok: true, state: this.snapshot(), warning: 'Your change was saved. Refresh My listings to see the latest state.' }; }
    return { ok: true, state: this.snapshot() };
  }
  createListing(draft = {}) {
    return this.mutate(async generation => {
      if (!this.user.inGameVerified || this.user.envoyNameReverificationRequired) throw fail('VERIFICATION_REQUIRED', 'Verify your current Envoy name in Market account settings before selling.');
      if (['LISTING_RESTRICTED', 'SUSPENDED', 'BANNED'].includes(this.user.restrictionState)) throw fail('RESTRICTION_ACTIVE', 'Your market account is restricted from creating listings.');
      if (this.trading.tradingDisabled) throw fail('TRADING_DISABLED', this.trading.tradingDisabledMessage || 'Market trading is temporarily disabled.');
      const fresh = await this.freshInventory(generation);
      const listings = await this.loadListings(); this.checkGeneration(generation);
      this.listings = listings.rows; this.listingsComplete = listings.complete;
      if (!listings.complete) throw fail('LISTING_LIMIT', 'The market returned too many open listings to verify all your inventory commitments. Close some open listings on the website before adding more.');
      const row = this.inventory(fresh.data).rows.find(row => row.key === draft.rowKey);
      if (!row?.canList) throw fail('ITEM_UNAVAILABLE', 'This item is no longer available to list. Refresh your inventory.');
      if (!Number.isInteger(draft.quantity) || draft.quantity < 1 || draft.quantity > Math.min(row.availableQuantity, row.maxQuantity)) throw fail('QUANTITY_UNAVAILABLE', `Choose a quantity from 1 to ${Math.min(row.availableQuantity, row.maxQuantity)}.`);
      const terms = this.terms(draft);
      if (fresh.session !== this.getSession() || fresh.session.isNonceExpired()) throw fail('GAME_SESSION_CHANGED', 'Your game session changed. Nothing was listed.');
      await this.request('me/listings', { method: 'POST', body: { itemId: row.itemId, type: 'OFFER', quantity: draft.quantity,
        platform: this.user.platform, locale: this.locale(), terms, ...row.attributes } });
      return this.afterMutation(generation);
    });
  }
  updateListing(draft = {}) {
    return this.mutate(async generation => {
      const listings = await this.loadListings(); this.checkGeneration(generation);
      this.listings = listings.rows; this.listingsComplete = listings.complete;
      const listing = listings.rows.find(row => row.id === draft.id);
      if (!listing) throw fail('LISTING_NOT_FOUND', 'This listing is no longer in your account. Refresh My listings.');
      const patch = {};
      if (Object.hasOwn(draft, 'status')) {
        if (!['ACTIVE', 'PAUSED', 'CLOSED'].includes(draft.status)) throw fail('VALIDATION_FAILED', 'Choose a valid listing status.');
        if (draft.status === 'ACTIVE' && listing.expiresAt && Date.parse(listing.expiresAt) <= Date.now()) {
          throw fail('LISTING_EXPIRED', 'This listing has expired. Create a new listing from your current inventory.');
        }
        patch.status = draft.status;
      }
      if (Object.hasOwn(draft, 'quantity')) {
        if (!Number.isInteger(draft.quantity) || draft.quantity < 1 || draft.quantity > maxQuantity(this.catalogue.find(item => item.id === listing.itemId))) throw fail('VALIDATION_FAILED', 'Choose a valid listing quantity.');
        patch.quantity = draft.quantity;
      }
      // Reactivation and quantity increases must not promise inventory that was sold or equipped.
      let fresh = null;
      if (listing.type === 'OFFER' && (patch.status === 'ACTIVE' || patch.quantity > listing.quantity)) {
        if (!listings.complete) throw fail('LISTING_LIMIT', 'The market returned too many open listings to verify all your inventory commitments. Close some open listings on the website before increasing or resuming listings.');
        fresh = await this.freshInventory(generation);
        const available = this.inventory(fresh.data, listing.id).rows.filter(row => row.canList && variantMatches(row, listing)).reduce((sum, row) => sum + row.availableQuantity, 0);
        if ((patch.quantity || listing.quantity) > available) throw fail('QUANTITY_UNAVAILABLE', 'There is not enough unequipped inventory available for this listing.');
      }
      if (Object.hasOwn(draft, 'priceAmount') || Object.hasOwn(draft, 'acceptedItems')) {
        patch.terms = this.terms(draft, listing.terms);
        if (listing.type === 'REQUEST' && !list(patch.terms.acceptedItems).length && !patch.terms.priceAmount) throw fail('VALIDATION_FAILED', 'Buying listings need at least one accepted item or Arcs amount.');
      }
      if (!Object.keys(patch).length) throw fail('VALIDATION_FAILED', 'No listing changes were provided.');
      this.checkGeneration(generation);
      if (fresh && (fresh.session !== this.getSession() || fresh.session.isNonceExpired())) throw fail('GAME_SESSION_CHANGED', 'Your game session changed. Nothing was updated.');
      await this.request(`me/listings/${encodeURIComponent(listing.id)}`, { method: 'PATCH', body: patch });
      return this.afterMutation(generation);
    });
  }
  copyContact(id) {
    return this.result(async () => {
      const listing = this.browsed.get(id);
      const handle = listing?.seller?.handle;
      if (!handle || !/^[A-Za-z0-9.,_-]{4,32}$/.test(handle)) throw fail('CONTACT_UNAVAILABLE', 'Refresh these listings to get the current trader details.');
      const name = text(listing.item.name).replace(/[\r\n\t]/g, ' ').slice(0, 160);
      const message = `/w ${handle} Hi, ${listing.type === 'REQUEST' ? 'I can help with your request for' : 'I am interested in'} ${name} x${listing.quantity} on Avakot Market.`;
      this.copyText(message); return { ok: true };
    });
  }
  openWebsite(section) {
    if (!WEBSITE) return Promise.resolve({ ok: false, message: 'This build has no Market website configured.' });
    const routes = { home: '/', account: '/settings', register: '/signup', reset: '/forgot-password' };
    return this.result(async () => { await this.openExternal(WEBSITE + (routes[section] || '/')); return { ok: true }; });
  }
}

module.exports = { MarketService, MarketTokenStore, API_BASE, WEBSITE, listingProjection, variantMatches };
