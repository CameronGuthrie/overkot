'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RELEASES_URL, VT_URL, SCAN_CATEGORIES, releaseAssets, releaseScope, readAsset, packageNames, validateMetadata, validatePublication } = require('../scripts/release-artifacts');
const { virusTotalClient, trustedUploadUrl, scanAsset, createMetadata } = require('../scripts/scan-release');
const { awsClient, publishCdn, validateUpdater } = require('../scripts/publish-cdn');
const { validateRelease, validateSourceTag } = require('../scripts/validate-release');
const { retainedState, retainedInventory, validateSourceRun } = require('../scripts/retained-release');

const tag = 'v0.0.13';
const date = '2026-09-28T12:00:00.000Z';
const noWait = async () => {};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-release-pipeline-'));
  t.after(() => {
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  const names = packageNames(tag);
  for (const filename of Object.values(names)) {
    fs.writeFileSync(path.join(directory, filename), `exact retained bytes for ${filename}`);
    const asset = readAsset(directory, filename);
    fs.writeFileSync(path.join(directory, filename + '.sha256'), `${asset.digest.slice(7)}  ${filename}\n`);
  }
  fs.writeFileSync(path.join(directory, names.windows + '.blockmap'), 'blockmap');
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(path.join(directory, names.windows))).digest('base64');
  const size = fs.statSync(path.join(directory, names.windows)).size;
  fs.writeFileSync(path.join(directory, 'latest.yml'), `version: ${tag.slice(1)}\nfiles:\n  - url: ${names.windows}\n    sha512: ${sha512}\n    size: ${size}\npath: ${names.windows}\nsha512: ${sha512}\n`);
  fs.writeFileSync(path.join(directory, 'changelog.json'), '{"versions":[]}');
  return { directory, names, assets: releaseAssets(directory, tag, { requireLinux: true, requirePortable: true, requireArch: true }) };
}

function fakeClient(status = 'completed') {
  const calls = [];
  const stats = Object.fromEntries(SCAN_CATEGORIES.map(category => [category, category === 'undetected' ? 1 : 0]));
  return { calls, async submit(asset) { calls.push(asset.name); return `analysis-${asset.name}`; },
    async analysis() { return { data: { attributes: { status, stats, date: Date.parse(date) / 1000 } } }; } };
}

async function metadataFixture(t) {
  const f = fixture(t);
  const client = fakeClient();
  f.metadata = await createMetadata({ tag, assets: f.assets, client, now: () => date,
    scanOptions: { wait: noWait, now: () => date }, log() {} });
  fs.writeFileSync(path.join(f.directory, `release-${tag.slice(1)}.json`), JSON.stringify(f.metadata));
  return f;
}

test('all packages retain exact checksums; Linux omissions and tampering fail', t => {
  const f = fixture(t);
  assert.equal(f.names.linuxAppImage, `overkot-${tag.slice(1)}-linux-x86_64.AppImage`);
  assert.equal(f.names.linuxArch, `overkot-${tag.slice(1)}-linux-x64.pkg.tar.xz`);
  assert.equal(f.assets.length, 9);
  fs.writeFileSync(path.join(f.directory, f.names.linuxDeb), 'rebuilt bytes');
  assert.throws(() => releaseAssets(f.directory, tag, { requireLinux: true }), /do not match/);
  fs.unlinkSync(path.join(f.directory, f.names.linuxDeb));
  assert.throws(() => releaseAssets(f.directory, tag, { requireLinux: true }), /ENOENT/);
  fs.writeFileSync(path.join(f.directory, f.names.linuxAppImage), 'rebuilt portable bytes');
  assert.throws(() => releaseAssets(f.directory, tag), /do not match/);
  fs.unlinkSync(path.join(f.directory, f.names.linuxAppImage));
  assert.throws(() => releaseAssets(f.directory, tag, { requirePortable: true }), /ENOENT/);
  fs.writeFileSync(path.join(f.directory, f.names.linuxArch), 'rebuilt Arch bytes');
  assert.throws(() => releaseAssets(f.directory, tag), /do not match/);
  fs.unlinkSync(path.join(f.directory, f.names.linuxArch));
  assert.throws(() => releaseAssets(f.directory, tag, { requireArch: true }), /ENOENT/);
  assert.equal(releaseAssets(f.directory, tag).length, 3, 'historical Windows-only recovery stays supported');
});

test('metadata binds all report URLs to the exact same-version retained packages', async t => {
  const f = await metadataFixture(t);
  assert.equal(f.metadata.schemaVersion, 2);
  for (const [platform, name] of Object.entries(f.names)) {
    const record = f.metadata.platforms[platform];
    assert.equal(record.filename, name);
    assert.equal(record.url, `${RELEASES_URL}/${name}`);
    assert.equal(record.checksumUrl, `${RELEASES_URL}/${name}.sha256`);
    assert.equal(record.virusTotal.url, VT_URL + record.sha256);
    assert.equal(record.virusTotal.analysedAt, date);
    assert.equal(record.virusTotal.stats.undetected, 1);
  }
  assert.equal(releaseAssets(f.directory, tag, { requireLinux: true, requirePortable: true, requireArch: true, requireMetadata: true }).length, 10);
  for (const mutate of [m => { m.platforms.linuxDeb.sha256 = 'a'.repeat(64); },
    m => { m.platforms.windows.virusTotal.url = VT_URL + 'b'.repeat(64); },
    m => { m.platforms.windows.virusTotal.status = 'clean'; },
    m => { m.version = '0.0.12-beta.4'; },
    m => { delete m.platforms.linuxDeb; },
    m => { delete m.platforms.linuxAppImage; },
    m => { delete m.platforms.linuxArch; },
    m => { m.platforms.linuxArch.sha256 = 'd'.repeat(64); },
    m => { m.platforms.linuxAppImage.checksumUrl = `${RELEASES_URL}/other.AppImage.sha256`; },
    m => { m.platforms.linuxAppImage.virusTotal.url = VT_URL + 'c'.repeat(64); }]) {
    const edited = structuredClone(f.metadata); mutate(edited);
    assert.throws(() => validateMetadata(edited, tag, f.assets), /metadata/);
  }
});

test('schema1 historical recovery allows missing newer formats; schema2 requires all four packages', async t => {
  const f = await metadataFixture(t);
  fs.unlinkSync(path.join(f.directory, f.names.linuxAppImage));
  fs.unlinkSync(path.join(f.directory, f.names.linuxAppImage + '.sha256'));
  assert.throws(() => releaseAssets(f.directory, tag, { requireLinux: true, requireMetadata: true }), /linuxAppImage/,
    'metadata cannot advertise a portable package whose retained bytes are missing');
  delete f.metadata.platforms.linuxAppImage;
  fs.writeFileSync(path.join(f.directory, `release-${tag.slice(1)}.json`), JSON.stringify(f.metadata));
  assert.throws(() => releaseAssets(f.directory, tag, { requireMetadata: true }), /linuxAppImage/);
  fs.unlinkSync(path.join(f.directory, f.names.linuxArch));
  fs.unlinkSync(path.join(f.directory, f.names.linuxArch + '.sha256'));
  delete f.metadata.platforms.linuxArch;
  f.metadata.schemaVersion = 1;
  for (const record of Object.values(f.metadata.platforms)) {
    record.virusTotal.status = 'queued';
    delete record.virusTotal.stats;
    delete record.virusTotal.analysedAt;
  }
  fs.writeFileSync(path.join(f.directory, `release-${tag.slice(1)}.json`), JSON.stringify(f.metadata));
  assert.equal(releaseAssets(f.directory, tag, { requireLinux: true, requireMetadata: true }).length, 6);
  const calls = [];
  const params = { directory: f.directory, tag, changelog: path.join(f.directory, 'changelog.json'), distribution: 'test', client: {
    async immutable(asset) { calls.push(asset.name); }, async pointer() {}, async invalidate() {},
  } };
  await assert.rejects(publishCdn(params), /ENOENT/);
  assert.deepEqual(calls, [], 'new publication validates the portable file before writing');
  await publishCdn({ ...params, requirePortable: false, requireArch: false });
  assert.equal(calls.length, 6, 'recovery publishes only the exact historical retained files');
});

test('schema2 rejects incomplete, malformed and empty analysis results while retaining detections for review', async t => {
  const f = await metadataFixture(t);
  for (const mutate of [scan => { scan.status = 'queued'; }, scan => { scan.analysedAt = 'yesterday'; },
    scan => { delete scan.stats; }, scan => { delete scan.stats.failure; }, scan => { scan.stats.malicious = -1; },
    scan => { scan.stats.malicious = 0.5; }, scan => { scan.stats.malicious = '1'; }, scan => { scan.stats.unknown = 1; },
    scan => { scan.stats.undetected = 0; }]) {
    const edited = structuredClone(f.metadata);
    mutate(edited.platforms.linuxArch.virusTotal);
    assert.throws(() => validateMetadata(edited, tag, f.assets), /metadata|completed VirusTotal/);
  }
  for (const category of ['malicious', 'suspicious']) {
    const detected = structuredClone(f.metadata);
    detected.platforms.linuxArch.virusTotal.stats[category] = 1;
    assert.equal(validateMetadata(detected, tag, f.assets), detected, 'scan evidence is retained for review');
    assert.throws(() => validatePublication(detected), /detections.*review/);
  }
});

test('positive scan results or an obsolete fresh manifest stop CDN publication before any writes', async t => {
  const f = await metadataFixture(t);
  const calls = [];
  const params = { directory: f.directory, tag, changelog: path.join(f.directory, 'changelog.json'), distribution: 'test', client: {
    async immutable() { calls.push('immutable'); }, async pointer() { calls.push('pointer'); }, async invalidate() { calls.push('invalidate'); },
  } };
  for (const [platform, category] of [['windows', 'malicious'], ['linuxArch', 'suspicious']]) {
    const detected = structuredClone(f.metadata);
    detected.platforms[platform].virusTotal.stats[category] = 2;
    fs.writeFileSync(path.join(f.directory, `release-${tag.slice(1)}.json`), JSON.stringify(detected));
    await assert.rejects(publishCdn(params), /detections.*review/);
    assert.deepEqual(calls, []);
  }
  fs.writeFileSync(path.join(f.directory, `release-${tag.slice(1)}.json`), JSON.stringify({ ...f.metadata, schemaVersion: 1 }));
  await assert.rejects(publishCdn(params), /New releases require schemaVersion 2/);
  assert.deepEqual(calls, []);
});

test('bounded polling records queued and in-progress status without claiming a verdict', async t => {
  const { assets } = fixture(t);
  for (const status of ['queued', 'in-progress', 'completed']) {
    const client = fakeClient(status);
    let polls = 0;
    const analysis = client.analysis;
    client.analysis = async () => { polls++; return analysis(); };
    const report = await scanAsset(assets[0], client, { polls: 3, wait: noWait, now: () => date });
    assert.equal(polls, status === 'completed' ? 1 : 3);
    assert.equal(report.status, status);
    assert.equal(report.submittedAt, date);
    assert.equal('clean' in report, false);
  }
});

test('scan metadata rejects wrong analysis hashes and invalid statuses', async t => {
  const { assets } = fixture(t);
  await assert.rejects(scanAsset(assets[0], { ...fakeClient(), async analysis() {
    return { data: { attributes: { status: 'completed' } }, meta: { file_info: { sha256: 'a'.repeat(64) } } };
  } }, { wait: noWait }), /hash does not match/);
  await assert.rejects(scanAsset(assets[0], fakeClient('clean'), { wait: noWait }), /unrecognised/);
});

test('any failed Linux package submission prevents creating a complete manifest', async t => {
  const f = fixture(t);
  for (const extension of ['.deb', '.AppImage', '.pkg.tar.xz']) {
    const client = fakeClient();
    client.submit = async asset => { if (asset.name.endsWith(extension)) throw new Error('upload rejected'); return 'accepted'; };
    await assert.rejects(createMetadata({ tag, assets: f.assets, client, scanOptions: { wait: noWait }, log() {} }), /upload rejected/);
    assert.equal(fs.existsSync(path.join(f.directory, `release-${tag.slice(1)}.json`)), false);
  }
});

test('API key is required and never forwarded to an untrusted upload host', () => {
  assert.throws(() => virusTotalClient({ apiKey: '' }), /VIRUSTOTAL_API_KEY/);
  for (const url of ['ftp://www.virustotal.com/upload', 'https://evil.example/upload', 'https://www.virustotal.com.evil.example/upload', 'https://user:pass@www.virustotal.com/upload']) {
    assert.throws(() => trustedUploadUrl(url), /untrusted/);
  }
});

test('small packages use multipart POST while large packages acquire a fresh upload URL for retries', async t => {
  const f = fixture(t);
  const calls = [], waits = [];
  const response = data => ({ ok: true, json: async () => data });
  let urlNumber = 0, postNumber = 0;
  const client = virusTotalClient({ apiKey: 'test-secret', wait: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers['x-apikey'], 'test-secret');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('upload_url')) return response({ data: `https://www.virustotal.com/_ah/upload/${++urlNumber}` });
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('file').name, f.assets[0].name);
    if (++postNumber === 2) return { ok: false, status: 503 };
    return response({ data: { id: 'accepted-analysis' } });
  } });
  assert.equal(await client.submit(f.assets[0]), 'accepted-analysis');
  // Size controls endpoint selection, while upload contents remain the retained fixture.
  assert.equal(await client.submit({ ...f.assets[0], size: 33 * 1024 * 1024 }), 'accepted-analysis');
  assert.deepEqual(calls.map(call => call.url), [
    'https://www.virustotal.com/api/v3/files',
    'https://www.virustotal.com/api/v3/files/upload_url', 'https://www.virustotal.com/_ah/upload/1',
    'https://www.virustotal.com/api/v3/files/upload_url', 'https://www.virustotal.com/_ah/upload/2',
  ]);
  assert.ok(waits.includes(16000), 'public API requests are paced');
});

test('authentication errors fail immediately without logging response bodies or keys', async t => {
  const f = fixture(t); let calls = 0;
  const client = virusTotalClient({ apiKey: 'test-secret', wait: noWait, fetchImpl: async () => {
    calls++; return { ok: false, status: 401, text: async () => 'test-secret' };
  } });
  await assert.rejects(client.submit(f.assets[0]), error => /HTTP 401/.test(error.message) && !error.message.includes('test-secret'));
  assert.equal(calls, 1);
});

test('rate limits and network failures have bounded, redacted retries', async () => {
  let calls = 0;
  const waits = [];
  const client = virusTotalClient({ apiKey: 'test-secret', wait: async ms => waits.push(ms), fetchImpl: async () => {
    calls++; return { ok: false, status: 429, headers: new Headers({ 'retry-after': '1000' }) };
  } });
  await assert.rejects(client.analysis('analysis'), /HTTP 429/);
  assert.equal(calls, 3);
  assert.ok(waits.includes(1000000), 'the provider Retry-After is respected');
  calls = 0;
  const failed = virusTotalClient({ apiKey: 'test-secret', wait: noWait, fetchImpl: async () => {
    calls++; throw new Error('request test-secret detail');
  } });
  await assert.rejects(failed.analysis('analysis'), error => /bounded retries/.test(error.message) && !error.message.includes('test-secret'));
  assert.equal(calls, 3);
});

test('CDN immutable assets precede all pointers, and latest download metadata is last', async t => {
  const f = await metadataFixture(t); const calls = [];
  await publishCdn({ directory: f.directory, tag, changelog: path.join(f.directory, 'changelog.json'), distribution: 'test', client: {
    async immutable(asset) { calls.push('immutable:' + asset.name); },
    async pointer(name) { calls.push('pointer:' + name); },
    async invalidate() { calls.push('invalidate'); },
  } });
  assert.equal(calls.filter(name => name.startsWith('immutable:')).length, 10);
  assert.ok(calls.includes('immutable:' + f.names.linuxAppImage));
  assert.ok(calls.includes('immutable:' + f.names.linuxAppImage + '.sha256'));
  assert.ok(calls.includes('immutable:' + f.names.linuxArch));
  assert.ok(calls.includes('immutable:' + f.names.linuxArch + '.sha256'));
  assert.deepEqual(calls.slice(10), ['pointer:overkot.exe', 'pointer:changelog.json', 'pointer:latest.yml', 'pointer:latest.json', 'invalidate']);
});

test('an immutable upload failure or invalid updater prevents advancing release pointers', async t => {
  const f = await metadataFixture(t); const pointers = [];
  const client = { async immutable(asset) { if (asset.name.endsWith('.AppImage')) throw new Error('immutable conflict'); },
    async pointer(name) { pointers.push(name); } };
  const params = { directory: f.directory, tag, changelog: path.join(f.directory, 'changelog.json'), distribution: 'test', client };
  await assert.rejects(publishCdn(params), /immutable conflict/);
  assert.deepEqual(pointers, []);
  fs.writeFileSync(path.join(f.directory, 'latest.yml'), 'version: 0.0.1\npath: old.exe\n');
  await assert.rejects(publishCdn(params), /updater metadata/);
  assert.deepEqual(pointers, []);
});

test('release preflight catches missing VT secret and tag mismatches before building', () => {
  const env = Object.fromEntries(['VIRUSTOTAL_API_KEY', 'AWS_DEPLOY_ROLE_ARN', 'CLOUDFRONT_DISTRIBUTION_ID_RELEASES', 'OVERKOT_MARKET_API_KEY', 'MARKET_SOURCE_READ_KEY'].map(name => [name, 'configured']));
  const options = { tag, pkg: { version: tag.slice(1) }, changelog: { versions: [{ version: tag.slice(1), changes: ['A change'] }] }, env };
  validateRelease(options);
  assert.throws(() => validateRelease({ ...options, env: { ...env, VIRUSTOTAL_API_KEY: '' } }), /VIRUSTOTAL_API_KEY/);
  assert.throws(() => validateRelease({ ...options, env: { ...env, MARKET_SOURCE_READ_KEY: '' } }), /MARKET_SOURCE_READ_KEY/);
  assert.throws(() => validateRelease({ ...options, tag: 'v0.0.12-beta.4' }), /do not match/);
  for (const sourceRunId of ['', 'not-a-run']) {
    assert.throws(() => validateRelease({ ...options, env: { ...env, RELEASE_PUBLISH: 'true', RELEASE_SOURCE_RUN_ID: sourceRunId } }), /Promotion requires source_run_id/);
  }
  validateRelease({ ...options, env: { ...env, MARKET_SOURCE_READ_KEY: '', RELEASE_PUBLISH: 'true', RELEASE_SOURCE_RUN_ID: '42' } });
});

test('S3 uploads are conditional, digest checked, and existing immutable objects cannot be overwritten', async t => {
  const f = fixture(t);
  const asset = f.assets[0];
  const calls = [];
  const client = awsClient('test-bucket', (_command, args) => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify({ ChecksumSHA256: Buffer.from(asset.digest.slice(7), 'hex').toString('base64') }) };
  });
  await client.immutable(asset);
  assert.equal(calls[0][calls[0].indexOf('--if-none-match') + 1], '*');
  assert.ok(calls[0].includes('public,max-age=31536000,immutable'));
  const rejected = awsClient('test-bucket', () => ({ status: 0, stdout: '{"ChecksumSHA256":"wrong"}' }));
  await assert.rejects(rejected.immutable(asset), /checksum verification/);
  for (const same of [true, false]) {
    let uploads = 0;
    const existing = awsClient('test-bucket', (_command, args) => {
      if (args[1] === 'put-object') { uploads++; return { status: 1, stderr: 'PreconditionFailed' }; }
      assert.equal(args[1], 'get-object');
      fs.writeFileSync(args[6], same ? fs.readFileSync(asset.path) : 'different published bytes');
      return { status: 0, stdout: '{}' };
    });
    if (same) await existing.immutable(asset);
    else await assert.rejects(existing.immutable(asset), /differs from the immutable release/);
    assert.equal(uploads, 1);
  }
});

test('updater files array must match the exact installer even when top-level YAML fields are valid', t => {
  const f = fixture(t);
  const yaml = fs.readFileSync(path.join(f.directory, 'latest.yml'), 'utf8');
  const installer = f.assets[0];
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer.path)).digest('base64');
  validateUpdater(yaml, tag, installer, sha512);
  validateUpdater(yaml.replaceAll('\n', '\r\n'), tag, installer, sha512);
  for (const edited of [yaml.replace('  - url: ' + installer.name, '  - url: other.exe'),
    yaml.replace('    sha512: ' + sha512, '    sha512: wrong'),
    yaml.replace('    size: ' + installer.size, '    size: 0'),
    yaml.replace('path:', '  - url: other.exe\npath:')]) {
    assert.throws(() => validateUpdater(edited, tag, installer, sha512), /updater metadata/);
  }
});

test('workflow retries preserve combined manifests and reuse completed platform builds', () => {
  const sha = 'a'.repeat(40);
  const empty = { has_release: false, has_windows: false, has_linux: false, has_scan_progress: false, has_market_source: false };
  assert.deepEqual(retainedState([], sha), empty);
  assert.deepEqual(retainedState([{ name: `overkot-windows-${sha}` }], sha), { ...empty, has_windows: true });
  assert.deepEqual(retainedState([{ name: `overkot-linux-${sha}` }], sha), { ...empty, has_linux: true });
  assert.deepEqual(retainedState([{ name: `overkot-linux-deb-${sha}` }], sha), empty,
    'a historical DEB alone cannot satisfy the new portable build');
  assert.deepEqual(retainedState([{ name: `overkot-release-${sha}` }], sha), { ...empty, has_release: true, has_windows: true, has_linux: true });
  assert.deepEqual(retainedState([{ name: `overkot-scan-progress-${sha}` }], sha), { ...empty, has_scan_progress: true });
  assert.deepEqual(retainedState([{ name: `overkot-market-source-${sha}` }], sha), { ...empty, has_market_source: true });
  assert.deepEqual(retainedState([{ name: `overkot-market-source-${sha}`, expired: true }], sha), empty);
  assert.deepEqual(retainedState([{ name: `overkot-release-${sha}`, expired: true }], sha), empty);
  assert.throws(() => retainedState([], '../invalid'), /Invalid source/);
});

const runProvenance = {
  repository: { full_name: 'example/app', id: 731 }, head_repository: { id: 731 },
  event: 'workflow_dispatch', actor: { id: 76098008 }, triggering_actor: { id: 76098008 },
};

test('external promotion verifies its successful source commit and complete artifact; current-run retries reuse failed progress', () => {
  const repository = 'example/app', sha = 'a'.repeat(40);
  const context = { repository, repositoryId: '731', sha, runId: '100', sourceRunId: '42', autoReuse: true };
  const source = { ...runProvenance, id: 42, path: '.github/workflows/build-app.yml', head_sha: sha,
    status: 'completed', conclusion: 'success' };
  const artifacts = [{ name: `overkot-release-${sha}` }];
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify(args.includes('--slurp') ? [{ artifacts }] : source) };
  };
  assert.deepEqual(retainedInventory(context, run), { has_release: true, has_windows: true, has_linux: true, has_scan_progress: false, has_market_source: false, source_run_id: '42' });
  assert.ok(calls.every(args => args.at(-1).includes('/runs/42')), 'both verification and download inventory target the selected source run');
  for (const overrides of [{ id: 43 }, { path: '.github/workflows/other.yml' }, { head_sha: 'b'.repeat(40) },
    { repository: { id: 731, full_name: 'other/app' } }, { repository: { id: 732, full_name: repository } },
    { head_repository: null }, { head_repository: { id: 732 } }, { event: 'pull_request_target' }, { event: 'pull_request' },
    { actor: { id: 1 } }, { triggering_actor: { id: 1 } }, { triggering_actor: null }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
    assert.throws(() => validateSourceRun({ ...source, ...overrides }, { ...context, runId: '42' }), /Source must|successful completed/);
  }
  validateSourceRun({ ...source, event: 'push', conclusion: 'failure' }, { ...context, runId: '42', requireSuccess: false });
  for (const unavailable of [[], [{ name: `overkot-release-${sha}`, expired: true }], [{ name: `overkot-windows-${sha}` }]]) {
    assert.throws(() => retainedInventory(context, (_command, args) => ({ status: 0,
      stdout: JSON.stringify(args.includes('--slurp') ? [{ artifacts: unavailable }] : source) })), /complete release artifact.*cannot rebuild/);
  }
  const retry = retainedInventory({ ...context, sourceRunId: '', autoReuse: false }, (_command, args) => {
    assert.ok(args.includes('--slurp'), 'the current failed run need not have a successful conclusion');
    return { status: 0, stdout: JSON.stringify([{ artifacts: [{ name: `overkot-windows-${sha}` }, { name: `overkot-scan-progress-${sha}` }] }]) };
  });
  assert.deepEqual(retry, { has_release: false, has_windows: true, has_linux: false, has_scan_progress: true, has_market_source: false, source_run_id: '100' });
  assert.throws(() => retainedInventory({ ...context, sourceRunId: '42/../100' }, run), /invalid release workflow/);
  assert.throws(() => retainedInventory(context, () => ({ status: 0, stdout: 'not-json' })), /invalid release run data/);
});

test('tag-stage discovery selects the newest verified complete same-commit source and filters unrelated runs', () => {
  const repository = 'example/app', sha = 'a'.repeat(40);
  const context = { repository, repositoryId: '731', sha, runId: '1000', autoReuse: true };
  const record = (id, overrides = {}) => ({ ...runProvenance, id, path: '.github/workflows/build-app.yml', head_sha: sha,
    status: 'completed', conclusion: 'success', created_at: `2026-10-06T12:${String(id / 10).padStart(2, '0')}:00Z`, ...overrides });
  const candidates = [record(50), record(80), record(90), record(100, { conclusion: 'failure' }),
    record(110, { head_sha: 'b'.repeat(40) }), record(120, { repository: { full_name: 'other/app' } }),
    record(130, { path: '.github/workflows/other.yml' }), record(140), record(150), record(1000),
    record('bad-id'), record(160, { status: 'in_progress' })];
  const inventories = [], queriedSources = [];
  const result = retainedInventory(context, (_command, args) => {
    const endpoint = args.at(-1);
    let data;
    if (endpoint.includes('/workflows/')) {
      assert.equal(endpoint, `repos/${repository}/actions/workflows/build-app.yml/runs?head_sha=${sha}&status=success&per_page=20`);
      data = { workflow_runs: candidates };
    } else if (endpoint.endsWith('/artifacts')) {
      const id = Number(endpoint.split('/').at(-2));
      inventories.push(id);
      data = [{ artifacts: id === 1000 ? [{ name: `overkot-windows-${sha}` }] :
        [{ name: `overkot-release-${sha}`, expired: id === 140 }] }];
    } else {
      const id = Number(endpoint.split('/').at(-1));
      queriedSources.push(id);
      data = record(id, id === 150 ? { head_sha: 'c'.repeat(40) } : {});
    }
    return { status: 0, stdout: JSON.stringify(data) };
  });
  assert.equal(result.source_run_id, '90', 'a newer expired source and a source changed since listing are skipped');
  assert.equal(result.has_release, true);
  assert.deepEqual(queriedSources, [150, 140, 90]);
  assert.deepEqual(inventories, [1000, 140, 90], 'invalid repository, workflow, commit, status and current-run records are never inventoried as sources');
});

test('a current-run complete artifact takes precedence over automatic discovery', () => {
  const repository = 'example/app', sha = 'a'.repeat(40);
  let calls = 0;
  const result = retainedInventory({ repository, repositoryId: '731', sha, runId: '100', autoReuse: true }, (_command, args) => {
    calls++;
    assert.equal(args.at(-1), `repos/${repository}/actions/runs/100/artifacts`);
    return { status: 0, stdout: JSON.stringify([{ artifacts: [{ name: `overkot-release-${sha}` }] }]) };
  });
  assert.equal(calls, 1);
  assert.equal(result.source_run_id, '100');
  assert.equal(result.has_release, true);
});

test('automatic discovery is bounded and falls back to the current partial run when no candidate retains a complete release', () => {
  const repository = 'example/app', sha = 'a'.repeat(40);
  const source = id => ({ ...runProvenance, id, path: '.github/workflows/build-app.yml', head_sha: sha,
    status: 'completed', conclusion: 'success', created_at: `2026-10-06T12:${String(id).padStart(2, '0')}:00Z` });
  const candidateInventories = [];
  const result = retainedInventory({ repository, repositoryId: '731', sha, runId: '100', autoReuse: true }, (_command, args) => {
    const endpoint = args.at(-1);
    let data;
    if (endpoint.includes('/workflows/')) data = { workflow_runs: Array.from({ length: 21 }, (_unused, index) => source(index + 1)) };
    else if (endpoint.endsWith('/artifacts')) {
      const id = Number(endpoint.split('/').at(-2));
      if (id !== 100) candidateInventories.push(id);
      data = [{ artifacts: id === 100 ? [{ name: `overkot-windows-${sha}` }, { name: `overkot-scan-progress-${sha}` }] :
        [{ name: `overkot-release-${sha}`, expired: true }] }];
    } else data = source(Number(endpoint.split('/').at(-1)));
    return { status: 0, stdout: JSON.stringify(data) };
  });
  assert.deepEqual(candidateInventories, [20, 19, 18, 17, 16], 'at most five of the first twenty listed runs are inventoried');
  assert.deepEqual(result, { has_release: false, has_windows: true, has_linux: false, has_scan_progress: true, has_market_source: false, source_run_id: '100' });
  assert.throws(() => retainedInventory({ repository, repositoryId: '731', sha, runId: '100', autoReuse: true }, (_command, args) => ({ status: 0,
    stdout: JSON.stringify(args.includes('--slurp') ? [{ artifacts: [] }] : { workflow_runs: null }) })), /Invalid release source run inventory/);
});

test('manual builds may precede a tag but cannot conflict with an existing tag commit', () => {
  const sha = 'a'.repeat(40);
  validateSourceTag(tag, () => ({ status: 1 }));
  validateSourceTag(tag, (_command, args) => ({ status: 0, stdout: sha + '\n' }));
  assert.throws(() => validateSourceTag(tag, (_command, args) => ({ status: 0, stdout: (args.at(-1).startsWith('HEAD') ? 'b'.repeat(40) : sha) + '\n' })), /does not match/);
  assert.throws(() => validateSourceTag(tag, () => ({ status: 128 })), /Could not verify/);
});

test('versioned Linux release notes select Linux for tag pushes, staging and recovery', () => {
  const notes = platforms => ({ versions: [{ version: '0.0.16', changes: ['Linux fixes'], ...(platforms === undefined ? {} : { platforms }) }] });
  assert.equal(releaseScope('v0.0.16', notes(['linux'])), 'linux');
  assert.equal(releaseScope('v0.0.16-beta.1', notes(['linux'])), 'linux');
  assert.equal(releaseScope('v0.0.16', notes()), 'all');
  const actual = structuredClone(require('../changelog.json'));
  const current = actual.versions.find(entry => entry.version === 'v0.0.15');
  assert.ok(current, 'exercise the actual v-prefixed changelog format');
  current.platforms = ['linux'];
  assert.equal(releaseScope('v0.0.15', actual), 'linux');
  for (const invalid of [[], ['windows'], ['linux', 'windows'], 'linux']) {
    assert.throws(() => releaseScope('v0.0.16', notes(invalid)), /Release platforms/);
  }
});

test('Linux-only preparation scans all three Linux packages without any Windows artifacts', async t => {
  const f = fixture(t);
  for (const file of [f.names.windows, f.names.windows + '.blockmap', f.names.windows + '.sha256', 'latest.yml']) fs.unlinkSync(path.join(f.directory, file));
  const assets = releaseAssets(f.directory, tag, { scope: 'linux', requireLinux: true, requirePortable: true, requireArch: true });
  const client = fakeClient();
  const metadata = await createMetadata({ tag, assets, client, scope: 'linux', now: () => date, scanOptions: { wait: noWait, now: () => date }, log() {} });
  assert.equal(metadata.scope, 'linux');
  assert.deepEqual(Object.keys(metadata.platforms), ['linuxDeb', 'linuxAppImage', 'linuxArch']);
  assert.deepEqual(client.calls, [f.names.linuxDeb, f.names.linuxAppImage, f.names.linuxArch]);
  fs.writeFileSync(path.join(f.directory, `release-${tag.slice(1)}.json`), JSON.stringify(metadata));
  assert.equal(releaseAssets(f.directory, tag, { scope: 'linux', requireMetadata: true }).length, 7);
  assert.throws(() => validateMetadata({ ...metadata, platforms: { ...metadata.platforms, windows: {} } }, tag, assets), /metadata platforms/);
  assert.throws(() => validateMetadata({ ...metadata, platforms: { ...metadata.platforms, linuxArch: undefined } }, tag, assets), /linuxArch/);
  assert.throws(() => validateMetadata({ ...metadata, scope: 'other' }, tag, assets), /scope/);
  const calls = [];
  await publishCdn({ directory: f.directory, tag, scope: 'linux', changelog: path.join(f.directory, 'changelog.json'), distribution: 'test', client: {
    async immutable(asset) { calls.push('immutable:' + asset.name); },
    async pointer(name) { calls.push('pointer:' + name); },
    async invalidate(_distribution, pointers) { calls.push(...pointers.map(name => 'invalidate:' + name)); },
  } });
  assert.equal(calls.filter(call => call.startsWith('immutable:')).length, 7);
  assert.deepEqual(calls.slice(7), ['pointer:changelog.json', 'pointer:latest-linux.json', 'invalidate:latest-linux.json', 'invalidate:changelog.json']);
  assert.ok(calls.every(call => !/latest\.yml|latest\.json|overkot\.exe|setup-/.test(call)));
});

test('Linux-only and complete release retention cannot satisfy each other during promotion', () => {
  const sha = 'a'.repeat(40);
  const complete = [{ name: `overkot-release-${sha}` }];
  const linux = [{ name: `overkot-release-linux-${sha}` }];
  assert.equal(retainedState(complete, sha, 'linux').has_release, false);
  assert.equal(retainedState(linux, sha).has_release, false);
  assert.equal(retainedState(linux, sha, 'linux').has_release, true);
  assert.equal(retainedState(linux, sha, 'linux').has_windows, false);
  assert.equal(retainedState(linux, sha, 'linux').has_linux, true);
});
