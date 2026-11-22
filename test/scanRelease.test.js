'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAsset, packageNames } = require('../scripts/release-artifacts');
const { scanAsset, createMetadata, scanProgress, completedResults, virusTotalClient, trustedUploadUrl, STAT_CATEGORIES } = require('../scripts/scan-release');

const tag = 'v0.0.13';
const date = '2026-10-06T12:00:00.000Z';
const epoch = Date.parse(date) / 1000;
const noWait = async () => {};
const stats = changes => ({ ...Object.fromEntries(STAT_CATEGORIES.map(key => [key, key === 'undetected' ? 60 : 0])), ...changes });
const complete = (asset, changes = {}) => ({ data: { attributes: { status: 'completed', stats: stats(changes), date: epoch } },
  meta: { file_info: { sha256: asset.digest.slice(7) } } });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-scan-'));
  t.after(() => {
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  const assets = Object.values(packageNames(tag)).map(name => {
    fs.writeFileSync(path.join(directory, name), 'Exact release bytes: ' + name);
    return readAsset(directory, name);
  });
  const file = path.join(directory, 'scan-progress-0.0.13.json');
  return { directory, file, assets, asset: assets[0] };
}

test('documented HTTP upload URLs are upgraded before any API key or file bytes are sent', async t => {
  const { asset } = fixture(t);
  const upload = 'http://www.virustotal.com/_ah/upload/single-use-token?signature=mock-token';
  const secureUpload = 'https://www.virustotal.com/_ah/upload/single-use-token?signature=mock-token';
  assert.equal(trustedUploadUrl(upload), secureUpload);
  assert.equal(trustedUploadUrl(secureUpload), secureUpload);
  const requests = [];
  const client = virusTotalClient({ apiKey: 'mock-secret', wait: noWait, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(new URL(url).hostname, 'www.virustotal.com');
    assert.equal(options.headers['x-apikey'], 'mock-secret');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/files/upload_url')) return { ok: true, json: async () => ({ data: upload }) };
    assert.equal(url, secureUpload);
    assert.equal(options.method, 'POST');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('file').name, asset.name);
    return { ok: true, json: async () => ({ data: { id: 'accepted-analysis' } }) };
  } });
  assert.equal(await client.submit({ ...asset, size: 33 * 1024 * 1024 }), 'accepted-analysis');
  assert.deepEqual(requests, ['https://www.virustotal.com/api/v3/files/upload_url', secureUpload]);
});

test('observed HTTPS BigFiles upload host receives the exact returned URL over TLS', async t => {
  const { asset } = fixture(t);
  const upload = 'https://bigfiles.virustotal.com/_ah/upload/mock-single-use-token?signature=mock-token';
  assert.equal(trustedUploadUrl(upload), upload);
  const requests = [];
  const client = virusTotalClient({ apiKey: 'mock-secret', wait: noWait, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(options.headers['x-apikey'], 'mock-secret');
    assert.equal(options.redirect, 'error');
    if (url === 'https://www.virustotal.com/api/v3/files/upload_url') {
      return { ok: true, json: async () => ({ data: upload }) };
    }
    assert.equal(url, upload);
    assert.equal(new URL(url).hostname, 'bigfiles.virustotal.com');
    assert.equal(options.method, 'POST');
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('file').name, asset.name);
    return { ok: true, json: async () => ({ data: { id: 'accepted-analysis' } }) };
  } });
  assert.equal(await client.submit({ ...asset, size: 33 * 1024 * 1024 }), 'accepted-analysis');
  assert.deepEqual(requests, ['https://www.virustotal.com/api/v3/files/upload_url', upload]);
});

test('upload URL guard rejects other authorities and schemes without logging credentials or tokens', () => {
  for (const url of ['https://evil.example/_ah/upload/path-token?query-token=value',
    'http://www.virustotal.com.evil.example/_ah/upload/path-token?query-token=value',
    'https://virustotal.com/_ah/upload/path-token?query-token=value',
    'https://user-secret:password-secret@www.virustotal.com/_ah/upload/path-token?query-token=value',
    'http://user-secret@www.virustotal.com/_ah/upload/path-token?query-token=value',
    'https://www.virustotal.com:8443/_ah/upload/path-token?query-token=value',
    'http://www.virustotal.com:443/_ah/upload/path-token?query-token=value',
    'http://bigfiles.virustotal.com/_ah/upload/path-token?query-token=value',
    'https://bigfiles.virustotal.com.evil.example/_ah/upload/path-token?query-token=value',
    'https://evil.bigfiles.virustotal.com/_ah/upload/path-token?query-token=value',
    'https://user-secret:password-secret@bigfiles.virustotal.com/_ah/upload/path-token?query-token=value',
    'https://bigfiles.virustotal.com:8443/_ah/upload/path-token?query-token=value',
    'ftp://bigfiles.virustotal.com/_ah/upload/path-token?query-token=value',
    'ftp://www.virustotal.com/_ah/upload/path-token?query-token=value']) {
    assert.throws(() => trustedUploadUrl(url), error => /untrusted upload URL/.test(error.message)
      && !['path-token', 'query-token', 'user-secret', 'password-secret'].some(secret => error.message.includes(secret)));
  }
  assert.throws(() => trustedUploadUrl('not a URL/path-token?query-token=value'), error => error.message === 'Invalid VirusTotal upload URL.');
});

test('untrusted returned upload destinations never receive an API key or upload request', async t => {
  const { asset } = fixture(t);
  let calls = 0;
  const client = virusTotalClient({ apiKey: 'mock-secret', wait: noWait, fetchImpl: async url => {
    assert.equal(url, 'https://www.virustotal.com/api/v3/files/upload_url');
    calls++;
    return { ok: true, json: async () => ({ data: 'https://evil.example/path-token?query-token=value' }) };
  } });
  await assert.rejects(client.submit({ ...asset, size: 33 * 1024 * 1024 }), error => /untrusted/.test(error.message)
    && !['mock-secret', 'path-token', 'query-token'].some(secret => error.message.includes(secret)));
  assert.equal(calls, 1);
});

test('completed results preserve engine counts, detections and actual analysis time', async t => {
  const { asset } = fixture(t);
  const report = await scanAsset(asset, { async submit() { return 'analysis-1'; }, async analysis() { return complete(asset, { malicious: 2, suspicious: 1 }); } },
    { wait: noWait, now: () => date });
  assert.equal(report.status, 'completed');
  assert.equal(report.analysedAt, date);
  assert.deepEqual(report.stats, stats({ malicious: 2, suspicious: 1 }));
  assert.equal('clean' in report, false);
});

test('completion without real engine results or date cannot produce a verdict', () => {
  for (const attributes of [{ date: epoch }, { date: epoch, stats: stats({ malicious: -1 }) },
    { date: epoch, stats: stats({ failure: 1.5 }) }, { date: epoch, stats: stats({ undetected: 0 }) },
    { date: 0, stats: stats() }, { date: 253402300800, stats: stats() }, { stats: stats() }, { date: epoch, stats: { undetected: 60 } }]) {
    assert.throws(() => completedResults(attributes), /VirusTotal completed analysis/);
  }
});

test('durable checkpoints survive failed polling and resume the same analysis without reupload', async t => {
  const { file, assets, asset } = fixture(t);
  let submissions = 0;
  let polls = 0;
  const progress = scanProgress(file, tag, assets);
  const client = { async submit() { submissions++; return 'accepted-analysis'; }, async analysis(id) {
    assert.equal(id, 'accepted-analysis');
    if (++polls === 1) return { data: { attributes: { status: 'in-progress' } } };
    throw new Error('Transient provider failure');
  } };
  await assert.rejects(scanAsset(asset, client, { wait: noWait, now: () => date,
    onProgress: (asset, report) => progress.save(asset, report) }), /Transient provider failure/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.files[asset.name].virusTotal.status, 'in-progress');
  assert.equal(saved.files[asset.name].sha256, asset.digest.slice(7));
  const resumed = scanProgress(file, tag, assets);
  const report = await scanAsset(asset, { ...client, async analysis() { return complete(asset); } },
    { checkpoint: resumed.get(asset), wait: noWait, onProgress: (asset, value) => resumed.save(asset, value) });
  assert.equal(submissions, 1);
  assert.equal(report.analysisId, 'accepted-analysis');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).files[asset.name].virusTotal.analysedAt, date);
});

test('completed checkpoints reuse exact results without any VirusTotal requests', async t => {
  const { file, assets, asset } = fixture(t);
  const progress = scanProgress(file, tag, assets);
  const report = { url: 'https://www.virustotal.com/gui/file/' + asset.digest.slice(7), status: 'completed',
    analysisId: 'analysis-1', submittedAt: date, analysedAt: date, stats: stats({ suspicious: 1 }) };
  progress.save(asset, report);
  const resumed = scanProgress(file, tag, assets);
  const result = await scanAsset(asset, { async submit() { throw new Error('Must not reupload'); },
    async analysis() { throw new Error('Must not repoll'); } }, { checkpoint: resumed.get(asset) });
  assert.deepEqual(result, report);
});

test('checkpoint reuse rejects another version, changed bytes and corrupted report data', t => {
  const { file, assets, asset } = fixture(t);
  const progress = scanProgress(file, tag, assets);
  progress.save(asset, { url: 'https://www.virustotal.com/gui/file/' + asset.digest.slice(7), status: 'queued', analysisId: 'analysis-1', submittedAt: date });
  assert.throws(() => scanProgress(file, 'v0.0.14', assets), /match this release/);
  assert.throws(() => scanProgress(file, tag, [{ ...asset, digest: 'sha256:' + 'a'.repeat(64) }]), /exact release bytes/);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.files[asset.name].virusTotal.url = 'https://untrusted.example/report';
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => scanProgress(file, tag, assets), /scan progress is invalid/);
});

test('checkpoint loading and saving retain only permitted scan fields', async t => {
  const { file, assets, asset } = fixture(t);
  const report = { url: 'https://www.virustotal.com/gui/file/' + asset.digest.slice(7), status: 'completed',
    analysisId: 'analysis-1', submittedAt: date, analysedAt: date, stats: stats() };
  const progress = scanProgress(file, tag, assets);
  progress.save(asset, report);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.extra = 'must-not-persist';
  saved.files[asset.name].virusTotal.extra = 'must-not-persist';
  saved.files[asset.name].virusTotal.stats.extra = 'must-not-persist';
  fs.writeFileSync(file, JSON.stringify(saved));
  const loaded = scanProgress(file, tag, assets);
  const result = await scanAsset(asset, {}, { checkpoint: loaded.get(asset) });
  assert.deepEqual(result, report);
  loaded.save(asset, result);
  assert.equal(fs.readFileSync(file, 'utf8').includes('must-not-persist'), false);
});

test('budget expiry retains the upload ID and pending state before any final manifest', async t => {
  const { file, assets, asset, directory } = fixture(t);
  const progress = scanProgress(file, tag, assets);
  let time = 0;
  const client = { async submit() { return 'analysis-1'; }, async analysis() { throw new Error('Must not poll after deadline'); } };
  await assert.rejects(createMetadata({ tag, assets, client, progress, log() {}, scanOptions: {
    deadline: 10000, clock: () => time, now: () => date, wait: async milliseconds => { time += milliseconds; },
  } }), error => error.code === 'SCAN_RESUMABLE');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).files[asset.name].virusTotal.analysisId, 'analysis-1');
  assert.equal(fs.existsSync(path.join(directory, 'release-0.0.13.json')), false);
});

test('pending analysis cannot be frozen into fresh release metadata', async t => {
  const { file, assets } = fixture(t);
  const progress = scanProgress(file, tag, assets);
  await assert.rejects(createMetadata({ tag, assets, progress, log() {}, client: {
    async submit() { return 'analysis-1'; }, async analysis() { return { data: { attributes: { status: 'queued' } } }; },
  }, scanOptions: { polls: 1, wait: noWait, now: () => date } }), error => error.code === 'SCAN_RESUMABLE');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).files).length, 1);
});

test('fresh metadata includes every package and retains detections for publication review', async t => {
  const { file, assets } = fixture(t);
  const progress = scanProgress(file, tag, assets);
  const submitted = [];
  const client = { async submit(asset) { submitted.push(asset.name); return asset.name; },
    async analysis(name) { return complete(assets.find(asset => asset.name === name), { malicious: 1 }); } };
  const metadata = await createMetadata({ tag, assets, client, progress, now: () => date, log() {}, scanOptions: { wait: noWait, now: () => date } });
  assert.equal(metadata.schemaVersion, 2);
  assert.deepEqual(submitted, Object.values(packageNames(tag)));
  for (const record of Object.values(metadata.platforms)) assert.equal(record.virusTotal.stats.malicious, 1);
});

test('long Retry-After instructions and HTTP dates are respected', async () => {
  for (const retryAfter of ['90', 'Tue, 06 Oct 2026 12:01:30 GMT']) {
    let time = Date.parse(date), calls = 0;
    const waits = [];
    const client = virusTotalClient({ apiKey: 'mock-secret', clock: () => time, deadline: time + 180000,
      wait: async milliseconds => { waits.push(milliseconds); time += milliseconds; }, fetchImpl: async () => {
        if (++calls === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': retryAfter }) };
        return { ok: true, json: async () => ({ data: 'accepted' }) };
      } });
    assert.deepEqual(await client.analysis('analysis-1'), { data: 'accepted' });
    assert.ok(waits.includes(90000));
    assert.equal(calls, 2);
  }
});

test('Retry-After beyond the scan budget stops safely instead of retrying early', async () => {
  let calls = 0;
  const client = virusTotalClient({ apiKey: 'mock-secret', deadline: 60000, clock: () => 0,
    wait: async () => { throw new Error('Must not wait beyond budget'); }, fetchImpl: async () => {
      calls++; return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
    } });
  await assert.rejects(client.analysis('analysis-1'), error => error.code === 'SCAN_RESUMABLE' && !error.message.includes('mock-secret'));
  assert.equal(calls, 1);
});

test('upload retries also honor Retry-After and large uploads get a fresh single-use URL', async t => {
  const { asset } = fixture(t);
  let time = 0, uploads = 0, urls = 0;
  const waits = [];
  const client = virusTotalClient({ apiKey: 'mock-secret', deadline: 300000, clock: () => time,
    wait: async milliseconds => { waits.push(milliseconds); time += milliseconds; }, fetchImpl: async url => {
      if (url.endsWith('upload_url')) return { ok: true, json: async () => ({ data: 'https://www.virustotal.com/_ah/upload/' + ++urls }) };
      if (++uploads === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) };
      return { ok: true, json: async () => ({ data: { id: 'analysis-1' } }) };
    } });
  assert.equal(await client.submit({ ...asset, size: 33 * 1024 * 1024 }), 'analysis-1');
  assert.equal(urls, 2);
  assert.ok(waits.includes(90000));
});

test('one client serializes concurrent calls with public API pacing', async () => {
  let time = 0;
  const times = [];
  const client = virusTotalClient({ apiKey: 'mock-secret', clock: () => time, wait: async milliseconds => { time += milliseconds; },
    fetchImpl: async () => { times.push(time); return { ok: true, json: async () => ({ data: {} }) }; } });
  await Promise.all([client.analysis('one'), client.analysis('two'), client.analysis('three')]);
  assert.deepEqual(times, [0, 16000, 32000]);
});

test('request allowance stops additional requests with a resumable error', async () => {
  let calls = 0;
  const client = virusTotalClient({ apiKey: 'mock-secret', maxRequests: 2, wait: noWait,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ data: {} }) }; } });
  await client.analysis('one');
  await client.analysis('two');
  await assert.rejects(client.analysis('three'), error => error.code === 'SCAN_RESUMABLE');
  assert.equal(calls, 2);
});

test('missing completed-analysis details use a hash-verified file report and its actual timestamp', async t => {
  const { asset } = fixture(t);
  const client = { async submit() { return 'analysis-1'; }, async analysis() { return { data: { attributes: { status: 'completed' } } }; },
    async file(hash) { assert.equal(hash, asset.digest.slice(7)); return { data: { id: hash,
      attributes: { last_analysis_stats: stats(), last_analysis_date: epoch } } }; } };
  const report = await scanAsset(asset, client, { wait: noWait, now: () => date });
  assert.equal(report.analysedAt, date);
  await assert.rejects(scanAsset(asset, { ...client, async file() { return { data: { id: 'a'.repeat(64),
    attributes: { last_analysis_stats: stats(), last_analysis_date: epoch } } }; } }, { wait: noWait }), /does not match/);
  await assert.rejects(scanAsset(asset, { ...client, async file(hash) { return { data: { id: hash,
    attributes: { sha256: 'a'.repeat(64), last_analysis_stats: stats(), last_analysis_date: epoch } } }; } }, { wait: noWait }), /does not match/);
});

test('expired checkpoint analysis IDs recover completed same-hash file reports without submission', async t => {
  const { asset } = fixture(t);
  const checkpoint = { url: 'https://www.virustotal.com/gui/file/' + asset.digest.slice(7), status: 'in-progress', analysisId: 'expired-id', submittedAt: date };
  const report = await scanAsset(asset, { async submit() { throw new Error('Must not resubmit'); },
    async analysis() { const error = new Error('HTTP 404'); error.status = 404; throw error; },
    async file(hash) { return { data: { id: hash, attributes: { last_analysis_stats: stats(), last_analysis_date: epoch } } }; },
  }, { checkpoint, wait: noWait });
  assert.equal(report.analysisId, 'expired-id');
  assert.equal(report.status, 'completed');
});

test('network and malformed-response errors never expose API credentials', async () => {
  for (const fetchImpl of [async () => { throw new Error('mock-secret sensitive detail'); },
    async () => ({ ok: true, json: async () => { throw new Error('mock-secret sensitive detail'); } })]) {
    const client = virusTotalClient({ apiKey: 'mock-secret', fetchImpl, wait: noWait });
    await assert.rejects(client.analysis('analysis-1'), error => !error.message.includes('mock-secret'));
  }
});
