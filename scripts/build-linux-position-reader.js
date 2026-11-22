'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseOutputDirectory } = require('./build-linux-scanner');

const ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.join(ROOT, '.build');
const HELPER_NAME = 'overkot-position-reader';
const CORE_NAME = 'overkot-position-reader-core';
const NOTICES_NAME = 'overkot-position-reader-NOTICES.txt';

function writeReaderNotices(outputDir, { dotnetRoot, licenseRoot = '/usr/share' }) {
  const sources = [
    ['.NET license', path.join(dotnetRoot, 'LICENSE.txt')],
    ['.NET third-party notices', path.join(dotnetRoot, 'ThirdPartyNotices.txt')],
    ['OpenSSL distribution notices', path.join(licenseRoot, 'doc', 'libssl-dev', 'copyright')],
    ['OpenSSL Apache License 2.0', path.join(licenseRoot, 'common-licenses', 'Apache-2.0')],
  ];
  const sections = sources.map(([title, file]) => {
    const contents = fs.readFileSync(file, 'utf8');
    if (!contents.trim()) throw new Error(`Missing ${title} for the Linux position reader.`);
    return `${title}\n${'='.repeat(title.length)}\n\n${contents}`;
  });
  const destination = path.join(outputDir, NOTICES_NAME);
  fs.writeFileSync(destination, 'Overkot Linux position reader\n\nThis executable includes .NET NativeAOT and statically linked OpenSSL.\n'
    + 'The following license and attribution texts accompany those components.\n\n' + sections.join('\n\n') + '\n', { mode: 0o644 });
  return destination;
}

function validateElf(compiled) {
  const header = fs.readFileSync(compiled).subarray(0, 20);
  if (header.length < 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
    throw new Error('The Linux position reader compiler did not produce a Linux x64 ELF executable.');
  }
}

function buildLinuxPositionReader({ outputDir = parseOutputDirectory(), platform = process.platform,
  arch = process.arch, exec = execFileSync, dotnetRoot, licenseRoot } = {}) {
  outputDir = parseOutputDirectory(['--output-dir', outputDir]);
  if (platform !== 'linux' || arch !== 'x64') throw new Error('The Linux position reader must be compiled on Linux x64 with the .NET 8 SDK, clang, CMake, OpenSSL and zlib development files.');
  fs.mkdirSync(outputDir, { recursive: true });
  const relative = path.relative(fs.realpathSync(BUILD_ROOT), fs.realpathSync(outputDir));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Linux position reader output cannot resolve outside App/.build');
  }
  if (!dotnetRoot) {
    const listing = exec('dotnet', ['--list-sdks'], { encoding: 'utf8', timeout: 60000 });
    const sdk = [...String(listing).matchAll(/^\S+\s+\[([^\]\r\n]+)\]/gm)].at(-1);
    if (!sdk) throw new Error('Could not locate .NET redistribution notices for the Linux position reader.');
    dotnetRoot = path.dirname(sdk[1]);
  }
  writeReaderNotices(outputDir, { dotnetRoot, licenseRoot });
  const intermediate = path.join(BUILD_ROOT, 'linux-position-reader', createHash('sha256').update(outputDir).digest('hex').slice(0, 12));
  const publish = path.join(intermediate, 'publish');
  const binary = path.join(outputDir, HELPER_NAME);
  exec('dotnet', ['publish', path.join(ROOT, 'native', 'linux-player-position-reader.csproj'),
    '--configuration', 'Release', '--runtime', 'linux-x64', '--output', publish,
    '--nologo', '--disable-build-servers',
    `-p:BaseIntermediateOutputPath=${path.join(intermediate, 'obj')}${path.sep}`,
    `-p:BaseOutputPath=${path.join(intermediate, 'bin')}${path.sep}`,
    '-p:DebugType=None'], { cwd: ROOT, stdio: 'inherit', timeout: 300000 });
  const compiled = path.join(publish, CORE_NAME);
  validateElf(compiled);
  const launcher = path.join(intermediate, HELPER_NAME);
  exec('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong',
    '-fPIE', '-pie', '-Wl,-z,relro,-z,now,-z,noexecstack',
    path.join(ROOT, 'native', 'linux-position-launcher.c'), '-o', launcher], { cwd: ROOT, stdio: 'inherit', timeout: 60000 });
  validateElf(launcher);
  fs.copyFileSync(compiled, path.join(outputDir, CORE_NAME));
  fs.chmodSync(path.join(outputDir, CORE_NAME), 0o755);
  fs.copyFileSync(launcher, binary);
  fs.chmodSync(binary, 0o755);
  console.log(`[build] Linux position reader: ${binary}`);
  return binary;
}

module.exports = { HELPER_NAME, CORE_NAME, NOTICES_NAME, buildLinuxPositionReader, writeReaderNotices, parseOutputDirectory };
if (require.main === module) {
  try { buildLinuxPositionReader({ outputDir: parseOutputDirectory(process.argv.slice(2)) }); }
  catch (error) { console.error('[build-linux-position-reader]', error.message); process.exitCode = 1; }
}
