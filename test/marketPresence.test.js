process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { MarketService } = require('../src/modules/marketService');

const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, saved = null) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = { requests: [], presence: [], override: null, saved };
  f.service = new MarketService({ getSession: () => null,
    tokenStore: { load: () => f.saved, save: token => { f.saved = token; return true; }, clear: () => { f.saved = null; } },
    fetchImpl: async (url, options) => {
      const request = { route: url.split('/v1/')[1], ...options, body: options.body ? JSON.parse(options.body) : undefined };
      f.requests.push(request);
      if (request.route === 'me/availability') f.presence.push(request);
      if (f.override) { const result = await f.override(request); if (result) return result; }
      if (request.route === 'auth/sign-in') return response({ data: { meta: { sessionToken: 'private-token' } } });
      if (request.route === 'me') return response({ data: { id: 'market-user', attributes: { displayHandle: 'TestEnvoy' } } });
      if (request.route === 'catalogue/feed') return response({ items: [] });
      if (request.route.startsWith('catalogue/languages/')) return response({});
      if (request.route.startsWith('me/listings?')) return response({ data: [] });
      if (['public/config', 'me/availability', 'auth/sign-out'].includes(request.route)) return response({ data: {} });
      throw new Error('Unexpected route: ' + request.route);
    } });
  t.after(() => f.service.dispose());
  f.login = () => f.service.login({ email: 'test@example.com', password: 'password' });
  f.tick = async () => {
    t.mock.timers.tick(60000);
    if (f.service.refreshing) await f.service.refreshing.promise;
    await f.service.presenceWork;
  };
  return f;
}

test('only an enabled authenticated market maintains online in-game presence without an open window', async t => {
  const f = fixture(t);
  await f.service.setEnabled(true);
  assert.equal(f.requests.length, 0, 'An enabled signed-out widget does not send requests');
  assert.equal((await f.login()).ok, true);
  await f.service.presenceWork;
  assert.equal(f.presence.length, 1);
  assert.equal(f.presence[0].method, 'PATCH');
  assert.equal(f.presence[0].headers.Authorization, 'Bearer private-token');
  assert.deepEqual(f.presence[0].body, { status: 'ONLINE', inGame: true, inGameSource: 'overlay' });
  for (let minute = 0; minute < 8; minute++) await f.tick();
  assert.equal(f.presence.length, 9, 'Heartbeats continue past the backend away timeout without UI interaction');
  await f.service.refresh();
  await f.tick();
  assert.equal(f.presence.length, 10, 'Refreshing data does not create duplicate heartbeat loops');
});

test('enabling restores a saved account; temporary presence failures are retried', async t => {
  const f = fixture(t, 'remembered-token');
  let failures = 1;
  f.override = request => request.route === 'me/availability' && failures-- > 0
    ? response({ error: { code: 'TEMPORARY_ERROR' } }, 503) : null;
  const result = await f.service.setEnabled(true);
  assert.equal(result.ok, true);
  assert.equal(f.service.snapshot().authenticated, true);
  assert.equal(f.requests.some(request => request.route === 'auth/sign-in'), false);
  await f.tick();
  assert.equal(f.presence.length, 2);
  assert.equal(f.presence[1].headers.Authorization, 'Bearer remembered-token');
});

test('disabled accounts do not heartbeat and disabling clears presence after an in-flight write', async t => {
  const f = fixture(t);
  await f.login();
  await f.tick();
  assert.equal(f.presence.length, 0);
  const started = deferred(), pending = deferred();
  f.override = async request => {
    if (request.route === 'me/availability' && request.body.inGame) { started.resolve(); await pending.promise; }
  };
  const enabling = f.service.setEnabled(true);
  await started.promise;
  const disabling = f.service.setEnabled(false);
  pending.resolve();
  await Promise.all([enabling, disabling]);
  assert.deepEqual(f.presence.map(request => request.body.inGame), [true, false]);
  assert.deepEqual(f.presence[1].body, { status: null, inGame: false, inGameSource: 'overlay' });
  await f.tick();
  assert.equal(f.presence.length, 2);
  await f.service.setEnabled(true);
  assert.equal(f.presence.at(-1).body.inGame, true);
  await f.service.dispose();
  assert.equal(f.presence.at(-1).body.inGame, false);
  const count = f.presence.length;
  await f.tick();
  await f.service.setEnabled(true);
  assert.equal(f.presence.length, count, 'Disposal permanently stops the heartbeat');
});

test('temporary account restoration failures retry without opening the market window', async t => {
  const f = fixture(t, 'remembered-token');
  let failures = 1;
  f.override = request => request.route === 'me' && failures-- > 0
    ? response({ error: { code: 'TEMPORARY_ERROR' } }, 503) : null;
  assert.equal((await f.service.setEnabled(true)).ok, false);
  assert.equal(f.presence.length, 0);
  await f.tick();
  assert.equal(f.service.snapshot().authenticated, true);
  assert.equal(f.presence.length, 1);
  assert.equal(f.presence[0].body.inGame, true);
  await f.tick();
  assert.equal(f.presence.length, 2);
});

test('logout waits for presence writes before revocation and a new sign-in restarts the heartbeat', async t => {
  const f = fixture(t, 'remembered-token');
  await f.service.setEnabled(true);
  const started = deferred(), pending = deferred();
  f.override = async request => {
    if (request.route === 'me/availability' && request.body.inGame) { started.resolve(); await pending.promise; }
  };
  t.mock.timers.tick(60000);
  await started.promise;
  const logout = f.service.logout();
  assert.equal(f.service.snapshot().authenticated, false);
  assert.equal(f.requests.some(request => request.route === 'auth/sign-out'), false);
  pending.resolve();
  await logout;
  assert.equal(f.requests.at(-1).route, 'auth/sign-out');
  const count = f.presence.length;
  await f.tick();
  assert.equal(f.presence.length, count);
  f.override = null;
  assert.equal((await f.login()).ok, true);
  await f.service.presenceWork;
  assert.equal(f.presence.at(-1).body.inGame, true);
  assert.equal(f.presence.at(-1).headers.Authorization, 'Bearer private-token');
});

test('expired sessions cancel further heartbeats', async t => {
  const f = fixture(t, 'expired-token');
  f.override = request => request.route === 'me/availability'
    ? response({ error: { code: 'UNAUTHORIZED' } }, 401) : null;
  await f.service.setEnabled(true);
  await f.service.presenceWork;
  assert.equal(f.service.snapshot().authenticated, false);
  assert.equal(f.saved, null);
  const count = f.presence.length;
  await f.tick();
  assert.equal(f.presence.length, count);
});
