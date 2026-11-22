'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startLayoutKeyMonitor } = require('../src/modules/layoutKeyMonitor');

function fixture(platform = 'win32') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let kills = 0;
  child.kill = () => { kills++; child.emit('exit', 0); };
  const shifts = [], buttons = [], foreground = [], errors = [], launches = [];
  const monitor = startLayoutKeyMonitor({ platform, parentPid: 321,
    onShift: active => shifts.push(active), onButtonUp: () => buttons.push('up'), onError: error => errors.push(error),
    onForeground: pid => foreground.push(pid),
    spawnProcess: (...args) => { launches.push(args); return child; } });
  return { child, monitor, shifts, buttons, foreground, errors, launches, get kills() { return kills; },
    output: text => child.stdout.emit('data', Buffer.from(text)) };
}

test('Windows layout monitor launches hidden PowerShell without a profile using an encoded fixed script', () => {
  const f = fixture();
  assert.equal(f.launches.length, 1);
  const [executable, args, options] = f.launches[0];
  assert.equal(executable, 'powershell.exe');
  for (const flag of ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']) assert.ok(args.includes(flag), flag);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.shell, undefined);
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(script, /Get-Process -Id 321/);
  assert.deepEqual([...script.matchAll(/GetAsyncKeyState\((\d+)\)/g)].map(match => Number(match[1])), [16, 1],
    'only Shift and the drag button are observed');
  assert.match(script, /Start-Sleep -Milliseconds 30/);
  assert.match(script, /GetForegroundWindow\(\)/);
  assert.match(script, /GetWindowThreadProcessId\(\$foregroundWindow/);
  f.monitor.stop();
});

test('monitor reconstructs fragmented lines and accepts only Shift transitions and button releases', () => {
  const f = fixture();
  f.output('shift:');
  assert.deepEqual(f.shifts, []);
  f.output('1\r');
  assert.deepEqual(f.shifts, [], 'a partial CRLF is not a complete event');
  f.output('\nbutton:u');
  assert.deepEqual(f.shifts, [true]);
  f.output('p\nshift:0\nshift:2\nbutton:down\nkey:A\n shift:1\n');
  assert.deepEqual(f.shifts, [true, false]);
  assert.deepEqual(f.buttons, ['up']);
  assert.deepEqual(f.errors, []);
  f.monitor.stop();
});

test('helper errors and unexpected exits release Shift and report the failure with bounded diagnostics', () => {
  const spawnFailure = fixture();
  spawnFailure.output('shift:1\n');
  const error = new Error('Cannot start PowerShell');
  spawnFailure.child.emit('error', error);
  assert.deepEqual(spawnFailure.shifts, [true, false]);
  assert.deepEqual(spawnFailure.errors, [error]);
  spawnFailure.monitor.stop();

  const exited = fixture();
  exited.output('shift:1\n');
  exited.child.stderr.emit('data', Buffer.from('x'.repeat(3000) + ' failed'));
  exited.child.emit('exit', 5);
  assert.deepEqual(exited.shifts, [true, false]);
  assert.equal(exited.errors.length, 1);
  assert.match(exited.errors[0].message, /stopped \(5\)/);
  assert.match(exited.errors[0].message, /failed$/);
  assert.ok(exited.errors[0].message.length < 2100, 'large helper output does not flood the failure message');
  exited.monitor.stop();
});

test('foreground samples are reconstructed, repeated and restricted to valid nonzero PIDs', () => {
  const f = fixture();
  f.output('foreground:12');
  f.output('3\r\nforeground:123\nforeground:0\nforeground:-2\nforeground:no\nforeground:99999999999999999999\n');
  assert.deepEqual(f.foreground, [123, 123]);
  f.monitor.stop();
  f.output('foreground:456\n');
  assert.deepEqual(f.foreground, [123, 123]);
});

test('stopping kills the helper and ignores late output, errors and expected exit events', () => {
  const f = fixture();
  f.monitor.stop();
  assert.equal(f.kills, 1);
  f.output('shift:1\nbutton:up\n');
  f.child.emit('error', new Error('Late child error'));
  f.child.emit('exit', 1);
  assert.deepEqual(f.shifts, []);
  assert.deepEqual(f.buttons, []);
  assert.deepEqual(f.errors, []);
});

test('other platforms do not launch a Windows helper and expose safe cleanup', () => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture(platform);
    assert.deepEqual(f.launches, [], platform);
    assert.doesNotThrow(() => f.monitor.stop());
    assert.equal(f.kills, 0);
  }
});
