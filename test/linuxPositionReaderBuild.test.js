'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HELPER_NAME, CORE_NAME, NOTICES_NAME, buildLinuxPositionReader, writeReaderNotices } = require('../scripts/build-linux-position-reader');
const root = path.resolve(__dirname, '..');

test('Linux position reader requires a Linux x64 compiler host', () => {
  for (const host of [{ platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }]) {
    assert.throws(() => buildLinuxPositionReader({ ...host, exec: () => assert.fail('compiler must not run') }), /Linux x64/);
  }
});

test('Linux position reader publishes a narrow launcher and native core without requiring an installed runtime', t => {
  const outputDir = path.join(root, '.build', `position-build-test-${process.pid}`);
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const dotnetRoot = path.join(outputDir, 'licenses');
  const licenseRoot = dotnetRoot;
  const files = [path.join(dotnetRoot, 'LICENSE.txt'), path.join(dotnetRoot, 'ThirdPartyNotices.txt'),
    path.join(licenseRoot, 'doc', 'libssl-dev', 'copyright'), path.join(licenseRoot, 'common-licenses', 'Apache-2.0')];
  files.forEach((file, index) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `Complete upstream notice ${index}\n`); });
  const result = buildLinuxPositionReader({ platform: 'linux', arch: 'x64', outputDir, dotnetRoot, licenseRoot, exec: (command, args) => {
    const header = Buffer.alloc(20); header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); header.writeUInt16LE(62, 18);
    if (command === 'dotnet') {
      assert.equal(args[0], 'publish');
      assert.equal(args[args.indexOf('--runtime') + 1], 'linux-x64');
      const output = args[args.indexOf('--output') + 1];
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, CORE_NAME), header);
    } else {
      assert.equal(command, 'cc');
      assert.ok(args.includes('-fstack-protector-strong'));
      fs.writeFileSync(args[args.indexOf('-o') + 1], header);
    }
  } });
  assert.equal(result, path.join(outputDir, HELPER_NAME));
  assert.deepEqual(fs.readdirSync(outputDir).sort(), [HELPER_NAME, CORE_NAME, NOTICES_NAME, 'licenses'].sort());
  const notices = fs.readFileSync(path.join(outputDir, NOTICES_NAME), 'utf8');
  files.forEach((file, index) => assert.ok(notices.includes(`Complete upstream notice ${index}\n`)));
  fs.writeFileSync(files[2], '');
  assert.throws(() => writeReaderNotices(outputDir, { dotnetRoot, licenseRoot }), /Missing OpenSSL distribution notices/);
  const project = fs.readFileSync(path.join(root, 'native', 'linux-player-position-reader.csproj'), 'utf8');
  assert.match(project, /<PublishAot>true<\/PublishAot>/);
  assert.match(project, /<StaticOpenSslLinking>true<\/StaticOpenSslLinking>/);
});
