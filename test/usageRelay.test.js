const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { validateBatch } = require('../firebase/analytics/events');

function relay() {
  let now = 1_800_000_000_000, ok = true, transactions = 0;
  const sent = [], documents = new Map();
  const ref = key => ({ key, update: async patch => documents.set(key, { ...documents.get(key), ...patch }) });
  const db = { doc: ref, runTransaction: async fn => {
    transactions++;
    const writes = [];
    const result = await fn({ get: async target => ({ exists: documents.has(target.key), data: () => documents.get(target.key) }),
      set: (target, value) => writes.push([target.key, value]) });
    for (const [key, value] of writes) documents.set(key, value);
    return result;
  } };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../firebase/analytics/index'), 'utf8'), {
    exports, URL, AbortSignal, Date: { now: () => now },
    fetch: async (url, options) => { sent.push(JSON.parse(options.body)); return { ok }; },
    require(name) {
      if (name === 'firebase-functions/v2/https') return { onCall: (_options, fn) => fn,
        HttpsError: class extends Error { constructor(code, message) { super(message); this.code = code; } } };
      if (name === 'firebase-functions/params') return { defineSecret: () => ({ value: () => 'server-secret-fixture' }) };
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/firestore') return { getFirestore: () => db, Timestamp: { fromMillis: n => n } };
      if (name === './events') return { validateBatch };
      return require(name);
    },
  });
  const request = () => ({ auth: { uid: 'fixture-user' }, rawRequest: { ip: '127.0.0.1' }, data: {
    client_id: '123456.1800000000', batch_id: randomUUID(), app_version: '0.0.9', os: 'win32',
    events: [{ name: 'app_launch', params: {}, session_id: 1800000000, timestamp: now, engagement_time_msec: 0 }],
  } });
  return { call: exports.collectUsage, request, sent, documents, transactions: () => transactions,
    advance: ms => { now += ms; }, fail: () => { ok = false; }, recover: () => { ok = true; } };
}

test('relay rejects unauthenticated or unapproved data before any database/network access', async () => {
  const r = relay(), request = r.request();
  await assert.rejects(r.call({ ...request, auth: null }), { code: 'unauthenticated' });
  request.data.events[0].params = { inventory: 'private' };
  await assert.rejects(r.call(request), { code: 'invalid-argument' });
  request.data.events[0] = { ...request.data.events[0], name: 'feature_open', params: null };
  await assert.rejects(r.call(request), { code: 'invalid-argument' });
  const oversized = r.request();
  oversized.rawRequest.rawBody = Buffer.alloc(16_385);
  await assert.rejects(r.call(oversized), { code: 'invalid-argument' });
  assert.equal(r.transactions(), 0);
  assert.equal(r.documents.size, 0);
  assert.equal(r.sent.length, 0);
});

test('relay forwards once per batch and stores only expiring receipts/counters', async () => {
  const r = relay(), request = r.request();
  await r.call(request); await r.call(request);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].client_id, request.data.client_id);
  assert.equal(r.sent[0].events[0].params.session_id, request.data.events[0].session_id);
  assert.equal(r.sent[0].consent.ad_personalization, 'DENIED');
  const stored = JSON.stringify([...r.documents]);
  assert.doesNotMatch(stored, /127\.0\.0\.1|fixture-user|client_id|app_launch|server-secret/);
  assert.ok([...r.documents.values()].every(v => v.expiresAt > 0));
});

test('relay enforces batch rate limits and expires the window', async () => {
  const r = relay();
  for (let i = 0; i < 4; i++) await r.call(r.request());
  await assert.rejects(r.call(r.request()), { code: 'resource-exhausted' });
  r.advance(60_001);
  await r.call(r.request());
  assert.equal(r.sent.length, 5);
});

test('one warm instance bounds Firestore transactions over a rolling minute, including receipt retries', async () => {
  const r = relay(), request = r.request();
  await r.call(request);
  r.advance(30_000);
  await Promise.all(Array.from({ length: 59 }, () => r.call(request)));
  assert.equal(r.transactions(), 60);
  await assert.rejects(r.call(request), { code: 'resource-exhausted' });
  r.advance(29_999);
  await assert.rejects(r.call(request), { code: 'resource-exhausted' });
  assert.equal(r.transactions(), 60, 'excess valid requests incur no Firestore work');
  r.advance(1);
  await r.call(request);
  await assert.rejects(r.call(request), { code: 'resource-exhausted' });
  assert.equal(r.transactions(), 61, 'only the oldest admission expired');
  assert.equal(r.sent.length, 1);
});

test('failed upstream delivery is retryable after the lease without recording success', async () => {
  const r = relay(), request = r.request();
  r.fail();
  await assert.rejects(r.call(request), { code: 'unavailable' });
  await assert.rejects(r.call(request), { code: 'resource-exhausted' });
  r.advance(60_001); r.recover();
  await r.call(request); await r.call(request);
  assert.equal(r.sent.length, 2);
});
