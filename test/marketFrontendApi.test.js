process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestMarketFrontend, sanitizeMarketResponse } = require('../src/modules/marketFrontendApi');
const { MarketService } = require('../src/modules/marketService');

test('stored Market game artwork is rebased without proxying unrelated external images', () => {
  const path = '/SF/Interface/Graphics/StoreItems/Art.png';
  const result = sanitizeMarketResponse({ history: [
    { imageUrl: '/api/v1/data-assets' + path },
    { imageUrl: 'https://dap1x6lmnonv6.cloudfront.net' + path },
    { avatarUrl: 'https://avatars.example/profile.png' },
  ] });
  assert.deepEqual(result.history.map(row => row.imageUrl || row.avatarUrl), [
    'overkot-game-data://images' + path, 'overkot-game-data://images' + path, 'https://avatars.example/profile.png',
  ]);
});

function fixture() {
  const calls = [];
  const market = {
    generation: 0, enabled: false, token: 'private-session', mutating: false,
    initialize: async () => { calls.push('initialize'); },
    request: async (route, options) => { calls.push({ route, options }); return { data: { id: 'listing-id' } }; },
    login: async credentials => { calls.push({ login: credentials }); market.generation++; return { ok: true }; },
    logout: async () => { calls.push('logout'); market.generation++; market.token = null; },
    refresh: async () => { calls.push('refresh'); return { ok: true }; },
    acceptAccountResponse: () => {},
    update: () => calls.push('update'),
  };
  return { market, calls, run: input => requestMarketFrontend(market, input) };
}

test('frontend bridge forwards known API paths and JSON without exposing credentials', async () => {
  const f = fixture();
  assert.deepEqual(await f.run({ path: '/v1/listings/search?q=Moonsteel%20Sword&limit=50' }), {
    status: 200, body: { data: { id: 'listing-id' } },
  });
  assert.deepEqual(f.calls, ['initialize', { route: 'listings/search?q=Moonsteel%20Sword&limit=50', options: { method: 'GET' } }]);
  assert.equal((await f.run({ path: '/v1/me/settings', method: 'patch', body: '{"sidebarSide":"right"}' })).status, 200);
  assert.deepEqual(f.calls.find(call => call.route === 'me/settings').options, { method: 'PATCH', body: { sidebarSide: 'right' } });
  assert.equal(f.calls.at(-1), 'refresh');
});

test('the upstream marketplace catalogue, search, counters, details and ordinary account route families remain available', async () => {
  const requests = [
    ['GET', '/v1/public/config'], ['GET', '/v1/catalogue/feed'], ['GET', '/v1/catalogue/languages/zh?projection=2'],
    ['GET', '/v1/arc-values/overview?period=day'], ['GET', '/v1/items/slug/moonsteel-sword'],
    ['GET', '/v1/items/moonsteel-sword/listings?view=offers&availability=in-game'],
    ['GET', '/v1/items/moonsteel-sword/arc-values?period=day&includeHistory=false'],
    ['GET', '/v1/listings/search?itemKind=weapon&side=get'], ['GET', '/v1/listings/recent?limit=50'],
    ['GET', '/v1/listing/listing-id'], ['GET', '/v1/offer/offer-id'], ['GET', '/v1/envoys?q=Envoy'],
    ['GET', '/v1/envoys/hero.name?include=activeListings'], ['GET', '/v1/envoys/hero.name/listings?status=active&limit=500'],
    ['GET', '/v1/envoys/hero.name/history'], ['GET', '/v1/me'], ['GET', '/v1/me/settings'], ['PATCH', '/v1/me/settings'],
    ['GET', '/v1/me/reports'], ['GET', '/v1/me/customization'], ['GET', '/v1/me/trade-modal-prefs'],
    ['PATCH', '/v1/me/trade-modal-prefs'], ['PATCH', '/v1/me/password'], ['PATCH', '/v1/me/email'],
    ['PATCH', '/v1/me/avatar'], ['PATCH', '/v1/me/name-color'], ['GET', '/v1/me/availability'],
    ['PATCH', '/v1/me/availability'], ['POST', '/v1/me/activity'], ['POST', '/v1/me/presence'],
    ['GET', '/v1/me/verification/status'], ['POST', '/v1/me/verification/request'], ['DELETE', '/v1/me/verification'],
    ['GET', '/v1/me/blocks'], ['POST', '/v1/me/blocks'], ['DELETE', '/v1/me/blocks/blocked-user'],
    ['GET', '/v1/me/listings?state=active'], ['GET', '/v1/me/listings/history'], ['POST', '/v1/me/listings'],
    ['PATCH', '/v1/me/listings/listing-id'], ['POST', '/v1/me/listings/bulk'],
    ['POST', '/v1/me/listings/listing-id/refresh'], ['DELETE', '/v1/me/listings/listing-id/history'],
    ['GET', '/v1/me/offers?handleSlug=hero.name'], ['GET', '/v1/me/offers/summary'], ['POST', '/v1/me/offers'],
    ['PATCH', '/v1/me/offers/offer-id'], ['POST', '/v1/upvotes'], ['POST', '/v1/reports'],
    ['GET', '/v1/store/packs'], ['GET', '/v1/store/my-purchases'], ['POST', '/v1/store/checkout'],
    ['POST', '/v1/auth/resend-verification'], ['POST', '/v1/auth/forgot-password'],
    ['GET', '/v1/auth/discord/status'], ['DELETE', '/v1/auth/discord/unlink'], ['PATCH', '/v1/auth/discord/privacy'],
    ['POST', '/v1/auth/discord/sync-roles'], ['GET', '/v1/auth/patreon/status'], ['GET', '/v1/fundraiser/pride'],
  ];
  for (const [method, path] of requests) {
    const f = fixture();
    const result = await f.run({ method, path, ...(method !== 'GET' ? { body: {} } : {}) });
    assert.equal(result.status, 200, `${method} ${path}`);
    assert.ok(f.calls.some(call => call.route === path.slice(4)), `${method} ${path} reached the transport`);
  }
});

test('path validation blocks traversal, credential routes and administrative access before network or initialization', async () => {
  const f = fixture();
  const paths = [
    'https://api.avakot.market/v1/me', '//api.avakot.market/v1/me', '/api/v1/me', '/v1/../me',
    '/v1/me/../../admin/api-keys', '/v1/me/%2e%2e/settings', '/v1/%61dmin/api-keys',
    '/v1/me%2fsettings', '/v1/me%5csettings', '/v1/me/%252e%252e/settings', '/v1/me/settings%3fadmin=1',
    '/v1/me/settings#fragment', '/v1//me', '/v1/me\u0000', '/v1/me%00', '/v1/me?bad=%ZZ',
    '/v1/admin/users', '/v1/internal/verification/confirm', '/v1/webhooks/stripe',
    '/v1/auth/desktop/token', '/v1/auth/desktop/authorizations', '/v1/auth/discord/login',
    '/v1/auth/avakot/login', '/v1/account-link/approve', '/v1/auth/register', '/v1/auth/reset-password',
  ];
  for (const path of paths) {
    const result = await f.run({ path });
    assert.ok(result.status >= 400, path);
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.run({ path: '/v1/me/settings', method: 'POST', body: {} })).status, 403);
  assert.deepEqual(f.calls, []);
});

test('bridge rejects malformed or excessive bodies and never accepts renderer headers', async () => {
  const f = fixture();
  for (const body of ['{', '[]', 'null', '"text"', { notes: 'x'.repeat(256 * 1024) }]) {
    assert.equal((await f.run({ path: '/v1/reports', method: 'POST', body })).status, 400);
  }
  assert.equal((await f.run({ path: '/v1/me', body: '{}' })).status, 400);
  assert.deepEqual(f.calls, []);
  await f.run({ path: '/v1/me', headers: { Authorization: 'renderer-token', 'X-API-Key': 'renderer-key' } });
  assert.deepEqual(f.calls[1], { route: 'me', options: { method: 'GET' } });
});

test('email sign-in uses the existing main-process session and returns the full safe account', async () => {
  const f = fixture();
  f.market.request = async route => {
    f.calls.push(route);
    return { data: { id: 'user', attributes: { displayHandle: 'Envoy', handleSlug: 'envoy', roles: ['USER'],
      avatar: 'acorn', sidebarSide: 'right' }, meta: { sessionToken: 'private-token' } } };
  };
  const result = await f.run({ path: '/v1/auth/sign-in', method: 'POST', body: { email: 'user@example.com', password: 'private-password' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.attributes.sidebarSide, 'right');
  assert.deepEqual(f.calls, ['initialize', { login: { email: 'user@example.com', password: 'private-password' } }, 'me']);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.deepEqual(await f.run({ path: '/v1/auth/sign-out', method: 'POST' }), { status: 200, body: { data: { status: 'signed_out' } } });
  assert.equal(f.market.token, null);
});

test('credential keys are removed recursively while real user preferences survive', () => {
  const raw = { data: [{ meta: { sessionToken: 'secret-a', access_token: 'secret-b', keep: true },
    child: { 'X-API-Key': 'integration', API_KEY: 'integration-2', authorization: 'bearer', password: 'password',
      session_token: 'secret-c', clientSecret: 'secret-d', deviceCode: 'secret-e', nonce: 'game-nonce',
      displayHandle: 'Envoy', tradeModalPacks: ['pack'] } }], meta: { refreshToken: 'secret-f' } };
  const safe = sanitizeMarketResponse(raw);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  for (const hidden of ['integration', 'bearer', 'password', 'game-nonce']) assert.equal(JSON.stringify(safe).includes(hidden), false);
  assert.equal(safe.data[0].child.displayHandle, 'Envoy');
  assert.deepEqual(safe.data[0].child.tradeModalPacks, ['pack']);
  assert.equal(raw.data[0].meta.sessionToken, 'secret-a', 'Sanitizing must not mutate service-owned responses');
});

test('HTTP error statuses are preserved without exposing unexpected exception details', async () => {
  const f = fixture();
  f.market.request = async () => { throw Object.assign(new Error('Choose a valid quantity.'), { code: 'VALIDATION_FAILED', status: 422 }); };
  assert.deepEqual(await f.run({ path: '/v1/me/listings', method: 'POST', body: {} }), {
    status: 422, body: { error: { code: 'VALIDATION_FAILED', message: 'Choose a valid quantity.' } },
  });
  assert.equal(f.market.mutating, false);
  f.market.login = async () => ({ ok: false, error: 'RATE_LIMITED', message: 'Try later.', status: 429 });
  assert.equal((await f.run({ path: '/v1/auth/sign-in', method: 'POST', body: {} })).status, 429);
  f.market.request = async () => { throw new Error('private-internal-secret'); };
  assert.equal(JSON.stringify(await f.run({ path: '/v1/me' })).includes('private-internal-secret'), false);
  f.market.request = async () => { throw Object.assign(new Error('Market integration is unavailable.'), { code: 'APP_ACCESS_REQUIRED', status: 401 }); };
  assert.deepEqual(await f.run({ path: '/v1/catalogue/feed' }), {
    status: 401, body: { error: { code: 'APP_ACCESS_REQUIRED', message: 'Market integration is unavailable.' } },
  });
});

test('listing and offer mutations share the inventory mutation lock and refresh reservations exactly once', async () => {
  const f = fixture();
  f.market.mutating = true;
  assert.equal((await f.run({ path: '/v1/me/listings', method: 'POST', body: {} })).status, 409);
  assert.equal(f.market.mutating, true, 'A rejected call must not release another mutation lock');
  f.market.mutating = false;
  let unlock;
  const requestDone = new Promise(resolve => { unlock = resolve; });
  f.market.request = async () => { assert.equal(f.market.mutating, true); await requestDone; return { data: { id: 'saved' } }; };
  const pending = f.run({ path: '/v1/me/listings', method: 'POST', body: { itemId: 'item', type: 'OFFER' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.run({ path: '/v1/me/offers/id', method: 'PATCH', body: { status: 'COMPLETED' } })).status, 409);
  unlock();
  assert.equal((await pending).status, 200);
  assert.equal(f.calls.filter(call => call === 'refresh').length, 1);
  assert.equal(f.market.mutating, false);
  assert.equal(f.calls.at(-1), 'update');
});

test('confirmed writes stay successful when the reservation refresh fails and are never replayed', async () => {
  const f = fixture();
  f.market.refresh = async () => { throw new Error('Offline after save'); };
  assert.equal((await f.run({ path: '/v1/me/listings/id', method: 'PATCH', body: { status: 'CLOSED' } })).status, 200);
  assert.equal(f.calls.filter(call => call.route === 'me/listings/id').length, 1);
  assert.equal(f.market.mutating, false);
});

test('a response from an account that changed in flight is discarded', async () => {
  const f = fixture();
  f.market.request = async () => { f.market.generation++; return { data: { privateAccountData: 'previous-user' } }; };
  const result = await f.run({ path: '/v1/me' });
  assert.equal(result.status, 409);
  assert.equal(JSON.stringify(result).includes('previous-user'), false);
});

test('a recovered website account read also restores the inventory account after a background read fails', async t => {
  let reads = 0;
  const account = { data: { id: 'market-user', attributes: { displayHandle: 'TestEnvoy', platform: 'PC', inGameVerified: true,
    restrictionState: 'NONE', email: 'private@example.com' }, meta: { sessionToken: 'private-response-token' } } };
  const market = new MarketService({ getSession: () => null, sharedAccount: true,
    fetchImpl: async url => {
      assert.equal(url.endsWith('/me'), true);
      reads++;
      return new Response(JSON.stringify(reads === 1
        ? { error: { code: 'TEMPORARY_FAILURE', message: 'Try later.' } } : account), { status: reads === 1 ? 503 : 200 });
    } });
  t.after(() => market.dispose());
  market.initialized = true; market.token = 'private-main-session';
  assert.equal((await market.refresh()).ok, false);
  assert.equal(market.snapshot().authenticated, false);
  const changed = [];
  market.on('changed', state => changed.push(state));
  const result = await requestMarketFrontend(market, { path: '/v1/me' });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.attributes.displayHandle, 'TestEnvoy');
  assert.equal(market.snapshot().authenticated, true);
  assert.deepEqual(market.snapshot().user, { id: 'market-user', displayHandle: 'TestEnvoy', platform: 'PC',
    inGameVerified: true, envoyNameReverificationRequired: false, restrictionState: 'NONE' });
  assert.equal(changed.at(-1).authenticated, true);
  for (const secret of ['private-main-session', 'private-response-token', 'private@example.com']) {
    assert.equal(JSON.stringify(changed).includes(secret), false, 'Inventory receives only the account projection');
  }
  assert.equal(JSON.stringify(result).includes('private-response-token'), false);
});

test('a late website account read cannot restore the inventory account after disconnect', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const market = new MarketService({ getSession: () => null, sharedAccount: true,
    fetchImpl: async () => { await pending; return new Response(JSON.stringify({ data: { id: 'previous-user',
      attributes: { displayHandle: 'PreviousEnvoy' } } })); } });
  t.after(() => market.dispose());
  market.initialized = true; market.token = 'previous-session';
  const read = requestMarketFrontend(market, { path: '/v1/me' });
  await new Promise(resolve => setImmediate(resolve));
  market.clearSession();
  finish();
  const result = await read;
  assert.equal(result.status, 409);
  assert.equal(market.snapshot().authenticated, false);
  assert.equal(market.snapshot().user, null);
  assert.equal(JSON.stringify(result).includes('PreviousEnvoy'), false);
});

test('confirmed account projection rejects a changed token and malformed account responses', () => {
  const market = new MarketService({ getSession: () => null, sharedAccount: true });
  market.token = 'current-session';
  const account = { data: { id: 'previous-user', attributes: { displayHandle: 'PreviousEnvoy' } } };
  assert.throws(() => market.acceptAccountResponse(account, market.generation, 'previous-session'), { code: 'SESSION_CHANGED' });
  assert.throws(() => market.acceptAccountResponse(account, market.generation - 1, market.token), { code: 'SESSION_CHANGED' });
  for (const response of [null, {}, { data: { id: 'user', attributes: [] } }, { data: { attributes: {} } }]) {
    assert.throws(() => market.acceptAccountResponse(response, market.generation, market.token), { code: 'INVALID_RESPONSE' });
  }
  assert.equal(market.snapshot().authenticated, false);
});

test('overlay presence wins over browser idle timers and manual availability controls', async () => {
  const f = fixture(); f.market.enabled = true;
  for (const input of [
    { path: '/v1/me/activity', method: 'POST' },
    { path: '/v1/me/presence', method: 'POST', body: { status: 'OFFLINE' } },
    { path: '/v1/me/availability', method: 'PATCH', body: { inGame: false } },
  ]) assert.equal((await f.run(input)).status, 200);
  assert.deepEqual(f.calls.filter(call => typeof call === 'object'), [
    { route: 'me/availability', options: undefined }, { route: 'me/availability', options: undefined },
    { route: 'me/availability', options: undefined },
  ]);
  f.market.enabled = false;
  await f.run({ path: '/v1/me/presence', method: 'POST', body: { status: 'AWAY' } });
  assert.deepEqual(f.calls.at(-1), { route: 'me/presence', options: { method: 'POST', body: { status: 'AWAY' } } });
});
