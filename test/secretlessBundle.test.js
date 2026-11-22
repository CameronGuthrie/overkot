'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('a standalone production bundle excludes a runtime integration credential', { timeout: 60000 }, t => {
  const root = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(root, '.build'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.build', 'secretless-bundle-test-'));
  const output = path.join(directory, 'src');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sentinel = 'synthetic-runtime-only-market-key-for-bundle-audit';
  execFileSync(process.execPath, ['-e', 'require("./scripts/bundle").bundle({outDir: process.argv[1]}).catch(error => { console.error(error.message); process.exit(1); })', output], {
    cwd: root, windowsHide: true, stdio: 'pipe', timeout: 55000,
    env: { ...process.env, OVERKOT_MARKET_UI: 'disabled', OVERKOT_MARKET_API_KEY: sentinel },
  });
  const main = fs.readFileSync(path.join(output, 'main.js'), 'utf8');
  assert.equal(main.includes(sentinel), false);
  assert.equal(main.includes('__OVERKOT_MARKET_API_KEY__'), false);
  assert.ok(fs.existsSync(path.join(output, 'modules', 'gameDataImages.js')));
  assert.ok(fs.existsSync(path.join(output, 'renderer', 'widget-host.html')));
});
