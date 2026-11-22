'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readAsset, releaseAssets, releaseScope, validateTag, validatePublication } = require('./release-artifacts');

function awsClient(bucket = 'overkot-releases', run = spawnSync) {
  function aws(args) {
    const result = run('aws', [...args, '--no-cli-pager', '--output', 'json'], { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const error = new Error('Release CDN request failed.');
      error.exists = /PreconditionFailed|412/.test(result.stderr || '');
      throw error;
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  }
  return {
    async immutable(asset) {
      const checksum = Buffer.from(asset.digest.slice(7), 'hex').toString('base64');
      try {
        const result = aws(['s3api', 'put-object', '--bucket', bucket, '--key', `releases/${asset.name}`, '--body', asset.path,
          '--if-none-match', '*', '--checksum-algorithm', 'SHA256', '--checksum-sha256', checksum,
          '--cache-control', 'public,max-age=31536000,immutable', '--content-type', asset.name.endsWith('.json') ? 'application/json' : 'application/octet-stream']);
        if (result.ChecksumSHA256 !== checksum) throw new Error(`S3 checksum verification failed for ${asset.name}.`);
      } catch (error) {
        if (!error.exists) throw error;
        // Older uploads may have only a multipart checksum. Compare downloaded bytes.
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-cdn-'));
        const downloaded = path.join(directory, asset.name);
        try {
          aws(['s3api', 'get-object', '--bucket', bucket, '--key', `releases/${asset.name}`, downloaded]);
          if (readAsset(directory, asset.name).digest !== asset.digest) throw new Error(`Existing ${asset.name} differs from the immutable release; use a new version.`);
        } finally {
          if (fs.existsSync(downloaded)) fs.unlinkSync(downloaded);
          fs.rmdirSync(directory);
        }
      }
    },
    async pointer(name, file, contentType) {
      aws(['s3api', 'put-object', '--bucket', bucket, '--key', `releases/${name}`, '--body', file,
        '--cache-control', 'no-cache', '--content-type', contentType]);
    },
    async invalidate(distribution, pointers = ['latest.json', 'latest.yml', 'changelog.json', 'overkot.exe']) {
      if (!distribution) throw new Error('CLOUDFRONT_DISTRIBUTION_ID_RELEASES is required.');
      aws(['cloudfront', 'create-invalidation', '--distribution-id', distribution, '--paths',
        ...pointers.map(name => `/releases/${name}`)]);
    },
  };
}

function validateUpdater(yaml, tag, installer, sha512) {
  const one = (text, pattern) => {
    const matches = [...text.matchAll(pattern)];
    return matches.length === 1 ? matches[0][1] : undefined;
  };
  const files = one(yaml, /^files:[ \t]*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))+)/gm) || '';
  if (one(yaml, /^version:[ \t]*(\S+)[ \t]*$/gm) !== validateTag(tag)
      || one(yaml, /^path:[ \t]*(\S+)[ \t]*$/gm) !== installer.name
      || one(yaml, /^sha512:[ \t]*(\S+)[ \t]*$/gm) !== sha512
      || one(files, /^[ \t]+-[ \t]+url:[ \t]*(\S+)[ \t]*$/gm) !== installer.name
      || one(files, /^[ \t]+sha512:[ \t]*(\S+)[ \t]*$/gm) !== sha512
      || one(files, /^[ \t]+size:[ \t]*(\d+)[ \t]*$/gm) !== String(installer.size)) {
    throw new Error('Windows updater metadata does not match the release.');
  }
}

async function publishCdn({ directory, tag, client, changelog = 'changelog.json', distribution, requirePortable = true, requireArch = true, scope = 'all' }) {
  const assets = releaseAssets(directory, tag, { scope, requireLinux: true, requirePortable, requireArch, requireMetadata: true });
  const metadata = assets.find(asset => asset.name === `release-${validateTag(tag)}.json`);
  validatePublication(JSON.parse(fs.readFileSync(metadata.path, 'utf8')), { requireCurrentSchema: requireArch });
  const updater = path.resolve(directory, 'latest.yml');
  const installer = assets[0];
  if (scope !== 'linux') {
    const yaml = fs.readFileSync(updater, 'utf8');
    const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer.path)).digest('base64');
    validateUpdater(yaml, tag, installer, sha512);
  }
  // Validate every input before publishing, then commit the discoverable pointers last.
  fs.accessSync(changelog);
  if (!distribution) throw new Error('CLOUDFRONT_DISTRIBUTION_ID_RELEASES is required.');
  for (const asset of assets) await client.immutable(asset);
  if (scope === 'linux') {
    await client.pointer('changelog.json', path.resolve(changelog), 'application/json');
    await client.pointer('latest-linux.json', metadata.path, 'application/json');
    await client.invalidate(distribution, ['latest-linux.json', 'changelog.json']);
    return;
  }
  await client.pointer('overkot.exe', installer.path, 'application/octet-stream');
  await client.pointer('changelog.json', path.resolve(changelog), 'application/json');
  await client.pointer('latest.yml', updater, 'text/yaml');
  await client.pointer('latest.json', metadata.path, 'application/json');
  await client.invalidate(distribution);
}

async function main() {
  await publishCdn({ directory: process.env.RELEASE_DIRECTORY || 'dist', tag: process.env.RELEASE_TAG,
    client: awsClient(), distribution: process.env.CLOUDFRONT_DISTRIBUTION_ID_RELEASES,
    requirePortable: process.env.RELEASE_REQUIRE_PORTABLE !== 'false', requireArch: process.env.RELEASE_REQUIRE_ARCH !== 'false',
    scope: releaseScope(process.env.RELEASE_TAG, require('../changelog.json')) });
  console.log('Published verified release files and platform download metadata.');
}

module.exports = { awsClient, publishCdn, validateUpdater };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
