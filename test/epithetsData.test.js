'use strict';
process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EpithetsData, FEED_URL, CHECK_INTERVAL, MAX_BYTES, projectEpithets, validateTitleCatalog,
  validTitleCatalog, getBundledTitleCatalog } = require('../src/modules/epithetsData');
const { epithets, epithet } = require('./fixtures/title-inventory');
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function dir(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-epithets-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
function response(data = epithets(), etag = 'titles-1') {
  return { status: 200, headers: { etag }, data: Buffer.from(JSON.stringify(data)) };
}

test('projects only enabled titles and needed display/progress fields from the pipeline export', () => {
  const source = epithets(), disabled = epithet('DisabledTitle', 'Disabled', 5);
  disabled.challenge.enabled = false; source[disabled.internalId] = disabled;
  const catalog = projectEpithets(source);
  assert.equal(catalog.schema, 1);
  assert.equal(catalog.titles.length, 3);
  assert.equal(validTitleCatalog(catalog), true);
  assert.deepEqual(catalog.titles[0], { id: 'FlavourItems.CogahTitle', name: 'Of The Sleeve',
    description: 'Complete 10 actions.', itemType: '/SF/Types/Items/Titles/CogahTitle',
    challengeName: 'CogahTitleChallenge', challengePath: '/SF/Types/Challenges/Titles/CogahTitleChallenge',
    legacyName: null, target: 10 });
  assert.deepEqual(validateTitleCatalog(catalog), catalog);
  catalog.titles[0].privateField = 'omit';
  assert.equal(validateTitleCatalog(catalog).titles[0].privateField, undefined);
  assert.equal(validTitleCatalog(getBundledTitleCatalog()), true, 'Source development has the release catalogue without private AWS access');
});

test('rejects invalid catalog paths, counts, duplicates and oversized content', () => {
  const mutate = callback => { const source = epithets(); callback(source[Object.keys(source)[0]], source); return source; };
  for (const value of [null, [], {}, mutate(row => { row.internalId = 'different'; }),
    mutate(row => { row.itemType = '/SF/Types/Items/Titles/../Title'; }),
    mutate(row => { row.challenge.name = 'not/the/name'; }),
    mutate(row => { row.challenge.path = '/SF/Types/Challenges/Titles/Different'; }),
    mutate(row => { row.challenge.requiredCount = 0; }), mutate(row => { row.challenge.requiredCount = 0.5; }),
    mutate(row => { row.challenge.requiredCount = Number.MAX_SAFE_INTEGER + 1; }),
    mutate(row => { row.challenge.enabled = 'true'; }), mutate(row => { row.challenge.legacyName = {}; }),
    mutate(row => { row.challenge.text = 'x'.repeat(4001); }), mutate(row => { row.value = ' '; })]) {
    assert.throws(() => projectEpithets(value));
  }
  const duplicate = projectEpithets(epithets()); duplicate.titles.push(duplicate.titles[0]);
  assert.equal(validTitleCatalog(duplicate), false);
  assert.throws(() => validateTitleCatalog(duplicate));
  const large = { schema: 1, titles: Array(1025).fill(projectEpithets(epithets()).titles[0]) };
  assert.equal(validTitleCatalog(large), false);
});

test('downloads through one main-process GET, deduplicates concurrent refresh and validates request bounds', async t => {
  const calls = [], cacheDir = dir(t);
  let finish;
  const feed = new EpithetsData({ cacheDir, now: () => 1000, http: { get(url, options) {
    calls.push({ url, options }); return new Promise(resolve => { finish = resolve; });
  } } });
  assert.equal(await feed.initialize(), null);
  const first = feed.refresh(), second = feed.refresh();
  assert.equal(first, second); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, FEED_URL);
  assert.equal(calls[0].options.maxRedirects, 0);
  assert.equal(calls[0].options.maxContentLength, MAX_BYTES);
  assert.equal(calls[0].options.responseType, 'arraybuffer');
  assert.equal(calls[0].options.validateStatus(200), true);
  assert.equal(calls[0].options.validateStatus(302), false);
  finish(response()); assert.equal(await first, true);
  assert.deepEqual(feed.getCatalog(), projectEpithets(epithets()));
  assert.equal(await feed.refresh(), false); assert.equal(calls.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'epithets.json'), 'utf8'));
  assert.equal(saved.sha256, sha(saved.data));
  assert.equal(saved.nextCheck, 1000 + CHECK_INTERVAL);
});

test('verified cache survives offline restart and revalidates with its ETag after six hours', async t => {
  const cacheDir = dir(t); let now = 1000, calls = 0;
  const first = new EpithetsData({ cacheDir, now: () => now, http: { get: async () => response() } });
  await first.refresh();
  const second = new EpithetsData({ cacheDir, now: () => now, http: { get: async (_url, options) => {
    calls++; assert.deepEqual(options.headers, { 'If-None-Match': 'titles-1' });
    return { status: 304, headers: {}, data: Buffer.alloc(0) };
  } } });
  assert.deepEqual(second.getCatalog(), first.getCatalog());
  assert.equal(await second.refresh(), false); assert.equal(calls, 0);
  now += CHECK_INTERVAL;
  assert.equal(await second.refresh(), false); assert.equal(calls, 1);
  assert.deepEqual(second.getCatalog(), first.getCatalog());
});

test('an explicit data check bypasses the scheduled interval and shares an existing request', async t => {
  const cacheDir = dir(t); let calls = 0;
  const feed = new EpithetsData({ cacheDir, now: () => 1000, http: { get: async () => { calls++; return response(); } } });
  await feed.refresh();
  assert.equal(await feed.refresh(), false); assert.equal(calls, 1);
  assert.equal(await feed.refresh({ force: true }), false); assert.equal(calls, 2);
});

test('bad remote responses and unavailable public feed retain the beta snapshot and throttle retries', async t => {
  const cacheDir = dir(t), data = projectEpithets(epithets()), messages = [];
  let now = 0, calls = 0;
  const feed = new EpithetsData({ cacheDir, bundledData: data, now: () => now, log: value => messages.push(value),
    http: { get: async () => { calls++; throw new Error('404'); } } });
  assert.deepEqual(await feed.initialize(), data);
  assert.equal(await feed.refresh(), false);
  assert.deepEqual(feed.getCatalog(), data);
  assert.equal(await feed.refresh(), false); assert.equal(calls, 1);
  now += CHECK_INTERVAL; assert.equal(await feed.refresh(), false); assert.equal(calls, 2);
  assert.equal(messages.length, 2);
  const restarted = new EpithetsData({ cacheDir, bundledData: data, now: () => now,
    http: { get: async () => { throw new Error('should remain throttled'); } } });
  assert.deepEqual(restarted.getCatalog(), data);
  assert.equal(await restarted.refresh(), false);
});

test('invalid and oversized downloads cannot replace a validated cache', async t => {
  const cacheDir = dir(t); let now = 0, next = response();
  const feed = new EpithetsData({ cacheDir, now: () => now, http: { get: async () => next } });
  assert.equal(await feed.refresh(), true);
  const good = structuredClone(feed.getCatalog());
  for (const bad of [{ status: 200, data: Buffer.from('{bad'), headers: {} }, response({}),
    { status: 200, data: Buffer.alloc(MAX_BYTES + 1), headers: {} },
    { status: 302, data: Buffer.from('{}'), headers: {} }]) {
    now += CHECK_INTERVAL; next = bad;
    assert.equal(await feed.refresh(), false);
    assert.deepEqual(feed.getCatalog(), good);
    const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'epithets.json'), 'utf8'));
    assert.equal(saved.sha256, sha(good));
  }
});

test('a malformed cache, wrong source URL or edited checksum cannot become runtime data', t => {
  const cacheDir = dir(t), filename = path.join(cacheDir, 'epithets.json'), data = projectEpithets(epithets());
  for (const saved of [{ url: FEED_URL, data, sha256: '0'.repeat(64) },
    { url: 'https://different.invalid/epithets.json', data, sha256: sha(data) },
    { url: FEED_URL, data: { schema: 1, titles: [] }, sha256: sha({ schema: 1, titles: [] }) }]) {
    fs.writeFileSync(filename, JSON.stringify(saved));
    assert.equal(new EpithetsData({ cacheDir }).getCatalog(), null);
    assert.deepEqual(new EpithetsData({ cacheDir, bundledData: data }).getCatalog(), data);
  }
  fs.writeFileSync(filename, 'x'.repeat(MAX_BYTES + 1));
  assert.equal(new EpithetsData({ cacheDir }).getCatalog(), null);
});

test('cache scheduling is bounded even if its clock or nextCheck was corrupted', async t => {
  const cacheDir = dir(t), data = projectEpithets(epithets());
  fs.writeFileSync(path.join(cacheDir, 'epithets.json'), JSON.stringify({ url: FEED_URL, data,
    sha256: sha(data), nextCheck: 9999999999999999, etag: 'x'.repeat(1025) }));
  let now = 0, headers;
  const feed = new EpithetsData({ cacheDir, now: () => now, http: { get: async (_url, options) => {
    headers = options.headers; return response();
  } } });
  assert.equal(feed.state.nextCheck, CHECK_INTERVAL);
  now += CHECK_INTERVAL; await feed.refresh(); assert.deepEqual(headers, {});
});

test('a 304 without a downloaded catalog is rejected and does not create an empty catalog', async t => {
  const cacheDir = dir(t), logs = [];
  const feed = new EpithetsData({ cacheDir, log: value => logs.push(value),
    http: { get: async () => ({ status: 304, headers: {}, data: Buffer.alloc(0) }) } });
  assert.equal(await feed.refresh(), false);
  assert.equal(feed.getCatalog(), null);
  assert.match(logs[0], /no cached catalog/);
});

test('HTTPS and loopback test feeds are permitted while credentials and insecure remote URLs are rejected', t => {
  const cacheDir = dir(t);
  for (const url of ['https://example.invalid/epithets.json', 'http://127.0.0.1:5000/titles', 'http://[::1]:5000/titles']) {
    assert.doesNotThrow(() => new EpithetsData({ cacheDir, url }));
  }
  for (const url of ['http://example.invalid/titles', 'https://user:secret@example.invalid/titles', 'file:///C:/titles']) {
    assert.throws(() => new EpithetsData({ cacheDir, url }), /HTTPS/);
  }
});

test('a cache write failure preserves a successfully downloaded catalog in memory', async t => {
  const cacheDir = dir(t), blocker = path.join(cacheDir, 'file'), messages = [];
  fs.writeFileSync(blocker, 'file');
  const feed = new EpithetsData({ cacheDir: blocker, log: value => messages.push(value), http: { get: async () => response() } });
  assert.equal(await feed.refresh(), true);
  assert.deepEqual(feed.getCatalog(), projectEpithets(epithets()));
  assert.ok(messages.some(value => /cache could not be saved/.test(value)));
});
