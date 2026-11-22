'use strict';

// Linux integration QA uses generated Wine-style memory, never a running game.
// A root CI/container orchestrator runs both children as normal numeric UIDs;
// a developer can also run the ordinary-user cases without administrative access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const linux = process.platform === 'linux';
const root = path.resolve(__dirname, '..');
const children = new Set();
const admin = linux && process.getuid() === 0;
const configuredUid = process.env.OVERKOT_POSITION_QA_UID || '1000';
if (admin) {
  assert.match(configuredUid, /^[1-9]\d*$/, 'OVERKOT_POSITION_QA_UID must name an ordinary numeric user.');
  assert.ok(Number.isSafeInteger(Number(configuredUid)) && Number(configuredUid) <= 0x7ffffffe,
    'OVERKOT_POSITION_QA_UID must leave room for a different ordinary test user.');
}
const uid = admin ? Number(configuredUid) : linux ? process.getuid() : 1000;
let directory, fixture, helper, sequence = 0;
const userOptions = (user = uid) => ({ uid: user, gid: user,
  env: { PATH: process.env.PATH, LANG: 'C', HOME: os.tmpdir() } });

async function launch(mode, user = uid) {
  const instance = path.join(directory, `fixture-${sequence++}`);
  fs.mkdirSync(instance, { mode: 0o777 });
  if (admin) fs.chownSync(instance, user, user);
  const child = spawn(fixture, [mode, path.join(instance, 'Soulframe.x64.exe')], {
    ...userOptions(user), stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  await new Promise((resolve, reject) => {
    let output = '', diagnostics = '';
    const timer = setTimeout(() => finish(new Error('Synthetic player did not become ready.')), 5000);
    const finish = error => {
      clearTimeout(timer); child.off('error', onError); child.off('exit', onExit);
      child.stdout.off('data', onData); child.stderr.off('data', onStderr);
      if (error) reject(error); else resolve();
    };
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`Synthetic player exited ${code}: ${diagnostics}`));
    const onData = data => { output += data; if (output.includes('READY\n')) finish(); };
    const onStderr = data => { diagnostics += data; };
    child.once('error', onError); child.once('exit', onExit);
    child.stdout.on('data', onData); child.stderr.on('data', onStderr);
  });
  return child;
}

async function probe(pid, { executable = helper, user = uid, args = ['--pid', String(pid), '--probe'] } = {}) {
  let output, code;
  try {
    const result = await execute(executable, args, { ...userOptions(user), encoding: 'utf8', timeout: 60000, maxBuffer: 131072 });
    output = result.stdout; code = 0;
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    output = error.stdout; code = error.code;
  }
  const packets = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.ok(packets.length && packets.length < 100, 'Helper must return bounded JSON telemetry.');
  return { packets, code, statuses: packets.filter(packet => packet.type === 'status').map(packet => packet.status) };
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
}

function copyReader(destination) {
  fs.copyFileSync(helper, destination); fs.chmodSync(destination, 0o755);
  const coreName = 'overkot-position-reader-core';
  const core = path.join(path.dirname(destination), coreName);
  fs.copyFileSync(path.join(path.dirname(helper), coreName), core); fs.chmodSync(core, 0o755);
}

test.before(async () => {
  if (!linux) return;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-position-qa-'));
  fs.chmodSync(directory, 0o755);
  fixture = path.join(directory, 'player-fixture');
  await execute('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O0',
    path.join(__dirname, 'fixtures', 'linux-player-process.c'), '-o', fixture]);
  fs.chmodSync(fixture, 0o755);
  if (process.env.OVERKOT_POSITION_READER) {
    helper = path.resolve(process.env.OVERKOT_POSITION_READER);
  } else {
    const { buildLinuxPositionReader } = require('../scripts/build-linux-position-reader');
    helper = buildLinuxPositionReader({ outputDir: path.join(root, '.build', 'linux-position-tests', 'bin') });
  }
});

test.after(async () => {
  if (!linux) return;
  await Promise.all([...children].map(terminate));
  if (directory) {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Linux reader discovers one typed player, facing and all current dungeon room frames', { skip: !linux }, async () => {
  const game = await launch('valid');
  try {
    const result = await probe(game.pid);
    assert.equal(result.code, 0, JSON.stringify(result.packets));
    assert.ok(result.statuses.includes('tracking'));
    const tracking = result.packets.find(packet => packet.type === 'status' && packet.status === 'tracking');
    assert.match(tracking.moduleHash, /^[a-f0-9]{64}$/);
    assert.match(tracking.processStartUtcTicks, /^[1-9][0-9]{0,18}$/);
    const pose = result.packets.find(packet => packet.type === 'pose');
    assert.equal(pose.source, 'memory');
    assert.deepEqual(pose.position, { x: 10, y: 20, z: 30 });
    assert.equal(pose.heading, 90);
    assert.equal(pose.dungeonFrames.length, 3);
    assert.deepEqual(pose.dungeonFrames.map(frame => frame.matrix.slice(12, 15)), [[0, 1000, 0], [100, 1000, 50], [200, 1000, 200]]);
    assert.ok(pose.dungeonFrames.every(frame => frame.source === 'level-info'));
    assert.ok(Number.isSafeInteger(pose.dungeonFramesTimestamp) && Math.abs(Date.now() - pose.dungeonFramesTimestamp) < 5000);
  } finally { await terminate(game); }
});

test('Linux reader rejects unrelated processes before publishing a pose or module identity', { skip: !linux }, async () => {
  const unrelated = await launch('unrelated');
  try {
    const result = await probe(unrelated.pid);
    assert.deepEqual(result.statuses, ['wrong-process']);
    assert.equal(result.packets.some(packet => packet.type === 'pose'), false);
    assert.equal(result.packets[0].moduleHash, null);
  } finally { await terminate(unrelated); }
});

test("Linux unprivileged core requires its launcher's descriptor handoff", { skip: !linux }, async () => {
  const game = await launch('valid');
  try {
    const result = await probe(game.pid, { executable: path.join(path.dirname(helper), 'overkot-position-reader-core') });
    assert.deepEqual(result.statuses, ['invalid-arguments']);
    assert.equal(result.packets.some(packet => packet.type === 'pose'), false);
    assert.equal(result.packets[0].moduleHash, null);
  } finally { await terminate(game); }
});

test('Linux reader rejects another user and root callers even when the target permits ptrace', { skip: !linux || !admin }, async () => {
  const game = await launch('valid');
  const other = await launch('valid', uid + 1);
  try {
    for (const result of [await probe(other.pid), await probe(game.pid, { user: 0 })]) {
      assert.deepEqual(result.statuses, ['wrong-process']);
      assert.equal(result.packets.some(packet => packet.type === 'pose'), false);
      assert.equal(result.packets[0].moduleHash, null);
    }
  } finally { await Promise.all([terminate(game), terminate(other)]); }
});

test('Linux reader fails closed for malformed PE data, changed getter evidence, invalid transforms and ambiguous players', { skip: !linux }, async () => {
  for (const [mode, expected] of [
    ['malformed', ['unsupported-build', 'profile-mismatch']], ['profile-mismatch', ['profile-mismatch']],
    ['invalid-pose', ['not-found']], ['ambiguous', ['ambiguous']],
  ]) {
    const game = await launch(mode);
    try {
      const result = await probe(game.pid);
      assert.ok(expected.includes(result.statuses.at(-1)), `${mode}: ${JSON.stringify(result.packets)}`);
      assert.equal(result.packets.some(packet => packet.type === 'pose'), false, mode);
      assert.notEqual(result.code, 0, mode);
    } finally { await terminate(game); }
  }
});

test('Linux portable reader reports permission denial under restricted sibling ptrace policy', { skip: !linux }, async t => {
  let policy;
  try { policy = fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim(); } catch { }
  if (!policy || policy === '0') { t.skip('Host does not enforce restricted sibling ptrace.'); return; }
  const uncapped = path.join(directory, 'position-without-capability');
  copyReader(uncapped);
  const game = await launch('blocked');
  try {
    const result = await probe(game.pid, { executable: uncapped });
    assert.deepEqual(result.statuses, ['permission-denied']);
    assert.equal(result.packets.some(packet => packet.type === 'pose'), false);
  } finally { await terminate(game); }
});

test('Linux installed reader uses its narrow capability for opening memory and drops it before telemetry', { skip: !linux || !admin }, async t => {
  const bounding = fs.readFileSync('/proc/self/status', 'utf8').match(/^CapBnd:\s+([0-9a-f]+)/m);
  if (!bounding || !(BigInt(`0x${bounding[1]}`) & (1n << 19n))) {
    t.skip('Container must be started with --cap-add SYS_PTRACE for installed-helper QA.'); return;
  }
  const capped = path.join(directory, 'position-with-capability');
  copyReader(capped);
  assert.equal((await execute('getcap', [path.join(path.dirname(helper), 'overkot-position-reader-core')])).stdout.trim(), '',
    'Only the single-threaded launcher may carry process-read capability.');
  await execute('setcap', ['cap_sys_ptrace=ep', capped]);
  assert.match((await execute('getcap', [capped])).stdout, /cap_sys_ptrace=ep/);
  const game = await launch('blocked');
  let child;
  try {
    child = spawn(capped, ['--pid', String(game.pid)], { ...userOptions(), stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); child.once('exit', () => children.delete(child));
    const pose = await new Promise((resolve, reject) => {
      let output = '', diagnostics = '';
      const timer = setTimeout(() => finish(new Error('Capability reader did not produce a pose.')), 60000);
      const finish = (error, packet) => {
        clearTimeout(timer); child.off('error', onError); child.off('exit', onExit);
        child.stdout.off('data', onData); child.stderr.off('data', onStderr);
        if (error) reject(error); else resolve(packet);
      };
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`Capability reader exited ${code}: ${output} ${diagnostics}`));
      const onStderr = data => { diagnostics += data; };
      const onData = data => {
        output += data;
        if (output.length > 131072) { finish(new Error('Capability reader exceeded output bound.')); return; }
        let end;
        while ((end = output.indexOf('\n')) >= 0) {
          const packet = JSON.parse(output.slice(0, end)); output = output.slice(end + 1);
          if (packet.type === 'pose') { finish(null, packet); return; }
        }
      };
      child.once('error', onError); child.once('exit', onExit);
      child.stdout.on('data', onData); child.stderr.on('data', onStderr);
    });
    assert.deepEqual(pose.position, { x: 10, y: 20, z: 30 });
    const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
    let checkedThreads = 0;
    for (const thread of fs.readdirSync(`/proc/${child.pid}/task`)) {
      let threadStatus;
      try { threadStatus = fs.readFileSync(`/proc/${child.pid}/task/${thread}/status`, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const field of ['CapEff', 'CapPrm', 'CapInh']) {
        assert.match(threadStatus, new RegExp(`^${field}:\\s+0+$`, 'm'), `${field} must be empty on reader thread ${thread} during live telemetry.`);
      }
      checkedThreads++;
    }
    assert.ok(checkedThreads > 0);
    assert.match(status, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, 'm'));
    child.stdin.write('refresh-roots\n');
  } finally { await Promise.all([terminate(child), terminate(game)]); }
});

test('Linux reader ends a closed game session and identifies a restarted game independently', { skip: !linux }, async () => {
  const game = await launch('valid');
  let child, replacement;
  try {
    child = spawn(helper, ['--pid', String(game.pid)], { ...userOptions(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); child.once('exit', () => children.delete(child));
    const packets = [];
    let carry = '';
    let resolvePose, rejectPose;
    const firstPose = new Promise((resolve, reject) => { resolvePose = resolve; rejectPose = reject; });
    const timer = setTimeout(() => rejectPose(new Error('Reader did not begin live tracking.')), 60000);
    child.once('error', rejectPose);
    child.stdout.on('data', data => {
      carry += data;
      let end;
      while ((end = carry.indexOf('\n')) >= 0) {
        const packet = JSON.parse(carry.slice(0, end)); carry = carry.slice(end + 1);
        packets.push(packet);
        if (packet.type === 'pose') { clearTimeout(timer); resolvePose(packet); }
      }
    });
    const exited = new Promise((resolve, reject) => {
      const exitTimer = setTimeout(() => reject(new Error('Reader did not finish the closed game session.')), 65000);
      child.once('error', error => { clearTimeout(exitTimer); clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(exitTimer); clearTimeout(timer);
        if (!packets.some(packet => packet.type === 'pose')) rejectPose(new Error(`Reader exited ${code} before a pose.`));
        resolve(code);
      });
    });
    await firstPose;
    await terminate(game);
    assert.equal(await exited, 0);
    assert.equal(packets.at(-1).status, 'process-gone');
    const identity = packets.find(packet => packet.status === 'tracking');
    replacement = await launch('valid');
    const resumed = await probe(replacement.pid);
    assert.equal(resumed.code, 0);
    const resumedIdentity = resumed.packets.find(packet => packet.status === 'tracking');
    assert.notEqual(resumedIdentity.processStartUtcTicks, identity.processStartUtcTicks);
    assert.deepEqual(resumed.packets.find(packet => packet.type === 'pose').position, { x: 10, y: 20, z: 30 });
  } finally { await Promise.all([terminate(child), terminate(game), terminate(replacement)]); }
});

test('Linux reader rejects malformed arguments and a missing process without scanning', { skip: !linux }, async () => {
  for (const args of [[], ['--pid', '-1'], ['--pid', '2147483648'], ['--pid', '1', '--unknown']]) {
    const result = await probe(0, { args });
    assert.deepEqual(result.statuses, ['invalid-arguments']);
    assert.equal(result.packets[0].bytesScanned, 0);
  }
  const missing = await probe(2147483647);
  assert.deepEqual(missing.statuses, ['process-gone']);
});
