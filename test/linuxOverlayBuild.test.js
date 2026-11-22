'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HELPER_NAME, parseOutputDirectory, buildLinuxOverlay } = require('../scripts/build-linux-overlay');
const root = path.resolve(__dirname, '..');

test('overlay helper outputs stay within build staging', () => {
  assert.equal(parseOutputDirectory(), path.join(root, '.build', 'bin'));
  assert.equal(parseOutputDirectory(['--output-dir', path.join(root, '.build', 'app', 'bin')]), path.join(root, '.build', 'app', 'bin'));
  for (const destination of [path.join(root, 'assets', 'bin'), path.join(root, '.build'), path.join(root, 'outside')]) {
    assert.throws(() => parseOutputDirectory(['--output-dir', destination]), /inside App\/\.build/);
  }
  for (const args of [['--output-dir'], ['--unknown'], ['--output-dir', '--bad'], ['--output-dir', 'x', '--extra']]) {
    assert.throws(() => parseOutputDirectory(args), /Usage:/);
  }
});

test('overlay helper compilation requires a Linux host', () => {
  let invoked = false;
  assert.throws(() => buildLinuxOverlay({ platform: 'win32', exec: () => { invoked = true; } }), /compiled on Linux/);
  assert.equal(invoked, false);
});

test('overlay helper build links X11 and stages one unprivileged hardened executable', t => {
  const outputDir = path.join(root, '.build', `overlay-build-test-${process.pid}`);
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  let invocation;
  const binary = buildLinuxOverlay({ platform: 'linux', outputDir, exec: (command, args) => {
    invocation = { command, args };
    fs.writeFileSync(args[args.indexOf('-o') + 1], Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } });
  assert.equal(invocation.command, 'cc');
  assert.ok(invocation.args.includes('-lX11'));
  assert.ok(invocation.args.includes('-fstack-protector-strong'));
  assert.ok(invocation.args.includes('-pie'));
  assert.ok(invocation.args.includes(path.join(root, 'native', 'linux-overlay-window.c')));
  assert.equal(binary, path.join(outputDir, HELPER_NAME));
  assert.deepEqual(fs.readdirSync(outputDir), [HELPER_NAME]);
  if (process.platform === 'linux') assert.equal(fs.statSync(binary).mode & 0o7777, 0o755);
});

test('overlay helper build rejects invalid output and cleans failed temporary artifacts', t => {
  const outputDir = path.join(root, '.build', `overlay-invalid-test-${process.pid}`);
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  assert.throws(() => buildLinuxOverlay({ platform: 'linux', outputDir, exec: (_command, args) => {
    fs.writeFileSync(args[args.indexOf('-o') + 1], 'not an ELF');
  } }), /ELF executable/);
  assert.deepEqual(fs.readdirSync(outputDir), []);
  assert.throws(() => buildLinuxOverlay({ platform: 'linux', outputDir, exec: (_command, args) => {
    fs.writeFileSync(args[args.indexOf('-o') + 1], 'partial');
    throw new Error('compiler failed');
  } }), /compiler failed/);
  assert.deepEqual(fs.readdirSync(outputDir), []);
});
