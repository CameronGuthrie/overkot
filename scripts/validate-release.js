'use strict';

const fs = require('node:fs');
const { validateTag, releaseScope } = require('./release-artifacts');
const { findRelease } = require('../src/modules/releaseNotes');
const { spawnSync } = require('node:child_process');

function validateRelease({ tag, pkg, changelog, env, configuration = 'all' }) {
  const scope = releaseScope(tag, changelog);
  if (validateTag(tag) !== pkg.version) throw new Error('Tag and package version do not match.');
  const entry = findRelease(changelog, pkg.version);
  if (!Array.isArray(entry?.changes) || !entry.changes.length || !entry.changes.every(change => typeof change === 'string' && change.trim())) {
    throw new Error('Missing or invalid release notes in changelog.json.');
  }
  if (env.RELEASE_PUBLISH === 'true' && !/^\d+$/.test(env.RELEASE_SOURCE_RUN_ID || '')) {
    throw new Error('Promotion requires source_run_id from a successful same-commit staging run; packages must not be rebuilt during publication.');
  }
  const cdnSettings = ['AWS_DEPLOY_ROLE_ARN', 'CLOUDFRONT_DISTRIBUTION_ID_RELEASES'];
  const required = { source: [], cdn: cdnSettings, all: ['VIRUSTOTAL_API_KEY', ...cdnSettings] };
  if (!Object.hasOwn(required, configuration)) throw new Error('Unknown release configuration check.');
  for (const name of required[configuration]) {
    if (!env[name]?.trim()) throw new Error(`Required release secret ${name} is missing; publication cannot proceed.`);
  }
  if (env.RELEASE_PUBLISH !== 'true' && !env.MARKET_SOURCE_READ_KEY?.trim()) {
    throw new Error('Required release secret MARKET_SOURCE_READ_KEY is missing; the private Market frontend cannot be built.');
  }
  return scope;
}

function validateSourceTag(tag, run = spawnSync, { requireTag = false } = {}) {
  validateTag(tag);
  const reference = `refs/tags/${tag}`;
  const exists = run('git', ['show-ref', '--verify', '--quiet', reference], { encoding: 'utf8', windowsHide: true });
  // Manual staging may precede a tag, but cannot contradict an existing tag.
  if (exists.status === 1) {
    if (requireTag) throw new Error('Promotion requires an existing version tag at the staged source commit.');
    return;
  }
  if (exists.status !== 0) throw new Error('Could not verify the release tag.');
  const resolve = ref => {
    const result = run('git', ['rev-parse', `${ref}^{commit}`], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout?.trim())) throw new Error('Could not resolve the release source commit.');
    return result.stdout.trim();
  };
  if (resolve(reference) !== resolve('HEAD')) throw new Error('Existing release tag does not match the checked-out source commit.');
}

module.exports = { validateRelease, validateSourceTag };
if (require.main === module) {
  try {
    const configuration = { '--source': 'source', '--cdn': 'cdn' };
    const option = process.argv[2];
    if (option && !Object.hasOwn(configuration, option)) throw new Error('Unknown release validation option.');
    const scope = validateRelease({ tag: process.env.RELEASE_TAG, pkg: require('../package.json'), changelog: require('../changelog.json'),
      env: process.env, configuration: option ? configuration[option] : 'all' });
    validateSourceTag(process.env.RELEASE_TAG, spawnSync, { requireTag: process.env.RELEASE_PUBLISH === 'true' });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\nartifact_suffix=${scope === 'linux' ? '-linux' : ''}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
