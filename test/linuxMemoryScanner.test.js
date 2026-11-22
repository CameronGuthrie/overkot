'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { scanLinuxMemory, readableRegions } = require('../src/modules/linuxMemoryScanner');

const account = 'abcdef0123456789abcdef01';
const staleNonce = '123456789';
const liveNonce = '987654321';
const credential = nonce => `accountId=${account}&nonce=${nonce}&ct=MSI`;
const failure = code => Object.assign(new Error('synthetic process error'), { code });

function procFixture(contents = Buffer.alloc(1024), { mapsError, openError, readError, shortRead = Infinity, maps } = {}) {
  const calls = [], reads = [];
  let closed = 0, yielded = 0;
  const base = 0x1000;
  const fsImpl = {
    async readFile(filename) {
      calls.push(filename);
      if (mapsError) throw failure(mapsError);
      return maps || `${base.toString(16)}-${(base + contents.length).toString(16)} rw-p 00000000 00:00 0 [heap]\n`;
    },
    async open(filename, mode) {
      calls.push(filename); assert.equal(mode, 'r');
      if (openError) throw failure(openError);
      return {
        async read(buffer, offset, length, position) {
          reads.push({ length, position });
          if (readError) throw failure(readError);
          const start = position - base;
          const bytesRead = Math.max(0, Math.min(length, shortRead, contents.length - start));
          contents.copy(buffer, offset, start, start + bytesRead);
          return { bytesRead, buffer };
        },
        async close() { closed++; },
      };
    },
  };
  return { fsImpl, calls, reads, get closed() { return closed; }, get yielded() { return yielded; },
    options: { fsImpl, chunkSize: 256, yieldControl: async () => { yielded++; await new Promise(resolve => setImmediate(resolve)); } } };
}

function scannerFixture(proc) {
  const tested = [];
  const context = { module: { exports: {} }, __dirname: path.join(__dirname, '../src/modules'), process, Buffer, console,
    require(name) {
      if (name === 'os') return { platform: () => 'linux' };
      if (name === 'fs') return { statSync() { throw failure('ENOENT'); } };
      if (name === './apiClient') return { ApiClient: class {
        async testSingleNonce(id, nonce) { tested.push({ id, nonce }); return nonce === liveNonce; }
      } };
      if (name === './linuxMemoryScanner') return { scanLinuxMemory: (pid, callback, options) =>
        scanLinuxMemory(pid, callback, { ...options, ...proc.options }) };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/memoryScanner.js'), 'utf8'), context);
  return { scanner: new context.module.exports.MemoryScanner(), tested };
}

test('Linux scans beyond stale ASCII candidates and reads UTF-16LE at an odd chunk boundary', async () => {
  const contents = Buffer.alloc(1024);
  contents.write(credential(staleNonce), 12, 'latin1');
  contents.write(credential(liveNonce), 501, 'utf16le');
  const proc = procFixture(contents);
  const { scanner, tested } = scannerFixture(proc);
  const result = await scanner.scanForAccountAndNonce(42);
  assert.equal(result.accountId, account);
  assert.equal(result.nonce, liveNonce);
  assert.equal(result.scanError, undefined);
  assert.deepEqual(tested.map(value => value.nonce), [staleNonce, liveNonce]);
  assert.ok(tested.every(value => value.id === account));
  assert.equal(proc.closed, 1);
  assert.ok(proc.yielded >= 4);
  assert.deepEqual(proc.calls, ['/proc/42/maps', '/proc/42/mem']);
});

test('short reads retain enough carry for the longest UTF-16LE credential and ASCII splits', async () => {
  const contents = Buffer.alloc(1024);
  const longNonce = '12345678901234567890';
  contents.write(credential(longNonce), 247, 'utf16le');
  contents.write(credential(liveNonce), 755, 'latin1');
  const proc = procFixture(contents, { shortRead: 17 });
  const found = new Set();
  await scanLinuxMemory(42, text => {
    for (const match of text.matchAll(/accountId=([a-f0-9]{24})&nonce=(\d{5,20})&ct=MSI/g)) found.add(match[2]);
  }, proc.options);
  assert.deepEqual([...found], [longNonce, liveNonce]);
  assert.equal(proc.closed, 1);
});

test('permissions and exited processes produce safe diagnostics without leaking OS error messages', async () => {
  for (const stage of ['mapsError', 'openError', 'readError']) {
    for (const code of ['EACCES', 'EPERM', 'ENOENT', 'ESRCH']) {
      const proc = procFixture(undefined, { [stage]: code });
      const { scanner, tested } = scannerFixture(proc);
      const result = await scanner.scanForAccountAndNonce(42, account);
      assert.equal(result.scanError, ['EACCES', 'EPERM'].includes(code) ? 'permission-denied' : 'process-gone');
      assert.equal(result.nonce, '');
      assert.deepEqual(tested, []);
      assert.equal(proc.closed, stage === 'readError' ? 1 : 0);
    }
  }
  const invalid = procFixture();
  assert.equal((await scanLinuxMemory('../self', () => {}, invalid.options)).error, 'process-gone');
  assert.deepEqual(invalid.calls, []);
});

test('byte and elapsed-time budgets close memory files and bound failed reads too', async () => {
  for (const readError of [undefined, 'EIO']) {
    const proc = procFixture(undefined, { readError });
    const result = await scanLinuxMemory(42, () => {}, { ...proc.options, byteLimit: 384 });
    assert.equal(result.limited, true);
    assert.equal(result.error, readError ? 'scan-failed' : '');
    assert.equal(proc.reads.reduce((sum, read) => sum + read.length, 0), 384);
    assert.equal(proc.closed, 1);
  }
  let elapsed = 0;
  const proc = procFixture();
  const result = await scanLinuxMemory(42, () => {}, { ...proc.options,
    now: () => elapsed, timeLimitMs: 5, yieldControl: async () => { elapsed += 5; } });
  assert.equal(result.limited, true);
  assert.equal(proc.reads.length, 1);
  assert.equal(proc.closed, 1);
});

test('large readable mappings rotate scan windows with overlap instead of being skipped', async () => {
  const contents = Buffer.alloc(1024);
  contents.write(credential(liveNonce), 235, 'latin1');
  const proc = procFixture(contents), matches = [], state = {};
  const onChunk = text => { if (text.includes(credential(liveNonce))) matches.push(true); };
  await scanLinuxMemory(42, onChunk, { ...proc.options, regionLimit: 256, state });
  assert.equal(matches.length, 0);
  await scanLinuxMemory(42, onChunk, { ...proc.options, regionLimit: 256, state });
  assert.ok(matches.length > 0);
});

test('a budget exhausted in an early mapping resumes later mappings on the next scan', async () => {
  const contents = Buffer.alloc(0x2400), state = {};
  contents.write(credential(liveNonce), 0x2010, 'latin1');
  const proc = procFixture(contents, { maps: '1000-1400 rw-p 00000000 00:00 0 [heap]\n3000-3400 rw-p 00000000 00:00 0\n' });
  let found = false;
  const callback = text => { if (text.includes(credential(liveNonce))) found = true; };
  await scanLinuxMemory(42, callback, { ...proc.options, byteLimit: 256, state });
  assert.equal(found, false);
  await scanLinuxMemory(42, callback, { ...proc.options, byteLimit: 256, state });
  assert.equal(found, true);
  assert.equal(proc.reads[1].position, 0x3000);
});

test('candidate batches remain bounded and later chunks can be scanned on following attempts', async () => {
  const contents = Buffer.alloc(8192);
  for (let i = 0; i < 65; i++) contents.write(credential(String(123456789 + i)), i * 100, 'latin1');
  contents.write(credential(liveNonce), 7000, 'latin1');
  const proc = procFixture(contents), { scanner, tested } = scannerFixture(proc);
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = tested.length;
    result = await scanner.scanForAccountAndNonce(42);
    assert.ok(tested.length - previous <= 32);
    if (result.nonce) break;
  }
  assert.equal(result.nonce, liveNonce);
});

test('readable map parsing prefers the heap, skips inaccessible and unsafe addresses', () => {
  const maps = [
    '1000-2000 r-xp 00000000 00:00 0 /game',
    '3000-4000 rw-p 00000000 00:00 0',
    '5000-6000 rw-p 00000000 00:00 0 [heap]',
    '7000-8000 ---p 00000000 00:00 0',
    'ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0 [vsyscall]',
    'bad map',
  ].join('\n');
  assert.deepEqual(readableRegions(maps).map(region => region.start), [0x5000, 0x3000, 0x1000]);
});

test('a permitted Linux child process can be read without a Windows helper', { skip: process.platform !== 'linux', timeout: 15_000 }, async t => {
  const child = spawn(process.execPath, ['-e', `
    global.syntheticInventory = Buffer.from(${JSON.stringify(credential(liveNonce))}, 'utf16le');
    process.stdout.write('ready\\n');
    setInterval(() => global.syntheticInventory.length, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  await once(child.stdout, 'data');
  let found = false;
  const result = await scanLinuxMemory(child.pid, text => { if (text.includes(credential(liveNonce))) found = true; });
  if (result.error === 'permission-denied') {
    t.skip('Host process policy also denies reading a direct child.');
    return;
  }
  assert.equal(result.error, '');
  assert.equal(found, true);
});
