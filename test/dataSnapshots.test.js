'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const promises = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { DataSnapshots, parseLogRecords, MAX_LOG_BYTES, MAX_LOG_RECORDS } = require('../src/modules/dataSnapshots');
const encryption = require('../src/modules/fileEncryption');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-data-snapshots-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'inventory-cache.json');
  const logPath = path.join(directory, 'EE.log');
  const service = new DataSnapshots({ cachePath, getLogPath: () => logPath, getNames: () => ({}), ...options });
  const cache = data => fs.writeFileSync(cachePath, encryption.encryptData(JSON.stringify(data), encryption.deriveCacheKey()));
  return { directory, cachePath, logPath, service, cache };
}

function sessionFixture() {
  let inventory = { PlayerLevel: 3 }, expired = false, cached = false, savedAt = 500, refreshed = 0;
  const session = { accountId: 'player-a', _running: true,
    getRawInventory: () => inventory, isNonceExpired: () => expired, isInventoryCached: () => cached,
    getInventorySavedAt: () => savedAt, getLastSuccessfulPollAt: () => cached ? 0 : savedAt,
    refreshNow: async () => { refreshed++; inventory = { PlayerLevel: 4 }; savedAt = 1000; cached = false; return { ok: true }; } };
  return { session, reads: () => refreshed, inventory: value => { inventory = value; },
    expired: value => { expired = value; }, cached: value => { cached = value; } };
}

test('invalid and inherited snapshot kinds cannot trigger source reads', async () => {
  const service = new DataSnapshots({ getLogPath: () => { throw new Error('Unexpected log read'); } });
  for (const kind of ['constructor', 'toString', '__proto__', null, {}, ['inventory']]) {
    assert.equal((await service.read(kind)).error.code, 'unknown-kind');
    assert.equal((await service.refresh(kind)).error.code, 'unknown-kind');
  }
});

test('inventory reads the existing session without sending any API request', async t => {
  const f = sessionFixture();
  const { service } = fixture(t, { getSession: () => f.session, now: () => 2000,
    getLanguage: () => 'de', getNames: (inventory, language) => ({ PlayerLevel: `${language} ${inventory.PlayerLevel}` }) });
  const result = await service.read('data-inventory');
  assert.equal(result.ok, true);
  assert.deepEqual(result.inventory, { PlayerLevel: 3 });
  assert.deepEqual(result.names, { PlayerLevel: 'de 3' });
  assert.equal(result.metadata.source, 'session');
  assert.equal(result.metadata.accountId, 'player-a');
  assert.equal(result.metadata.savedAt, 500);
  assert.equal(result.metadata.fetchedAt, 500);
  assert.equal(result.metadata.readAt, 2000);
  assert.equal(result.metadata.canRefresh, true);
  assert.equal(f.reads(), 0);
});

test('default name resolution uses local language maps without downloading data', async () => {
  const commonjs = { exports: {} };
  let calls = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/dataSnapshots.js'), 'utf8'), {
    module: commonjs, console, Date, Buffer,
    require(name) {
      if (name === './languageNames') return {
        ensureNamesForLanguage: async (language, options) => {
          calls++; assert.equal(language, 'de'); assert.equal(options.network, false);
          return { 'PendingRecipe:BromiusHelm': 'Bromius helmet' };
        },
        loadLanguageData: () => ({ '/SF/Language/Consumables/WevetSeedName': 'Wevet seed' }),
      };
      if (name.startsWith('./')) return require('../src/modules/' + name.slice(2));
      if (name === '../renderer/inventory-format') return require('../src/renderer/inventory-format');
      return require(name);
    },
  });
  const inventory = { Consumables: [{ ItemType: '/SF/Types/Items/Consumables/WevetSeed', ItemCount: 2 }] };
  const service = new commonjs.exports.DataSnapshots({ getSession: () => current, getLanguage: () => 'de' });
  const current = { getRawInventory: () => inventory, isInventoryCached: () => false };
  const result = await service.read('inventory');
  assert.equal(calls, 1);
  assert.equal(result.names['/SF/Types/Items/Consumables/WevetSeed'], 'Wevet seed');
});

test('offline inventory restores encrypted cache with its original age', async t => {
  const { service, cache, cachePath } = fixture(t, { now: () => 5000 });
  cache({ accountId: 'player-a', savedAt: 1234, rawInventory: { Consumables: [{ ItemType: '/SF/Items/WevetSeed', ItemCount: 2 }] } });
  const result = await service.read('inventory');
  assert.equal(result.ok, true);
  assert.equal(result.inventory.Consumables[0].ItemCount, 2);
  assert.equal(result.metadata.cached, true);
  assert.equal(result.metadata.savedAt, 1234);
  assert.equal(result.metadata.fetchedAt, null);
  assert.equal(result.metadata.path, cachePath);
  assert.equal(result.metadata.canRefresh, false);
  assert.equal(result.metadata.accountId, 'player-a');
  const refreshed = await service.refresh('inventory');
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.refresh.updated, false);
  assert.match(refreshed.refresh.message, /sign in/);
});

test('legacy plain cache is readable and is not rewritten', async t => {
  const { service, cachePath } = fixture(t);
  const text = JSON.stringify({ rawInventory: { PlayerLevel: 2 } });
  fs.writeFileSync(cachePath, text);
  const result = await service.read('inventory');
  assert.equal(result.ok, true);
  assert.equal(result.metadata.savedAt, null);
  assert.equal(fs.readFileSync(cachePath, 'utf8'), text);
});

test('current account never receives a different or unidentified account cache', async t => {
  const f = sessionFixture(); f.inventory(null);
  const { service, cache } = fixture(t, { getSession: () => f.session });
  for (const accountId of ['player-b', undefined]) {
    cache({ accountId, rawInventory: { PlayerLevel: 9 } });
    const result = await service.read('inventory');
    assert.equal(result.ok, false);
    assert.equal(result.inventory, null);
    assert.equal(result.error.code, 'inventory-waiting');
    assert.equal(result.metadata.accountId, 'player-a');
    assert.equal(result.invalidatePrevious, true);
  }
  cache({ accountId: 'player-a', savedAt: 5, rawInventory: { PlayerLevel: 8 } });
  assert.equal((await service.read('inventory')).inventory.PlayerLevel, 8);
});

test('missing, corrupt and oversized cache have useful empty states', async t => {
  const { service, cachePath } = fixture(t, { maxInventoryBytes: 100 });
  assert.equal((await service.read('inventory')).error.code, 'inventory-missing');
  fs.writeFileSync(cachePath, 'bad data');
  assert.equal((await service.read('inventory')).error.code, 'cache-unreadable');
  fs.writeFileSync(cachePath, 'x'.repeat(101));
  assert.equal((await service.read('inventory')).error.code, 'cache-unreadable');
  assert.equal((await service.read('unsupported')).error.code, 'unknown-kind');
});

test('explicit refresh updates the existing poller and concurrent clicks share one request', async t => {
  const f = sessionFixture();
  let release, count = 0;
  const wait = new Promise(resolve => { release = resolve; });
  f.session.refreshNow = async () => { count++; await wait; f.inventory({ PlayerLevel: 10 }); return { ok: true }; };
  const { service } = fixture(t, { getSession: () => f.session });
  const first = service.refresh('inventory'), second = service.refresh('data-inventory');
  assert.equal(first, second);
  release();
  const result = await first;
  assert.equal(count, 1);
  assert.equal(result.refresh.updated, true);
  assert.equal(result.inventory.PlayerLevel, 10);
});

test('refresh failure keeps the last snapshot and expired sessions never refresh', async t => {
  const f = sessionFixture();
  f.session.refreshNow = async () => ({ ok: false, reason: 'refresh-failed' });
  const { service } = fixture(t, { getSession: () => f.session });
  const failed = await service.refresh('inventory');
  assert.equal(failed.ok, true);
  assert.equal(failed.inventory.PlayerLevel, 3);
  assert.equal(failed.error.code, 'refresh-failed');
  f.expired(true);
  f.session.refreshNow = () => { throw new Error('must not call'); };
  const expired = await service.refresh('inventory');
  assert.equal(expired.metadata.canRefresh, false);
  assert.equal(expired.refresh.updated, false);
});

test('account changes during name loading discard the old snapshot', async t => {
  const f = sessionFixture();
  let current = f.session, release;
  const names = new Promise(resolve => { release = resolve; });
  const { service } = fixture(t, { getSession: () => current, getNames: () => names });
  const pending = service.read('inventory');
  current = null; release({});
  const result = await pending;
  assert.equal(result.error.code, 'session-changed');
  assert.equal(result.inventory, null);
  assert.equal(result.invalidatePrevious, true);
});

test('new session empty states explicitly invalidate previously displayed account data', async t => {
  const f = sessionFixture();
  let current = f.session;
  const { service, cachePath } = fixture(t, { getSession: () => current });
  assert.equal((await service.read('inventory')).metadata.accountId, 'player-a');
  current = { ...f.session, accountId: 'player-b', getRawInventory: () => null };
  const missing = await service.read('inventory');
  assert.equal(missing.error.code, 'inventory-missing');
  assert.equal(missing.metadata.accountId, 'player-b');
  assert.equal(missing.invalidatePrevious, true);
  fs.writeFileSync(cachePath, 'unreadable');
  const corrupt = await service.read('inventory');
  assert.equal(corrupt.error.code, 'cache-unreadable');
  assert.equal(corrupt.metadata.accountId, 'player-b');
  assert.equal(corrupt.invalidatePrevious, true);
});

test('EE.log separates real headers, preserves multiline JSON and unknown text', () => {
  const raw = [
    'Soulframe session started',
    '12.340 Script [Info]: Inventory: {',
    '  "items": [{"name":"Wevet seed", "count":2}],',
    '  "note": "a } inside a string"',
    '}',
    '13.000 Physics [Error]: Invalid rigid body',
    '  at Run() in physics.lua:10',
    '14.250 Net [Warning]: Retry requested',
    '[Debug]: diagnostic',
    'Unknown subsystem output',
  ].join('\r\n');
  const parsed = parseLogRecords(raw);
  assert.equal(parsed.records.length, 6);
  const inventory = parsed.records[1];
  assert.equal(inventory.timestamp, '12.340');
  assert.equal(inventory.elapsedSeconds, 12.34);
  assert.equal(inventory.category, 'Script');
  assert.equal(inventory.severity, 'info');
  assert.equal(inventory.json.items[0].count, 2);
  assert.match(inventory.detail, /"count": 2/);
  assert.equal(inventory.lineStart, 2);
  assert.equal(inventory.lineEnd, 5);
  assert.equal(inventory.raw, raw.split('\r\n').slice(1, 5).join('\n'));
  assert.equal(parsed.records[2].severity, 'error');
  assert.match(parsed.records[2].message, /at Run/);
  assert.equal(parsed.records[3].severity, 'warning');
  assert.equal(parsed.records[4].severity, 'debug');
  assert.equal(parsed.records[5].severity, 'plain');
});

test('log parser accepts clock timestamps and does not consume ordinary braces as JSON', () => {
  const result = parseLogRecords('01:23:45.678 Sys [Info]: failed {lookup}\nOrdinary line\n[12:30:00] [Warn]: wait\n');
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].timestamp, '01:23:45.678');
  assert.equal(result.records[0].elapsedSeconds, null);
  assert.equal(result.records[1].message, 'Ordinary line');
  assert.equal(result.records[2].timestamp, '12:30:00');
});

test('EE.log uses bounded recent bytes and records and reports the limitations', async t => {
  const { service, logPath } = fixture(t, { maxLogBytes: 250, maxLogRecords: 3 });
  fs.writeFileSync(logPath, Array.from({ length: 20 }, (_, i) => `${i}.000 Script [Info]: useful record ${i}\n`).join(''));
  const result = await service.read('data-ee-log');
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records.map(row => row.message), ['useful record 17', 'useful record 18', 'useful record 19']);
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.bytesRead, 250);
  assert.ok(result.metadata.discardedRecords > 0);
  assert.ok(result.metadata.totalBytes > result.metadata.bytesRead);
  assert.equal(result.metadata.maxBytes, 250);
  assert.equal(result.metadata.maxRecords, 3);
  assert.equal(MAX_LOG_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_LOG_RECORDS, 2000);
});

test('manual log reads include append, truncation, replacement and path changes', async t => {
  let selected;
  const { service, logPath, directory } = fixture(t, { getLogPath: () => selected });
  selected = logPath;
  fs.writeFileSync(logPath, '1.000 Game [Info]: first\n');
  const first = await service.read('ee-log');
  assert.equal(first.metadata.truncated, false);
  fs.appendFileSync(logPath, '2.000 Game [Info]: second\n');
  assert.equal((await service.refresh('ee-log')).records.length, 2);
  fs.writeFileSync(logPath, '0.000 Sys [Info]: restarted\n');
  assert.equal((await service.read('ee-log')).records[0].message, 'restarted');
  fs.renameSync(logPath, path.join(directory, 'EE-old.log'));
  fs.writeFileSync(logPath, '0.100 Sys [Info]: replacement\n');
  assert.equal((await service.read('ee-log')).records[0].message, 'replacement');
  selected = path.join(directory, 'custom-EE.log');
  fs.writeFileSync(selected, '3.000 Game [Info]: selected\n');
  assert.equal((await service.read('ee-log')).metadata.path, selected);
});

test('missing, empty, inaccessible and long single-line log files stay readable', async t => {
  const { service, logPath } = fixture(t, { maxLogBytes: 128 });
  assert.equal((await service.read('ee-log')).error.code, 'log-missing');
  fs.writeFileSync(logPath, '');
  const empty = await service.read('ee-log');
  assert.equal(empty.ok, true);
  assert.equal(empty.records.length, 0);
  fs.writeFileSync(logPath, 'x'.repeat(1000));
  const long = await service.read('ee-log');
  assert.equal(long.records[0].raw.length, 128);
  assert.equal(long.metadata.startsMidLine, true);
  const inaccessible = new DataSnapshots({ getLogPath: () => logPath, fsImpl: {
    open: async () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); },
  } });
  assert.equal((await inaccessible.read('ee-log')).error.code, 'log-unreadable');
});

test('log shrink during a read is retried from the new start', async t => {
  const { logPath } = fixture(t);
  fs.writeFileSync(logPath, 'Old header\n' + 'x'.repeat(500));
  let changed = false;
  const service = new DataSnapshots({ getLogPath: () => logPath, maxLogBytes: 128, fsImpl: {
    open: async (...args) => {
      const handle = await promises.open(...args);
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        read: async (...readArgs) => {
          if (!changed) { changed = true; fs.writeFileSync(logPath, '0.000 Sys [Info]: restarted\n'); }
          return handle.read(...readArgs);
        },
      };
    },
  } });
  const result = await service.read('ee-log');
  assert.equal(result.ok, true);
  assert.equal(result.records[0].message, 'restarted');
  assert.equal(result.metadata.truncated, false);
});

test('log replacement during a read is retried against the new file', async t => {
  const { logPath, directory } = fixture(t);
  fs.writeFileSync(logPath, '1.000 Sys [Info]: previous log\n');
  let changed = false;
  const service = new DataSnapshots({ getLogPath: () => logPath, fsImpl: {
    stat: (...args) => promises.stat(...args),
    open: async (...args) => {
      const handle = await promises.open(...args);
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        read: async (...readArgs) => {
          if (!changed) {
            changed = true;
            fs.renameSync(logPath, path.join(directory, 'EE-old.log'));
            fs.writeFileSync(logPath, '0.000 Sys [Info]: new log\n');
          }
          return handle.read(...readArgs);
        },
      };
    },
  } });
  const result = await service.read('ee-log');
  assert.equal(result.ok, true);
  assert.equal(result.records[0].message, 'new log');
});

function loadPoller(t) {
  const { cachePath } = fixture(t);
  const commonjs = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/inventoryPoller.js'), 'utf8'), {
    module: commonjs, console, Date, setTimeout, clearTimeout,
    require(name) {
      if (name === './appPaths') return { INVENTORY_CACHE_PATH: cachePath };
      if (name === './apiClient') return { ApiClient: class {} };
      if (name === './fileEncryption') return encryption;
      if (name === './affiliationProgress') return require('../src/modules/affiliationProgress');
      return require(name);
    },
  });
  return commonjs.exports.InventoryPoller;
}

test('poller explicit refresh shares an in-flight background request and saves its age', async t => {
  const InventoryPoller = loadPoller(t);
  const poller = new InventoryPoller('player-a', 'fixture');
  let release, count = 0;
  poller.api.fetchInventory = () => { count++; return new Promise(resolve => { release = resolve; }); };
  poller.start();
  t.after(() => poller.stop());
  const first = poller.refreshNow(), second = poller.refreshNow();
  assert.equal(first, second);
  release({ data: { PlayerLevel: 4 } });
  assert.equal((await first).ok, true);
  assert.equal(count, 1);
  assert.equal(poller.getRawInventory().PlayerLevel, 4);
  assert.ok(poller.getInventorySavedAt() > 0);
  assert.equal(poller.getLastSuccessfulPollAt(), poller.getInventorySavedAt());
  const restored = new InventoryPoller('player-a', 'fixture');
  assert.equal(restored.getInventorySavedAt(), poller.getInventorySavedAt());
  assert.equal(restored.getLastSuccessfulPollAt(), 0);
  assert.equal(restored.isInventoryCached(), true);
});

test('stopped or expired poller responses do not overwrite old inventory', async t => {
  const InventoryPoller = loadPoller(t);
  const poller = new InventoryPoller('player-a', 'fixture');
  let release;
  poller.api.fetchInventory = () => new Promise(resolve => { release = resolve; });
  poller.start();
  const pending = poller.refreshNow();
  poller.stop();
  release({ data: { PlayerLevel: 99 } });
  assert.equal((await pending).ok, false);
  assert.equal(poller.getRawInventory(), null);
  assert.equal((await poller.refreshNow()).reason, 'session-unavailable');
  const expired = new InventoryPoller('player-a', 'fixture');
  expired._running = true;
  expired.api.fetchInventory = async () => ({ nonceExpired: true });
  const result = await expired.refreshNow();
  assert.equal(result.reason, 'session-expired');
  assert.equal(expired.isNonceExpired(), true);
  assert.equal(expired._running, false);
});
