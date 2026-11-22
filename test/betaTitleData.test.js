const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBetaTitleCatalog, loadTitleCatalogSnapshot, refreshTitleCatalogSnapshot, BUCKET, SOURCE_PATH } = require('../scripts/build-title-data');

function fixture() {
  const buildId = '2026-10-06T06-06-49Z-beta-test';
  const pointer = { build_id: buildId };
  const raw = { 'FlavourItems.CogahTitle': {
    internalId: 'FlavourItems.CogahTitle', value: 'Of The Sleeve',
    itemType: '/SF/Types/Items/Titles/CogahTitle',
    challenge: { enabled: true, name: 'CogahTitleChallenge', path: '/SF/Types/Challenges/Titles/CogahTitleChallenge',
      legacyName: null, requiredCount: 10, text: 'Defeat 10 Agari in The Cogah.' },
    extraPipelineField: 'must not be embedded',
  } };
  const bytes = Buffer.from(JSON.stringify(raw));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = { build_id: buildId, files: [{ path: SOURCE_PATH, bytes: bytes.length, sha256 }] };
  const reads = [];
  async function getObject(key) {
    reads.push(key);
    if (key === 'current.json') return Buffer.from(JSON.stringify(pointer));
    if (key === `builds/${buildId}/manifest.json`) return Buffer.from(JSON.stringify(manifest));
    assert.equal(key, `builds/${buildId}/${SOURCE_PATH}`);
    return bytes;
  }
  return { buildId, pointer, manifest, bytes, sha256, reads, getObject };
}

test('beta title data reads the same S3 build, verifies its manifest and embeds only projected fields', async () => {
  const data = fixture();
  const result = await loadBetaTitleCatalog(data);
  assert.deepEqual(data.reads, ['current.json', `builds/${data.buildId}/manifest.json`, `builds/${data.buildId}/${SOURCE_PATH}`]);
  assert.deepEqual(result.source, { bucket: BUCKET, buildId: data.buildId, path: SOURCE_PATH, sha256: data.sha256 });
  assert.equal(result.catalog.schema, 1);
  assert.equal(result.catalog.titles.length, 1);
  assert.equal(result.catalog.titles[0].name, 'Of The Sleeve');
  assert.equal(result.catalog.titles[0].target, 10);
  assert.equal(result.catalog.titles[0].extraPipelineField, undefined);
});

test('unsafe S3 pointers fail before reading their indicated location', async () => {
  for (const changes of [{ build_id: '../outside' }, { prefix: 'elsewhere' }, { manifest: 'another/manifest.json' }]) {
    const data = fixture();
    Object.assign(data.pointer, changes);
    await assert.rejects(loadBetaTitleCatalog(data), /Invalid title data S3 build id|Unexpected title data S3 manifest location/);
    assert.deepEqual(data.reads, ['current.json']);
  }
});

test('mismatched, missing, duplicate or malformed manifest records prevent a beta seed', async () => {
  const mutations = [
    data => { data.manifest.build_id = 'different-build'; },
    data => { data.manifest.files = []; },
    data => { data.manifest.files.push({ ...data.manifest.files[0] }); },
    data => { data.manifest.files[0].sha256 = 'invalid'; },
    data => { data.manifest.files[0].bytes = 1024 * 1024 + 1; },
  ];
  for (const mutate of mutations) {
    const data = fixture(); mutate(data);
    await assert.rejects(loadBetaTitleCatalog(data), /S3 pointer\/manifest mismatch|Missing or invalid epithets entry/);
    assert.equal(data.reads.length, 2);
  }
});

test('byte count or SHA-256 mismatches reject downloaded title data', async () => {
  for (const key of ['bytes', 'sha256']) {
    const data = fixture();
    data.manifest.files[0][key] = key === 'bytes' ? data.bytes.length + 1 : '0'.repeat(64);
    await assert.rejects(loadBetaTitleCatalog(data), /S3 content hash mismatch/);
  }
});

test('an unavailable S3 source stops the beta build without any local fallback', async () => {
  let calls = 0;
  await assert.rejects(loadBetaTitleCatalog({ getObject: async () => { calls++; throw new Error('S3 unavailable'); } }), /S3 unavailable/);
  assert.equal(calls, 1);
});

function snapshotPaths(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-title-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { catalogPath: path.join(directory, 'catalog.json'), sourcePath: path.join(directory, 'source.json') };
}

test('the checked-in release snapshot contains validated titles and matching source provenance without AWS access', () => {
  const data = loadTitleCatalogSnapshot();
  assert.ok(data.catalog.titles.length > 0);
  assert.equal(data.catalog.schema, 1);
  assert.equal(data.source.bucket, BUCKET);
  assert.equal(data.source.path, SOURCE_PATH);
  assert.match(data.source.sha256, /^[a-f0-9]{64}$/);
  assert.ok(data.catalog.titles.every(title => title.target > 0 && title.challengeName));
});

test('an explicit refresh persists only the verified projected catalog and can then build offline', async t => {
  const files = snapshotPaths(t);
  const data = fixture();
  const downloaded = await refreshTitleCatalogSnapshot({ ...files, getObject: data.getObject });
  assert.deepEqual(loadTitleCatalogSnapshot(files), downloaded);
  assert.doesNotMatch(fs.readFileSync(files.catalogPath, 'utf8'), /extraPipelineField|must not be embedded/);
  const source = JSON.parse(fs.readFileSync(files.sourcePath, 'utf8'));
  assert.equal(source.catalogSha256, createHash('sha256').update(JSON.stringify(downloaded.catalog)).digest('hex'));
});

test('snapshot tampering, invalid titles and invalid provenance stop release builds', async t => {
  const files = snapshotPaths(t);
  await refreshTitleCatalogSnapshot({ ...files, getObject: fixture().getObject });
  const originalCatalog = fs.readFileSync(files.catalogPath, 'utf8');
  const originalSource = fs.readFileSync(files.sourcePath, 'utf8');
  const catalog = JSON.parse(originalCatalog);
  catalog.titles[0].target++;
  fs.writeFileSync(files.catalogPath, JSON.stringify(catalog));
  assert.throws(() => loadTitleCatalogSnapshot(files), /snapshot hash mismatch/);
  catalog.titles[0].target = 0;
  fs.writeFileSync(files.catalogPath, JSON.stringify(catalog));
  assert.throws(() => loadTitleCatalogSnapshot(files), /Invalid title catalog/);
  fs.writeFileSync(files.catalogPath, originalCatalog);
  for (const changes of [{ bucket: 'other' }, { buildId: '../outside' }, { path: 'unexpected.json' },
    { sha256: 'invalid' }, { catalogSha256: 'invalid' }]) {
    fs.writeFileSync(files.sourcePath, JSON.stringify({ ...JSON.parse(originalSource), ...changes }));
    assert.throws(() => loadTitleCatalogSnapshot(files), /snapshot provenance/);
  }
  fs.writeFileSync(files.sourcePath, originalSource);
  fs.writeFileSync(files.catalogPath, ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => loadTitleCatalogSnapshot(files), /size limit/);
});

test('a failed source verification leaves the reviewed snapshot intact', async t => {
  const files = snapshotPaths(t);
  await refreshTitleCatalogSnapshot({ ...files, getObject: fixture().getObject });
  const before = [files.catalogPath, files.sourcePath].map(file => fs.readFileSync(file, 'utf8'));
  const data = fixture();
  data.manifest.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(refreshTitleCatalogSnapshot({ ...files, getObject: data.getObject }), /S3 content hash mismatch/);
  assert.deepEqual([files.catalogPath, files.sourcePath].map(file => fs.readFileSync(file, 'utf8')), before);
});
