'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MarketAccountConnection } = require('../src/modules/marketAccountConnection');

const centralToken = 'c'.repeat(43), grant = 'g'.repeat(43), marketToken = 'm'.repeat(43);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const account = new EventEmitter();
  account.token = options.signedIn === false ? null : centralToken;
  account.state = { signedIn: options.signedIn !== false, marketSignIn: options.scope !== false };
  account.snapshot = () => ({ ...account.state });
  account.clearCredential = () => { account.token = null; account.state.signedIn = false; };
  account.publish = () => account.emit('changed');
  const requests = [], exchanges = [], exchangeOptions = [], revoked = [];
  account.request = async (route, input) => {
    requests.push({ route, ...input });
    return options.authorize ? options.authorize(requests.length, input) : { grant };
  };
  const market = Object.assign(new EventEmitter(), {
    token: null, user: null, generation: 0,
    clearSession() { this.token = null; this.user = null; this.generation++; this.emit('changed'); },
    revokeToken: async value => { revoked.push(value); },
    async loginWithAccountGrant(value, input) {
      exchanges.push(value);
      exchangeOptions.push(input);
      if (options.exchange) return options.exchange(value, this, input);
      this.token = marketToken; this.user = { id: 'real-market-user' };
      return { ok: true };
    },
  });
  const connection = new MarketAccountConnection({ account, market, retryMs: options.retryMs ?? 10 });
  t.after(() => connection.dispose());
  return {
    account, market, connection, requests, exchanges, exchangeOptions, revoked,
    setAccount(state, token = account.token) {
      account.state = { ...account.state, ...state }; account.token = token; account.emit('changed');
    },
  };
}

test('shared sign-in requests a one-use grant in main and publishes no grant or credential', async t => {
  const f = fixture(t);
  const snapshots = [];
  f.connection.on('changed', state => snapshots.push(state));
  await f.connection.sync();
  assert.deepEqual(f.requests, [{ route: 'market-authorization', method: 'POST', body: {}, token: centralToken }]);
  assert.deepEqual(f.exchanges, [grant]);
  assert.equal(f.connection.snapshot().connected, true);
  for (const secret of [centralToken, grant, marketToken]) assert.equal(JSON.stringify(snapshots).includes(secret), false);
  assert.equal(f.connection.snapshot().busy, false);
  await f.connection.sync();
  assert.equal(f.requests.length, 1, 'An established Market session does not request or replay another grant');
});

test('central account identity alone never establishes a Market session', async t => {
  const pending = deferred();
  const f = fixture(t, { authorize: () => pending.promise });
  const work = f.connection.sync();
  assert.equal(f.connection.snapshot().connected, false);
  assert.equal(f.market.user, null);
  assert.equal(f.connection.snapshot().busy, true);
  pending.resolve({ grant }); await work;
  assert.equal(f.connection.snapshot().connected, true);
});

test('repeated state events share a single in-flight authorization and exchange', async t => {
  const pending = deferred();
  const f = fixture(t, { authorize: () => pending.promise });
  const first = f.connection.sync();
  assert.equal(f.connection.sync(), first);
  f.setAccount({ busy: true }); f.setAccount({ busy: false });
  assert.equal(f.requests.length, 1);
  pending.resolve({ grant }); await first; await tick();
  assert.equal(f.exchanges.length, 1);
  assert.equal(f.connection.work, null);
});

test('disconnect during authorization prevents the late grant from reaching Market', async t => {
  const pending = deferred();
  const f = fixture(t, { authorize: () => pending.promise });
  const work = f.connection.sync();
  f.setAccount({ signedIn: false }, null);
  pending.resolve({ grant }); await work;
  assert.deepEqual(f.exchanges, []);
  assert.equal(f.connection.snapshot().connected, false);
  assert.equal(f.connection.snapshot().busy, false);
});

test('account switch drops the previous Market identity immediately and ignores its late authorization', async t => {
  const pending = deferred();
  const secondGrant = 's'.repeat(43);
  const f = fixture(t, { authorize: count => count === 1 ? pending.promise : { grant: secondGrant } });
  f.market.token = 'old-market-session'; f.market.user = { id: 'old-market-user' };
  const first = f.connection.sync();
  assert.deepEqual(f.revoked, ['old-market-session']);
  assert.equal(f.market.user, null);
  f.setAccount({ signedIn: true }, 'n'.repeat(43));
  await f.connection.work.promise;
  pending.resolve({ grant }); await first;
  assert.deepEqual(f.exchanges, [secondGrant]);
  assert.equal(f.connection.snapshot().connected, true);
});

test('legacy account scopes require reconnect and obtain a grant only after new approval', async t => {
  const f = fixture(t, { scope: false });
  await f.connection.sync();
  assert.equal(f.connection.snapshot().requiresReconnect, true);
  assert.match(f.connection.snapshot().error, /Reconnect/);
  assert.deepEqual(f.requests, []);
  f.setAccount({ marketSignIn: true }, 'r'.repeat(43));
  await f.connection.work.promise;
  assert.equal(f.connection.snapshot().requiresReconnect, false);
  assert.equal(f.connection.snapshot().connected, true);
});

test('server scope rejection stops automatic retries until reconnect', async t => {
  const f = fixture(t, { authorize: () => { throw Object.assign(new Error('insufficient scope'), { code: 'scope_required' }); } });
  await f.connection.sync();
  assert.equal(f.connection.snapshot().requiresReconnect, true);
  assert.equal(f.connection.timer, null);
  await f.connection.sync();
  assert.equal(f.requests.length, 1);
});

test('missing Market account link waits for explicit retry and succeeds after the link is added', async t => {
  let linked = false;
  const f = fixture(t, { authorize: () => {
    if (!linked) throw Object.assign(new Error('connection missing'), { code: 'market_connection_required' });
    return { grant };
  } });
  await f.connection.sync();
  assert.equal(f.connection.snapshot().requiresLink, true);
  assert.equal(f.connection.timer, null);
  await f.connection.sync(); assert.equal(f.requests.length, 1);
  linked = true; await f.connection.retry();
  assert.equal(f.connection.snapshot().requiresLink, false);
  assert.equal(f.connection.snapshot().connected, true);
});

test('network failures retry authorization automatically and obtain a fresh grant after failed exchange', async t => {
  const grants = ['a'.repeat(43), 'b'.repeat(43)];
  const f = fixture(t, {
    retryMs: 5,
    authorize: count => ({ grant: grants[count - 1] }),
    exchange: (value, market) => {
      if (value === grants[0]) return { ok: false, error: 'NETWORK_ERROR' };
      market.token = marketToken; market.user = { id: 'real-market-user' }; return { ok: true };
    },
  });
  await f.connection.sync();
  assert.match(f.connection.snapshot().error, /retry automatically/);
  const deadline = Date.now() + 1000;
  while (!f.connection.snapshot().connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.connection.snapshot().connected, true);
  assert.deepEqual(f.exchanges, grants, 'A consumed or uncertain grant is never replayed');
  assert.equal(f.connection.snapshot().error, '');
});

test('invalid authorization grants remain in main and cannot reach Market exchange', async t => {
  const f = fixture(t, { authorize: () => ({ grant: 'not-a-valid-grant' }) });
  await f.connection.sync();
  assert.deepEqual(f.exchanges, []);
  assert.equal(f.connection.snapshot().connected, false);
  assert.match(f.connection.snapshot().error, /retry automatically/);
});

test('a recovered confirmed Market account clears an earlier connection outage and pending retry', async t => {
  const f = fixture(t, { retryMs: 30_000, exchange: () => ({ ok: false, error: 'NETWORK_ERROR' }) });
  await f.connection.sync();
  assert.ok(f.connection.snapshot().error);
  assert.ok(f.connection.timer);
  f.market.token = marketToken; f.market.user = { id: 'real-market-user' }; f.market.emit('changed');
  assert.equal(f.connection.snapshot().connected, true);
  assert.equal(f.connection.snapshot().error, '');
  assert.equal(f.connection.timer, null);
  assert.equal(f.exchanges.length, 1, 'Recovering /me does not request another sign-in');
});

test('a confirmed Market account stays connected when only the public catalogue refresh fails', async t => {
  const f = fixture(t, { exchange: (_grant, market) => {
    market.token = marketToken; market.user = { id: 'confirmed-market-user' };
    return { ok: false, error: 'NETWORK_ERROR' };
  } });
  await f.connection.sync();
  assert.equal(f.connection.snapshot().connected, true);
  assert.equal(f.connection.snapshot().error, '');
  assert.equal(f.connection.timer, null);
  await f.connection.sync();
  assert.equal(f.requests.length, 1);
});

test('a revoked central credential clears both connection state and Market identity', async t => {
  const f = fixture(t, { authorize: () => { throw Object.assign(new Error('revoked'), { code: 'unauthorized', status: 401 }); } });
  await f.connection.sync();
  assert.equal(f.account.token, null);
  assert.equal(f.account.snapshot().signedIn, false);
  assert.equal(f.connection.snapshot().connected, false);
  assert.equal(f.connection.snapshot().busy, false);
  assert.match(f.account.error, /expired or was revoked/);
  assert.equal(f.connection.timer, null);
});

test('an expired Market session automatically obtains a new grant for the connected central account', async t => {
  const f = fixture(t);
  await f.connection.sync();
  f.market.clearSession();
  await tick();
  if (f.connection.work) await f.connection.work.promise;
  assert.equal(f.requests.length, 2);
  assert.equal(f.connection.snapshot().connected, true);
});

test('disposal removes central listeners and cancels authorization retries', async t => {
  const f = fixture(t, { authorize: () => { throw new Error('offline'); } });
  await f.connection.sync();
  assert.notEqual(f.connection.timer, null);
  f.connection.dispose();
  assert.equal(f.account.listenerCount('changed'), 0);
  f.setAccount({ signedIn: true }, 'z'.repeat(43));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.requests.length, 1);
});

test('short-lived sessions renew one minute early while preserving the connected account during exchange', async t => {
  const late = deferred(); let count = 0;
  const f = fixture(t, { exchange: async (_value, market, input) => {
    if (++count === 2) {
      assert.equal(input.renew, true);
      assert.equal(market.token, marketToken);
      await late.promise;
    }
    market.token = count === 1 ? marketToken : 'r'.repeat(43); market.user = { id: 'real-market-user' };
    market.sessionExpiresAt = Date.now() + 900_000; market.emit('session-expiry');
    return { ok: true };
  } });
  await f.connection.sync();
  assert.ok(f.connection.renewalTimer._idleTimeout > 830_000);
  f.market.sessionExpiresAt = Date.now() + 60_005; f.market.emit('session-expiry');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.requests.length, 2); assert.equal(f.connection.snapshot().connected, true);
  assert.equal(f.market.token, marketToken);
  late.resolve(); await f.connection.work.promise;
  assert.equal(f.market.token, 'r'.repeat(43)); assert.equal(f.connection.renewalNeeded, false);
  assert.deepEqual(f.revoked, []);
});

test('a failed renewal retries with a fresh grant without clearing the working Market or central session', async t => {
  let count = 0;
  const f = fixture(t, { retryMs: 10, exchange: (_value, market) => {
    if (++count === 2) return { ok: false, status: 401, error: 'SIGN_IN_DENIED' };
    market.token = marketToken; market.user = { id: 'real-market-user' };
    market.sessionExpiresAt = Date.now() + 900_000; return { ok: true };
  } });
  await f.connection.sync();
  f.connection.renewalNeeded = true; await f.connection.sync();
  assert.equal(f.account.token, centralToken); assert.equal(f.market.token, marketToken);
  assert.equal(f.connection.renewalNeeded, true); assert.ok(f.connection.timer);
  const deadline = Date.now() + 1000;
  while (f.exchanges.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  if (f.connection.work) await f.connection.work.promise;
  assert.equal(f.exchanges.length, 3); assert.equal(f.connection.renewalNeeded, false);
  assert.equal(f.connection.snapshot().error, '');
});
