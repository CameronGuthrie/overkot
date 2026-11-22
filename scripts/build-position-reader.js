const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function buildPositionReader({ outputDir = path.join(ROOT, 'assets', 'bin'), platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('The player position reader currently supports Windows only');
  const destination = path.resolve(outputDir);
  const buildRoot = path.join(ROOT, '.build');
  if (destination !== path.join(ROOT, 'assets', 'bin') && !destination.startsWith(buildRoot + path.sep)) {
    throw new Error('Player position reader output must be assets/bin or inside App/.build');
  }
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const intermediate = path.join(buildRoot, 'position-reader');
  fs.mkdirSync(intermediate, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  const executable = path.join(intermediate, 'overkot-position-reader.exe');
  execFileSync(compiler, ['/nologo', '/optimize+', '/unsafe+', '/platform:x64', '/target:exe', `/out:${executable}`,
    path.join(ROOT, 'native', 'player-position-reader.cs'), path.join(ROOT, 'native', 'world-drop-shiny.cs')], { stdio: 'pipe', windowsHide: true });
  const output = path.join(destination, 'overkot-position-reader.exe');
  fs.copyFileSync(executable, output);
  return output;
}

if (require.main === module) {
  const flag = process.argv.indexOf('--output-dir');
  if (flag !== -1 && !process.argv[flag + 1]) throw new Error('--output-dir requires a path');
  const output = buildPositionReader(flag === -1 ? {} : { outputDir: process.argv[flag + 1] });
  console.log(`Built player position reader: ${path.relative(ROOT, output)}`);
}

module.exports = { buildPositionReader };
