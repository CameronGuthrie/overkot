'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const accountA = 'abcdef0123456789abcdef01';
const accountB = 'abcdef0123456789abcdef02';
const minute = 60_000;
const profile = (account, seconds) => ({
  Results: [{ AccountId: { $oid: account }, DisplayName: 'Envoy' }],
  Stats: { TimePlayedSec: seconds },
});
const ok = data => ({ status: 200, data });

function fixture(t, respond) {
  let now = Date.UTC(2026, 0, 1);
  const requests = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(axios, 'get', async (url, options) => {
    requests.push({ url, params: options.params });
    return respond(options.params.playerId, requests.length, now);
  });
  const modulePath = require.resolve('../src/modules/apiClient');
  delete require.cache[modulePath];
  const { ApiClient } = require(modulePath);
  const client = canReadProfile => new ApiClient({ canReadProfile });
  const fixtureAccount = account => account === accountA || account === accountB;
  return { first: client(fixtureAccount), second: client(fixtureAccount), client, requests, advance: ms => { now += ms; } };
}

function rateLimited(retryAfter) {
  const error = new Error('Too many requests');
  error.response = { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } };
  return error;
}

test('an unconfirmed account cannot start a lookup or read a cached profile', async t => {
  const f = fixture(t, (account, count) => ok(profile(account, count)));
  let current = accountA;
  const active = f.client(id => id === current);
  const queued = Promise.resolve().then(() => active.fetchProfile(accountA, { force: true }));
  current = null;
  assert.equal(await queued, null);
  current = accountB;
  assert.equal(await active.fetchProfile(accountA), null);
  assert.equal(await f.client().fetchProfile(accountB), null);
  assert.equal(await f.client(() => { throw new Error('Login unavailable'); }).fetchProfile(accountB), null);
  assert.equal(f.requests.length, 0);

  assert.deepEqual(await active.fetchProfile(accountB.toUpperCase()), profile(accountB, 1));
  current = accountA;
  assert.equal(await active.fetchProfile(accountB), null);
  assert.equal(active.getProfileFetchedAt(accountB), null);
  assert.equal(await active.fetchProfile(accountB, { force: true }), null);
  assert.deepEqual(f.requests.map(request => request.params.playerId), [accountB]);
});

test('a response from a replaced session cannot populate the cache for a later login on the same account', async t => {
  let finish, generation = 1;
  const f = fixture(t, (account, count) => count === 1
    ? new Promise(resolve => { finish = () => resolve(ok(profile(account, 10))); })
    : ok(profile(account, 20)));
  const old = f.client(id => id === accountA && generation === 1);
  const next = f.client(id => id === accountA && generation === 2);
  const pending = old.fetchProfile(accountA);
  generation = 2;
  const joined = next.fetchProfile(accountA);
  finish();
  assert.deepEqual(await Promise.all([pending, joined]), [null, null]);
  assert.equal(next.getProfileFetchedAt(accountA), null);
  assert.deepEqual(await next.fetchProfile(accountA), profile(accountA, 20));
  assert.equal(f.requests.length, 2);
});

test('a caller joining an in-flight profile rechecks its own session before delivery', async t => {
  let finish, active = true;
  const f = fixture(t, account => new Promise(resolve => { finish = () => resolve(ok(profile(account, 10))); }));
  const reader = f.client(id => active && id === accountA);
  const owner = f.first.fetchProfile(accountA), joined = reader.fetchProfile(accountA);
  active = false;
  assert.equal(await reader.fetchProfile(accountA, { force: true }), null);
  finish();
  assert.deepEqual(await owner, profile(accountA, 10));
  assert.equal(await joined, null);
  assert.equal(f.requests.length, 1);
});

test('a 429 for a signed-out account still blocks the newly signed-in account', async t => {
  let finish, current = accountA;
  const f = fixture(t, (account, count) => count === 1
    ? new Promise((_, reject) => { finish = () => reject(rateLimited('3600')); })
    : ok(profile(account, 20)));
  const reader = f.client(id => id === current);
  const pending = reader.fetchProfile(accountA);
  current = accountB;
  finish();
  assert.equal(await pending, null);
  f.advance(60 * minute - 1);
  assert.equal(await reader.fetchProfile(accountB, { force: true }), null);
  assert.equal(f.requests.length, 1);
  f.advance(1);
  assert.deepEqual(await reader.fetchProfile(accountB), profile(accountB, 20));
});

test('clients share one in-flight GET and reuse its response for 15 minutes per account', async t => {
  let finish;
  const f = fixture(t, (account, count) => count === 1
    ? new Promise(resolve => { finish = () => resolve(ok(profile(accountA, 10))); })
    : ok(profile(account, 20)));
  const reads = [f.first.fetchProfile(accountA), f.second.fetchProfile(accountA.toUpperCase(), { force: true })];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests, [{ url: 'https://api.soulframe.com/cdn/getProfileViewingData.php', params: { playerId: accountA } }]);
  finish();
  assert.deepEqual(await Promise.all(reads), [profile(accountA, 10), profile(accountA, 10)]);
  const fetchedAt = Date.now();
  assert.equal(f.second.getProfileFetchedAt(accountA.toUpperCase()), fetchedAt);
  f.advance(15 * minute - 1);
  assert.deepEqual(await f.second.fetchProfile(accountA), profile(accountA, 10));
  assert.equal(f.requests.length, 1);
  assert.equal(f.first.getProfileFetchedAt(accountA), fetchedAt);
  f.advance(1);
  assert.deepEqual(await f.second.fetchProfile(accountA), profile(accountA, 20));
  assert.equal(f.requests.length, 2);
  assert.equal(f.first.getProfileFetchedAt(accountA), Date.now());
});

test('different accounts can complete in reverse order and keep separate cached profiles', async t => {
  const pending = new Map();
  const f = fixture(t, (account, count) => count <= 2
    ? new Promise(resolve => pending.set(account, resolve))
    : ok(profile(account, 99)));
  const first = f.first.fetchProfile(accountA), second = f.second.fetchProfile(accountB);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 2);
  pending.get(accountB)(ok(profile(accountB, 20)));
  assert.deepEqual(await second, profile(accountB, 20));
  pending.get(accountA)(ok(profile(accountA, 10)));
  assert.deepEqual(await first, profile(accountA, 10));
  assert.deepEqual(await f.first.fetchProfile(accountB), profile(accountB, 20));
  assert.deepEqual(await f.second.fetchProfile(accountA), profile(accountA, 10));
  assert.equal(f.requests.length, 2);
});

test('successful forced lookup replaces cached data, and failed force observes the one-minute retry delay', async t => {
  const f = fixture(t, (account, count) => {
    if (count === 3) throw new Error('Network unavailable');
    return ok(profile(account, count));
  });
  assert.deepEqual(await f.first.fetchProfile(accountA), profile(accountA, 1));
  f.advance(minute);
  assert.deepEqual(await f.second.fetchProfile(accountA, { force: true }), profile(accountA, 2));
  assert.deepEqual(await f.first.fetchProfile(accountA), profile(accountA, 2));
  f.advance(minute);
  assert.equal(await f.first.fetchProfile(accountA, { force: true }), null);
  f.advance(minute - 1);
  assert.equal(await f.second.fetchProfile(accountA, { force: true }), null);
  assert.equal(f.requests.length, 3);
  f.advance(1);
  assert.deepEqual(await f.second.fetchProfile(accountA, { force: true }), profile(accountA, 4));
});

test('manual refresh reuses a recent result and requests a new profile at one minute', async t => {
  const f = fixture(t, (account, count) => ok(profile(account, count)));
  await f.first.fetchProfile(accountA);
  f.advance(minute - 1);
  assert.deepEqual(await f.second.fetchProfile(accountA, { maxAgeMs: minute }), profile(accountA, 1));
  assert.equal(f.requests.length, 1);
  f.advance(1);
  assert.deepEqual(await f.second.fetchProfile(accountA, { maxAgeMs: minute }), profile(accountA, 2));
  assert.equal(f.first.getProfileFetchedAt(accountA), Date.now());
});

for (const format of ['seconds', 'HTTP date']) {
  test('429 Retry-After in ' + format + ' applies across accounts, including forced lookups', async t => {
    const delay = 42 * minute;
    const f = fixture(t, (account, count, now) => {
      if (count === 2) throw rateLimited(format === 'seconds' ? String(delay / 1000) : new Date(now + delay).toUTCString());
      return ok(profile(account, count));
    });
    assert.deepEqual(await f.first.fetchProfile(accountA), profile(accountA, 1));
    f.advance(minute);
    assert.equal(await f.second.fetchProfile(accountA, { force: true }), null);
    assert.equal(await f.first.fetchProfile(accountA, { force: true }), null);
    f.advance(delay - 1);
    assert.equal(await f.second.fetchProfile(accountB), null);
    assert.equal(await f.second.fetchProfile(accountB, { force: true }), null);
    assert.equal(f.requests.length, 2);
    f.advance(1);
    assert.deepEqual(await f.second.fetchProfile(accountB), profile(accountB, 3));
  });
}

test('consecutive 429s without Retry-After back off across accounts', async t => {
  const f = fixture(t, (account, count) => {
    if (count < 5 || count === 6) throw rateLimited();
    return ok(profile(account, count));
  });
  assert.equal(await f.first.fetchProfile(accountA), null);
  for (const quietMinutes of [15, 30, 60, 60]) {
    const calls = f.requests.length;
    f.advance(quietMinutes * minute - 1);
    assert.equal(await f.second.fetchProfile(accountB, { force: true }), null);
    assert.equal(f.requests.length, calls);
    f.advance(1);
    await f.second.fetchProfile(accountB, { force: true });
    assert.equal(f.requests.length, calls + 1);
  }
  assert.equal(await f.first.fetchProfile(accountA), null);
  f.advance(15 * minute);
  assert.deepEqual(await f.first.fetchProfile(accountA), profile(accountA, 7), 'A success resets the next fallback interval');
});

test('a later 429 for a concurrent request cannot shorten an existing Retry-After', async t => {
  const pending = new Map();
  const f = fixture(t, (account, count) => count <= 2
    ? new Promise((_resolve, reject) => pending.set(account, reject))
    : ok(profile(account, count)));
  const a = f.first.fetchProfile(accountA), b = f.second.fetchProfile(accountB);
  await new Promise(resolve => setImmediate(resolve));
  pending.get(accountA)(rateLimited('7200'));
  assert.equal(await a, null);
  f.advance(minute);
  pending.get(accountB)(rateLimited('60'));
  assert.equal(await b, null);
  f.advance(119 * minute - 1);
  assert.equal(await f.second.fetchProfile(accountB, { force: true }), null);
  assert.equal(f.requests.length, 2);
  f.advance(1);
  assert.deepEqual(await f.first.fetchProfile(accountB), profile(accountB, 3));
});

test('a pending success on another account cannot release an active endpoint cooldown', async t => {
  let finish;
  const f = fixture(t, (account, count) => {
    if (count === 1) return new Promise(resolve => { finish = () => resolve(ok(profile(account, 10))); });
    throw rateLimited('3600');
  });
  const pending = f.first.fetchProfile(accountA);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.second.fetchProfile(accountB), null);
  finish();
  assert.deepEqual(await pending, profile(accountA, 10));
  f.advance(30 * minute);
  assert.equal(await f.second.fetchProfile(accountA, { force: true }), null);
  assert.equal(f.requests.length, 2);
});

test('malformed and mismatched 200 responses retry after a minute and never enter the success cache', async t => {
  const f = fixture(t, (account, count) => ok(count === 1 ? {} : count === 2 ? profile(accountB, 4) : profile(account, 5)));
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.equal(await f.first.fetchProfile(accountA), null);
    f.advance(minute - 1);
    assert.equal(await f.second.fetchProfile(accountA, { force: true }), null);
    assert.equal(f.requests.length, attempt);
    f.advance(1);
  }
  assert.deepEqual(await f.second.fetchProfile(accountA), profile(accountA, 5));
});
