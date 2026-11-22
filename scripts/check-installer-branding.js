#!/usr/bin/env node
'use strict';

// Exercise the real installer bitmap functions without installing the app or
// showing a wizard. The NSIS harness owns its hidden test control and files.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

async function main() {
  if (process.platform !== 'win32') throw new Error('The native installer branding check requires Windows');
  if (process.argv.length > 2) throw new Error('Usage: node scripts/check-installer-branding.js');
  const root = path.resolve(__dirname, '..');
  require('./build-app-icons').validateAppIcons({ root });
  const { NSIS_PATH, NsisTargetOptions } = require('app-builder-lib/out/targets/nsis/nsisUtil');
  NsisTargetOptions.resolve(require('../package.json').build.nsis || {});
  const nsis = await NSIS_PATH();
  const parent = path.join(root, 'output', 'app-icon-quality');
  fs.mkdirSync(parent, { recursive: true });
  const out = fs.mkdtempSync(path.join(parent, 'native-check-'));
  const executable = path.join(out, 'check.exe');
  const options = { cwd: __dirname, windowsHide: true, encoding: 'utf8', timeout: 60000 };
  fs.writeFileSync(path.join(out, 'compile.log'), execFileSync(path.join(nsis, 'makensis.exe'), [
    '/WX', '/DOUTPUT_EXE=' + executable, '/DSOURCE_BITMAP=' + path.join(root, 'assets', 'installer-header.bmp'),
    path.join(__dirname, 'check-installer-branding.nsi'),
  ], options));
  execFileSync(executable, [], options);
  const result = fs.readFileSync(path.join(out, 'nsis-branding-check.txt'), 'utf8');
  assert.match(result, /ok=true/);
  assert.match(result, /registersPreserved=true/);
  const before = Number(/gdiBefore=(\d+)/.exec(result)?.[1]);
  const after = Number(/gdiAfter=(\d+)/.exec(result)?.[1]);
  assert(Number.isSafeInteger(before) && Number.isSafeInteger(after) && after <= before, 'native bitmap handles are released');
  const images = [];
  for (const scale of [1, 2]) {
    const direct = fs.readFileSync(path.join(out, `nsis-halftone-${scale}.bmp`));
    const control = fs.readFileSync(path.join(out, `nsis-control-halftone-${scale}.bmp`));
    assert(direct.equals(control), 'the image control uses the same high-quality pixels as the resizer');
    assert.equal(direct.toString('ascii', 0, 2), 'BM');
    assert.equal(direct.readInt32LE(18), 150 * scale);
    assert.equal(Math.abs(direct.readInt32LE(22)), 57 * scale);
    assert.equal(direct.readUInt16LE(28), 32);
    images.push({ scale, width: 150 * scale, height: 57 * scale, controlMatches: true });
  }
  const report = { ok: true, registersPreserved: true, gdiBefore: before, gdiAfter: after, images, out };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
