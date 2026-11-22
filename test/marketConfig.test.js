const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMarketApiKey } = require('../src/modules/marketConfig');

test('local configuration reads only the integration key and honors environment overrides', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-market-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, '.env.local');
  fs.writeFileSync(envFile, '# local key\nOVERKOT_MARKET_API_KEY="test-local-key"\nUNRELATED_SECRET=never-import\n');
  const env = {};
  assert.equal(readMarketApiKey({ env, envFile }), 'test-local-key');
  assert.deepEqual(env, {});
  assert.equal(readMarketApiKey({ env: { OVERKOT_MARKET_API_KEY: 'test-override' }, envFile }), 'test-override');
  assert.equal(readMarketApiKey({ env: {}, envFile: path.join(directory, 'absent'), bundledKey: 'test-bundled' }), '');
});

test('runtime compatibility credentials are opt-in and a bundled fallback is never accepted', () => {
  assert.equal(readMarketApiKey({ env: {}, bundledKey: 'test-bundled' }), '');
  assert.equal(readMarketApiKey({ env: { OVERKOT_MARKET_API_KEY: 'test-override' }, bundledKey: 'test-bundled' }), 'test-override');
  assert.equal(readMarketApiKey({ env: { OVERKOT_MARKET_API_KEY: '' }, bundledKey: 'test-bundled' }), '');
  assert.equal(readMarketApiKey({ env: {} }), '');
});

test('invalid header values are rejected without revealing the value', () => {
  for (const value of ['secret\nheader: value', 'secret key', 'x'.repeat(257)]) {
    assert.throws(() => readMarketApiKey({ env: { OVERKOT_MARKET_API_KEY: value } }), error => {
      assert.ok(!error.message.includes(value));
      return /OVERKOT_MARKET_API_KEY/.test(error.message);
    });
  }
});
