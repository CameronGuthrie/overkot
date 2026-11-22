// Use the packaged executable, DLLs, ICU data and locales. Development Electron
// has additional resources that can hide omissions in the packaged runtime.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runPackagedCheck(script, args, timeout = 60000, options = {}) {
  const root = path.resolve(__dirname, '..');
  const source = path.resolve(process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist', process.platform === 'linux' ? 'linux-unpacked' : 'win-unpacked'));
  const executable = process.platform === 'linux' ? 'overkot' : 'Overkot.exe';
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'output', 'packaged-runtime-'));
  if (!fs.existsSync(path.join(source, executable))) throw new Error('Build or install the packaged app before running this check');
  function linkTree(from, to, relative = '') {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      const input = path.join(from, entry.name), output = path.join(to, entry.name);
      if (next === path.join('resources', 'app.asar')) continue;
      if (next === path.join('resources', 'bin')) {
        // Exercise the packaged fullscreen helper, while keeping game-memory
        // scanners out of these isolated renderer/window checks.
        const overlay = path.join(input, 'overkot-overlay-window');
        if (process.platform === 'linux' && fs.existsSync(overlay)) {
          fs.mkdirSync(output, { recursive: true });
          fs.copyFileSync(overlay, path.join(output, 'overkot-overlay-window'));
          fs.chmodSync(path.join(output, 'overkot-overlay-window'), 0o755);
        }
        continue;
      }
      if (entry.isDirectory()) linkTree(input, output, next);
      else if (process.platform === 'linux' && entry.name === 'chrome-sandbox') fs.symlinkSync(input, output);
      else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(input), output);
      else {
        try { fs.linkSync(input, output); }
        catch (error) {
          if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
          fs.copyFileSync(input, output);
        }
      }
    }
  }
  linkTree(source, directory);
  const fixture = path.join(directory, 'resources', 'app');
  fs.mkdirSync(fixture, { recursive: true });
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({name:'overkot-check',version,main:'main.cjs'}));
  // Skip auto-updates in the isolated check; retain the actual bundled main
  // process, native window behavior and native runtime resources.
  fs.writeFileSync(path.join(fixture, 'main.cjs'), `Object.defineProperty(require('electron').app,'isPackaged',{get:()=>false});require(${JSON.stringify(script)});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawnSync(path.join(directory, executable), ['--lang=en-GB', ...args], {
    env, stdio: 'inherit', windowsHide: options.windowsHide ?? true, timeout,
  });
}
module.exports = { runPackagedCheck };
