'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows is required');
  const root = path.resolve(__dirname, '..');
  const { NSIS_PATH, NsisTargetOptions } = require('app-builder-lib/out/targets/nsis/nsisUtil');
  NsisTargetOptions.resolve(require('../package.json').build.nsis);
  const nsis = await NSIS_PATH();
  const out = fs.mkdtempSync(path.join(root, 'output', 'installer-update-check-'));
  const executable = path.join(out, 'check.exe');
  const compilation = execFileSync(path.join(nsis, 'makensis.exe'), [
    '/WX', '/DOUTPUT_EXE=' + executable, '/DPROJECT_DIR=' + root, path.join(__dirname, 'check-installer-update.nsi'),
  ], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  fs.writeFileSync(path.join(out, 'compile.log'), compilation);
  execFileSync(executable, [], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  const report = fs.readFileSync(path.join(out, 'update-flow.txt'), 'utf8');
  assert.match(report, /installed=true/);
  assert.match(report, /header=Updating to Overkot 9\.8\.7/);
  assert.match(report, /status=Installing Overkot 9\.8\.7/);
  assert.match(report, /progress=msctls_progress32/i);
  assert.match(report, /reopened=true/);
  console.log(JSON.stringify({ ok: true, out, report }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
