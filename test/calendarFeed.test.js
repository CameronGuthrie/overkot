const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { brotliCompressSync } = require('node:zlib');
const { CalendarFeed, CHECK_INTERVAL } = require('../src/modules/calendarFeed');
const data = require('../src/data/calendar.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-calendar-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  let clock = 100000;
  const updated = structuredClone(data); updated.weapons[0][1] += 5;
  const bytes = Buffer.from(JSON.stringify(updated));
  const wire = brotliCompressSync(bytes);
  const manifest = { schema: 1, sha256: hash(bytes), bytes: bytes.length, downloadBytes: wire.length, url: `objects/${hash(wire)}.json.br` };
  return { cacheDir, url: 'https://calendar.example/manifest.json', bundledData: data, now: () => clock, advance: () => { clock += CHECK_INTERVAL; }, updated, bytes, wire, manifest };
}

test('downloads once, verifies both hashes, persists, and uses conditional manifest checks', async t => {
  const f = fixture(t); const requests = [];
  const http = { get: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('.br')) return { data: f.wire };
    if (options.headers['If-None-Match']) return { status: 304 };
    return { status: 200, data: f.manifest, headers: { etag: 'calendar-v2' } };
  } };
  const feed = new CalendarFeed({ ...f, http });
  assert.equal(requests.length, 0, 'Disabled calendar must not fetch');
  const concurrent = await Promise.all([feed.refresh(), feed.refresh()]);
  assert.deepEqual(concurrent, [true, true]);
  assert.equal(requests.length, 2);
  assert.deepEqual(feed.data, f.updated);
  await feed.refresh(); assert.equal(requests.length, 2);
  const restored = new CalendarFeed({ ...f, http });
  assert.deepEqual(restored.data, f.updated);
  await restored.refresh(); assert.equal(requests.length, 2);
  f.advance(); await restored.refresh();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.headers['If-None-Match'], 'calendar-v2');
});

test('matching bundled hash costs only the small manifest', async t => {
  const f = fixture(t); let count = 0;
  const feed = new CalendarFeed({ ...f, http: { get: async () => {
    count++; return { status: 200, data: { ...f.manifest, sha256: hash(JSON.stringify(data)) } };
  } } });
  assert.equal(await feed.refresh(), false);
  assert.equal(count, 1);
});

test('offline and corrupt updates retain working data and back off across restarts', async t => {
  const f = fixture(t); let count = 0;
  const http = { get: async url => {
    count++;
    return url.endsWith('.br') ? { data: Buffer.alloc(f.wire.length) } : { status: 200, data: f.manifest };
  } };
  const feed = new CalendarFeed({ ...f, http });
  assert.equal(await feed.refresh(), false);
  assert.deepEqual(feed.data, data);
  const restored = new CalendarFeed({ ...f, http });
  await restored.refresh(); assert.equal(count, 2);
  f.advance();
  restored.http = { get: async () => { throw new Error('offline'); } };
  assert.equal(await restored.refresh(), false);
  assert.deepEqual(restored.data, data);
});

test('rejects malformed schedules even when the published hashes match', async t => {
  const f = fixture(t);
  const invalid = structuredClone(data); invalid.encounters.days[0] = '7'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(invalid)); const wire = brotliCompressSync(bytes);
  const manifest = { schema: 1, sha256: hash(bytes), bytes: bytes.length, downloadBytes: wire.length, url: `objects/${hash(wire)}.json.br` };
  const feed = new CalendarFeed({ ...f, http: { get: async url => url.endsWith('.br') ? { data: wire } : { status: 200, data: manifest } } });
  assert.equal(await feed.refresh(), false);
  assert.deepEqual(feed.data, data);
});
