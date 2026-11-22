'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HELPER_NAME, parseOutputDirectory, buildLinuxScanner } = require('../scripts/build-linux-scanner');
const root = path.resolve(__dirname, '..');

test('Linux helper outputs are limited to build staging and cannot target assets or installed files', () => {
  assert.equal(parseOutputDirectory(), path.join(root, '.build', 'bin'));
  assert.equal(parseOutputDirectory(['--output-dir', path.join(root, '.build', 'app', 'bin')]), path.join(root, '.build', 'app', 'bin'));
  for (const destination of [path.join(root, 'assets', 'bin'), path.join(root, '.build'), path.join(root, '.build', '..', 'outside')]) {
    assert.throws(() => parseOutputDirectory(['--output-dir', destination]), /inside App\/\.build/);
  }
  for (const args of [['--output-dir'], ['--unknown'], ['--output-dir', '--bad'], ['--output-dir', 'x', '--extra']]) {
    assert.throws(() => parseOutputDirectory(args), /Usage:/);
  }
});

test('non-Linux hosts fail before attempting compiler execution', () => {
  let invoked = false;
  assert.throws(() => buildLinuxScanner({ platform: 'win32', exec: () => { invoked = true; } }), /compiled on Linux/);
  assert.equal(invoked, false);
});

test('Linux build stages one native executable with compiler hardening and no Windows scanner', t => {
  const outputDir = path.join(root, '.build', `scanner-build-test-${process.pid}`);
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  let invocation;
  const result = buildLinuxScanner({ platform: 'linux', outputDir, exec: (command, args) => {
    invocation = { command, args };
    fs.writeFileSync(args[args.indexOf('-o') + 1], Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } });
  assert.equal(invocation.command, 'cc');
  assert.ok(invocation.args.includes('-fstack-protector-strong'));
  assert.ok(invocation.args.includes('-pie'));
  assert.ok(invocation.args.includes(path.join(root, 'native', 'linux-session-scanner.c')));
  assert.equal(result, path.join(outputDir, HELPER_NAME));
  assert.deepEqual(fs.readdirSync(outputDir), [HELPER_NAME]);
  if (process.platform === 'linux') assert.equal(fs.statSync(result).mode & 0o7777, 0o755);
});

test('invalid compiler output is rejected and temporary artifacts are removed', t => {
  const outputDir = path.join(root, '.build', `scanner-invalid-test-${process.pid}`);
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  assert.throws(() => buildLinuxScanner({ platform: 'linux', outputDir, exec: (_command, args) => {
    fs.writeFileSync(args[args.indexOf('-o') + 1], 'not an ELF');
  } }), /ELF executable/);
  assert.deepEqual(fs.readdirSync(outputDir), []);
});
