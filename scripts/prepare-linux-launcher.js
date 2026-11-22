'use strict';

const fs = require('node:fs');
const path = require('node:path');
const verifyLocales = require('./verify-runtime-locales');

function installLinuxLauncher(appOutDir) {
  const executable = path.join(appOutDir, 'overkot');
  const runtime = path.join(appOutDir, 'overkot-bin');
  const launcher = fs.readFileSync(path.join(__dirname, 'linux-launcher.sh'), 'utf8').replaceAll('\r\n', '\n');
  const header = fs.readFileSync(executable).subarray(0, 4);
  if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (fs.readFileSync(executable, 'utf8') === launcher && fs.existsSync(runtime)
      && fs.readFileSync(runtime).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      fs.chmodSync(executable, 0o755);
      fs.chmodSync(runtime, 0o755);
      return;
    }
    throw new Error('Expected the packaged Linux Electron ELF before installing its display launcher.');
  }
  if (fs.existsSync(runtime)) throw new Error('The packaged Linux runtime destination already exists.');
  fs.renameSync(executable, runtime);
  fs.writeFileSync(executable, launcher, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  fs.chmodSync(runtime, 0o755);
  console.log('[build] Installed early X11/XWayland launcher; native display overrides remain available');
}

module.exports = context => {
  verifyLocales(context);
  if (context.packager.platform.nodeName === 'linux') installLinuxLauncher(context.appOutDir);
};
module.exports.installLinuxLauncher = installLinuxLauncher;
