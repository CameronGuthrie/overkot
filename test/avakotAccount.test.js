process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AvakotAccountService, AvakotTokenStore, LIVE_SESSION_MS } = require('../src/modules/avakotAccount');

const token = 't'.repeat(43), accountId = 'a'.repeat(24), authorizationId = 'i'.repeat(43), deviceCode = 'd'.repeat(43);
const account = { email: 'test@example.com', displayName: 'AvakotUser' };
const profile = (id = accountId, name = 'RealEnvoy') => ({ Results: [{ AccountId: { $oid: id }, DisplayName: name }] });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  let time = 100_000, session = null;
  const calls = [], opened = [], stored = { value: options.saved || null };
  const service = new AvakotAccountService({
    getSession: () => session, now: () => time, openExternal: async url => opened.push(url),
    tokenStore: { load: () => stored.value, save: value => { stored.value = value; return true; }, clear: () => { stored.value = null; } },
    fetchImpl: async (url, init) => {
      const route = url.split('/v1/overlay/')[1];
      const call = { route, ...init, body: init.body && JSON.parse(init.body) }; calls.push(call);
      const custom = await options.respond?.(call);
      if (custom) return custom;
      if (route === 'authorizations') return response({ authorizationId, deviceCode, verificationUri: `https://account.avakot.dev/?overlay=${authorizationId}`, interval: 5, expiresIn: 600 });
      if (route === 'token') return response({ accessToken: token, account });
      if (route === 'me') return response({ account });
      return response({ ok: true });
    },
  });
  t.after(async () => { await service.dispose(); });
  return { service, calls, opened, stored, advance: ms => { time += ms; },
    setSession: value => { session = value; service.update(); },
    session: (extra = {}) => ({ accountId, _running: true, api: { fetchProfile: async () => profile() },
      isNonceExpired: () => false, isInventoryCached: () => false, getRawInventory: () => ({ valid: true }),
      getLastSuccessfulPollAt: () => time, ...extra }),
    login: async () => { await service.signIn(); await service.pollAuthorization(service.generation); await tick(); await service.sync(); },
  };
}

test('browser approval exposes no device secret or credential in renderer state', async t => {
  const f = fixture(t);
  await f.service.initialize();
  await f.service.signIn();
  assert.equal(f.service.snapshot().authorizing, true);
  assert.deepEqual(f.opened, [`https://account.avakot.dev/?overlay=${authorizationId}`]);
  await f.service.pollAuthorization(f.service.generation);
  assert.equal(f.service.snapshot().signedIn, true);
  assert.equal(f.service.snapshot().game.online, false, 'Account login alone must not mean game online');
  assert.equal(f.stored.value, token);
  const state = JSON.stringify(f.service.snapshot());
  assert.equal(state.includes(token), false); assert.equal(state.includes(deviceCode), false);
  assert.deepEqual(f.calls.find(c => c.route === 'presence').body, { online: false });
  assert.equal(f.calls[0].credentials, 'omit'); assert.equal(f.calls[0].redirect, 'error');
});

test('Market permission comes only from the approved credential and reconnect revokes the legacy session', async t => {
  const f = fixture(t, { respond: call => call.route === 'token'
    ? response({ accessToken: token, account, overlay: { marketSignIn: true } }) : null });
  await f.login();
  assert.equal(f.service.snapshot().marketSignIn, true);
  await f.service.reconnect();
  assert.equal(f.service.snapshot().marketSignIn, false);
  assert.equal(f.service.snapshot().authorizing, true);
  assert.equal(f.calls.some(call => call.route === 'session' && call.method === 'DELETE'), true);
  assert.equal(f.calls.filter(call => call.route === 'authorizations').length, 2);
});

test('legacy credentials never gain Market permission from account identity alone', async t => {
  const f = fixture(t); await f.login();
  assert.equal(f.service.snapshot().signedIn, true);
  assert.equal(f.service.snapshot().marketSignIn, false);
});

test('cached inventory and mismatched public profiles never report online', async t => {
  const f = fixture(t); await f.login();
  f.setSession(f.session({ isInventoryCached: () => true })); await tick();
  assert.equal(f.service.snapshot().game.online, false);
  f.setSession(f.session({ api: { fetchProfile: async () => profile('b'.repeat(24), 'WrongEnvoy') } })); await tick();
  assert.equal(f.service.snapshot().game.online, false);
  assert.equal(f.calls.some(c => c.body?.online), false);
});

test('fresh account-matched game login reports only resolved identity, then offline on logout', async t => {
  const f = fixture(t); await f.login();
  f.setSession(f.session({ nonce: 'SECRET_GAME_NONCE' })); await tick(); await f.service.sync();
  assert.deepEqual(f.calls.filter(c => c.route === 'presence').at(-1).body,
    { online: true, accountId, displayName: 'RealEnvoy' });
  assert.equal(JSON.stringify(f.calls).includes('SECRET_GAME_NONCE'), false);
  f.setSession(null); await f.service.sync();
  assert.deepEqual(f.calls.filter(c => c.route === 'presence').at(-1).body, { online: false });
});

test('old profile lookup cannot publish after a game account switch', async t => {
  let resolve;
  const f = fixture(t); await f.login();
  f.setSession(f.session({ api: { fetchProfile: () => new Promise(done => { resolve = done; }) } }));
  await tick();
  const secondId = 'b'.repeat(24);
  f.setSession(f.session({ accountId: secondId, api: { fetchProfile: async () => profile(secondId, 'SecondEnvoy') } }));
  await tick(); resolve(profile()); await tick(); await f.service.sync();
  assert.equal(f.service.snapshot().game.displayName, 'SecondEnvoy');
  assert.equal(f.calls.some(c => c.body?.accountId === accountId), false);
});

test('expired inventory freshness stops online heartbeats', async t => {
  const f = fixture(t); await f.login();
  f.setSession(f.session({ getLastSuccessfulPollAt: () => 100_000 })); await tick(); await f.service.sync();
  assert.equal(f.service.snapshot().game.online, true);
  f.advance(LIVE_SESSION_MS + 1); f.service.update(); await f.service.sync();
  assert.equal(f.service.snapshot().game.online, false);
  assert.deepEqual(f.calls.filter(c => c.route === 'presence').at(-1).body, { online: false });
});

test('offline is serialized behind an in-flight online request', async t => {
  let release;
  const f = fixture(t, { respond: call => call.route === 'presence' && call.body.online
    ? new Promise(resolve => { release = () => resolve(response({})); }) : null });
  await f.login(); f.setSession(f.session()); await tick();
  f.setSession(null);
  release(); await f.service.sync();
  assert.deepEqual(f.calls.filter(c => c.route === 'presence').slice(-2).map(c => c.body.online), [true, false]);
});

test('a status change queued at promise cleanup is drained immediately', async t => {
  const f = fixture(t), sent = [];
  f.service.token = token; f.service.account = account;
  let queued = false;
  f.service.request = (_route, { body }) => {
    sent.push(body);
    const result = Promise.resolve({});
    if (!queued) {
      queued = true;
      result.then(() => queueMicrotask(() => {
        f.service.game = { online: true, accountId, displayName: 'RealEnvoy' };
        void f.service.sync();
      }));
    }
    return result;
  };
  await f.service.sync();
  assert.deepEqual(sent.map(body => body.online), [false, true]);
  assert.equal(f.service.resync, false);
});

test('late approval result after cancellation is revoked and never saved', async t => {
  let release;
  const f = fixture(t, { respond: call => call.route === 'token' ? new Promise(resolve => { release = resolve; }) : null });
  await f.service.signIn(); const work = f.service.pollAuthorization(f.service.generation); await tick();
  f.service.cancelSignIn(); release(response({ accessToken: token, account })); await work;
  assert.equal(f.service.snapshot().signedIn, false); assert.equal(f.stored.value, null);
  assert.ok(f.calls.some(c => c.route === 'session' && c.method === 'DELETE' && c.headers.Authorization === `Bearer ${token}`));
});

test('revoked remembered credentials are erased and require a fresh sign-in', async t => {
  const f = fixture(t, { saved: token, respond: call => call.route === 'me'
    ? response({ error: { code: 'overlay_authentication_required', message: 'Revoked' } }, 401) : null });
  await f.service.initialize();
  assert.equal(f.stored.value, null); assert.equal(f.service.snapshot().signedIn, false);
  assert.match(f.service.snapshot().error, /revoked/);
});

test('sign-out clears stored credentials and revokes the scoped session', async t => {
  const f = fixture(t); await f.login(); await f.service.signOut();
  assert.equal(f.stored.value, null); assert.equal(f.service.snapshot().signedIn, false);
  assert.ok(f.calls.some(c => c.route === 'session' && c.method === 'DELETE'));
  assert.deepEqual(f.calls.find(c => c.route === 'session').body, {});
  assert.equal(f.calls.find(c => c.route === 'session').headers['Content-Type'], 'application/json');
});

test('a remembered sign-in can retry immediately after a transient restore outage', async t => {
  let unavailable = true;
  const f = fixture(t, { saved: token, respond: call => {
    if (call.route === 'me' && unavailable) throw new Error('offline');
  } });
  await f.service.initialize();
  assert.equal(f.service.snapshot().signedIn, false); assert.equal(f.service.snapshot().hasCredential, true);
  unavailable = false;
  assert.equal((await f.service.signIn()).ok, true);
  assert.equal(f.service.snapshot().signedIn, true);
  assert.equal(f.calls.some(call => call.route === 'authorizations'), false);
});

test('a gateway throttle keeps browser approval pending and honors Retry-After', async t => {
  let limited = true;
  const f = fixture(t, { respond: call => {
    if (limited && call.route === 'token') return new Response('{"message":"Too Many Requests"}',
      { status: 429, headers: { 'Retry-After': '20' } });
  } });
  const delays = [];
  f.service.schedulePoll = (_generation, delay) => delays.push(delay);
  await f.service.signIn();
  await f.service.pollAuthorization(f.service.generation);
  assert.equal(f.service.snapshot().authorizing, true);
  assert.match(f.service.snapshot().error, /retry.*automatically/);
  assert.equal(delays.at(-1), 20_000);
  limited = false;
  f.advance(20_000);
  await f.service.pollAuthorization(f.service.generation);
  assert.equal(f.service.snapshot().signedIn, true);
  assert.equal(f.service.snapshot().error, '');
  assert.equal(f.calls.filter(c => c.route === 'authorizations').length, 1);
});

test('a throttled restore retains the saved sign-in and explains the delay', async t => {
  const f = fixture(t, { saved: token, respond: call => call.route === 'me'
    ? new Response('Too Many Requests', { status: 429 }) : null });
  await f.service.initialize();
  assert.equal(f.stored.value, token);
  assert.match(f.service.snapshot().error, /busy/);
  assert.equal(f.calls.some(c => c.route === 'authorizations'), false);
});

test('offline sessions detect remote revocation without repeated presence writes', async t => {
  let revoked = false;
  const f = fixture(t, { respond: call => call.route === 'me' && revoked
    ? response({ error: { code: 'overlay_authentication_required', message: 'Revoked' } }, 401) : null });
  await f.login();
  f.advance(60_000); await f.service.sync();
  assert.equal(f.calls.filter(call => call.route === 'presence').length, 1);
  revoked = true; f.advance(5 * 60_000); await f.service.sync();
  assert.equal(f.service.snapshot().signedIn, false); assert.equal(f.stored.value, null);
});

test('OS storage refuses plaintext backends and writes encrypted credentials', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-account-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let backend = 'basic_text';
  const store = new AvakotTokenStore({ directory, safeStorage: { isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend, encryptString: value => Buffer.from(value.split('').reverse().join('') + ':encrypted'),
    decryptString: value => value.toString().replace(':encrypted', '').split('').reverse().join('') } });
  assert.equal(store.save(token), false); assert.equal(store.load(), null);
  backend = 'dpapi'; assert.equal(store.save(token), true); assert.equal(store.load(), token);
  assert.match(fs.readFileSync(store.file, 'utf8'), /:encrypted$/);
  store.clear(); assert.equal(store.load(), null);
});

test('untrusted production origins are rejected before credentials can be sent', () => {
  for (const apiBase of ['https://evil.example', 'http://auth.avakot.dev', 'https://auth.avakot.dev/other', 'https://user:password@auth.avakot.dev']) {
    assert.throws(() => new AvakotAccountService({ apiBase }), /production origin/);
  }
});
