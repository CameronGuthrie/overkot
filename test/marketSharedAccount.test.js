'use strict';

process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MarketService } = require('../src/modules/marketService');
const { MarketAccountConnection } = require('../src/modules/marketAccountConnection');

const grant = 'g'.repeat(43), token = 'm'.repeat(43);
const session = sessionToken => ({ sessionToken, expiresAt: new Date(Date.now() + 900_000).toISOString() });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const calls = [], events = [], store = { value: 'unrelated-legacy-market-session', loads: 0, saves: [], clears: 0 };
  const market = new MarketService({
    sharedAccount: true, rememberSession: true, getSession: () => null,
    readLocalApiKey: () => assert.fail('Production must ignore stale Market key configuration'),
    tokenStore: {
      load() { store.loads++; return store.value; },
      save(value) { store.saves.push(value); store.value = value; return true; },
      clear() { store.clears++; store.value = null; },
    },
    fetchImpl: async (url, input) => {
      const route = url.split('/v1/')[1];
      const call = { route, url, ...input, body: input.body ? JSON.parse(input.body) : undefined }; calls.push(call);
      const custom = await options.respond?.(call, calls);
      if (custom) return custom;
      if (route === 'auth/desktop/avakot') return response({ data: { attributes: session(token) } });
      if (route === 'auth/sign-out') return response({ data: {} });
      if (route === 'me') return response({ data: { id: 'actual-market-user', attributes: {
        displayHandle: 'VerifiedMarketEnvoy', platform: 'PC', inGameVerified: true, restrictionState: 'NONE',
      } } });
      if (route === 'catalogue/feed') return response({ items: [] });
      if (route === 'public/config') return response({ data: {} });
      if (route.startsWith('catalogue/languages/')) return response({});
      if (route.startsWith('me/listings?')) return response({ data: [] });
      throw new Error('Unexpected fixture request: ' + route);
    },
  });
  market.on('changed', state => events.push(state));
  t.after(async () => { await market.dispose(); });
  return { market, calls, store, events };
}

test('shared mode deletes legacy Market storage without loading or restoring its unrelated session', async t => {
  const f = fixture(t);
  await f.market.initialize(); await f.market.initialize();
  assert.equal(f.store.loads, 0); assert.equal(f.store.clears, 1); assert.equal(f.store.value, null);
  assert.equal(f.market.token, null); assert.equal(f.market.snapshot().authenticated, false);
  assert.deepEqual(f.calls, []);
});

test('shared mode blocks separate credential and device login before making any request', async t => {
  const f = fixture(t);
  assert.equal((await f.market.login({ email: 'unused@example.com', password: 'unused-password' })).error, 'ACCOUNT_CONNECTION_REQUIRED');
  assert.equal((await f.market.loginWithAvakot()).error, 'ACCOUNT_CONNECTION_REQUIRED');
  assert.deepEqual(f.calls, []);
});

test('grant exchange authenticates only after the real Market account response and exposes no credentials', async t => {
  const me = deferred();
  const f = fixture(t, { respond: call => call.route === 'me' ? me.promise : null });
  const work = f.market.loginWithAccountGrant(grant);
  await tick();
  assert.equal(f.market.token, token);
  assert.equal(f.market.snapshot().authenticated, false, 'A granted token alone is not a verified Market account');
  me.resolve(response({ data: { id: 'confirmed-user', attributes: { displayHandle: 'ActualMarketIdentity', inGameVerified: true } } }));
  const result = await work;
  assert.equal(result.ok, true); assert.equal(result.state.authenticated, true);
  assert.equal(result.state.user.displayHandle, 'ActualMarketIdentity');
  assert.equal(result.state.sessionPersistent, false);
  const exchange = f.calls.find(call => call.route === 'auth/desktop/avakot');
  assert.deepEqual(exchange.body, { grant }); assert.equal(exchange.headers.Authorization, undefined);
  assert.equal(exchange.headers['X-API-Key'], undefined);
  assert.equal(exchange.url, 'https://api.avakot.market/v1/auth/desktop/avakot');
  assert.equal(f.calls.find(call => call.route === 'catalogue/feed').url, 'https://avakot.market/api/v1/catalogue/feed');
  assert.equal(f.calls.find(call => call.route === 'me').headers.Authorization, 'Bearer ' + token);
  assert.deepEqual(f.store.saves, []);
  for (const secret of [grant, token, 'private-integration-key']) assert.equal(JSON.stringify({ result, events: f.events }).includes(secret), false);
});

test('shared mode never persists its derived Market token when the remember setting changes', async t => {
  const f = fixture(t);
  assert.equal((await f.market.loginWithAccountGrant(grant)).ok, true);
  f.market.setRememberSession(false); f.market.setRememberSession(true);
  assert.deepEqual(f.store.saves, []);
  assert.equal(f.market.snapshot().sessionPersistent, false);
});

test('malformed grant and malformed token fail without creating a session', async t => {
  const f = fixture(t, { respond: call => call.route === 'auth/desktop/avakot'
    ? response({ data: { attributes: { sessionToken: 'wrong-format-token' } } }) : null });
  for (const value of [null, '', 'short', 'g'.repeat(44), '/'.repeat(43)]) {
    assert.equal((await f.market.loginWithAccountGrant(value)).error, 'VALIDATION_FAILED');
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.market.loginWithAccountGrant(grant)).error, 'INVALID_RESPONSE');
  assert.equal(f.market.snapshot().authenticated, false);
  assert.equal(f.calls.some(call => call.route === 'me'), false);
});

test('simultaneous grant submissions exchange only once', async t => {
  const exchange = deferred();
  const f = fixture(t, { respond: call => call.route === 'auth/desktop/avakot' ? exchange.promise : null });
  const first = f.market.loginWithAccountGrant(grant);
  assert.equal((await f.market.loginWithAccountGrant(grant)).error, 'BUSY');
  assert.equal(f.calls.filter(call => call.route === 'auth/desktop/avakot').length, 1);
  exchange.resolve(response({ data: { attributes: session(token) } }));
  assert.equal((await first).ok, true);
});

test('a fresh grant retry revokes an earlier token whose account read failed', async t => {
  let meRequests = 0;
  const nextToken = 'n'.repeat(43);
  const f = fixture(t, { respond: call => {
    if (call.route === 'auth/desktop/avakot') return response({ data: { attributes: session(call.body.grant === grant ? token : nextToken) } });
    if (call.route === 'me' && ++meRequests === 1) throw new Error('Transient account read failure');
    return null;
  } });
  assert.equal((await f.market.loginWithAccountGrant(grant)).error, 'NETWORK_ERROR');
  assert.equal(f.market.snapshot().authenticated, false);
  assert.equal(f.market.token, token);
  assert.equal((await f.market.loginWithAccountGrant('h'.repeat(43))).ok, true);
  assert.equal(f.market.token, nextToken);
  assert.equal(f.calls.find(call => call.route === 'auth/sign-out').headers.Authorization, 'Bearer ' + token);
});

test('logout during grant exchange revokes a late token before it can be accepted', async t => {
  const exchange = deferred();
  const f = fixture(t, { respond: call => call.route === 'auth/desktop/avakot' ? exchange.promise : null });
  const work = f.market.loginWithAccountGrant(grant);
  await f.market.logout();
  exchange.resolve(response({ data: { attributes: session(token) } }));
  assert.equal((await work).error, 'SESSION_CHANGED');
  assert.equal(f.market.token, null); assert.equal(f.market.snapshot().authenticated, false);
  assert.equal(f.calls.some(call => call.route === 'me'), false);
  assert.equal(f.calls.find(call => call.route === 'auth/sign-out').headers.Authorization, 'Bearer ' + token);
});

test('central disconnect during real Market exchange cannot revive its session', async t => {
  const exchange = deferred();
  const f = fixture(t, { respond: call => call.route === 'auth/desktop/avakot' ? exchange.promise : null });
  const account = new EventEmitter();
  account.token = 'c'.repeat(43); account.signedIn = true;
  account.snapshot = () => ({ signedIn: account.signedIn, marketSignIn: true });
  account.request = async () => ({ grant });
  const connection = new MarketAccountConnection({ account, market: f.market, retryMs: 5 });
  t.after(() => connection.dispose());
  const work = connection.sync(); await tick();
  account.token = null; account.signedIn = false; account.emit('changed');
  exchange.resolve(response({ data: { attributes: session(token) } }));
  await work;
  assert.equal(f.market.snapshot().authenticated, false);
  assert.equal(connection.snapshot().connected, false);
  assert.equal(f.calls.find(call => call.route === 'auth/sign-out').headers.Authorization, 'Bearer ' + token);
});

test('central account switch revokes the old session and signs in only the new Market account', async t => {
  const firstExchange = deferred(), secondGrant = 'h'.repeat(43), secondToken = 'n'.repeat(43);
  const f = fixture(t, { respond: call => {
    if (call.route === 'auth/desktop/avakot') return call.body.grant === grant ? firstExchange.promise
      : response({ data: { attributes: session(secondToken) } });
    if (call.route === 'me') return response({ data: { id: 'second-market-user', attributes: { displayHandle: 'SecondMarketEnvoy' } } });
    return null;
  } });
  const account = new EventEmitter();
  account.token = 'c'.repeat(43);
  account.snapshot = () => ({ signedIn: true, marketSignIn: true });
  account.request = async () => ({ grant: account.token[0] === 'c' ? grant : secondGrant });
  const connection = new MarketAccountConnection({ account, market: f.market, retryMs: 5 });
  t.after(() => connection.dispose());
  const first = connection.sync(); await tick();
  account.token = 'd'.repeat(43); account.emit('changed');
  await tick();
  firstExchange.resolve(response({ data: { attributes: session(token) } })); await first;
  const deadline = Date.now() + 1000;
  while (!connection.snapshot().connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(connection.snapshot().connected, true);
  assert.equal(f.market.token, secondToken);
  assert.equal(f.market.snapshot().user.displayHandle, 'SecondMarketEnvoy');
  assert.equal(f.calls.find(call => call.route === 'auth/sign-out').headers.Authorization, 'Bearer ' + token);
  assert.equal(f.calls.filter(call => call.route === 'auth/desktop/avakot' && call.body.grant === grant).length, 1);
});

test('same-account renewal preserves an in-flight write and revokes overlapping credentials on logout', async t => {
  const pendingWrite = deferred(), nextToken = 'n'.repeat(43); let exchanges = 0;
  const f = fixture(t, { respond: call => {
    if (call.route === 'auth/desktop/avakot') return response({ data: { attributes: session(++exchanges === 1 ? token : nextToken) } });
    if (call.route === 'me/listings' && call.method === 'POST') return pendingWrite.promise;
    return null;
  } });
  assert.equal((await f.market.loginWithAccountGrant(grant)).ok, true);
  const generation = f.market.generation;
  const writing = f.market.mutate(async generation => {
    await f.market.request('me/listings', { method: 'POST', body: { marker: 'one write' } });
    f.market.checkGeneration(generation); return { ok: true };
  });
  await tick();
  assert.equal((await f.market.loginWithAccountGrant('h'.repeat(43), { renew: true })).ok, true);
  assert.equal(f.market.generation, generation); assert.equal(f.market.token, nextToken);
  assert.equal(f.calls.some(call => call.route === 'auth/sign-out'), false);
  assert.equal(f.calls.find(call => call.route === 'me/listings').headers.Authorization, 'Bearer ' + token);
  pendingWrite.resolve(response({ data: {} }));
  assert.equal((await writing).ok, true);
  assert.equal(f.calls.filter(call => call.route === 'me/listings').length, 1, 'The write is never replayed');
  await f.market.logout();
  assert.deepEqual(new Set(f.calls.filter(call => call.route === 'auth/sign-out').map(call => call.headers.Authorization)),
    new Set(['Bearer ' + token, 'Bearer ' + nextToken]));
});

test('renewal rejects a different Market identity and revokes only the unaccepted candidate', async t => {
  const nextToken = 'n'.repeat(43); let exchanges = 0;
  const f = fixture(t, { respond: call => {
    if (call.route === 'auth/desktop/avakot') return response({ data: { attributes: session(++exchanges === 1 ? token : nextToken) } });
    if (call.route === 'me' && call.headers.Authorization === 'Bearer ' + nextToken) return response({ data: { id: 'different-user', attributes: { displayHandle: 'Different' } } });
    return null;
  } });
  await f.market.loginWithAccountGrant(grant);
  const generation = f.market.generation;
  assert.equal((await f.market.loginWithAccountGrant('h'.repeat(43), { renew: true })).error, 'SESSION_CHANGED');
  assert.equal(f.market.token, token); assert.equal(f.market.user.id, 'actual-market-user');
  assert.equal(f.market.generation, generation);
  assert.equal(f.calls.find(call => call.route === 'auth/sign-out').headers.Authorization, 'Bearer ' + nextToken);
});

test('invalid grant-session expiry never installs a credential or exposes it to a renderer', async t => {
  for (const expiresAt of [undefined, 'bad-date', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 86_400_000).toISOString()]) {
    const f = fixture(t, { respond: call => call.route === 'auth/desktop/avakot'
      ? response({ data: { attributes: { sessionToken: token, expiresAt } } }) : null });
    assert.equal((await f.market.loginWithAccountGrant(grant)).error, 'INVALID_RESPONSE');
    assert.equal(f.market.token, null); assert.equal(f.market.user, null);
    assert.equal(f.calls.some(call => call.route === 'me'), false);
  }
});
