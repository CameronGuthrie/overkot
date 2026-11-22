const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { githubClient, publishRelease, releaseAssets, validateTag, validateGithubSource, verifyRemoteTag } = require('../scripts/publish-release');
const { RELEASES_URL, VT_URL, SCAN_CATEGORIES, readAsset, packageNames } = require('../scripts/release-artifacts');

const tag = 'v0.0.12-beta.1';
const assets = [
  { name: 'installer.exe', path: '/retained/installer.exe', size: 100, digest: 'sha256:installer' },
  { name: 'installer.exe.sha256', path: '/retained/installer.exe.sha256', size: 20, digest: 'sha256:checksum' },
];
const uploaded = (asset, id = 1) => ({ ...asset, id, state: 'uploaded' });

function fixture(existing = [], draft = true) {
  const state = { release: { id: 1, draft, assets: existing, html_url: 'https://github.com/example/app/releases/tag/' + tag },
    uploads: [], deletes: [], publishes: 0, waits: [], creates: 0 };
  const client = {
    async readRelease() { return structuredClone(state.release); },
    async createRelease() { state.creates++; state.release = { id: 1, draft: true, assets: [] }; return structuredClone(state.release); },
    async uploadAsset(_tag, asset) { state.uploads.push(asset.path); state.release.assets.push(uploaded(asset, state.release.assets.length + 1)); },
    async deleteAsset(id) { state.deletes.push(id); state.release.assets = state.release.assets.filter(asset => asset.id !== id); },
    async publishRelease() { state.publishes++; state.release.draft = false; },
  };
  return { state, client, run: () => publishRelease({ tag, assets, client, sleep: async ms => state.waits.push(ms), log() {} }) };
}

function packageFixture(t) {
  const releaseTag = 'v0.0.13';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-complete-release-'));
  t.after(() => {
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  const names = packageNames(releaseTag);
  const metadata = { schemaVersion: 2, version: releaseTag.slice(1), publishedAt: '2026-10-06T12:00:00.000Z', platforms: {} };
  for (const [platform, filename] of Object.entries(names)) {
    fs.writeFileSync(path.join(directory, filename), `immutable ${platform} package`);
    const asset = readAsset(directory, filename);
    const sha256 = asset.digest.slice(7);
    fs.writeFileSync(path.join(directory, filename + '.sha256'), `${sha256}  ${filename}\n`);
    metadata.platforms[platform] = { filename, url: `${RELEASES_URL}/${filename}`, checksumUrl: `${RELEASES_URL}/${filename}.sha256`, sha256, size: asset.size,
      virusTotal: { url: VT_URL + sha256, status: 'completed', analysisId: `analysis-${platform}`, submittedAt: metadata.publishedAt, analysedAt: metadata.publishedAt,
        stats: Object.fromEntries(SCAN_CATEGORIES.map(category => [category, category === 'undetected' ? 1 : 0])) } };
  }
  fs.writeFileSync(path.join(directory, names.windows + '.blockmap'), 'immutable blockmap');
  const manifest = path.join(directory, `release-${metadata.version}.json`);
  fs.writeFileSync(manifest, JSON.stringify(metadata));
  const read = () => releaseAssets(directory, releaseTag, { requireLinux: true, requirePortable: true, requireArch: true, requireMetadata: true });
  return { directory, tag: releaseTag, names, metadata, manifest, read };
}

test('recovery reuses matching attachments and publishes only verified retained files', async () => {
  const f = fixture([uploaded(assets[1])]);
  const result = await f.run();
  assert.equal(result.draft, false);
  assert.deepEqual(f.state.uploads, [assets[0].path]);
  assert.deepEqual(f.state.deletes, []);
  assert.equal(f.state.publishes, 1);
});

test('a lost success response is reconciled without uploading the file again', async () => {
  const f = fixture();
  const original = f.client.uploadAsset;
  f.client.uploadAsset = async (...args) => { await original(...args); throw new Error('Gateway timeout'); };
  await f.run();
  assert.deepEqual(f.state.uploads, assets.map(asset => asset.path));
  assert.deepEqual(f.state.waits, []);
  assert.equal(f.state.publishes, 1);
});

test('transient upload failures retry the same immutable file', async () => {
  const f = fixture([uploaded(assets[1])]);
  const original = f.client.uploadAsset;
  let calls = 0;
  f.client.uploadAsset = async (...args) => {
    calls++;
    if (calls < 3) { f.state.uploads.push(args[1].path); throw new Error('HTTP 502'); }
    await original(...args);
  };
  await f.run();
  assert.deepEqual(f.state.uploads, Array(3).fill(assets[0].path));
  assert.deepEqual(f.state.waits, [5000, 10000]);
  assert.equal(f.state.publishes, 1);
});

test('an uploaded artifact with different bytes is never deleted or replaced', async () => {
  for (const override of [{ digest: 'sha256:different' }, { size: 101 }]) {
    const f = fixture([{ ...uploaded(assets[0]), ...override }]);
    await assert.rejects(f.run(), /differs.*immutable/);
    assert.deepEqual(f.state.uploads, []);
    assert.deepEqual(f.state.deletes, []);
    assert.equal(f.state.publishes, 0);
  }
});

test('failed attempts leave a draft, while incomplete starter assets can be retried', async () => {
  const failed = fixture();
  failed.client.uploadAsset = async () => { throw new Error('HTTP 502'); };
  await assert.rejects(failed.run(), /upload failed.*3 attempts/);
  assert.equal(failed.state.release.draft, true);
  assert.equal(failed.state.publishes, 0);
  const incomplete = fixture([{ name: assets[0].name, id: 72, state: 'starter', size: 0 }]);
  await incomplete.run();
  assert.deepEqual(incomplete.state.deletes, [72]);
  assert.equal(incomplete.state.publishes, 1);
});

test('a completed published release is an idempotent no-op', async () => {
  const f = fixture(assets.map(asset => uploaded(asset)), false);
  await f.run();
  assert.deepEqual(f.state.uploads, []);
  assert.deepEqual(f.state.deletes, []);
  assert.equal(f.state.publishes, 0);
});

test('a missing release is created as a draft before uploads', async () => {
  const f = fixture(); f.state.release = null;
  await f.run();
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.publishes, 1);
});

test('retained files must have the exact versioned name and matching installer checksum', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-release-test-'));
  const installer = 'overkot-setup-0.0.12-beta.1.exe';
  const bytes = Buffer.from('same immutable installer');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(directory, installer), bytes);
  fs.writeFileSync(path.join(directory, installer + '.blockmap'), 'blockmap');
  fs.writeFileSync(path.join(directory, installer + '.sha256'), `${hash}  ${installer}\n`);
  t.after(() => {
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  assert.equal(releaseAssets(directory, tag)[0].digest, 'sha256:' + hash);
  fs.writeFileSync(path.join(directory, installer), 'rebuilt with different bytes');
  assert.throws(() => releaseAssets(directory, tag), /do not match/);
  for (const invalid of ['v0.0.11b', '../../secret', 'v0.0.12;command']) assert.throws(() => validateTag(invalid));
});

test('fresh GitHub publication retains all four packages, checksums and scan metadata', async t => {
  const packages = packageFixture(t);
  const retained = packages.read();
  const f = fixture();
  await publishRelease({ tag: packages.tag, assets: retained, client: f.client, sleep: async () => {}, log() {}, requireCurrentSchema: true });
  assert.equal(retained.length, 10);
  assert.deepEqual(f.state.uploads, retained.map(asset => asset.path));
  assert.ok(f.state.release.assets.some(asset => asset.name === packages.names.linuxArch));
  assert.ok(f.state.release.assets.some(asset => asset.name === packages.names.linuxArch + '.sha256'));
  assert.equal(f.state.publishes, 1);
});

test('scan detections and invalid retained evidence stop GitHub publication before contacting GitHub', async t => {
  const packages = packageFixture(t);
  for (const category of ['malicious', 'suspicious']) {
    const detected = structuredClone(packages.metadata);
    detected.platforms.linuxArch.virusTotal.stats[category] = 1;
    fs.writeFileSync(packages.manifest, JSON.stringify(detected));
    const f = fixture();
    let reads = 0;
    f.client.readRelease = async () => { reads++; return structuredClone(f.state.release); };
    await assert.rejects(publishRelease({ tag: packages.tag, assets: packages.read(), client: f.client, requireCurrentSchema: true }), /detections.*review/);
    assert.equal(reads, 0);
    assert.deepEqual(f.state.uploads, []);
    assert.equal(f.state.publishes, 0);
  }
  fs.writeFileSync(packages.manifest, JSON.stringify(packages.metadata));
  const retained = packages.read();
  fs.writeFileSync(packages.manifest, JSON.stringify({ ...packages.metadata, publishedAt: '2026-10-07T12:00:00.000Z' }));
  await assert.rejects(publishRelease({ tag: packages.tag, assets: retained, client: fixture().client }), /metadata changed/);
  fs.writeFileSync(packages.manifest, JSON.stringify({ ...packages.metadata, schemaVersion: 1 }));
  await assert.rejects(publishRelease({ tag: packages.tag, assets: packages.read(), client: fixture().client, requireCurrentSchema: true }), /schemaVersion 2/);
  await assert.rejects(publishRelease({ tag, assets, client: fixture().client, requireCurrentSchema: true }), /retained schemaVersion 2 manifest/);
});

test('GitHub recovery source matches the tag commit and repository even after the source publication job failed', () => {
  const repository = 'example/app', sha = 'a'.repeat(40), sourceRunId = '42';
  const source = { id: 42, path: '.github/workflows/build-app.yml', repository: { full_name: repository, id: 731 },
    head_repository: { id: 731 }, event: 'push', actor: { id: 76098008 }, triggering_actor: { id: 76098008 },
    head_sha: sha, status: 'completed', conclusion: 'failure' };
  const options = { tag, repository, repositoryId: '731', sourceRunId };
  const runner = record => (command, args) => {
    if (command === 'git') {
      assert.deepEqual(args, ['rev-parse', `${tag}^{commit}`]);
      return { status: 0, stdout: sha + '\n' };
    }
    if (args[1] === `repos/${repository}/git/ref/tags/${tag}`) {
      return { status: 0, stdout: JSON.stringify({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha } }) };
    }
    assert.deepEqual(args, ['api', `repos/${repository}/actions/runs/${sourceRunId}`]);
    return { status: 0, stdout: JSON.stringify(record) };
  };
  assert.equal(validateGithubSource(options, runner(source)), sha);
  for (const overrides of [{ head_sha: 'b'.repeat(40) }, { id: 100 }, { repository: { full_name: 'other/app' } }, { path: '.github/workflows/other.yml' }]) {
    assert.throws(() => validateGithubSource(options, runner({ ...source, ...overrides })), /Source must/);
  }
  assert.throws(() => validateGithubSource({ ...options, sourceRunId: '42;bad' }, runner(source)), /Invalid source/);
  for (const field of ['sourceRunId', 'repository', 'repositoryId']) {
    assert.throws(() => validateGithubSource({ ...options, [field]: '' }, runner(source)), /Invalid source/);
  }
  assert.throws(() => validateGithubSource({ ...options, repositoryId: '732' }, runner(source)), /Source must/);
  assert.throws(() => validateGithubSource(options, () => ({ status: 1 })), /resolve the release tag/);
});

test('remote release verification peels annotated tags to the original commit and rejects other refs and objects', () => {
  const repository = 'example/app', commit = 'a'.repeat(40), outer = 'b'.repeat(40), inner = 'c'.repeat(40);
  const ref = `refs/tags/${tag}`, base = `repos/${repository}/git`;
  const responses = {
    [`${base}/ref/tags/${tag}`]: { ref, object: { type: 'tag', sha: outer } },
    [`${base}/tags/${outer}`]: { sha: outer, object: { type: 'tag', sha: inner } },
    [`${base}/tags/${inner}`]: { sha: inner, object: { type: 'commit', sha: commit } },
  };
  const run = (command, args) => {
    assert.equal(command, 'gh'); assert.equal(args[0], 'api');
    return { status: 0, stdout: JSON.stringify(responses[args[1]]) };
  };
  verifyRemoteTag(repository, tag, commit, run);
  responses[`${base}/tags/${inner}`].object = { type: 'commit', sha: outer };
  assert.throws(() => verifyRemoteTag(repository, tag, commit, run), /does not point/);
  responses[`${base}/tags/${inner}`].object = { type: 'tag', sha: outer };
  assert.throws(() => verifyRemoteTag(repository, tag, commit, run), /tag chain/);
  responses[`${base}/ref/tags/${tag}`] = { ref, object: { type: 'tree', sha: commit } };
  assert.throws(() => verifyRemoteTag(repository, tag, commit, run), /does not point/);
  responses[`${base}/ref/tags/${tag}`].ref = `refs/heads/${tag}`;
  assert.throws(() => verifyRemoteTag(repository, tag, commit, run), /exact release tag/);
  assert.throws(() => verifyRemoteTag(repository, tag, commit, () => ({ status: 1 })), /Could not verify/);
});

test('a tag moved after staging leaves the verified GitHub release in draft', async () => {
  const repository = 'example/app', commit = 'a'.repeat(40), other = 'b'.repeat(40), calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args[0] === 'release' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ databaseId: 42, isDraft: true, assets: [] }) };
    }
    assert.deepEqual(args, ['api', `repos/${repository}/git/ref/tags/${tag}`]);
    return { status: 0, stdout: JSON.stringify({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: other } }) };
  };
  const client = githubClient(repository, { sourceCommit: commit, run });
  await assert.rejects(client.publishRelease(tag), /does not point/);
  assert.equal(calls.length, 2);
});
