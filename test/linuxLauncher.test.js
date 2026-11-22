'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installLinuxLauncher } = require('../scripts/prepare-linux-launcher');
const { createConfig, parseOptions } = require('../scripts/build');
const pkg = require('../package.json');
const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x02]);

function directory(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot launcher '));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  return out;
}

test('Linux afterPack installs its early launcher while other platforms retain locale checks', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const config = createConfig(pkg, parseOptions(['--dir'], { platform, arch: 'x64' }));
    assert.equal(path.basename(config.afterPack), platform === 'linux' ? 'prepare-linux-launcher.js' : 'verify-runtime-locales.js');
  }
});

test('launcher installation preserves the packaged ELF and is safe to repeat', t => {
  const out = directory(t);
  const executable = path.join(out, 'overkot');
  const runtime = path.join(out, 'overkot-bin');
  fs.writeFileSync(executable, elf);
  installLinuxLauncher(out);
  assert.deepEqual(fs.readFileSync(runtime), elf);
  const launcher = fs.readFileSync(executable, 'utf8');
  assert.match(launcher, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(launcher, /\r|--no-sandbox/);
  installLinuxLauncher(out);
  assert.equal(fs.readFileSync(executable, 'utf8'), launcher);
  assert.deepEqual(fs.readFileSync(runtime), elf);
});

test('launcher installation rejects unexpected files and protects an existing runtime', t => {
  const out = directory(t);
  fs.writeFileSync(path.join(out, 'overkot'), '#!/bin/sh\nexit 1\n');
  assert.throws(() => installLinuxLauncher(out), /Expected.*ELF/);
  fs.writeFileSync(path.join(out, 'overkot'), elf);
  fs.writeFileSync(path.join(out, 'overkot-bin'), 'existing runtime');
  assert.throws(() => installLinuxLauncher(out), /destination already exists/);
  assert.equal(fs.readFileSync(path.join(out, 'overkot-bin'), 'utf8'), 'existing runtime');
  assert.deepEqual(fs.readFileSync(path.join(out, 'overkot')), elf);
});

test('Linux launcher selects X11 before startup, preserves overrides, argument quoting and symlinks', { skip: process.platform !== 'linux' }, t => {
  const out = directory(t);
  const launcher = path.join(out, 'overkot');
  fs.writeFileSync(launcher, fs.readFileSync(path.join(__dirname, '../scripts/linux-launcher.sh'), 'utf8').replaceAll('\r\n', '\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(out, 'overkot-bin'), '#!/bin/sh\nprintf "%s\\0" "$@"\n', { mode: 0o755 });
  const link = path.join(out, 'native symlink');
  fs.symlinkSync(launcher, link);
  const inherited = { ...process.env, DISPLAY: ':99', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-qa',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland', OZONE_PLATFORM: 'auto' };
  delete inherited.ELECTRON_RUN_AS_NODE;
  const run = (args, extraEnv = {}, executable = launcher) => execFileSync(executable, args, { env: { ...inherited, ...extraEnv } })
    .toString('utf8').split('\0').filter((value, index, all) => index !== all.length - 1);
  const literal = ['space in value', '', "literal'quote", 'literal$(unwanted)', 'literal`unwanted`'];
  assert.deepEqual(run(literal), ['--ozone-platform=x11', ...literal]);
  assert.deepEqual(run(literal, {}, link), ['--ozone-platform=x11', ...literal]);
  assert.deepEqual(run(['--ozone-platform=wayland', 'file with spaces']), ['--ozone-platform=wayland', 'file with spaces']);
  assert.deepEqual(run(['--ozone-platform', 'wayland', '--log']), ['--ozone-platform', 'wayland', '--log']);
  assert.deepEqual(run(['--ozone-platform=x11', '--log']), ['--ozone-platform=x11', '--log']);
  assert.deepEqual(run(['--log', '--ozone-platform=auto']), ['--log', '--ozone-platform=x11']);
  assert.deepEqual(run(['--ozone-platform', 'auto', '--log']), ['--ozone-platform=x11', '--log']);
  assert.deepEqual(run(['--ozone-platform=auto', '--log'], { DISPLAY: '' }), ['--log']);
  assert.deepEqual(run(['--log'], { DISPLAY: '' }), ['--log']);
  assert.deepEqual(run(['--ozone-platform-hint=wayland']), ['--ozone-platform=wayland', '--ozone-platform-hint=wayland']);
  assert.deepEqual(run(['--', '--ozone-platform=wayland']), ['--ozone-platform=x11', '--', '--ozone-platform=wayland']);
  assert.deepEqual(run(['--ozone-platform=auto', '--log'], { ELECTRON_RUN_AS_NODE: '1' }), ['--ozone-platform=auto', '--log']);
});
