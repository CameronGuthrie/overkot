const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(exists = true, platform = 'win32', helper = {}) {
  const calls = [];
  const filesystemReads = [];
  const context = { module: { exports: {} }, __dirname: '/app/src/modules', Buffer,
    process: { resourcesPath: '/installed/resources' },
    require: name => {
      if (name === 'os') return { platform: () => platform };
      if (name === 'fs') return {
        statSync: filename => { filesystemReads.push(filename); if (!exists) throw new Error('missing'); return { isFile: () => true }; },
        existsSync: filename => { filesystemReads.push(filename); return exists; },
      };
      if (name === 'child_process') return { execFile: (exe, args, options, done) => {
        calls.push({ exe, args, options }); done(helper.execError || null, { stdout: helper.output || '' });
      } };
      if (name === './apiClient') return { ApiClient: class { async testSingleNonce(id, nonce) { return helper.testNonce?.(id, nonce) || false; } } };
      if (name === './linuxMemoryScanner') return helper.scanLinuxMemory
        ? { scanLinuxMemory: helper.scanLinuxMemory } : require('../src/modules/linuxMemoryScanner');
      if (name === 'util') return { promisify: fn => (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => error ? reject(error) : resolve(value))) };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/memoryScanner.js'), 'utf8'), context);
  return { ...context.module.exports, calls, filesystemReads };
}

test('scanner executes the bundled resource directly with an argument array and no writes', async () => {
  const { MemoryScanner, scannerAvailableSync, calls } = fixture();
  assert.equal(scannerAvailableSync(), true);
  await new MemoryScanner()._scanMemoryWindows(1234, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, path.join('/installed/resources', 'bin', 'hostservice.exe'));
  assert.equal(JSON.stringify(calls[0].args), JSON.stringify(['1234', '4']));
  assert.equal(calls[0].options.shell, undefined);
});

test('missing scanner does not generate, download or launch a fallback executable', async () => {
  const { MemoryScanner, calls } = fixture(false);
  const result = await new MemoryScanner()._scanMemoryWindows(1234, false);
  assert.equal(result.length, 0);
  assert.equal(calls.length, 0);
});

test('Linux uses its native scanner backend without checking or launching a Windows helper', async () => {
  const { MemoryScanner, scannerSupported, scannerAvailableSync, calls, filesystemReads } = fixture(true, 'linux');
  assert.equal(scannerSupported(), true);
  assert.equal(scannerAvailableSync(), true);
  const scanner = new MemoryScanner();
  let scannedPid;
  scanner._scanMemoryLinux = pid => { scannedPid = pid; return []; };
  await scanner.scanForAccountAndNonce(1234, 'test-account');
  assert.equal(scannedPid, 1234);
  assert.deepEqual(filesystemReads, ['/proc/self/maps']);
  assert.equal(calls.length, 0);
  assert.equal(fixture(false, 'linux').scannerAvailableSync(), false);
});

test('macOS companion mode never scans or checks for a Windows helper', async () => {
  const { MemoryScanner, scannerSupported, scannerAvailableSync, calls, filesystemReads } = fixture(true, 'darwin');
  assert.equal(scannerSupported(), false);
  assert.equal(scannerAvailableSync(), false);
  const scanner = new MemoryScanner();
  assert.equal(await scanner.scanForWorkingNonce(1234, 'test-account'), '');
  const result = await scanner.scanForAccountAndNonce(1234, 'test-account');
  assert.equal(result.accountId, 'test-account');
  assert.equal(result.nonce, '');
  assert.equal(scanner._scanAttempts, 0);
  assert.equal(calls.length, 0);
  assert.equal(filesystemReads.length, 0);
});

const helperResponse = overrides => JSON.stringify({ accountIds: ['abcdef0123456789abcdef01'], nonces: ['123456789'],
  error: '', nextRegion: 3, nextOffset: 524288, ...overrides });

test('Linux launches its fixed native helper with bounded output, cursor arguments and no shell', async () => {
  const tested = [];
  const { MemoryScanner, calls } = fixture(true, 'linux', { output: helperResponse(),
    testNonce: (id, nonce) => { tested.push({ id, nonce }); return true; } });
  const scanner = new MemoryScanner();
  const result = await scanner.scanForAccountAndNonce(1234);
  assert.equal(result.nonce, '123456789');
  assert.equal(result.accountId, 'abcdef0123456789abcdef01');
  assert.equal(calls[0].exe, path.join('/installed/resources', 'bin', 'overkot-session-scanner'));
  assert.equal(JSON.stringify(calls[0].args), JSON.stringify(['1234', 'normal', '0', '0']));
  assert.equal(calls[0].options.timeout, 12000);
  assert.equal(calls[0].options.maxBuffer, 65536);
  assert.equal(calls[0].options.shell, undefined);
  await scanner._scanMemoryLinux(1234, true);
  assert.equal(JSON.stringify(calls[1].args), JSON.stringify(['1234', 'extended', '3', '524288']));
  assert.equal(calls[1].options.timeout, 17000);
  await scanner._scanMemoryLinux(2345, false);
  assert.equal(JSON.stringify(calls[2].args), JSON.stringify(['2345', 'normal', '0', '0']));
  assert.equal(tested.length, 1);
});

test('Linux falls back to ordinary process access when helper is missing or cannot execute', async () => {
  for (const code of ['missing', 'ENOENT', 'EACCES', 'EPERM']) {
    let directScans = 0;
    const { MemoryScanner, calls } = fixture(code !== 'missing', 'linux', {
      execError: Object.assign(new Error('cannot execute'), { code }),
      scanLinuxMemory: async () => { directScans++; return { error: 'permission-denied', regionsScanned: 0, bytesRead: 0 }; },
    });
    const result = await new MemoryScanner().scanForAccountAndNonce(1234);
    assert.equal(result.scanError, 'permission-denied');
    assert.equal(directScans, 1);
    assert.equal(calls.length, code === 'missing' ? 0 : 1);
  }
});

test('invalid helper responses and timeouts fail safely without using a second scanner', async () => {
  for (const options of [{ output: 'invalid JSON' }, { output: helperResponse({ nonces: ['secret?not-a-nonce'] }) },
    { execError: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }]) {
    const { MemoryScanner } = fixture(true, 'linux', { ...options,
      scanLinuxMemory: async () => { throw new Error('Unexpected fallback'); } });
    const result = await new MemoryScanner().scanForAccountAndNonce(1234);
    assert.equal(result.scanError, 'scan-failed');
    assert.equal(result.nonce, '');
  }
});

test('helper target failures never validate candidate nonces and invalid PIDs never launch', async () => {
  for (const error of ['permission-denied', 'process-gone', 'wrong-process', 'scan-failed']) {
    const { MemoryScanner, calls } = fixture(true, 'linux', { output: helperResponse({ error }),
      testNonce: () => { throw new Error('Unexpected API call'); } });
    const scanner = new MemoryScanner();
    const result = await scanner.scanForAccountAndNonce(1234);
    assert.equal(result.scanError, error === 'wrong-process' ? 'process-gone' : error);
    assert.equal(result.nonce, '');
    await scanner._scanMemoryLinux('../self', false);
    assert.equal(scanner._lastScanError, 'process-gone');
    assert.equal(calls.length, 1);
  }
});

test('helper protocol validates strict sizes, values and cursors before use', () => {
  const { parseLinuxHelperOutput } = fixture(true, 'linux');
  for (const overrides of [
    { accountIds: Array(17).fill('abcdef0123456789abcdef01') }, { nonces: Array(33).fill('123456789') },
    { accountIds: ['invalid'] }, { nonces: [123456789] }, { nonces: ['1234'] }, { nonces: ['1'.repeat(21)] },
    { error: 'private OS failure' }, { nextRegion: -1 }, { nextOffset: 1.5 }, { nextOffset: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => parseLinuxHelperOutput(helperResponse(overrides)));
  for (const value of ['null', '[]', '{}', ' '.repeat(65537)]) assert.throws(() => parseLinuxHelperOutput(value));
  const result = parseLinuxHelperOutput(helperResponse({ accountIds: ['ABCDEF0123456789ABCDEF01', 'abcdef0123456789abcdef01'], nonces: ['123456789', '123456789'] }));
  assert.equal(result.accountIds.length, 1);
  assert.equal(result.nonces.length, 1);
});
