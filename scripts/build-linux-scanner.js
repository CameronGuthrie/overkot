'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.join(ROOT, '.build');
const HELPER_NAME = 'overkot-session-scanner';

function parseOutputDirectory(args = []) {
  if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1] || args[1].startsWith('--'))) {
    throw new Error('Usage: node scripts/build-linux-scanner.js [--output-dir .build/bin]');
  }
  const outputDir = args.length ? path.resolve(args[1]) : path.join(BUILD_ROOT, 'bin');
  const relative = path.relative(BUILD_ROOT, outputDir);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Linux scanner output must be inside App/.build');
  }
  return outputDir;
}

function buildLinuxScanner({ outputDir = parseOutputDirectory(), platform = process.platform, exec = execFileSync } = {}) {
  outputDir = parseOutputDirectory(['--output-dir', outputDir]);
  if (platform !== 'linux') throw new Error('The Linux session scanner must be compiled on Linux with a C compiler (install build-essential).');
  fs.mkdirSync(outputDir, { recursive: true });
  const actualBuildRoot = fs.realpathSync(BUILD_ROOT);
  const actualOutput = fs.realpathSync(outputDir);
  const relative = path.relative(actualBuildRoot, actualOutput);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Linux scanner output cannot resolve outside App/.build');
  }
  const binary = path.join(outputDir, HELPER_NAME);
  const temporary = `${binary}.tmp`;
  try {
    fs.rmSync(temporary, { force: true });
    exec('cc', [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong',
      '-fPIE', '-pie', '-Wl,-z,relro,-z,now,-z,noexecstack',
      path.join(ROOT, 'native', 'linux-session-scanner.c'), '-o', temporary,
    ], { cwd: ROOT, stdio: 'inherit', timeout: 60000 });
    const header = fs.readFileSync(temporary).subarray(0, 4);
    if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('The Linux compiler did not produce an ELF executable.');
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, binary);
    console.log(`[build] Linux session scanner: ${binary}`);
    return binary;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { HELPER_NAME, parseOutputDirectory, buildLinuxScanner };
if (require.main === module) {
  try {
    buildLinuxScanner({ outputDir: parseOutputDirectory(process.argv.slice(2)) });
  } catch (error) {
    console.error('[build-linux-scanner]', error.message);
    process.exitCode = 1;
  }
}
