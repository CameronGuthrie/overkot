'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { RELEASES_URL, packageNames, releaseScope, releaseAssets, validateTag, readAsset, validateMetadata, validatePublication } = require('./release-artifacts');
const { githubJson, validateSourceRun } = require('./retained-release');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const matches = (remote, asset) => remote?.state === 'uploaded'
  && remote.size === asset.size && remote.digest === asset.digest;

function validatePublicationAssets(tag, assets, { requireCurrentSchema = false } = {}) {
  const manifest = assets.find(asset => asset.name === `release-${validateTag(tag)}.json`);
  if (!manifest) {
    if (requireCurrentSchema) throw new Error('New releases require their retained schemaVersion 2 manifest.');
    return;
  }
  if (readAsset(path.dirname(manifest.path), manifest.name).digest !== manifest.digest) throw new Error('Retained release metadata changed before publication.');
  const metadata = validateMetadata(JSON.parse(fs.readFileSync(manifest.path, 'utf8')), tag, assets);
  validatePublication(metadata, { requireCurrentSchema });
}

async function publishRelease({ tag, assets, client, sleep = pause, attempts = 3, log = console.log, requireCurrentSchema = false }) {
  validateTag(tag);
  validatePublicationAssets(tag, assets, { requireCurrentSchema });
  let release = await client.readRelease(tag);
  if (!release) release = await client.createRelease(tag, assets);
  for (const asset of assets) {
    let verified = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        release = await client.readRelease(tag);
        if (!release) throw new Error('GitHub release is not yet available for upload.');
        const existing = release.assets.find(value => value.name === asset.name);
        if (matches(existing, asset)) { verified = true; break; }
        if (existing?.state === 'uploaded') {
          const error = new Error(`Existing ${asset.name} differs from the immutable published artifact.`);
          error.permanent = true;
          throw error;
        }
        if (existing) {
          if (existing.state !== 'starter') {
            const error = new Error(`Cannot safely replace incomplete asset ${asset.name}.`);
            error.permanent = true;
            throw error;
          }
          await client.deleteAsset(existing.id);
        }
        await client.uploadAsset(tag, asset);
        release = await client.readRelease(tag);
        if (!matches(release?.assets.find(value => value.name === asset.name), asset)) {
          throw new Error(`GitHub upload verification failed for ${asset.name}.`);
        }
        verified = true;
        break;
      } catch (error) {
        if (error.permanent) throw error;
        // A timeout can lose the response after GitHub has stored the bytes.
        // Reconcile the digest before retrying or declaring the upload failed.
        const reconciled = await client.readRelease(tag).catch(() => null);
        if (matches(reconciled?.assets.find(value => value.name === asset.name), asset)) {
          verified = true;
          break;
        }
        if (attempt === attempts) throw new Error(`GitHub upload failed for ${asset.name} after ${attempts} attempts. ${error.message}`);
        log(`Retrying GitHub upload for ${asset.name} (${attempt + 1}/${attempts}).`);
        await sleep(attempt * 5000);
      }
    }
    if (!verified) throw new Error(`GitHub upload was not verified for ${asset.name}.`);
  }
  release = await client.readRelease(tag);
  if (!assets.every(asset => matches(release?.assets.find(value => value.name === asset.name), asset))) {
    throw new Error('GitHub release assets changed before publication.');
  }
  if (release.draft) await client.publishRelease(tag);
  return client.readRelease(tag);
}

function verifyRemoteTag(repository, tag, expectedCommit, run = spawnSync) {
  validateTag(tag);
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error('Missing verified source commit for the GitHub release tag.');
  const api = `repos/${repository}/git`;
  const reference = githubJson([`${api}/ref/tags/${tag}`], run);
  if (reference?.ref !== `refs/tags/${tag}`) throw new Error('GitHub did not return the exact release tag.');
  let object = reference.object;
  const seen = new Set();
  while (object?.type === 'tag') {
    if (!/^[0-9a-f]{40}$/.test(object.sha) || seen.has(object.sha) || seen.size >= 16) {
      throw new Error('Invalid annotated GitHub release tag chain.');
    }
    seen.add(object.sha);
    const annotation = githubJson([`${api}/tags/${object.sha}`], run);
    if (annotation?.sha !== object.sha) throw new Error('GitHub returned a different annotated tag object.');
    object = annotation.object;
  }
  if (object?.type !== 'commit' || object.sha !== expectedCommit) {
    throw new Error('The remote GitHub release tag does not point to the verified source commit.');
  }
}

function githubClient(repository, { scope = 'all', sourceCommit, run = spawnSync } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must identify the release repository.');
  function gh(args, input) {
    const result = run('gh', args, { input, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const notFound = /release not found|HTTP 404/i.test(result.stderr || '');
      const status = /HTTP (\d+)/.exec(result.stderr || '')?.[1];
      const error = new Error(result.error?.code === 'ETIMEDOUT' ? 'GitHub request timed out.' : `GitHub request failed${status ? ' (HTTP ' + status + ')' : ''}.`);
      error.notFound = notFound;
      throw error;
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }
  const api = (method, endpoint, body) => gh(['api', '--method', method, `repos/${repository}/${endpoint}`,
    ...(body ? ['--input', '-'] : [])], body ? JSON.stringify(body) : undefined);
  const client = {
    async readRelease(tag) {
      try {
        const release = gh(['release', 'view', tag, '--repo', repository, '--json', 'databaseId,isDraft,assets,url']);
        return { id: release.databaseId, draft: release.isDraft, html_url: release.url,
          assets: release.assets.map(asset => ({ ...asset, id: Number(asset.apiUrl.split('/').pop()) })) };
      } catch (error) { if (error.notFound) return null; throw error; }
    },
    async createRelease(tag, assets) {
      const linux = assets.some(asset => asset.name === packageNames(tag).linuxDeb);
      const portable = assets.some(asset => asset.name === packageNames(tag).linuxAppImage);
      const arch = assets.some(asset => asset.name === packageNames(tag).linuxArch);
      const windows = assets.some(asset => asset.name === packageNames(tag).windows);
      const packages = [windows && 'Windows installer', linux && 'experimental Linux Mint/Debian amd64 DEB',
        arch && 'experimental Arch x64 package', portable && 'portable Linux x64 AppImage'].filter(Boolean).join(', ');
      verifyRemoteTag(repository, tag, sourceCommit, run);
      return api('POST', 'releases', { tag_name: tag, target_commitish: sourceCommit, name: tag, draft: true, prerelease: false,
        body: `${scope === 'linux' ? 'Linux-only update. The current Windows release is unchanged.\n\n' : ''}Download the versioned ${packages} and matching SHA-256 checksum below.\n\n${linux || portable || arch ? 'Download and VirusTotal result links are also available on the [download page](https://overkot.com/download). Linux requires manual updates.\n\n' : ''}See the [changelog](https://overkot.com/changelog) for details.\n` });
    },
    async uploadAsset(tag, asset) { gh(['release', 'upload', tag, asset.path, '--repo', repository]); },
    async deleteAsset(id) { api('DELETE', `releases/assets/${id}`); },
    async publishRelease(tag) {
      const release = await client.readRelease(tag);
      verifyRemoteTag(repository, tag, sourceCommit, run);
      api('PATCH', `releases/${release.id}`, { draft: false, make_latest: scope === 'linux' ? 'false' : 'true' });
    },
  };
  return client;
}

function validateGithubSource({ tag, repository, repositoryId, sourceRunId }, run = spawnSync) {
  if (!/^[1-9]\d*$/.test(sourceRunId) || !/^[1-9]\d*$/.test(repositoryId) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('Invalid source run or repository for GitHub release recovery.');
  }
  validateTag(tag);
  const commit = run('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const sha = commit.stdout?.trim();
  if (commit.error || commit.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Could not resolve the release tag commit for GitHub recovery.');
  const source = githubJson([`repos/${repository}/actions/runs/${sourceRunId}`], run);
  // A failed GitHub upload may follow successful CDN publication in that run.
  validateSourceRun(source, { repository, repositoryId, sha, runId: sourceRunId, requireSuccess: false });
  verifyRemoteTag(repository, tag, sha, run);
  return sha;
}

async function main() {
  const tag = process.env.RELEASE_TAG || process.argv[2];
  const directory = process.env.RELEASE_DIRECTORY || process.argv[3] || 'dist';
  const requireLinux = process.env.RELEASE_REQUIRE_LINUX === 'true';
  const requirePortable = process.env.RELEASE_REQUIRE_PORTABLE === 'true';
  const requireArch = process.env.RELEASE_REQUIRE_ARCH === 'true';
  const { GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: repositoryId, SOURCE_RUN_ID: sourceRunId } = process.env;
  const scope = releaseScope(tag, require('../changelog.json'));
  const sourceCommit = validateGithubSource({ tag, repository, repositoryId, sourceRunId });
  const assets = releaseAssets(directory, tag, { scope, requireLinux, requirePortable, requireArch, requireMetadata: requireLinux || requirePortable || requireArch });
  validatePublicationAssets(tag, assets, { requireCurrentSchema: requireArch });
  // Recovery reuses the exact Windows and Linux packages already served by the CDN.
  for (const asset of assets.filter(value => /\.(?:exe|deb|AppImage|pkg\.tar\.xz)$/.test(value.name))) {
    const response = await fetch(`${RELEASES_URL}/${asset.name}.sha256`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    const checksum = response.ok ? (await response.text()).trim().split(/\s+/) : [];
    if (checksum[0] !== asset.digest.slice(7) || checksum[1] !== asset.name) {
      throw new Error('Retained package differs from the published CDN artifact; refusing to replace this version.');
    }
  }
  const release = await publishRelease({ tag, assets, client: githubClient(repository, { scope, sourceCommit }), requireCurrentSchema: requireArch });
  console.log(`Published verified GitHub release: ${release.html_url}`);
}

module.exports = { githubClient, publishRelease, releaseAssets, validateTag, validateGithubSource, validatePublicationAssets, verifyRemoteTag };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
