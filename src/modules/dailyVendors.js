'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { resolveName, humanize } = require('../renderer/inventory-format');
const { validTemperCatalog, resolveTemperIcon, temperAlias, legacyTemperName } = require('./catalogData');
const { getCollectionCatalog, itemId, validIcon } = require('./collectionCatalog');

const CATALOG_URL = require('./serviceConfig').services.vendorCatalog;
const STOCK_URL = 'https://api.soulframe.com/api/getVendorInfo.php';
const AVAKOT_VENDOR = '/SF/Types/Game/AvakotVendorManifest';
const DAY = 86400000, ROTATION = 3 * 3600000, RETRY = 10 * 60000, CATALOG_TTL = 3600000;
const MAX_BYTES = 2 * 1024 * 1024;
const FACTIONS = { ChampionSyndicate: 'Kith of Kings', FeySyndicate: 'The Fey', SilentRoseSyndicate: 'Silent Rose' };
// The public vendor catalogue can roll these newer tags before a downloaded
// localized Temper catalogue is available. These canonical names and artwork
// come from the versioned overlay Temper feed, never buff-tag descriptions.
const VENDOR_TEMPERS = {
  legshotmod: { id: '/SF/Language/Upgrades/AspectLegShotName', name: 'Severed Root', icon: 'temper-icons/4acdc5a71580130306b5663edb19b6b53ff620a2565387ef6a97bed1d7dbfb50.png' },
  magickheavyattackdamageandstaggermod: { id: '/SF/Language/Upgrades/AspectHeavyCastAttackName', name: 'Arcane Barrage', icon: 'temper-icons/bb37ae83e1f7c082c500dc4cf639cc4566ef677bc4b0f9050dddec7fa7ad97c5.png' },
  focusedheavyattackdamagemod: { id: '/SF/Language/Upgrades/AspectFocusedHeavyAttackDamageName', name: 'Conjuration', icon: 'temper-icons/e21c3e7cc9c3214672e5a3fcf7906ada3a4f0e732ccb685d1de55d28e9149a04.png' },
  dodgefocusmod: { id: '/SF/Language/Upgrades/AspectDodgeFocusName', name: 'Grounding Spell', icon: 'temper-icons/b7d5ffd131cb92113b7fe21deca172dd4d6af66d5548960f58e40d7a559232f2.png' },
  dendritregaindecaymod: { id: '/SF/Language/Upgrades/AspectDendritRegainDecayName', name: 'Well Woven', icon: 'temper-icons/847f2a315877f64d8802c561412b196b305e529553664cfe52b7144a63209deb.png' },
};
const { normalizeLocale: languageOf } = require('./gameLocales');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, limit = 200) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u001f]/.test(value) ? value.trim() : null;
const itemPath = value => text(value, 400) && /^\/SF\/[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').some(part => part === '.' || part === '..') ? value : null;

const utcDate = time => new Date(time).toISOString().slice(0, 10);

function vendorIcon(value) {
  if (typeof value !== 'string' || value.length > 700 || /[\u0000-\u0020\u007f%\\]/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')) return null;
  if (validIcon(value)) return value;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    // The vendor API publishes game artwork through this image mirror. Reuse
    // the same verified game path on the CDN already allowed by ItemImages.
    const path = url.origin === 'https://img.s3.avkt.org' && url.pathname.startsWith('/Graphics/')
      ? '/SF/Interface' + url.pathname : url.origin === 'https://dap1x6lmnonv6.cloudfront.net' ? url.pathname : null;
    return validIcon(path) ? path : null;
  } catch { return null; }
}

/** Independent replay of the game's audited daily store buff selection. */
function storeWeaponSeed(itemType, now) {
  if (!itemPath(itemType) || !Number.isFinite(now)) return null;
  const lower = Math.floor(now / DAY) * 86400 - 0x40048680;
  if (!Number.isSafeInteger(lower) || lower < 0 || lower > 0xffffffff) return null;
  let crc = 0xffffffff;
  for (const byte of Buffer.from(itemType, 'utf8')) {
    crc ^= byte;
    for (let bit = 0; bit !== 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const upper = ((crc ^ 0xffffffff) >>> 0) || 1;
  return (BigInt(upper) << 32n) | BigInt(lower);
}

function aspectCandidates(value) {
  if (!Array.isArray(value) || value.length > 512) return null;
  const rows = [];
  for (const row of value) {
    if (!record(row) || !text(row.tag, 160) || !Number.isInteger(row.rarity) || row.rarity < 0 || row.rarity > 3
      || typeof row.canBeBuff !== 'boolean' || typeof row.canRollTwice !== 'boolean') return null;
    rows.push({ tag: row.tag, rarity: row.rarity, canBeBuff: row.canBeBuff, canRollTwice: row.canRollTwice });
  }
  return rows;
}

function dailyWeaponTempers(itemType, aspects, now, quality = 3) {
  const parsed = aspectCandidates(aspects);
  let state = storeWeaponSeed(itemType, now);
  const ranges = { 1: [0, 1], 2: [1, 3], 3: [2, 4], 4: [3, 5], 5: [4, 6], 6: [5, 8] };
  if (state === null || parsed === null || !ranges[quality]) return null;
  let pool = parsed.filter(row => row.canBeBuff);
  if (!pool.length) return [];
  const masses = [0x3f4147ae, 0x3e6147ae, 0x3ca3d70a, 0x3ba3d70a].map(bits => {
    const bytes = Buffer.alloc(4); bytes.writeUInt32LE(bits); return bytes.readFloatLE();
  });
  function distribution(rarities) {
    const counts = rarities.reduce((out, rarity) => { out[rarity]++; return out; }, [0, 0, 0, 0]);
    const raw = rarities.map(rarity => Math.max(Math.fround(masses[rarity] / counts[rarity]), 1.1754943508222875e-38));
    const sum = raw.reduce((total, weight) => Math.fround(total + weight), 0);
    const inverse = Math.fround(1 / sum);
    return raw.map(weight => Math.fround(weight * inverse));
  }
  function draw(weights) {
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
    let value = Number((state >> 38n) & 0xffffffn) / 16777216;
    for (let index = 0; index < weights.length; index++) {
      if (value <= weights[index]) return index;
      value -= weights[index];
    }
    return weights.length - 1;
  }
  const [minimum, maximum] = ranges[quality];
  const requested = minimum + draw(distribution(Array(maximum - minimum + 1).fill(0)));
  const selected = [], prior = new Set();
  for (let index = 0; index < requested && pool.length; index++) {
    const position = draw(distribution(pool.map(row => row.rarity)));
    const chosen = pool[position];
    if (!chosen.canRollTwice || prior.has(chosen.tag)) pool.splice(position, 1);
    selected.push(chosen.tag); prior.add(chosen.tag);
    // The native power draw follows each selection even though this view only shows names.
    state = BigInt.asUintN(64, state * 6364136223846793005n + 1442695040888963407n);
  }
  return selected;
}

function normalizeCatalog(value) {
  if (!record(value) || value.avakot?.vendor !== AVAKOT_VENDOR || !Array.isArray(value.avakot.pool)
    || value.avakot.pool.length > 500 || !Array.isArray(value.factions) || value.factions.length > 12) throw new Error('Invalid vendor catalogue');
  function item(row) {
    if (!record(row) || !itemPath(row.storeItem)) return null;
    return { storeItem: row.storeItem, typeName: itemPath(row.typeName), value: text(row.value), icon: vendorIcon(row.icon),
      langKey: text(row.langKey, 400) };
  }
  const pool = value.avakot.pool.map(item).filter(Boolean);
  const seen = new Set();
  const factions = [];
  for (const faction of value.factions) {
    if (!record(faction) || !Object.hasOwn(FACTIONS, faction.syndicate) || seen.has(faction.syndicate)) continue;
    if (!Array.isArray(faction.favors) || faction.favors.length > 500) throw new Error('Invalid faction catalogue');
    seen.add(faction.syndicate);
    const favors = faction.favors.flatMap(row => {
      const projected = item(row);
      return projected ? [{ ...projected, standingCost: number(row.standingCost), requiredLevel: integer(row.requiredLevel),
        freeFavor: row.freeFavor === true, aspects: aspectCandidates(row.aspects) }] : [];
    });
    factions.push({ syndicate: faction.syndicate, favors });
  }
  return { avakot: { vendor: AVAKOT_VENDOR, pool }, factions };
}

function dateMilliseconds(value) {
  const raw = record(value?.$date) ? value.$date.$numberLong : value?.$date;
  const milliseconds = typeof raw === 'number' || typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 8640000000000000 ? milliseconds : null;
}

function normalizeStock(value, now) {
  const info = value?.VendorInfo;
  if (!record(info) || info.TypeName !== AVAKOT_VENDOR || !Array.isArray(info.ItemManifest) || info.ItemManifest.length > 500) throw new Error('Invalid vendor stock');
  const items = [];
  const expires = [];
  const topExpiry = dateMilliseconds(info.Expiry);
  if (topExpiry !== null && topExpiry > now && topExpiry - now < 365 * DAY) expires.push(topExpiry);
  const seen = new Set();
  for (const row of info.ItemManifest) {
    if (!record(row) || !itemPath(row.StoreItem)) continue;
    const rawExpiry = dateMilliseconds(row.Expiry);
    if (rawExpiry !== null && rawExpiry <= now) continue;
    const expiry = rawExpiry !== null && rawExpiry - now < 365 * DAY ? rawExpiry : null;
    if (expiry !== null) expires.push(expiry);
    const regular = Array.isArray(row.RegularPrice) ? number(row.RegularPrice[0]) : null;
    const premium = Array.isArray(row.PremiumPrice) ? number(row.PremiumPrice[0]) : null;
    const price = regular > 0 ? regular : premium > 0 ? premium : null;
    const currency = regular > 0 ? 'Dracs' : premium > 0 ? 'Arcs' : null;
    const id = `${row.StoreItem}@${expiry || 'permanent'}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, storeItem: row.StoreItem, price, currency, limit: integer(row.PurchaseQuantityLimit) > 0 ? row.PurchaseQuantityLimit : null,
      weekly: row.RotatedWeekly === true, expiresAt: expiry });
  }
  return { items, updatedAt: now, nextRefreshAt: (expires.length ? Math.min(...expires) : (Math.floor(now / ROTATION) + 1) * ROTATION) + 30000 };
}

class DailyVendors extends EventEmitter {
  constructor({ getSession = () => null, getLanguage = () => 'en', getNames = () => ({}), cacheDir = null,
    getTemperCatalog = () => null, getItemCatalog = getCollectionCatalog,
    http = axios, now = Date.now, log = () => {} } = {}) {
    super(); Object.assign(this, { getSession, getLanguage, getNames, getTemperCatalog, getItemCatalog, cacheDir, http, now, log });
    this.language = null; this.catalog = null; this.catalogStatus = 'unavailable'; this.catalogAt = null;
    this.stock = null; this.stockStatus = 'connect'; this.nextCatalogAt = 0; this.nextStockAt = 0;
    this.pending = null; this.previous = ''; this.lastSession = null; this.lastAccount = null; this.lastNonce = null;
  }
  context() {
    const session = this.getSession();
    const valid = session && !session.isNonceExpired?.();
    const accountId = valid && /^[a-f0-9]{24}$/i.test(session.accountId || '') ? session.accountId : null;
    const nonce = valid && text(session.nonce, 4096) ? session.nonce : null;
    const live = !!(accountId && nonce && session.getRawInventory?.() && session.isInventoryCached?.() === false);
    return { session: valid ? session : null, accountId, nonce, live, language: languageOf(this.getLanguage()) };
  }
  matches(context) {
    const current = this.context();
    return current.session === context.session && current.accountId === context.accountId && current.nonce === context.nonce
      && current.language === context.language && current.live === context.live;
  }
  loadCatalog(language) {
    if (!this.cacheDir) return;
    try {
      const filename = path.join(this.cacheDir, `daily-vendors-${language}.json`);
      if (fs.statSync(filename).size > MAX_BYTES) return;
      const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (saved.schema !== 1 || saved.language !== language) return;
      this.catalog = normalizeCatalog(saved.data); this.catalogAt = number(saved.updatedAt);
      this.catalogStatus = 'cached';
    } catch { /* No valid local catalogue yet. */ }
  }
  async saveCatalog(language, data, updatedAt) {
    if (!this.cacheDir) return;
    try {
      await fs.promises.mkdir(this.cacheDir, { recursive: true });
      const filename = path.join(this.cacheDir, `daily-vendors-${language}.json`), temp = `${filename}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, JSON.stringify({ schema: 1, language, updatedAt, data }));
      await fs.promises.rename(temp, filename);
    } catch { this.log('Vendor catalogue could not be saved.'); }
  }
  synchronize(context) {
    if (context.language !== this.language) {
      this.language = context.language; this.catalog = null; this.catalogAt = null; this.nextCatalogAt = 0;
      this.catalogStatus = 'unavailable'; this.loadCatalog(context.language);
      this.stock = null; this.nextStockAt = 0; this.stockStatus = context.live ? 'waiting' : 'connect';
    }
    if (context.session !== this.lastSession || context.accountId !== this.lastAccount || context.nonce !== this.lastNonce) {
      this.stock = null; this.nextStockAt = 0;
      this.stockStatus = context.live ? 'waiting' : context.session ? 'waiting' : 'connect';
      this.lastSession = context.session; this.lastAccount = context.accountId; this.lastNonce = context.nonce;
    }
    if (!context.live) this.stockStatus = context.session ? 'waiting' : 'connect';
  }
  update() {
    const context = this.context();
    this.synchronize(context);
    if (!this.pending && (CATALOG_URL && this.now() >= this.nextCatalogAt || context.live && this.now() >= this.nextStockAt)) void this.refresh();
    return this.publish();
  }
  getSnapshot() { return this.update(); }
  snapshot() {
    const now = this.now(), names = this.getNames() || {}, context = this.context();
    const inventory = context.session?.getRawInventory?.();
    const suppliedTempers = this.getTemperCatalog(), tempers = validTemperCatalog(suppliedTempers) ? suppliedTempers : null;
    const temperRows = new Map(tempers?.tempers.map(row => [row.id, row]));
    const icons = new Map((this.getItemCatalog()?.items || []).map(row => [itemId(row.itemType), row.icon]));
    const iconFor = row => {
      const icon = validIcon(row.icon) && row.icon || icons.get(itemId(row.typeName || row.storeItem));
      return validIcon(icon) ? icon : null;
    };
    const temperFor = (id, count, weapon) => {
      const tag = id.toLowerCase(), short = tag.split('/').pop(), weaponKey = itemId(weapon);
      const compatibility = Object.hasOwn(VENDOR_TEMPERS, short) ? VENDOR_TEMPERS[short] : null;
      const temperId = tempers?.weaponAliases[weaponKey]?.[short] || tempers?.aliases[tag] || tempers?.aliases[short]
        || temperAlias(null, tag, weaponKey) || temperAlias(null, short, weaponKey) || compatibility?.id;
      const row = temperRows.get(temperId) || compatibility;
      // Buff-tag translations describe effects. Only the canonical Name key is
      // a Temper name; the catalogue also supplies its matching artwork.
      return { id, name: names[temperId] || row?.name || legacyTemperName(temperId) || humanize(id.replace(/Mod$/, '')),
        icon: resolveTemperIcon(temperId, row?.icon) || null, count };
    };
    const label = row => names[row.langKey] || names[row.typeName] || names[row.storeItem] || row.value || resolveName(row.typeName || row.storeItem, names);
    const factions = (this.catalog?.factions || []).map(faction => {
      const rank = Array.isArray(inventory?.Affiliations) ? inventory.Affiliations.find(row => row?.Tag === faction.syndicate)?.Title : null;
      return { id: faction.syndicate, name: names[faction.syndicate] || FACTIONS[faction.syndicate], items: faction.favors.map(row => {
        const isWeapon = !!row.typeName?.startsWith('/SF/Weapons/');
        const tags = isWeapon ? dailyWeaponTempers(row.typeName, row.aspects, now, 3) : null;
        const counts = new Map(); for (const tag of tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
        return { id: row.storeItem, itemType: row.typeName || row.storeItem, name: label(row), icon: iconFor(row), isWeapon,
          price: row.standingCost, currency: 'Standing', requiredRank: row.requiredLevel,
          eligible: row.requiredLevel === null || !Number.isInteger(rank) ? null : rank >= row.requiredLevel,
          quality: isWeapon ? 'Officer' : null, qualityId: isWeapon ? 'IQ_OFFICER' : null,
          tempers: [...counts].map(([id, count]) => temperFor(id, count, row.typeName)),
          rollStatus: isWeapon ? tags === null ? 'unavailable' : 'calculated' : null,
          rollDate: isWeapon && tags !== null ? utcDate(now) : null, freeFavor: row.freeFavor };
      }) };
    });
    const pool = new Map((this.catalog?.avakot.pool || []).map(row => [row.storeItem, row]));
    const stock = context.live ? this.stock : null;
    const items = (stock?.items || []).filter(row => row.expiresAt === null || row.expiresAt > now).map(row => {
      const info = pool.get(row.storeItem) || { storeItem: row.storeItem };
      return { ...row, itemType: info.typeName || row.storeItem, name: label(info), icon: iconFor(info) };
    });
    const stockStatus = !context.live ? context.session ? 'waiting' : 'connect'
      : stock && (now >= stock.nextRefreshAt || this.stockStatus === 'cached') ? 'cached' : stock ? 'live' : this.stockStatus;
    return { date: utcDate(now), catalogStatus: this.catalogStatus, stockStatus, factions,
      avakot: { items, updatedAt: stock?.updatedAt || null, nextRefreshAt: stock?.nextRefreshAt || (context.live ? this.nextStockAt || null : null) },
      updatedAt: this.catalogAt };
  }
  publish() {
    // A request may finish after a login/language change without another poll tick.
    this.synchronize(this.context());
    const snapshot = this.snapshot(), serialized = JSON.stringify(snapshot);
    if (serialized !== this.previous) { this.previous = serialized; this.emit('changed', snapshot); }
    return snapshot;
  }
  refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    const context = this.context(), now = this.now();
    this.synchronize(context);
    const catalogDue = CATALOG_URL && (now >= this.nextCatalogAt || force && now - (this.lastCatalogAttempt || 0) >= 30000);
    const stockDue = context.live && (now >= this.nextStockAt || force && now - (this.lastStockAttempt || 0) >= 30000);
    if (!catalogDue && !stockDue) return Promise.resolve(this.publish());
    if (catalogDue) {
      this.lastCatalogAttempt = now; this.nextCatalogAt = now + RETRY;
      if (!this.catalog) this.catalogStatus = 'loading';
    }
    if (stockDue) { this.lastStockAttempt = now; this.nextStockAt = now + RETRY; if (!this.stock) this.stockStatus = 'waiting'; }
    const tasks = [];
    if (catalogDue) tasks.push((async () => {
      try {
        const response = await this.http.get(CATALOG_URL, { params: { lang: context.language }, timeout: 15000,
          maxRedirects: 0, maxContentLength: MAX_BYTES, headers: { Accept: 'application/json' } });
        if (response.status !== 200) throw new Error('Catalogue unavailable');
        const data = normalizeCatalog(response.data);
        if (this.context().language !== context.language) return;
        this.catalog = data; this.catalogAt = this.now(); this.catalogStatus = 'ready'; this.nextCatalogAt = this.now() + CATALOG_TTL;
        await this.saveCatalog(context.language, data, this.catalogAt);
      } catch { if (this.context().language === context.language) this.catalogStatus = this.catalog ? 'cached' : 'unavailable'; this.log('Vendor catalogue update unavailable.'); }
    })());
    if (stockDue) tasks.push((async () => {
      try {
        const response = await this.http.get(STOCK_URL, { params: { accountId: context.accountId, nonce: context.nonce, vendor: AVAKOT_VENDOR },
          timeout: 15000, maxRedirects: 0, maxContentLength: MAX_BYTES,
          headers: { Accept: 'application/json', 'User-Agent': 'Soulframe.x64.exe' } });
        if (response.status !== 200) throw new Error('Stock unavailable');
        const stock = normalizeStock(response.data, this.now());
        if (!this.matches(context)) return;
        this.stock = stock; this.nextStockAt = stock.nextRefreshAt; this.stockStatus = 'live';
      } catch {
        if (this.matches(context)) this.stockStatus = this.stock ? 'cached' : 'unavailable';
        this.log('Avakot stock update unavailable.');
      }
    })());
    this.pending = Promise.all(tasks).then(() => this.publish()).finally(() => {
      this.pending = null;
      if (!this.matches(context)) this.update();
    });
    return this.pending;
  }
}

module.exports = { DailyVendors, dailyWeaponTempers, storeWeaponSeed, normalizeCatalog, normalizeStock,
  dateMilliseconds, languageOf, vendorIcon, CATALOG_URL, STOCK_URL, AVAKOT_VENDOR };
