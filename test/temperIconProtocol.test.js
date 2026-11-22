'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTemperIconHandler } = require('../src/modules/temperIconProtocol');

test('both icon sessions use verified cache paths and only request a manifest for a cold miss', async () => {
  const key = 'temper-icons/' + 'a'.repeat(64) + '.png';
  const url = 'overkot-map-tiles://data/' + key;
  const calls = [];
  let file = null;
  const manager = {
    cachedPath(requested) { assert.equal(requested, key); return file; },
    async checkForUpdates() { calls.push('manifest'); this.manifest = { files: { [key]: {} } }; },
    async ensureAsset(requested) { assert.equal(requested, key); calls.push('asset'); return file; },
  };
  const handle = createTemperIconHandler(manager);
  const read = (url, method = 'GET') => new Promise(resolve => handle({ url, method }, resolve));
  for (const invalid of [url + '?v=1', url + '#icon', url.replace('data/', 'other/'), url.replace('data/', 'user@data/'),
    url.replace('temper-icons/', 'map-icons/'), url.replace('.png', '.webp'), url.replace('temper-icons/', '%74emper-icons/')]) {
    assert.deepEqual(await read(invalid), { error: -10 });
  }
  assert.deepEqual(await read(url, 'POST'), { error: -10 });
  assert.deepEqual(calls, []);
  assert.deepEqual(await read(url), { error: -6 });
  assert.deepEqual(calls.splice(0), ['manifest', 'asset']);
  file = 'verified-cache-thumbnail.png';
  assert.deepEqual(await read(url), { path: file });
  assert.deepEqual(calls.splice(0), ['asset']);
  manager.manifest = null;
  assert.deepEqual(await read(url, 'HEAD'), { path: file });
  assert.deepEqual(calls, ['asset']);
});
