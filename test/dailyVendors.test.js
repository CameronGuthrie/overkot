'use strict';

process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DailyVendors, dailyWeaponTempers, storeWeaponSeed, normalizeCatalog, normalizeStock,
  vendorIcon, AVAKOT_VENDOR, CATALOG_URL, STOCK_URL } = require('../src/modules/dailyVendors');
const DAY = 86400000;
const weapon = '/SF/Weapons/Melee/TestDailyWeapon';
const storeItem = '/SF/StoreItems/Weapons/Melee/TestDailyWeapon';
const aspects = [
  { tag: 'CommonA', rarity: 0, canBeBuff: true, canRollTwice: true },
  { tag: 'CommonB', rarity: 0, canBeBuff: true, canRollTwice: false },
  { tag: 'Uncommon', rarity: 1, canBeBuff: true, canRollTwice: true },
  { tag: 'Rare', rarity: 2, canBeBuff: true, canRollTwice: false },
  { tag: 'Legendary', rarity: 3, canBeBuff: true, canRollTwice: false },
  { tag: 'CurseOnly', rarity: 0, canBeBuff: false, canRollTwice: false },
];
const date = value => ({ $date: { $numberLong: String(value) } });
function catalogue() {
  return { avakot: { vendor: AVAKOT_VENDOR, pool: [{ storeItem, typeName: weapon, value: 'Daily weapon' }] },
    factions: [{ syndicate: 'FeySyndicate', favors: [{ storeItem, typeName: weapon, value: 'Daily weapon',
      standingCost: 1000, requiredLevel: 2, freeFavor: true, aspects }] }] };
}
function vendorStock(now) {
  return { VendorInfo: { TypeName: AVAKOT_VENDOR, Expiry: date(now + 3600000), ItemManifest: [
    { StoreItem: storeItem, RegularPrice: [200, 200], PurchaseQuantityLimit: 3, Expiry: date(now + 3600000) },
    { StoreItem: '/SF/StoreItems/Permanent', PremiumPrice: [20, 20], RotatedWeekly: true, Expiry: date(now + 5 * 365 * DAY) },
    { StoreItem: '/SF/StoreItems/Ended', RegularPrice: [50, 50], Expiry: date(now - 1) },
  ] } };
}
function fixture(options = {}) {
  let now = Date.UTC(2026, 10, 11, 12), current = null, language = 'en';
  const calls = [], logs = [];
  const session = { accountId: 'a'.repeat(24), nonce: 'private-session-token',
    isNonceExpired: () => false, isInventoryCached: () => false,
    getRawInventory: () => ({ Affiliations: [{ Tag: 'FeySyndicate', Title: 2 }] }) };
  const http = { get: async (url, options) => { calls.push({ url, options });
    return { status: 200, data: url === CATALOG_URL ? catalogue() : vendorStock(now) }; } };
  const service = new DailyVendors({ getSession: () => current, getLanguage: () => language,
    getNames: () => ({ CommonA: 'Common A' }), http, now: () => now, log: value => logs.push(value), ...options });
  return { service, session, calls, logs, http, get now() { return now; }, advance(ms) { now += ms; },
    connect(value = session) { current = value; }, language(value) { language = value; } };
}

test('daily store selection matches independent audited golden vectors with rarity and repeat rules', () => {
  const vectors = [
    [1794268800, 3, ['CommonA', 'CommonA', 'CommonB']],
    [1794355200, 3, ['CommonA', 'CommonB', 'CommonA', 'Uncommon']],
    [1794441600, 3, ['CommonA', 'Uncommon', 'Uncommon', 'CommonB']],
    [1794268800, 5, ['CommonA', 'CommonA', 'CommonB', 'Uncommon', 'Uncommon']],
    [1794355200, 5, ['CommonA', 'CommonB', 'CommonA', 'Uncommon', 'Uncommon', 'Rare']],
    [1794441600, 5, ['CommonA', 'Uncommon', 'Uncommon', 'CommonB', 'CommonA', 'Rare']],
  ];
  for (const [seconds, quality, expected] of vectors) assert.deepEqual(dailyWeaponTempers(weapon, aspects, seconds * 1000, quality), expected);
  assert.equal(storeWeaponSeed(weapon, 1794268800000), 0xc99d610e2aedd800n);
});
test('roll remains stable within one UTC day and never invents a roll from malformed candidates', () => {
  const now = Date.UTC(2026, 10, 11);
  assert.deepEqual(dailyWeaponTempers(weapon, aspects, now), dailyWeaponTempers(weapon, aspects, now + DAY - 1));
  assert.deepEqual(dailyWeaponTempers(weapon, [], now), []);
  assert.equal(dailyWeaponTempers(weapon, [{ ...aspects[0], rarity: 9 }], now), null);
  assert.equal(dailyWeaponTempers(weapon, [{ ...aspects[0], canRollTwice: undefined }], now), null);
  assert.equal(dailyWeaponTempers(weapon, aspects, 0), null);
  assert.equal(dailyWeaponTempers('/SF/../Invalid', aspects, now), null);
});
test('catalogue schema keeps factual vendor details and rejects unexpected shapes', () => {
  const data = normalizeCatalog(catalogue());
  assert.equal(data.factions[0].favors[0].standingCost, 1000);
  assert.equal(data.factions[0].favors[0].requiredLevel, 2);
  assert.throws(() => normalizeCatalog({ avakot: { vendor: 'wrong', pool: [] }, factions: [] }), /Invalid/);
  const input = catalogue(); input.factions[0].favors[0].storeItem = '/SF/../Bad';
  assert.equal(normalizeCatalog(input).factions[0].favors.length, 0);
});
test('live stock uses actual manifest offers, expiration, currency and purchase limits', () => {
  const now = Date.UTC(2026, 10, 11);
  const data = normalizeStock(vendorStock(now), now);
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.items[0], { id: `${storeItem}@${now + 3600000}`, storeItem,
    price: 200, currency: 'Dracs', limit: 3, weekly: false, expiresAt: now + 3600000 });
  assert.equal(data.items[1].currency, 'Arcs'); assert.equal(data.items[1].weekly, true); assert.equal(data.items[1].expiresAt, null);
  assert.equal(data.nextRefreshAt, now + 3600000 + 30000);
  assert.throws(() => normalizeStock({ VendorInfo: { TypeName: 'wrong', ItemManifest: [] } }, now), /Invalid/);
});
test('public catalogue loads without login and never masquerades as current Avakot stock', async () => {
  const f = fixture(); f.service.update(); await f.service.refresh();
  const snapshot = f.service.getSnapshot();
  assert.equal(snapshot.catalogStatus, 'ready'); assert.equal(snapshot.stockStatus, 'connect');
  assert.equal(snapshot.avakot.items.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, CATALOG_URL);
  assert.equal(snapshot.factions[0].items[0].quality, 'Officer');
  assert.equal(snapshot.factions[0].items[0].eligible, null);
});
test('valid live login fetches stock only when due and projects no private credentials', async () => {
  const f = fixture(); f.connect(); f.service.update(); const first = f.service.refresh(), second = f.service.refresh();
  assert.equal(first, second); await first;
  const data = f.service.getSnapshot();
  assert.equal(data.stockStatus, 'live'); assert.equal(data.avakot.items[0].name, 'Daily weapon');
  assert.equal(data.factions[0].items[0].eligible, true);
  assert.ok(data.factions[0].items[0].tempers.some(row => row.name === 'Common A'));
  const stockCall = f.calls.find(call => call.url === STOCK_URL);
  assert.equal(stockCall.options.maxRedirects, 0); assert.equal(stockCall.options.params.vendor, AVAKOT_VENDOR);
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes(f.session.accountId), false); assert.equal(serialized.includes(f.session.nonce), false);
  f.advance(1000); f.service.update(); await f.service.refresh(); assert.equal(f.calls.length, 2);
});

test('faction weapon tags resolve to canonical Temper names and matching logos instead of effect descriptions', async () => {
  const f = fixture({ getNames: () => ({ CassidPoisonMod: 'Chance to apply poison on hit.',
    '/SF/Language/Upgrades/AspectPoisonName': 'Afflicted Lurgy' }) });
  const catalog = catalogue();
  catalog.factions[0].favors[0].aspects = [{ tag: 'CassidPoisonMod', rarity: 0, canBeBuff: true, canRollTwice: true }];
  f.http.get = async () => ({ status: 200, data: catalog });
  await f.service.refresh();
  const tempers = f.service.getSnapshot().factions[0].items[0].tempers;
  assert.equal(tempers.length, 1);
  assert.equal(tempers[0].name, 'Afflicted Lurgy');
  assert.equal(tempers[0].icon, require('../src/data/tempers.json').tempers.find(row => row.id === '/SF/Language/Upgrades/AspectPoisonName').icon);
  assert.ok(tempers[0].count >= 2);
  assert.equal(JSON.stringify(tempers).includes('Chance to apply'), false);
});

test('localized catalogues and weapon-specific aliases supply the correct Temper name and streamed artwork', async () => {
  const data = structuredClone(require('../src/data/tempers.json'));
  const id = '/SF/Language/Upgrades/AspectHeavyCastAttackName';
  const row = data.tempers.find(temper => temper.id === id);
  row.name = 'Localized Arcane Barrage'; row.icon = 'temper-icons/' + 'a'.repeat(64) + '.png';
  data.weaponAliases[weapon.toLowerCase()] = { heavyattackdamageandstaggermod: id };
  const f = fixture({ getTemperCatalog: () => data,
    getNames: () => ({ HeavyAttackDamageAndStaggerMod: 'Increased damage during heavy attacks.' }) });
  const catalog = catalogue();
  catalog.factions[0].favors[0].aspects = [{ tag: 'HeavyAttackDamageAndStaggerMod', rarity: 0, canBeBuff: true, canRollTwice: true }];
  f.http.get = async () => ({ status: 200, data: catalog });
  await f.service.refresh();
  const temper = f.service.getSnapshot().factions[0].items[0].tempers[0];
  assert.equal(temper.name, 'Localized Arcane Barrage');
  assert.equal(temper.icon, row.icon);
});

test('current vendor tags retain verified Temper identities while the localized catalogue is still loading', async () => {
  const expected = { LegShotMod: 'Severed Root', MagickHeavyAttackDamageAndStaggerMod: 'Arcane Barrage',
    FocusedHeavyAttackDamageMod: 'Conjuration', DodgeFocusMod: 'Grounding Spell', DendritRegainDecayMod: 'Well Woven' };
  for (const [tag, name] of Object.entries(expected)) {
    const f = fixture({ getTemperCatalog: () => null, getNames: () => ({ [tag]: 'Effect description must not be a name.' }) });
    const catalog = catalogue();
    catalog.factions[0].favors[0].aspects = [{ tag, rarity: 0, canBeBuff: true, canRollTwice: true }];
    f.http.get = async () => ({ status: 200, data: catalog }); await f.service.refresh();
    const temper = f.service.getSnapshot().factions[0].items[0].tempers[0];
    assert.equal(temper.name, name, tag);
    assert.match(temper.icon, /^temper-icons\/[a-f0-9]{64}\.png$/, tag);
  }
});

test('live Avakot items carry validated catalogue artwork next to their actual stock entries', async () => {
  const icon = '/SF/Interface/Graphics/Weapons/TestDailyWeapon.png';
  const f = fixture({ getItemCatalog: () => ({ items: [{ itemType: weapon, icon }] }) });
  f.connect(); await f.service.refresh();
  assert.equal(f.service.getSnapshot().avakot.items[0].icon, icon);
  assert.equal(f.service.getSnapshot().factions[0].items[0].icon, icon);
  assert.equal(f.service.getSnapshot().avakot.items[1].icon, null, 'Unknown artwork is not invented');
  f.service.getItemCatalog = () => ({ items: [{ itemType: weapon, icon: 'https://untrusted.example/icon.png' }] });
  assert.equal(f.service.getSnapshot().avakot.items[0].icon, null);
  const explicit = catalogue(); explicit.avakot.pool[0].icon = icon;
  assert.equal(normalizeCatalog(explicit).avakot.pool[0].icon, icon);
  explicit.avakot.pool[0].icon = '/SF/Interface/Graphics/../private.png';
  assert.equal(normalizeCatalog(explicit).avakot.pool[0].icon, null);
});

test('the vendor image mirror normalizes verified Duelo and Lampyrite artwork onto the allowed game CDN', () => {
  for (const suffix of ['StoreItems/Pacts/Duelo.png', 'StoreItems/Materials/CatalystA.png',
    'StoreItems/Materials/CatalystB.png', 'StoreItems/Materials/CatalystC.png']) {
    const path = '/SF/Interface/Graphics/' + suffix;
    assert.equal(vendorIcon('https://img.s3.avkt.org/Graphics/' + suffix), path);
    assert.equal(vendorIcon('https://dap1x6lmnonv6.cloudfront.net' + path), path);
    const data = catalogue(); data.avakot.pool[0].icon = 'https://img.s3.avkt.org/Graphics/' + suffix;
    assert.equal(normalizeCatalog(data).avakot.pool[0].icon, path);
  }
  for (const icon of ['https://img.s3.avkt.org.evil.example/Graphics/a.png', 'http://img.s3.avkt.org/Graphics/a.png',
    'https://user@img.s3.avkt.org/Graphics/a.png', 'https://img.s3.avkt.org/Graphics/a.png?private=1',
    'https://img.s3.avkt.org/Graphics/a.png#part', 'https://img.s3.avkt.org/Graphics/../../private.png',
    'https://img.s3.avkt.org/Graphics/a/../Materials/CatalystA.png', 'https://img.s3.avkt.org/Graphics/a/./Materials/CatalystA.png',
    'https://img.s3.avkt.org/Graphics/%2e%2e/private.png', 'https://img.s3.avkt.org/Graphics/a\n.png',
    'https://img.s3.avkt.org/Graphics/\tCatalystA.png', 'file:///SF/Interface/Graphics/a.png']) {
    assert.equal(vendorIcon(icon), null, icon);
  }
});
test('saved inventory never causes a credentialed vendor request', async () => {
  const f = fixture(); f.connect({ ...f.session, isInventoryCached: () => true }); f.service.update(); await f.service.refresh();
  assert.equal(f.service.getSnapshot().stockStatus, 'waiting');
  assert.equal(f.calls.some(call => call.url === STOCK_URL), false);
});
test('account or nonce expiry clears stock and ignores a late credentialed response', async () => {
  const f = fixture(); let resolve;
  f.http.get = async (url, options) => { f.calls.push({ url, options }); return url === CATALOG_URL
    ? { status: 200, data: catalogue() } : new Promise(done => { resolve = done; }); };
  f.connect(); f.service.update(); const pending = f.service.refresh();
  f.connect(null); const disconnected = f.service.update(); assert.equal(disconnected.stockStatus, 'connect');
  resolve({ status: 200, data: vendorStock(f.now) }); await pending;
  assert.equal(f.service.getSnapshot().avakot.items.length, 0);
  assert.equal(f.service.getSnapshot().stockStatus, 'connect');
});
test('changing the language discards a late catalogue response and refreshes only the selected language', async () => {
  const f = fixture(); let resolve;
  f.http.get = async (url, options) => { f.calls.push({ url, options }); return options.params.lang === 'en'
    ? new Promise(done => { resolve = done; }) : { status: 200, data: catalogue() }; };
  const first = f.service.refresh(); f.language('fr'); f.service.update();
  resolve({ status: 200, data: { ...catalogue(), factions: [] } }); await first;
  await f.service.refresh();
  assert.equal(f.service.getSnapshot().factions.length, 1);
  assert.equal(f.calls.at(-1).options.params.lang, 'fr');
});
test('a first direct refresh initializes a durable catalogue instead of resetting it on the next read', async () => {
  const f = fixture(); await f.service.refresh();
  assert.equal(f.service.getSnapshot().catalogStatus, 'ready');
  assert.equal(f.service.getSnapshot().factions.length, 1); assert.equal(f.calls.length, 1);
});
test('a response completion detects account replacement before emitting any saved shelf', async () => {
  const f = fixture(); f.connect(); await f.service.refresh();
  const seen = []; let finish;
  f.service.on('changed', data => seen.push(data));
  f.advance(31000);
  f.http.get = async url => url === CATALOG_URL ? { status: 200, data: catalogue() }
    : new Promise(resolve => { finish = resolve; });
  const pending = f.service.refresh({ force: true });
  f.connect({ ...f.session, accountId: 'b'.repeat(24), isInventoryCached: () => true });
  finish({ status: 200, data: vendorStock(f.now) }); await pending;
  assert.ok(seen.length); assert.ok(seen.every(data => data.avakot.items.length === 0));
  assert.equal(f.service.getSnapshot().stockStatus, 'waiting');
});
test('a failed update retains labelled saved stock, hides expired items, and never logs request credentials', async () => {
  const f = fixture(); f.connect(); f.service.update(); await f.service.refresh();
  f.advance(3600000 + 31000);
  f.http.get = async () => { throw new Error(`private URL ?nonce=${f.session.nonce}`); };
  f.service.update(); await f.service.refresh(); const data = f.service.getSnapshot();
  assert.equal(data.stockStatus, 'cached'); assert.equal(data.avakot.items.length, 1);
  assert.equal(JSON.stringify(f.logs).includes(f.session.nonce), false);
});
test('daily faction rolls update at midnight without inventing current stock from catalogue', async () => {
  const f = fixture(); f.service.update(); await f.service.refresh();
  const before = f.service.getSnapshot().factions[0].items[0];
  f.advance(DAY); const after = f.service.getSnapshot().factions[0].items[0];
  assert.notEqual(after.rollDate, before.rollDate);
  assert.equal(after.rollStatus, 'calculated'); assert.equal(f.service.getSnapshot().avakot.items.length, 0);
  await f.service.refresh();
});
test('validated public catalogue cache works offline and contains no game credentials', async t => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-vendors-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(cacheDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cacheDir).startsWith('overkot-vendors-'));
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
  const now = Date.UTC(2026, 10, 11);
  const service = new DailyVendors({ cacheDir, now: () => now, http: { get: async () => ({ status: 200, data: catalogue() }) } });
  service.update(); await service.refresh();
  const saved = fs.readFileSync(path.join(cacheDir, 'daily-vendors-en.json'), 'utf8');
  assert.equal(saved.includes('nonce'), false); assert.equal(saved.includes('accountId'), false);
  const offline = new DailyVendors({ cacheDir, now: () => now, http: { get: async () => { throw new Error('Offline'); } } });
  offline.update(); await offline.refresh();
  assert.equal(offline.getSnapshot().catalogStatus, 'cached'); assert.equal(offline.getSnapshot().factions[0].items.length, 1);
});
