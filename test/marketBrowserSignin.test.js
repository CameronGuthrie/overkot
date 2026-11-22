'use strict';
process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { MarketService } = require('../src/modules/marketService');
const id = 'a'.repeat(43), deviceCode = 'd'.repeat(43), sessionToken = 's'.repeat(43);
const response = (attributes, status = 200) => new Response(JSON.stringify({ data: { attributes } }), { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const f = { saved: null, opened: [], requests: [], clock: 1000, result: { status: 'pending' },
    start: { authorizationId: id, deviceCode, userCode: 'ABCD-1234', expiresIn: 600, interval: 5, verificationUri: `https://avakot.market/overkot-signin#${id}` } };
  f.service = new MarketService({ getSession: () => null, apiBase: 'http://127.0.0.1:3000/v1', readLocalApiKey: () => 'integration-secret',
    tokenStore: { load: () => null, save: token => { f.saved = token; return true; }, clear: () => { f.saved = null; } },
    openExternal: async url => { f.opened.push(url); if (f.openError) throw new Error('browser error'); },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname.replace('/v1/', '');
      f.requests.push({ route, ...options });
      if (route === 'auth/desktop/authorizations') return response(await f.start);
      if (route === 'auth/desktop/token') {
        if (f.networkError) throw new Error('offline');
        const result = await f.result;
        return result instanceof Response ? result : response(result);
      }
      if (route === 'auth/desktop/cancel' || route === 'auth/sign-out') return response({});
      if (route === 'me') return new Response(JSON.stringify({ data: { id: 'market-user', attributes: { displayHandle: 'Envoy', inGameVerified: true } } }));
      if (route === 'catalogue/feed' || route.startsWith('me/listings?')) return new Response(JSON.stringify({ data: [] }));
      if (route === 'public/config') return new Response(JSON.stringify({ data: {} }));
      if (route.startsWith('languages/')) return response({});
      throw new Error('Unexpected route ' + route);
    } });
  f.service.browserSignin.now = () => f.clock;
  f.begin = remember => f.service.loginWithAvakot({ remember: remember !== false });
  f.poll = () => f.service.browserSignin.poll();
  return f;
}

test('browser sign-in opens the fixed site, protects secrets, and uses the normal market session', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  const events = []; f.service.on('changed', state => events.push(state));
  assert.equal((await f.begin()).ok, true);
  assert.deepEqual(f.opened, [f.start.verificationUri]);
  assert.deepEqual(f.service.snapshot().signIn, { pending: true, userCode: 'ABCD-1234', error: '' });
  assert.equal((await f.begin()).error, 'BUSY');
  assert.equal((await f.service.login({ email: 'envoy@example.test', password: 'pass' })).error, 'BUSY');
  await f.poll(); assert.equal(f.service.token, null);
  f.result = { status: 'approved', sessionToken }; await f.poll();
  assert.equal(f.service.snapshot().authenticated, true);
  assert.equal(f.service.snapshot().signIn.pending, false);
  assert.equal(f.saved, sessionToken);
  for (const secret of [deviceCode, sessionToken, 'integration-secret']) assert.equal(JSON.stringify(events).includes(secret), false);
  assert.ok(f.requests.every(r => r.headers['X-API-Key'] === 'integration-secret'));
  assert.ok(f.requests.filter(r => r.route.startsWith('auth/desktop')).every(r => !r.headers.Authorization));
  await f.service.logout(); assert.equal(f.saved, null);
  assert.ok(f.requests.some(r => r.route === 'auth/sign-out' && r.headers.Authorization === `Bearer ${sessionToken}`));
});

test('remember preference changes during approval apply before storing the session', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.begin(); f.service.setRememberSession(false);
  f.result = { status: 'approved', sessionToken }; await f.poll();
  assert.equal(f.saved, null); assert.equal(f.service.snapshot().authenticated, true);
  assert.equal(f.service.snapshot().sessionPersistent, false);
});

test('cancel, logout and shutdown ignore and revoke late successful exchanges', async () => {
  for (const action of ['cancelAvakotLogin', 'logout', 'dispose']) {
    const f = fixture(); await f.begin();
    const late = deferred(); f.result = late.promise;
    const polling = f.poll(); await f.service[action]();
    late.resolve({ status: 'approved', sessionToken }); await polling;
    assert.equal(f.service.token, null); assert.equal(f.saved, null);
    assert.equal(f.service.snapshot().signIn.pending, false);
    assert.ok(f.requests.some(r => r.route === 'auth/desktop/cancel'));
    assert.ok(f.requests.some(r => r.route === 'auth/sign-out' && r.headers.Authorization === `Bearer ${sessionToken}`));
    await f.service.dispose();
  }
});

test('cancelling a slow start prevents browser navigation and cancels the new request', async () => {
  const f = fixture(), late = deferred(), value = f.start;
  f.start = late.promise; const starting = f.begin();
  await f.service.cancelAvakotLogin(); late.resolve(value); await starting;
  assert.deepEqual(f.opened, []); assert.equal(f.service.snapshot().signIn.pending, false);
  assert.ok(f.requests.some(r => r.route === 'auth/desktop/cancel'));
  await f.service.dispose();
});

test('outages retry, slow-down increases polling interval, and expiry ends sign-in', async t => {
  const f = fixture(); t.after(() => f.service.dispose()); await f.begin();
  f.networkError = true; await f.poll();
  assert.equal(f.service.snapshot().signIn.pending, true);
  assert.match(f.service.snapshot().signIn.error, /retry automatically/);
  f.networkError = false; f.result = { status: 'slow_down' }; await f.poll();
  assert.equal(f.service.browserSignin.authorization.interval, 15000);
  f.clock += 600001; await f.poll();
  assert.equal(f.service.snapshot().signIn.pending, false); assert.match(f.service.snapshot().signIn.error, /expired/);
});

test('denied approvals, browser failure, and invalid destinations fail without a session', async () => {
  for (const issue of ['denied', 'browser', 'url', 'malformed']) {
    const f = fixture();
    if (issue === 'url') f.start.verificationUri = 'https://attacker.invalid/';
    if (issue === 'browser') f.openError = true;
    await f.begin();
    if (issue === 'denied') f.result = new Response(JSON.stringify({ error: { code: 'SIGN_IN_DENIED', message: 'Sign-in declined.' } }), { status: 403 });
    if (issue === 'malformed') f.result = { status: 'approved', sessionToken: 'invalid' };
    await f.poll();
    assert.equal(f.service.snapshot().signIn.pending, false); assert.ok(f.service.snapshot().signIn.error);
    assert.equal(f.service.token, null); assert.equal(f.saved, null);
    await f.service.dispose();
  }
});
