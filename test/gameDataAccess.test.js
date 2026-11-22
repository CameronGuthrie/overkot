'use strict';
process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { GameDataAccess, MANIFEST_URL, DATA_ORIGIN, protectedUrl } = require('../src/modules/gameDataAccess');
const { imageUrl, IMAGE_BASE } = require('../src/modules/gameDataImages');
const path = '/SF/Interface/Graphics/Art.png';
const png = Buffer.from([137,80,78,71,13,10,26,10,0]);

function fixture(t, get = async () => ({ data: {} }), options = {}) {
  let now = 100_000, grants = 0;
  const account = new EventEmitter(); account.token = 'native-account-a';
  account.snapshot = () => ({ signedIn: !!account.token });
  account.request = async (route, options) => {
    assert.equal(route, 'data-authorization'); assert.equal(options.method, 'POST');
    assert.equal(options.token, account.token); assert.deepEqual(options.body, {});
    grants++;
    return { accessToken: `header.payload.signature${grants}`, tokenType: 'Bearer', expiresIn: 300,
      expiresAt: new Date(now + 300_000).toISOString(), scope: 'overlay:read' };
  };
  const client = new GameDataAccess({ account, http: { get }, now: () => now, ...options });
  t.after(() => client.dispose());
  return { client, account, grants: () => grants, advance: ms => { now += ms; } };
}

test('authorization is deduplicated, refreshed early and never attached to external fixtures', async t => {
  const calls = [];
  const f = fixture(t, async (url, options) => { calls.push({ url, options }); return { data: {} }; });
  await Promise.all([f.client.get(MANIFEST_URL), f.client.get(MANIFEST_URL)]);
  assert.equal(f.grants(), 1); assert.match(calls[0].options.headers.Authorization, /^Bearer header/);
  assert.equal(calls[0].options.maxRedirects, 0);
  f.advance(241_000); await f.client.get(MANIFEST_URL); assert.equal(f.grants(), 2);
  await f.client.get('http://127.0.0.1:8000/fixture.json');
  assert.equal(calls.at(-1).options.headers, undefined);
  for (const url of [DATA_ORIGIN + '.evil.test/protected/overlay/v2/manifest.json', DATA_ORIGIN + '/protected/files/secret.json']) assert.equal(protectedUrl(url), false);
});

test('a 401 renews once and signed-out requests cannot use a legacy public fallback', async t => {
  let calls = 0;
  const f = fixture(t, async url => {
    assert.equal(url, MANIFEST_URL); calls++;
    if (calls === 1) throw Object.assign(new Error('Expired'), { response: { status: 401 } });
    return { data: {} };
  });
  await f.client.get(MANIFEST_URL); assert.equal(f.grants(), 2); assert.equal(calls, 2);
  f.account.token = null; f.account.emit('changed');
  await assert.rejects(f.client.get(MANIFEST_URL), { code: 'DATA_SIGN_IN_REQUIRED' });
  assert.equal(calls, 2);
});

for (const nextIdentity of ['native-account-b', null]) test(`a cached token cannot cross the authorization await when switching to ${nextIdentity || 'signed out'}`, async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { data: { private: 'old-account' } }; });
  await f.client.token();
  assert.equal(f.grants(), 1);
  const pending = f.client.get(MANIFEST_URL);
  // token() returned a cached A token, but the get continuation has not run.
  f.account.token = nextIdentity; f.account.emit('changed');
  await assert.rejects(pending, { code: 'DATA_ACCOUNT_CHANGED' });
  assert.equal(calls, 0, 'no stale bearer is sent after the account change');
});

test('logout discards in-flight authorization and artwork before either can reach a renderer', async t => {
  let complete;
  const f = fixture(t, () => new Promise(resolve => { complete = resolve; }));
  const response = f.client.imageResponse({ url: IMAGE_BASE + path, method: 'GET' });
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  f.account.token = null; f.account.emit('changed'); complete({ data: png });
  assert.equal((await response).status, 502); assert.equal(f.client.images.size, 0);
  assert.equal((await f.client.imageResponse({ url: IMAGE_BASE + path })).status, 401);
  let finish;
  f.account.token = 'native-account-b'; f.account.emit('changed');
  f.account.request = () => new Promise(resolve => { finish = resolve; });
  const token = f.client.token(); await new Promise(resolve => setImmediate(resolve));
  f.account.token = null; f.account.emit('changed');
  finish({}); await assert.rejects(token, { code: 'DATA_ACCOUNT_CHANGED' });
});

test('artwork protocol validates paths and file magic, caches bytes and rebases Market proxy URLs', async t => {
  let calls = 0, body = png;
  const f = fixture(t, async url => { calls++; assert.equal(url, `${DATA_ORIGIN}/protected/images${path}`); return { data: body }; });
  assert.equal(imageUrl('/api/v1/data-assets' + path), IMAGE_BASE + path);
  assert.equal(imageUrl('https://avakot.market/api/v1/data-assets' + path), IMAGE_BASE + path);
  assert.equal((await f.client.imageResponse({ url: IMAGE_BASE + path })).headers.get('content-type'), 'image/png');
  assert.equal((await f.client.imageResponse({ url: IMAGE_BASE + path, method: 'HEAD' })).status, 200); assert.equal(calls, 1);
  for (const url of [IMAGE_BASE + '/SF/Secrets/Test.png', IMAGE_BASE + '/SF/Interface/Graphics/../Test.png', IMAGE_BASE + path + '?token=bad', 'overkot-game-data://images.evil.test' + path]) assert.equal((await f.client.imageResponse({ url })).status, 404);
  f.account.token = 'other-account'; f.account.emit('changed'); body = Buffer.from('<svg/>');
  assert.equal((await f.client.imageResponse({ url: IMAGE_BASE + path })).status, 502);
});

test('a community icon host serves signed-out users and receives no credentials or redirects', async t => {
  const imageBase = 'https://icons.example/images';
  const requests = [];
  const f = fixture(t, async (url, options) => { requests.push({ url, options }); return { data: png }; }, { imageBase });
  for (const token of [null, 'native-account-b']) {
    f.account.token = token;
    f.account.emit('changed');
    const response = await f.client.imageResponse({ url: imageUrl(path) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.equal(requests.at(-1).url, imageBase + path);
    assert.equal(requests.at(-1).options.maxRedirects, 0);
    assert.deepEqual(requests.at(-1).options.headers, { 'Accept-Encoding': 'identity' });
  }
  assert.equal(f.grants(), 0);
  assert.equal((await f.client.imageResponse({ url: IMAGE_BASE + path + '?other' })).status, 404);
  assert.equal(requests.length, 2);
});
