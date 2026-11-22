'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRelease, validateSourceTag } = require('../scripts/validate-release');

test('promotion requires a retained source run while staging permits a missing tag', () => {
  const secrets = Object.fromEntries(['VIRUSTOTAL_API_KEY', 'AWS_DEPLOY_ROLE_ARN', 'CLOUDFRONT_DISTRIBUTION_ID_RELEASES', 'OVERKOT_MARKET_API_KEY', 'MARKET_SOURCE_READ_KEY'].map(name => [name, 'configured']));
  const release = { tag: 'v0.0.13', pkg: { version: '0.0.13' }, changelog: { versions: [{ version: 'v0.0.13', changes: ['Dock and packages'] }] } };
  assert.doesNotThrow(() => validateRelease({ ...release, env: secrets }));
  assert.doesNotThrow(() => validateRelease({ ...release, configuration: 'source', env: { MARKET_SOURCE_READ_KEY: 'configured' } }));
  assert.throws(() => validateRelease({ ...release, configuration: 'source', env: {} }), /MARKET_SOURCE_READ_KEY/);
  const promotion = { RELEASE_PUBLISH: 'true', RELEASE_SOURCE_RUN_ID: '123',
    AWS_DEPLOY_ROLE_ARN: 'configured', CLOUDFRONT_DISTRIBUTION_ID_RELEASES: 'configured' };
  assert.doesNotThrow(() => validateRelease({ ...release, configuration: 'cdn', env: promotion }));
  assert.throws(() => validateRelease({ ...release, configuration: 'cdn', env: { ...promotion, AWS_DEPLOY_ROLE_ARN: '' } }), /AWS_DEPLOY_ROLE_ARN/);
  assert.throws(() => validateRelease({ ...release, env: { ...secrets, RELEASE_PUBLISH: 'true' } }), /source_run_id/);
  assert.doesNotThrow(() => validateRelease({ ...release, env: { ...secrets, RELEASE_PUBLISH: 'true', RELEASE_SOURCE_RUN_ID: '123' } }));
  const missing = () => ({ status: 1 });
  assert.doesNotThrow(() => validateSourceTag('v0.0.13', missing));
  assert.throws(() => validateSourceTag('v0.0.13', missing, { requireTag: true }), /existing version tag/);
});
