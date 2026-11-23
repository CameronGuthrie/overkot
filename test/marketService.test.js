process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MarketService, MarketTokenStore } = require('../src/modules/marketService');

const accountId = '1234567890abcdef12345678';
const itemPath = '/SF/Types/Items/Resources/TestResource';
const item = { id: 'resource-id', unique_name: 'TestResource', path: itemPath, name: 'Test resource',
  slug: 'test-resource', category: 'Resource', tradeable: true, image_path: '/SF/Interface/Graphics/Resources/Test.png' };
const inventory = count => ({ AccountId: accountId, Secret: 'game-secret', MiscItems: [{ ItemType: itemPath, ItemCount: count }] });
const profile = name => ({ Results: [{ AccountId: { $oid: accountId }, DisplayName: name }] });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const f = { requests: [], own: [], live: inventory(10), cached: false, expired: false, name: 'TestEnvoy',
    saved: null, writes: [], copies: [], opened: [], override: null, marketConfig: {}, publicStatus: 200, fetches: 0, catalogue: [item],
    locale: 'en', languagePack: {} };
  f.session = { accountId, nonce: 'game-nonce', getRawInventory: () => inventory(10), isNonceExpired: () => f.expired,
    isInventoryCached: () => f.cached, api: {
      fetchInventory: async () => { f.fetches++; if (f.inventoryWait) await f.inventoryWait.promise; return { data: f.live }; },
      fetchProfile: async () => profile(f.name),
    } };
  f.service = new MarketService({ getSession: () => f.session, locale: () => f.locale,
    apiBase: 'http://127.0.0.1:3000/v1', readLocalApiKey: () => 'private-integration-key',
    tokenStore: { load: () => f.saved, clear: () => { f.saved = null; }, save: token => { f.saved = token; return true; } },
    copyText: value => f.copies.push(value), openExternal: url => f.opened.push(url),
    fetchImpl: async (url, options) => {
      const route = url.split('/v1/')[1];
      const request = { route, ...options, body: options.body ? JSON.parse(options.body) : undefined };
      f.requests.push(request);
      if (f.override) { const result = await f.override(request); if (result) return result; }
      if (route === 'auth/sign-in') return response({ data: { id: 'market-user', meta: { sessionToken: 'private-market-token' } } });
      if (route === 'me') return response({ data: { id: 'market-user', attributes: { displayHandle: 'TestEnvoy', platform: 'PC', inGameVerified: true, restrictionState: 'NONE' } } });
      if (route === 'catalogue/feed') return f.publicStatus === 200 ? response({ items: f.catalogue })
        : response({ error: { code: 'UNAUTHORIZED', message: 'API key required.' } }, f.publicStatus);
      if (route === 'public/config') return response({ data: f.marketConfig });
      if (route.startsWith('catalogue/languages/')) return response(f.languagePack);
      if (route.startsWith('me/listings?')) {
        const query = new URLSearchParams(route.split('?')[1]), state = query.get('state')?.toUpperCase();
        return response({ data: f.own.filter(row => !state || row.attributes.status === state).slice(0, Number(query.get('limit')) || 25) });
      }
      if (route === 'me/listings' && options.method === 'POST') {
        f.writes.push(request.body);
        const listing = { id: 'created-' + f.writes.length, attributes: { ...request.body, status: 'ACTIVE', item: { ...item, displayName: item.name } } };
        f.own.push(listing); return response({ data: listing }, 201);
      }
      if (route.startsWith('me/listings/') && options.method === 'PATCH') {
        f.writes.push(request.body);
        const listing = f.own.find(row => row.id === decodeURIComponent(route.split('/').pop()));
        Object.assign(listing.attributes, request.body); return response({ data: listing });
      }
      if (route.startsWith('listings/recent') || route.startsWith('listings/search') || route.startsWith('items/')) return response({ data: [{ id: 'browse-id', attributes: {
        type: 'OFFER', status: 'ACTIVE', quantity: 3, item: route.startsWith('items/') ? undefined : { ...item, displayName: item.name },
        seller: { handle: 'TraderName', inGame: true }, terms: { priceAmount: 10, priceUnit: 'arcs' },
      } }], meta: { nextCursor: 'next', hasMore: true } });
      if (route === 'auth/sign-out') return response({ data: {} });
      throw new Error('Unexpected route: ' + route);
    } });
  f.login = () => f.service.login({ email: 'test@example.com', password: 'example-password', remember: true });
  f.row = () => f.service.snapshot().inventory.rows[0];
  return f;
}

test('inventory sidebar availability follows account verification, restrictions and the connected game', async () => {
  const f = fixture();
  assert.equal(f.service.snapshot().canTrade, false);
  await f.login();
  assert.equal(f.service.snapshot().canTrade, true);
  f.service.user.inGameVerified = false;
  assert.equal(f.service.snapshot().canTrade, false);
  f.service.user.inGameVerified = true;
  f.service.user.restrictionState = 'LISTING_RESTRICTED';
  assert.equal(f.service.snapshot().canTrade, false);
  f.service.user.restrictionState = 'NONE';
  f.service.trading.tradingDisabled = true;
  assert.equal(f.service.snapshot().canTrade, false);
  f.service.trading.tradingDisabled = false;
  f.expired = true;
  assert.equal(f.service.snapshot().canTrade, false);
  f.expired = false;
  f.service.playerName = 'AnotherEnvoy'; f.service.playerSession = f.session;
  assert.equal(f.service.snapshot().canTrade, false);
});

test('native sign-in keeps credentials in main and returns safe inventory and image projections', async () => {
  const f = fixture();
  const result = await f.login(); assert.equal(result.ok, true);
  assert.equal(result.state.authenticated, true); assert.equal(f.saved, 'private-market-token');
  assert.equal(f.row().availableQuantity, 10);
  assert.match(result.state.catalogue[0].imageUrl, /^overkot-game-data:\/\/images\/SF\/Interface\/Graphics\//);
  const exposed = JSON.stringify(result);
  for (const secret of [accountId, 'game-nonce', 'game-secret', 'private-market-token', 'example-password']) assert.equal(exposed.includes(secret), false);
  assert.equal(f.requests.find(r => r.route === 'me').headers.Authorization, 'Bearer private-market-token');
  assert.equal(f.requests.find(r => r.route === 'catalogue/feed').headers.Authorization, undefined);
  assert.ok(f.requests.every(r => r.headers['X-API-Key'] === 'private-integration-key'));
  assert.equal(f.requests.some(r => r.headers.Origin), false);
  assert.equal(JSON.stringify(result).includes('private-integration-key'), false);
});

test('signed-out browsing loads public catalogue and listings without account credentials or writes', async () => {
  const f = fixture();
  assert.equal((await f.service.refresh()).ok, true);
  assert.equal(f.service.snapshot().authenticated, false);
  assert.equal(f.service.snapshot().catalogue[0].id, item.id);
  assert.deepEqual(f.service.snapshot().listings, []);
  assert.equal((await f.service.browse()).listings.length, 1);
  const selected = await f.service.browse({ slug: item.slug, view: 'requests', page: 2 });
  assert.equal(selected.ok, true);
  assert.equal(selected.listings[0].itemId, item.id);
  assert.equal((await f.service.copyContact('browse-id')).ok, true);
  assert.match(f.copies[0], /^\/w TraderName /);
  assert.ok(f.requests.every(request => request.method === 'GET' && !request.headers.Authorization));
  assert.ok(f.requests.every(request => request.headers['X-API-Key'] === 'private-integration-key'));
  assert.equal(f.requests.some(request => request.route === 'me' || request.route.startsWith('me/')), false);
  const requestCount = f.requests.length;
  assert.equal((await f.service.createListing({ rowKey: f.row().key, quantity: 1 })).error, 'SIGN_IN_REQUIRED');
  assert.equal((await f.service.updateListing({ id: 'browse-id', status: 'CLOSED' })).error, 'SIGN_IN_REQUIRED');
  assert.equal(f.requests.length, requestCount, 'Protected actions fail before making a request');
  assert.equal(f.saved, null);
});

test('public browse network failures can be retried without signing in', async () => {
  const f = fixture();
  f.override = request => { if (request.route.startsWith('listings/recent')) throw new Error('Offline'); };
  assert.equal((await f.service.browse()).error, 'NETWORK_ERROR');
  f.override = null;
  assert.equal((await f.service.browse()).ok, true);
  assert.equal(f.service.snapshot().authenticated, false);
  assert.equal(f.requests.some(request => request.headers.Authorization), false);
});

test('expired saved credentials do not prevent public listing reads', async () => {
  const f = fixture(); f.saved = 'expired-token';
  await f.service.initialize();
  assert.equal((await f.service.browse()).ok, true);
  assert.equal(f.requests[0].headers.Authorization, undefined);
  assert.equal(f.requests[0].route.startsWith('listings/recent'), true);
  assert.equal(f.service.snapshot().authenticated, false);
});

test('market feed StoreItems paths match physical resource and rune inventory through service normalization', async () => {
  const f = fixture();
  const resourcePath = '/SF/Types/PickUps/Resources/Inorganics/CorruptOnyxResource';
  const runePath = '/SF/Upgrades/Runes/Weapon/Bow/StarterRune';
  f.catalogue = [
    { ...item, id: 'onyx-id', name: 'Corrupt Onyx', slug: 'corrupt-onyx', unique_name: 'CorruptOnyxResource', path: resourcePath.replace('/SF/', '/SF/StoreItems/') },
    { id: 'starter-rune-id', name: 'Starter rune', slug: 'starter-rune', unique_name: 'StarterRune', category: 'Mote', tradeable: true,
      path: runePath.replace('/SF/', '/SF/StoreItems/') },
  ];
  f.live = { AccountId: accountId, MiscItems: [{ ItemType: resourcePath, ItemCount: 20 }],
    Upgrades: [{ ItemId: { $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, ItemType: runePath, UpgradeFingerprint: '{"lvl":2}' }] };
  f.session.getRawInventory = () => f.live;
  const login = await f.login(); assert.equal(login.ok, true);
  const rows = login.state.inventory.rows;
  assert.equal(rows.length, 2); assert.equal(rows.every(row => row.canList), true);
  const resource = rows.find(row => row.itemId === 'onyx-id'), rune = rows.find(row => row.itemId === 'starter-rune-id');
  assert.equal(resource.availableQuantity, 20); assert.equal(resource.maxQuantity, 999);
  assert.equal(rune.category, 'rune'); assert.deepEqual(rune.attributes, { rune: { upgradeLevel: 2 } });
  assert.equal((await f.service.createListing({ rowKey: rune.key, quantity: 1, acceptedItems: [] })).ok, true);
  assert.equal(f.writes[0].itemId, 'starter-rune-id'); assert.deepEqual(f.writes[0].rune, { upgradeLevel: 2 });
});

test('remember opt-out, stored session restore, and logout revocation', async () => {
  const f = fixture();
  await f.service.login({ email: 'test@example.com', password: 'example-password', remember: false });
  assert.equal(f.saved, null); assert.equal(f.service.snapshot().sessionPersistent, false);
  await f.service.logout(); assert.equal(f.service.snapshot().authenticated, false);
  assert.equal(f.requests.at(-1).headers.Authorization, 'Bearer private-market-token');
  assert.equal(f.service.snapshot().catalogue.length, 1, 'Public catalogue remains usable after sign-out');
  assert.equal((await f.service.browse({ slug: item.slug })).ok, true);
  assert.equal(f.requests.at(-1).headers.Authorization, undefined);
  const restored = fixture(); restored.saved = 'stored-token';
  assert.equal((await restored.service.refresh()).ok, true);
  assert.equal(restored.requests.some(r => r.route === 'auth/sign-in'), false);
  assert.equal(restored.service.snapshot().authenticated, true);
});

test('Settings can change session persistence without signing out or storing a password', async () => {
  const f = fixture(); await f.login();
  const preferences = [];
  f.service.on('remember-changed', value => preferences.push(value));
  assert.equal(f.service.setRememberSession(false), true);
  assert.equal(f.saved, null);
  assert.equal(f.service.snapshot().authenticated, true);
  assert.equal(f.service.snapshot().sessionPersistent, false);
  assert.equal(f.service.setRememberSession(true), true);
  assert.equal(f.saved, 'private-market-token');
  assert.equal(f.service.snapshot().sessionPersistent, true);
  assert.deepEqual(preferences, [false, true]);
  assert.equal(f.requests.filter(request => request.route === 'auth/sign-in').length, 1);
});

test('remember opt-out prevents restoration and wins an in-flight sign-in', async () => {
  const restored = fixture(); restored.saved = 'old-token'; restored.service.rememberSession = false;
  await restored.service.refresh();
  assert.equal(restored.saved, null);
  assert.ok(restored.requests.length > 0, 'Public catalogue still loads when session restoration is disabled');
  assert.equal(restored.requests.some(request => request.headers.Authorization || request.route.startsWith('me')), false);
  assert.equal(restored.service.snapshot().authenticated, false);
  const f = fixture(), wait = deferred();
  f.override = async request => {
    if (request.route === 'auth/sign-in') { await wait.promise; return response({ data: { meta: { sessionToken: 'new-token' } } }); }
  };
  const login = f.login();
  assert.equal(f.service.setRememberSession(false), true);
  wait.resolve();
  assert.equal((await login).ok, true);
  assert.equal(f.saved, null);
  assert.equal(f.service.snapshot().authenticated, true);
  assert.equal(f.service.snapshot().sessionPersistent, false);
});

test('failed protected storage changes are reported and preserve the active session', async () => {
  const f = fixture(); await f.login();
  f.service.tokenStore.clear = () => { throw new Error('Access denied'); };
  assert.equal(f.service.setRememberSession(false), false);
  assert.equal(f.service.snapshot().authenticated, true);
  assert.equal(f.service.rememberSession, true);
  f.service.tokenStore.clear = () => { f.saved = null; };
  assert.equal(f.service.setRememberSession(false), true);
  f.service.tokenStore.save = () => false;
  assert.equal(f.service.setRememberSession(true), false);
  assert.equal(f.service.rememberSession, false);
  assert.equal(f.service.snapshot().sessionPersistent, false);
});

test('replacing a protected session preserves the old file when encryption fails', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-token-replace-'));
  const store = new MarketTokenStore({ directory, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from('protected:' + value),
    decryptString: bytes => bytes.toString().replace(/^protected:/, ''),
  } });
  t.after(() => { store.clear(); fs.rmdirSync(directory); });
  store.save('synthetic-first-session');
  store.safeStorage.encryptString = () => { throw new Error('Temporary encryption failure'); };
  assert.throws(() => store.save('synthetic-second-session'));
  assert.equal(store.load(), 'synthetic-first-session');
  assert.equal(fs.existsSync(store.file + '.tmp'), false);
  store.safeStorage.encryptString = value => Buffer.from('protected:' + value);
  store.save('synthetic-second-session');
  assert.equal(store.load(), 'synthetic-second-session');
});

test('API key rollout error preserves valid login; expired sessions clear protected state', async () => {
  const f = fixture(); f.publicStatus = 401;
  const result = await f.login(); assert.equal(result.ok, false); assert.equal(result.error, 'APP_ACCESS_REQUIRED');
  assert.equal(f.service.snapshot().authenticated, true); assert.equal(f.saved, 'private-market-token');
  f.override = r => r.route === 'me' ? response({ error: { code: 'UNAUTHORIZED', message: 'Expired session.' } }, 401) : null;
  await f.service.refresh(); assert.equal(f.service.snapshot().authenticated, false); assert.equal(f.saved, null);
});

for (const code of ['API_KEY_REQUIRED', 'API_KEY_INVALID']) for (const route of ['catalogue/feed', 'me']) {
  test(`${code} on ${route} preserves the user session and reports integration access failure`, async () => {
    const f = fixture(); await f.login();
    f.override = r => r.route === route
      ? response({ error: { code, message: 'Integration key rejected.' } }, 401) : null;
    f.service.catalogueAt = 0;
    const result = await f.service.refresh();
    assert.equal(result.error, 'APP_ACCESS_REQUIRED');
    assert.equal(f.service.snapshot().authenticated, true);
    assert.equal(f.saved, 'private-market-token');
    assert.equal(JSON.stringify(result).includes('private-integration-key'), false);
  });
}

test('missing integration configuration is explained without signing the user out', async () => {
  const f = fixture(); f.service.apiKey = ''; f.publicStatus = 401;
  const result = await f.login();
  assert.equal(result.error, 'APP_ACCESS_REQUIRED');
  assert.match(result.message, /reconnect your avakot.dev account/);
  assert.ok(f.requests.every(r => !r.headers['X-API-Key']));
  assert.equal(f.service.snapshot().authenticated, true);
});

test('logout wins an in-flight sign-in without restoring an old token', async () => {
  const f = fixture(), wait = deferred();
  f.override = async r => { if (r.route === 'auth/sign-in') { await wait.promise; return response({ data: { meta: { sessionToken: 'old-token' } } }); } };
  const login = f.login(); await f.service.logout(); wait.resolve();
  assert.equal((await login).error, 'SESSION_CHANGED'); assert.equal(f.saved, null); assert.equal(f.service.snapshot().authenticated, false);
});

test('creates open-to-offers from a fresh matching inventory without exposing or sending game credentials', async () => {
  const f = fixture(); await f.login();
  const profiles = [];
  f.session.api.fetchProfile = async (...args) => { profiles.push(args); return profile(f.name); };
  const result = await f.service.createListing({ rowKey: f.row().key, quantity: 2, acceptedItems: [], termsNote: 'Ignored legacy input' });
  assert.equal(result.ok, true); assert.equal(f.fetches, 1); assert.equal(f.writes.length, 1);
  assert.deepEqual(profiles, [[accountId, { force: true }]]);
  assert.deepEqual(f.writes[0], { itemId: 'resource-id', type: 'OFFER', quantity: 2, platform: 'PC', locale: 'en', terms: {} });
  assert.equal(f.row().availableQuantity, 8); assert.equal(f.row().listedQuantity, 2);
  assert.equal(JSON.stringify(f.requests).includes('game-nonce'), false);
});

test('fresh stock, character mismatch, and account switches prevent publishing', async () => {
  for (const condition of ['stock', 'identity', 'session']) {
    const f = fixture(); await f.login(); const key = f.row().key;
    if (condition === 'stock') f.live = inventory(1);
    if (condition === 'identity') f.name = 'OtherEnvoy';
    if (condition === 'session') f.session.api.fetchInventory = async () => { f.session = null; return { data: inventory(10) }; };
    const result = await f.service.createListing({ rowKey: key, quantity: 2 });
    assert.equal(result.ok, false, condition); assert.equal(f.writes.length, 0, condition);
  }
});

test('replacing the game session during the inventory read skips the profile lookup', async t => {
  const f = fixture(); await f.login();
  const lookup = t.mock.method(f.session.api, 'fetchProfile');
  f.inventoryWait = deferred();
  const pending = f.service.createListing({ rowKey: f.row().key, quantity: 1 });
  assert.equal(f.fetches, 1);
  f.session = { ...f.session, accountId: 'b'.repeat(24) };
  f.inventoryWait.resolve();
  assert.equal((await pending).error, 'GAME_SESSION_CHANGED');
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(f.writes.length, 0);
});

test('a mismatched or malformed inventory owner blocks profile lookup and publishing', async t => {
  const f = fixture(); await f.login();
  const lookup = t.mock.method(f.session.api, 'fetchProfile');
  for (const owner of ['b'.repeat(24), { $oid: 'b'.repeat(24) }, null, {}]) {
    f.live.AccountId = owner;
    const result = await f.service.createListing({ rowKey: f.row().key, quantity: 1 });
    assert.equal(result.error, 'GAME_SESSION_CHANGED');
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(f.writes.length, 0);
  f.live.AccountId = { $oid: accountId.toUpperCase() };
  assert.equal((await f.service.createListing({ rowKey: f.row().key, quantity: 1 })).ok, true);
  assert.equal(lookup.mock.callCount(), 1);
});

test('a game session replaced during the profile lookup cannot publish a listing', async () => {
  const f = fixture(); await f.login();
  f.session.api.fetchProfile = async () => {
    f.session = { ...f.session, accountId: 'b'.repeat(24) };
    return profile(f.name);
  };
  const result = await f.service.createListing({ rowKey: f.row().key, quantity: 1 });
  assert.equal(result.error, 'GAME_SESSION_CHANGED');
  assert.equal(f.writes.length, 0);
});

test('cached inventory cannot be offered by the UI; missing live inventory blocks create', async () => {
  const f = fixture(); f.cached = true; await f.login();
  assert.equal(f.service.snapshot().inventory.available, false); assert.equal(f.service.snapshot().inventory.rows.length, 0);
  f.session = null;
  assert.equal((await f.service.createListing({ rowKey: 'anything', quantity: 1 })).error, 'GAME_REQUIRED');
});

test('parallel listing clicks cause one market write and pending reservations are honored', async () => {
  const f = fixture(); await f.login(); f.inventoryWait = deferred();
  const draft = { rowKey: f.row().key, quantity: 8, priceAmount: 12 };
  const first = f.service.createListing(draft);
  assert.equal((await f.service.createListing(draft)).error, 'BUSY');
  f.inventoryWait.resolve(); assert.equal((await first).ok, true);
  assert.equal((await f.service.createListing(draft)).error, 'QUANTITY_UNAVAILABLE');
  assert.equal(f.writes.length, 1);
});

test('browse pagination encodes queries and selected-item responses keep catalogue identity', async () => {
  const f = fixture(); await f.login();
  const recent = await f.service.browse({ view: 'requests', availability: 'available', cursor: 'next&evil=1', category: 'resource' });
  assert.equal(recent.ok, true); assert.match(f.requests.at(-1).route, /availability=online/);
  assert.match(f.requests.at(-1).route, /cursor=next%26evil%3D1/);
  const selected = await f.service.browse({ slug: 'test-resource', page: 2, sort: 'lowest' });
  assert.equal(selected.listings[0].itemId, item.id); assert.equal(selected.listings[0].item.name, item.name);
  assert.equal((await f.service.copyContact('browse-id')).ok, true);
  assert.match(f.copies[0], /^\/w TraderName /); assert.match(f.copies[0], /Test resource/);
  f.override = r => r.route.startsWith('listings/recent') ? response({ data: [{ id: 'second-page', attributes: {
    type: 'OFFER', item, quantity: 1, seller: { handle: 'NextTrader' },
  } }] }) : null;
  await f.service.browse({ cursor: 'next' });
  assert.equal((await f.service.copyContact('browse-id')).ok, true, 'Earlier appended cards keep their contact action');
  assert.equal(f.writes.length, 0);
  assert.equal((await f.service.browse({ slug: '../../auth' })).error, 'UNKNOWN_ITEM');
});

test('advanced public browsing sends supported weapon and temper filters with recent ordering by default', async () => {
  const f = fixture();
  assert.equal((await f.service.browse()).ok, true);
  assert.match(f.requests.at(-1).route, /^listings\/recent\?/);
  const result = await f.service.browse({ view: 'requests', availability: 'available', advanced: {
    q: 'Windfall & Moonsteel', qualityMin: 'MILITARY', qualityMax: 'LEGENDARY', moonsteel: 'true',
    weaponGripType: 'SwordSkill', tempers: ['AspectAttackSpeed', 'AspectHeavyAttack'], temperMatch: 'all',
  } });
  assert.equal(result.ok, true);
  const request = f.requests.at(-1);
  const params = new URL('https://fixture.invalid/' + request.route).searchParams;
  assert.match(request.route, /^listings\/search\?/);
  assert.equal(request.headers.Authorization, undefined);
  assert.deepEqual(Object.fromEntries(params), { itemKind: 'weapon', side: 'give', availability: 'online', sort: 'recent', limit: '50',
    q: 'Windfall & Moonsteel', qualityMin: 'MILITARY', qualityMax: 'LEGENDARY', moonsteel: 'true',
    weaponGripType: 'SwordSkill', temperMatch: 'all', tempers: 'AspectAttackSpeed,AspectHeavyAttack' });
  await f.service.browse({ sort: 'highest', advanced: { tempers: ['AspectAttackSpeed'], temperMatch: 'any' } });
  assert.match(f.requests.at(-1).route, /sort=highest/);
  await f.service.browse({ sort: 'trusted', advanced: {} });
  assert.match(f.requests.at(-1).route, /sort=recent/);
});

test('signed-in listing reads retain optional authentication for market block filtering', async () => {
  const f = fixture(); await f.login();
  for (const query of [{}, { slug: item.slug }, { advanced: { moonsteel: 'true' } }]) {
    assert.equal((await f.service.browse(query)).ok, true);
    assert.equal(f.requests.at(-1).headers.Authorization, 'Bearer private-market-token');
  }
  await f.service.logout();
  assert.equal((await f.service.browse()).ok, true);
  assert.equal(f.requests.at(-1).headers.Authorization, undefined);
});

test('invalid advanced filters fail before issuing public requests', async () => {
  const f = fixture();
  for (const advanced of [false, [], { q: 'x'.repeat(257) }, { moonsteel: 'sometimes' }, { qualityMin: 'invalid' },
    { qualityMin: 'LEGENDARY', qualityMax: 'MILITARY' }, { weaponGripType: 'invalid' }, { temperMatch: 'none' },
    { tempers: 'AspectAttackSpeed' }, { tempers: ['AspectAttackSpeed&moonsteel=true'] }, { tempers: Array(9).fill('AspectAttackSpeed') }]) {
    assert.equal((await f.service.browse({ advanced })).error, 'VALIDATION_FAILED', JSON.stringify(advanced));
  }
  assert.equal(f.requests.length, 0);
});

test('edits preserve barter terms; close releases reservations and resume rechecks stock', async () => {
  const f = fixture(); await f.login(); await f.service.createListing({ rowKey: f.row().key, quantity: 3 });
  f.own[0].attributes.terms = { acceptedItems: [{ type: 'ITEM', itemId: 'rune', quantity: 1, runeUpgradeLevel: 3 }], termsNote: 'original' };
  const edited = await f.service.updateListing({ id: 'created-1', priceAmount: null, termsNote: 'Ignored legacy input' }); assert.equal(edited.ok, true);
  assert.deepEqual(f.writes.at(-1).terms.acceptedItems, [{ type: 'ITEM', itemId: 'rune', quantity: 1, rune: { upgradeLevel: 3 } }]);
  assert.equal(f.writes.at(-1).terms.termsNote, 'original');
  assert.equal((await f.service.updateListing({ id: 'created-1', status: 'PAUSED' })).ok, true);
  assert.equal(f.row().availableQuantity, 7);
  f.live = inventory(1); assert.equal((await f.service.updateListing({ id: 'created-1', status: 'ACTIVE' })).error, 'QUANTITY_UNAVAILABLE');
  assert.equal((await f.service.updateListing({ id: 'created-1', status: 'CLOSED' })).ok, true);
  assert.equal(f.row().availableQuantity, 10);
});

test('Market recovers legacy artwork and follows the same current icon as the tracker', async () => {
  const f = fixture();
  const id = 'AspectAttackSpeed';
  const newKey = 'temper-icons/' + '9'.repeat(64) + '.png';
  f.catalogue.push({ id: 'weapon', slug: 'blade', name: 'Blade', category: 'Weapon', possible_tempers: [
    { unique_name: id, name: 'Legacy', icon: '../../assets/tempers/Balanced.webp' },
    { unique_name: 'NewTemper', name: 'New', icon: newKey },
    { unique_name: 'UnknownTemper', name: 'Unknown', icon: 'Unknown.webp' },
  ] });
  await f.login();
  const rows = f.service.snapshot().catalogue.find(item => item.id === 'weapon').possibleTempers;
  const canonical = require('../src/data/tempers.json').tempers.find(row => row.id.endsWith('/' + id + 'Name')).icon;
  assert.deepEqual(rows.map(row => row.icon), [canonical, newKey, '']);
  const current = structuredClone(require('../src/data/tempers.json'));
  const active = current.tempers.find(row => row.id.endsWith('/' + id + 'Name'));
  active.icon = 'temper-icons/' + '7'.repeat(64) + '.png';
  const path = '/sf/types/items/aspects/current-test#current';
  current.aliases[path] = active.id;
  current.aliases.currentbuffmod = active.id;
  f.service.getTemperCatalog = () => current;
  f.service.catalogue.find(item => item.id === 'weapon').possible_tempers = [
    { unique_name: id, icon: '/SF/Interface/Graphics/Aspects/Old.png' },
    { unique_name: 'RenamedAspect', path: path.toUpperCase(), icon: canonical },
    { unique_name: 'TagOnly', tag: 'CurrentBuffMod', icon: '' },
  ];
  const market = f.service.snapshot().catalogue.find(item => item.id === 'weapon').possibleTempers;
  const tracker = require('../src/modules/temperTracker').inventoryTempers({}, current).rows.find(row => row.id === active.id);
  assert.equal(tracker.icon, active.icon);
  assert.deepEqual(market.map(row => row.icon), [tracker.icon, tracker.icon, tracker.icon]);
});

function addAcceptedCatalogue(f) {
  f.catalogue.push(
    { id: 'weapon-id', slug: 'test-weapon', name: 'Test weapon', category: 'Weapon', tradeable: true,
      possible_tempers: [{ unique_name: 'AspectA', name: 'First temper', icon: '/SF/Interface/Graphics/Aspects/Test.png' },
        { unique_name: 'AspectStaggerCrit', tag: 'OdeReduceDefenseMod', icon: '/SF/Interface/Graphics/Aspects/Ode/Crush.png' }] },
    { id: 'mote-id', slug: 'test-mote', name: 'Test mote', category: 'Mote', tradeable: true },
    { id: 'rune-id', slug: 'test-rune', name: 'Test rune', category: 'Mote', path: '/SF/Types/Upgrades/Runes/TestRune', tradeable: true },
    { id: 'thread-id', slug: 'moonsteel-thread', name: 'Moonsteel Thread', category: 'Upgrade', tradeable: true },
    { id: 'untradable-id', slug: 'untradable', name: 'Untradable', category: 'Resource', tradeable: false });
}

test('market language projection resolves catalogue, inventory, listing and temper labels across locale changes', async () => {
  const f = fixture(); addAcceptedCatalogue(f);
  f.catalogue[0] = { ...item, lang_name_key: '/SF/Language/Materials/TestResource' };
  const weapon = f.catalogue.find(item => item.id === 'weapon-id');
  weapon.possible_tempers = [{ unique_name: 'AspectAttackSpeed', name: 'AspectAttackSpeed',
    lang_key: '/SF/Language/Upgrades/AspectAttackSpeedName', icon: '/SF/Interface/Graphics/Aspects/Speed.png' }];
  f.languagePack = { '/SF/Language/Materials/TestResource': 'Resolved resource',
    '/SF/Language/Upgrades/AspectAttackSpeedName': 'Swift', '/SF/Language/Codex/Resource': 'Resources' };
  f.own = [{ id: 'existing', attributes: { itemId: item.id, item: { ...item, displayName: 'Test resource' },
    type: 'OFFER', status: 'ACTIVE', quantity: 1 } }];
  const login = await f.login(); assert.equal(login.ok, true);
  assert.equal(login.state.catalogue[0].name, 'Resolved resource');
  assert.equal(login.state.inventory.rows[0].name, 'Resolved resource');
  assert.equal(login.state.inventory.rows[0].category, 'resource');
  assert.equal(login.state.inventory.rows[0].categoryLabel, 'Resources');
  assert.equal(login.state.listings[0].item.name, 'Resolved resource');
  assert.equal(login.state.listings[0].item.categoryLabel, 'Resources');
  const temper = login.state.catalogue.find(item => item.id === 'weapon-id').possibleTempers[0];
  assert.equal(temper.displayName, 'Swift');
  assert.equal(temper.unique_name, 'AspectAttackSpeed');
  assert.equal(temper.icon, require('../src/data/tempers.json').tempers.find(row => row.id === '/SF/Language/Upgrades/AspectAttackSpeedName').icon);
  assert.equal(login.state.catalogue.find(item => item.id === 'mote-id').categoryLabel, 'Totems');
  assert.equal(login.state.catalogue.find(item => item.id === 'rune-id').categoryLabel, 'Runes');
  assert.equal((await f.service.browse()).listings[0].item.name, 'Resolved resource');
  f.locale = 'fr';
  f.languagePack = { '/SF/Language/Materials/TestResource': 'Ressource test',
    '/SF/Language/Upgrades/AspectAttackSpeedName': 'Vif', '/SF/Language/Codex/Resource': 'Ressources' };
  const refreshed = await f.service.refresh();
  assert.equal(refreshed.state.inventory.rows[0].name, 'Ressource test');
  assert.equal(refreshed.state.inventory.rows[0].categoryLabel, 'Ressources');
  assert.equal(refreshed.state.catalogue.find(item => item.id === 'weapon-id').possibleTempers[0].name, 'Vif');
  assert.equal(weapon.possible_tempers[0].name, 'AspectAttackSpeed', 'The cached source keeps its original identity and labels');
  assert.ok(f.requests.some(request => request.route === 'catalogue/languages/fr?projection=1'));
  assert.equal(f.requests.filter(request => request.route === 'catalogue/feed').length, 1, 'Locale changes resolve the cached catalogue again');
});

test('public translation failures retain readable fallbacks without invalidating the account session', async () => {
  const f = fixture(); addAcceptedCatalogue(f); f.locale = '../../auth/sign-out';
  f.catalogue.find(item => item.id === 'weapon-id').possible_tempers = [{ unique_name: 'AspectAttackSpeed' }];
  f.override = request => request.route.startsWith('catalogue/languages/')
    ? response({ error: { code: 'UNAVAILABLE' } }, 503) : null;
  const login = await f.login();
  assert.equal(login.ok, true);
  assert.equal(login.state.catalogue[0].categoryLabel, 'Resources');
  assert.equal(login.state.catalogue.find(item => item.id === 'weapon-id').possibleTempers[0].name, 'Attack Speed');
  assert.ok(f.requests.some(request => request.route === 'catalogue/languages/en?projection=1'));
  f.override = request => request.route.startsWith('catalogue/languages/')
    ? response({ error: { code: 'UNAUTHORIZED' } }, 401) : null;
  const unavailable = await f.service.refresh();
  assert.equal(unavailable.ok, true);
  assert.equal(f.service.snapshot().authenticated, true);
  assert.equal(f.saved, 'private-market-token');
});

test('six accepted trade slots match the market payload and expose picker attributes', async () => {
  const f = fixture(); addAcceptedCatalogue(f); await f.login();
  const acceptedItems = [
    { type: 'ARCS', amount: 100000 },
    { type: 'ITEM', itemId: item.id, quantity: 999 },
    { type: 'ITEM', itemId: 'weapon-id', quantity: 1, weapon: { quality: 'MILITARY', moonsteel: true, tempers: ['AspectA', 'AspectReduceArmour'] } },
    { type: 'ITEM', itemId: 'mote-id', mote: { virtue: 'SPIRIT', upgradeLevel: 3, gripType: 'PolearmSkill' } },
    { type: 'ITEM', itemId: 'rune-id', rune: { upgradeLevel: 2 } },
    { type: 'ITEM', itemId: 'thread-id', quantity: 999 },
  ];
  const result = await f.service.createListing({ rowKey: f.row().key, quantity: 1, acceptedItems });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(f.writes[0].terms, { acceptedItems: [
    acceptedItems[0], acceptedItems[1],
    { type: 'ITEM', itemId: 'weapon-id', weapon: { quality: 'MILITARY', moonsteel: true, tempers: ['AspectA', 'AspectReduceArmour'], tempersAny: null } },
    acceptedItems[3], acceptedItems[4], acceptedItems[5],
  ] });
  assert.equal(acceptedItems[2].quantity, 1, 'Draft objects are not modified');
  const catalogue = result.state.catalogue;
  const weapon = catalogue.find(row => row.id === 'weapon-id');
  assert.equal(weapon.attributeType, 'weapon'); assert.equal(weapon.acceptedQuantityMax, 1);
  assert.equal(weapon.canBeShiny, true); assert.equal(weapon.tradeable, true);
  assert.equal(weapon.possibleTempers[1].unique_name, 'AspectReduceArmour');
  assert.match(weapon.possibleTempers[0].icon, /^overkot-game-data:\/\/images\//);
  assert.equal(catalogue.find(row => row.id === 'rune-id').attributeType, 'rune');
  assert.equal(catalogue.find(row => row.id === 'thread-id').acceptedQuantityMax, 999);
  assert.equal(catalogue.find(row => row.id === 'untradable-id').tradeable, false);
});

test('accepted slot edits replace prices, preserve website notes, and can return to open offers', async () => {
  const f = fixture(); addAcceptedCatalogue(f); await f.login();
  await f.service.createListing({ rowKey: f.row().key, quantity: 1, priceAmount: 12 });
  f.own[0].attributes.terms.termsNote = 'Website note';
  const runeSlot = { type: 'ITEM', itemId: 'rune-id', rune: { upgradeLevel: 3 } };
  assert.equal((await f.service.updateListing({ id: 'created-1', acceptedItems: [runeSlot] })).ok, true);
  assert.deepEqual(f.writes.at(-1).terms, { priceAmount: null, priceUnit: null, termsNote: 'Website note', acceptedItems: [runeSlot] });
  assert.equal((await f.service.updateListing({ id: 'created-1', acceptedItems: [{ type: 'ARCS', amount: 25 }] })).ok, true);
  assert.equal(f.writes.at(-1).terms.priceAmount, 25); assert.equal(f.writes.at(-1).terms.priceUnit, 'arcs');
  assert.equal((await f.service.updateListing({ id: 'created-1', acceptedItems: [] })).ok, true);
  assert.deepEqual(f.writes.at(-1).terms, { priceAmount: null, priceUnit: null, termsNote: 'Website note', acceptedItems: null });
  assert.equal((await f.service.updateListing({ id: 'created-1', quantity: 1 })).ok, true);
  assert.deepEqual(f.writes.at(-1), { quantity: 1 }, 'Quantity edits do not rewrite unrelated terms');
  f.own[0].attributes.type = 'REQUEST';
  const writes = f.writes.length;
  assert.equal((await f.service.updateListing({ id: 'created-1', acceptedItems: [] })).error, 'VALIDATION_FAILED');
  assert.equal(f.writes.length, writes);
});

test('accepted weapons support any tempers and preserve flattened variant snapshots during price edits', async () => {
  const f = fixture(); addAcceptedCatalogue(f); await f.login();
  assert.equal((await f.service.createListing({ rowKey: f.row().key, quantity: 1, acceptedItems: [
    { type: 'ITEM', itemId: 'weapon-id', weapon: { quality: 'LEGENDARY', moonsteel: false, tempersAny: true } },
  ] })).ok, true);
  assert.deepEqual(f.writes[0].terms.acceptedItems[0].weapon, { quality: 'LEGENDARY', moonsteel: false, tempers: null, tempersAny: true });
  f.own[0].attributes.terms = { acceptedItems: [
    { type: 'ITEM', itemId: 'weapon-id', quality: 'LEGENDARY', moonsteel: true, tempers: null, tempersAny: true },
    { type: 'ITEM', itemId: 'mote-id', moteVirtue: 'GRACE', moteUpgradeLevel: 2, moteGripType: 'SwordSkill' },
    { type: 'ITEM', itemId: 'rune-id', runeUpgradeLevel: 0 },
  ], termsNote: 'Existing terms' };
  assert.equal((await f.service.updateListing({ id: 'created-1', priceAmount: 45 })).ok, true);
  assert.deepEqual(f.writes.at(-1).terms, { termsNote: 'Existing terms', priceAmount: null, priceUnit: null, acceptedItems: [
    { type: 'ITEM', itemId: 'weapon-id', weapon: { quality: 'LEGENDARY', moonsteel: true, tempers: null, tempersAny: true } },
    { type: 'ITEM', itemId: 'mote-id', mote: { virtue: 'GRACE', upgradeLevel: 2, gripType: 'SwordSkill' } },
    { type: 'ITEM', itemId: 'rune-id', rune: { upgradeLevel: 0 } },
    { type: 'ARCS', amount: 45 },
  ] });
});

test('invalid accepted slots never reach a listing write', async () => {
  const f = fixture(); addAcceptedCatalogue(f); await f.login();
  const invalid = [null, {}, [null], [{ type: 'OTHER' }], Array(7).fill({ type: 'ITEM', itemId: item.id }),
    [{ type: 'ITEM', itemId: 'unknown' }], [{ type: 'ITEM', itemId: 'untradable-id' }],
    ...[0, -1, 1000, 1.5, '2', null].map(quantity => [{ type: 'ITEM', itemId: item.id, quantity }]),
    [{ type: 'ITEM', itemId: 'weapon-id', quantity: 2, weapon: { quality: 'NONE' } }],
    ...[0, -1, 100001, 1.5, '2'].map(amount => [{ type: 'ARCS', amount }]),
    [{ type: 'ARCS', amount: 1 }, { type: 'ARCS', amount: 2 }],
    [{ type: 'ITEM', itemId: 'weapon-id' }],
    ...[{ quality: 'INVALID' }, { quality: 'NONE', moonsteel: 'false' }, { quality: 'LEGENDARY', tempers: [] },
      { quality: 'NONE', tempers: ['UnknownTemper'] }, { quality: 'MILITARY', tempers: ['AspectA', 'AspectA', 'AspectA'] },
      { quality: 'NONE', tempersAny: 'yes' }].map(weapon => [{ type: 'ITEM', itemId: 'weapon-id', weapon }]),
    [{ type: 'ITEM', itemId: 'mote-id', mote: { upgradeLevel: 4 } }],
    [{ type: 'ITEM', itemId: 'mote-id', mote: { virtue: 'INVALID' } }],
    [{ type: 'ITEM', itemId: 'rune-id', rune: { upgradeLevel: -1 } }],
    [{ type: 'ITEM', itemId: item.id, weapon: { quality: 'NONE' } }],
  ];
  for (const acceptedItems of invalid) {
    const result = await f.service.createListing({ rowKey: f.row().key, quantity: 1, acceptedItems });
    assert.equal(result.ok, false, JSON.stringify(acceptedItems));
  }
  f.service.trading.arcsTradeDisabled = true;
  assert.equal((await f.service.createListing({ rowKey: f.row().key, quantity: 1, acceptedItems: [{ type: 'ARCS', amount: 1 }] })).error, 'ARCS_DISABLED');
  assert.equal(f.writes.length, 0);
});

test('mutation timeout is not retried and tells the user to check listings', async () => {
  const f = fixture(); await f.login();
  let attempts = 0; f.override = r => { if (r.route === 'me/listings') { attempts++; throw new Error('timeout'); } };
  const result = await f.service.createListing({ rowKey: f.row().key, quantity: 1 });
  assert.equal(result.ok, false); assert.equal(attempts, 1); assert.match(result.message, /Refresh My listings/);
});

test('maintenance and malformed terms block create; registration opens only fixed routes', async () => {
  const f = fixture(); f.marketConfig = { arcsTradeDisabled: true }; await f.login();
  for (const priceAmount of [1.5, -1, 100001, '10']) assert.equal((await f.service.createListing({ rowKey: f.row().key, quantity: 1, priceAmount })).error, 'VALIDATION_FAILED');
  assert.equal((await f.service.createListing({ rowKey: f.row().key, quantity: 1, priceAmount: 10 })).error, 'ARCS_DISABLED');
  assert.equal(f.writes.length, 0);
  await f.service.openWebsite('register'); await f.service.openWebsite('https://evil.test');
  assert.deepEqual(f.opened, ['https://avakot.market/signup', 'https://avakot.market/']);
  assert.throws(() => new MarketService({ apiBase: 'https://evil.test', getSession: () => null }), /production origin/);
});

test('session persistence fails closed when protected storage is unavailable', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-market-token-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => false };
  const store = new MarketTokenStore({ directory, safeStorage });
  assert.equal(store.save('never-plaintext'), false); assert.equal(fs.existsSync(store.file), false); assert.equal(store.load(), null);
  safeStorage.isEncryptionAvailable = () => true;
  safeStorage.encryptString = value => Buffer.from(value).reverse(); safeStorage.decryptString = value => Buffer.from(value).reverse().toString();
  assert.equal(store.save('protected-token'), true); assert.equal(store.load(), 'protected-token');
  assert.equal(fs.readFileSync(store.file).includes('protected-token'), false); store.clear(); assert.equal(store.load(), null);
});
