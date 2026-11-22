const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageAnalytics } = require('../src/modules/usageAnalytics');
const { validateBatch } = require('../firebase/analytics/events');

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-usage-'));
  let time = 1_800_000_000_000;
  const sent = [];
  const options = { enabled: true, directory, version: '0.0.9', now: () => time, os: 'win32',
    send: async batch => sent.push(structuredClone(batch)), ...overrides };
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); });
  return { options, sent, advance: value => { time += value; }, create: () => new UsageAnalytics(options) };
}

test('usage contains only allowed event dimensions, and rejects secrets or extra fields at the relay', async t => {
  const f = fixture(t), usage = f.create();
  assert.equal(usage.track('feature_open', { feature: 'map', accountId: 'private', nonce: 'secret' }), true);
  assert.equal(usage.track('feature_use', { action: 'raw_inventory' }), false);
  await usage.flush();
  assert.ok(validateBatch(f.sent[0], f.options.now()));
  assert.doesNotMatch(JSON.stringify(f.sent[0]), /private|secret|nonce|accountId/);
  const extra = structuredClone(f.sent[0]);
  extra.events[0].params.playerName = 'Envoy';
  assert.equal(validateBatch(extra, f.options.now()), null);
  extra.events[0].params = { feature: 'map' };
  extra.user_id = 'game-account';
  assert.equal(validateBatch(extra, f.options.now()), null);
});

test('offline batches survive restart with stable IDs and retry backoff', async t => {
  let offline = true;
  const f = fixture(t, { send: async () => { if (offline) throw new Error('offline'); } });
  const first = f.create();
  first.track('app_launch');
  await first.flush();
  const batch = structuredClone(first.batch), clientId = first.clientId;
  first.track('feature_open', { feature: 'map' });
  const restored = f.create();
  assert.equal(restored.clientId, clientId);
  assert.deepEqual(restored.batch, batch);
  assert.equal(restored.queue.length, 1);
  offline = false;
  await restored.flush();
  assert.equal(restored.batch, null);
  assert.equal(restored.queue.length, 1);
  assert.equal(f.create().batch, null);
});

test('in-flight delivery never loses events queued while sending', async t => {
  let release;
  const f = fixture(t, { send: () => new Promise(resolve => { release = resolve; }) });
  const usage = f.create();
  usage.track('app_launch');
  const first = usage.flush();
  await Promise.resolve();
  usage.track('feature_open', { feature: 'calendar' });
  assert.equal(usage.flush(), first);
  release();
  await first;
  assert.equal(usage.queue.length, 1);
  assert.equal(usage.queue[0].name, 'feature_open');
});

test('queue is bounded, old events expire, and hidden/tray time is not engagement', async t => {
  let active = false;
  const f = fixture(t, { isActive: () => active }), usage = f.create();
  usage.track('app_launch');
  f.advance(10_000);
  usage.track('app_running');
  assert.equal(usage.queue.at(-1).engagement_time_msec, 0);
  active = true;
  f.advance(10_000);
  usage.track('feature_open', { feature: 'map' });
  assert.equal(usage.queue.at(-1).engagement_time_msec, 10_000);
  for (let i = 0; i < 220; i++) usage.track('app_running');
  assert.equal(usage.queue.length, 200);
  f.advance(49 * 3600_000);
  await usage.flush();
  assert.equal(usage.queue.length, 0);
  assert.equal(f.sent.length, 0);
});

test('development mode performs no collection, storage or sending', async t => {
  const f = fixture(t, { enabled: false }), usage = f.create();
  usage.start(); usage.track('app_launch'); usage.stop(); await usage.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(fs.existsSync(usage.file), false);
});
