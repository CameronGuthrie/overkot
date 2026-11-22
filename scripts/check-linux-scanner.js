'use strict';

// Native QA only: run as root in an isolated Linux container with SYS_PTRACE.
// Both the helper and synthetic game run as ordinary users. No network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function main() {
  assert.equal(process.platform, 'linux', 'This check requires Linux.');
  assert.equal(process.getuid(), 0, 'Use a root QA orchestrator in an isolated container.');
  const helper = process.argv[2];
  assert.ok(helper && path.isAbsolute(helper), 'Pass the absolute installed helper path.');
  const stat = fs.statSync(helper);
  assert.ok(stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022), 'Installed helper must be a root-owned, non-writable executable.');
  const { stdout: capability } = await execFileAsync('getcap', [helper]);
  assert.match(capability, /\bcap_sys_ptrace=ep\b/, 'Installed helper must carry the configured capability.');
  const scope = fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim();
  assert.equal(scope, '1', 'This check requires Yama restricted mode (1); it never changes host policy.');

  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'overkot-scanner-check-'));
  fs.chmodSync(directory, 0o755);
  const fixture = path.join(directory, 'game-fixture');
  const children = [];
  const environment = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' };
  async function launch(mode, uid) {
    const child = spawn(fixture, [mode], { uid, gid: uid, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Synthetic fixture did not become ready.')), 5000);
      let text = '';
      const cleanup = () => { clearTimeout(timeout); child.removeListener('error', onError); child.removeListener('exit', onExit); child.stdout.removeListener('data', onData); };
      const onError = error => { cleanup(); reject(error); };
      const onExit = code => { cleanup(); reject(new Error(`Synthetic fixture exited (${code}).`)); };
      const onData = data => { text += data.toString('utf8'); if (text.includes('READY\n')) { cleanup(); resolve(); } };
      child.once('error', onError); child.once('exit', onExit); child.stdout.on('data', onData);
    });
    return child;
  }
  async function scan(executable, pid) {
    const { stdout } = await execFileAsync(executable, [String(pid), 'normal', '0', '0'],
      { uid: 1000, gid: 1000, env: environment, encoding: 'utf8', timeout: 12000, maxBuffer: 65536 });
    const result = JSON.parse(stdout);
    assert.ok(Array.isArray(result.accountIds) && result.accountIds.length <= 16);
    assert.ok(Array.isArray(result.nonces) && result.nonces.length <= 32);
    assert.ok(Number.isSafeInteger(result.nextRegion) && result.nextRegion >= 0);
    assert.ok(Number.isSafeInteger(result.nextOffset) && result.nextOffset >= 0);
    return result;
  }
  try {
    await execFileAsync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O0',
      path.join(__dirname, '../test/fixtures/linux-game-process.c'), '-o', fixture]);
    fs.chmodSync(fixture, 0o755);
    const game = await launch('game', 1000);
    const unrelated = await launch('unrelated', 1000);
    const otherUser = await launch('game', 1001);

    const valid = await scan(helper, game.pid);
    assert.equal(valid.error, '');
    assert.ok(valid.accountIds.includes('abcdef0123456789abcdef01'));
    for (const nonce of ['246813579', '975318642']) assert.ok(valid.nonces.includes(nonce), 'Both synthetic encodings must be discovered.');
    console.log('PASS: ordinary-user helper reads ASCII and UTF-16LE candidates from a same-user sibling game process.');

    for (const [label, child] of [['unrelated process', unrelated], ['another user’s game', otherUser]]) {
      const denied = await scan(helper, child.pid);
      assert.equal(denied.error, 'wrong-process');
      assert.deepEqual(denied.accountIds, []);
      assert.deepEqual(denied.nonces, []);
      console.log(`PASS: rejects ${label}.`);
    }

    const uncapped = path.join(directory, 'scanner-without-capability');
    fs.copyFileSync(helper, uncapped);
    fs.chmodSync(uncapped, 0o755);
    assert.equal((await execFileAsync('getcap', [uncapped])).stdout.trim(), '', 'Test copy must not inherit file capabilities.');
    const denied = await scan(uncapped, game.pid);
    assert.equal(denied.error, 'permission-denied');
    assert.deepEqual(denied.nonces, []);
    console.log('PASS: removing the file capability blocks the same sibling read under Yama mode 1.');

    for (const pid of ['../self', '0', '-1', '2147483648']) {
      const invalid = await scan(helper, pid);
      assert.equal(invalid.error, 'scan-failed');
      assert.deepEqual(invalid.nonces, []);
    }
    console.log('PASS: malformed or out-of-range process arguments are rejected.');
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGKILL');
    })));
    assert.equal(path.dirname(directory), tempRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
