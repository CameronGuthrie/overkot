'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { RELEASES_URL, VT_URL, SCAN_STATUSES, validateTag, scopedPackageNames, releaseScope, releaseAssets, validateMetadata } = require('./release-artifacts');

const API = 'https://www.virustotal.com/api/v3';
const STAT_CATEGORIES = ['harmless', 'malicious', 'suspicious', 'undetected', 'timeout', 'confirmed-timeout', 'failure', 'type-unsupported'];
const DEFAULT_BUDGET_MS = 55 * 60000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function resumableError(message = 'VirusTotal scan budget exhausted; retained scan progress can be resumed.') {
  const error = new Error(message);
  error.code = 'SCAN_RESUMABLE';
  return error;
}

function budgetWait(wait, deadline, clock) {
  return async milliseconds => {
    if (clock() + milliseconds >= deadline) throw resumableError();
    await wait(milliseconds);
    if (clock() >= deadline) throw resumableError();
  };
}

function retryAfterMilliseconds(value, clock = Date.now) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until - clock()) : 0;
}

function completedResults(attributes, statsKey = 'stats', dateKey = 'date') {
  const raw = attributes?.[statsKey];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('VirusTotal completed analysis has no valid engine statistics.');
  const stats = {};
  for (const key of STAT_CATEGORIES) {
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 0) throw new Error('VirusTotal completed analysis has invalid engine statistics.');
    stats[key] = raw[key];
  }
  if (!Object.values(stats).some(count => count > 0)) throw new Error('VirusTotal completed analysis has no engine results.');
  const timestamp = attributes[dateKey];
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 253402300799) throw new Error('VirusTotal completed analysis has no valid analysis date.');
  return { stats, analysedAt: new Date(timestamp * 1000).toISOString() };
}

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function validateProgressReport(report, sha256) {
  if (!report || report.url !== VT_URL + sha256 || !SCAN_STATUSES.has(report.status)
      || typeof report.analysisId !== 'string' || !report.analysisId || report.analysisId.length > 1024
      || !validTimestamp(report.submittedAt)) throw new Error('Retained VirusTotal scan progress is invalid.');
  if (report.status === 'completed') {
    if (!validTimestamp(report.analysedAt)) throw new Error('Retained VirusTotal analysis date is invalid.');
    completedResults({ stats: report.stats, date: Math.floor(Date.parse(report.analysedAt) / 1000) });
  }
  return { url: report.url, status: report.status, analysisId: report.analysisId, submittedAt: report.submittedAt,
    ...(report.status === 'completed' ? { analysedAt: report.analysedAt,
      stats: Object.fromEntries(STAT_CATEGORIES.map(category => [category, report.stats[category]])) } : {}) };
}

function scanProgress(file, tag, assets) {
  const version = validateTag(tag);
  let state = { schemaVersion: 1, version, files: {} };
  if (fs.existsSync(file)) {
    if (fs.statSync(file).size > 1048576) throw new Error('Retained VirusTotal scan progress is too large.');
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Retained VirusTotal scan progress is invalid JSON.'); }
    if (state?.schemaVersion !== 1 || state.version !== version || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
      throw new Error('Retained VirusTotal scan progress does not match this release.');
    }
    const retainedFiles = {};
    for (const [name, value] of Object.entries(state.files)) {
      const asset = assets.find(asset => asset.name === name);
      if (!asset || value?.sha256 !== asset.digest.slice(7) || value.size !== asset.size) throw new Error('Retained VirusTotal scan progress does not match the exact release bytes.');
      retainedFiles[name] = { sha256: value.sha256, size: value.size, virusTotal: validateProgressReport(value.virusTotal, value.sha256) };
    }
    state = { schemaVersion: 1, version, files: retainedFiles };
  }
  return {
    get(asset) { return state.files[asset.name]?.virusTotal; },
    save(asset, report) {
      const sha256 = asset.digest.slice(7);
      validateProgressReport(report, sha256);
      // Construct the saved object from permitted fields; credentials never enter checkpoints.
      const virusTotal = { url: report.url, status: report.status, analysisId: report.analysisId, submittedAt: report.submittedAt,
        ...(report.status === 'completed' ? { analysedAt: report.analysedAt,
          stats: Object.fromEntries(STAT_CATEGORIES.map(category => [category, report.stats[category]])) } : {}) };
      state.files[asset.name] = { sha256, size: asset.size, virusTotal };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
      fs.renameSync(temporary, file);
    },
  };
}

function trustedUploadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid VirusTotal upload URL.'); }
  const officialDestination = (url.hostname === 'www.virustotal.com' && ['http:', 'https:'].includes(url.protocol))
    || (url.hostname === 'bigfiles.virustotal.com' && url.protocol === 'https:');
  if (!officialDestination || url.port || url.username || url.password) {
    // Only public connection details are safe diagnostics; the upload path/query are bearer tokens.
    const destination = JSON.stringify({ protocol: url.protocol, hostname: url.hostname, port: url.port });
    throw new Error(`Refusing to send the VirusTotal API key to an untrusted upload URL (${destination}).`);
  }
  // Upgrade documented legacy www HTTP URLs; the current BigFiles upload host requires HTTPS.
  url.protocol = 'https:';
  return url.href;
}

function virusTotalClient({ apiKey, fetchImpl = fetch, wait = sleep, attempts = 3, requestInterval = 16000,
  deadline = Infinity, clock = Date.now, maxRequests = 450 }) {
  if (!apiKey?.trim()) throw new Error('VIRUSTOTAL_API_KEY is required to publish release downloads and scan links.');
  let firstRequest = true;
  let requests = 0;
  let queue = Promise.resolve();
  const pause = budgetWait(wait, deadline, clock);
  async function performRequest(url, options = {}, maxAttempts = attempts, allowMissing = false) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (clock() >= deadline) throw resumableError();
      if (!firstRequest) await pause(requestInterval);
      firstRequest = false;
      if (++requests > maxRequests) throw resumableError('VirusTotal request allowance exhausted; retained scan progress can be resumed after quota is available.');
      let response;
      try {
        response = await fetchImpl(url, { ...options, headers: { 'x-apikey': apiKey }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(180000, deadline - clock())))) });
      } catch {
        if (attempt === maxAttempts) throw new Error('VirusTotal request failed after bounded retries.');
        await pause(attempt * 20000);
        continue;
      }
      if (allowMissing && response.status === 404) return null;
      if (response.ok) {
        try { return await response.json(); } catch { throw new Error('VirusTotal returned an invalid response.'); }
      }
      const retryAfterMs = retryAfterMilliseconds(response.headers?.get('retry-after'), clock);
      if ((response.status !== 429 && response.status < 500) || attempt === maxAttempts) {
        const error = new Error(`VirusTotal request failed (HTTP ${response.status}); release pointers were not updated.`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs;
        throw error;
      }
      // Never print response bodies, upload URLs, or headers: they may contain credentials.
      await pause(Math.max(20000 * attempt, retryAfterMs));
    }
  }
  function request(...args) {
    const operation = queue.then(() => performRequest(...args));
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    async submit(asset) {
      const blob = await fs.openAsBlob(asset.path);
      // A large upload URL is single-use; do not retry its POST against the same URL.
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const url = asset.size > 32 * 1024 * 1024 ? trustedUploadUrl((await request(`${API}/files/upload_url`)).data) : `${API}/files`;
        const form = new FormData();
        form.set('file', blob, asset.name);
        try {
          const response = await request(url, { method: 'POST', body: form }, 1);
          const id = response.data?.id;
          if (typeof id !== 'string' || !id || id.length > 1024) throw new Error('VirusTotal did not return an analysis ID.');
          return id;
        } catch (error) {
          if (error.code === 'SCAN_RESUMABLE' || attempt === attempts || /HTTP (?:400|401|403|413)/.test(error.message)) throw error;
          await pause(Math.max(20000, error.retryAfterMs || 0));
        }
      }
    },
    async analysis(id) { return request(`${API}/analyses/${encodeURIComponent(id)}`); },
    async file(sha256) { return request(`${API}/files/${encodeURIComponent(sha256)}`, {}, attempts, true); },
  };
}

async function fileResults(asset, client) {
  if (typeof client.file !== 'function') throw new Error('VirusTotal completed analysis is missing required results.');
  const response = await client.file(asset.digest.slice(7));
  const attributes = response?.data?.attributes;
  if (!response || response.data?.id !== asset.digest.slice(7)
      || (attributes?.sha256 && attributes.sha256 !== asset.digest.slice(7))) {
    throw new Error('VirusTotal file report does not match the retained release file.');
  }
  return completedResults(attributes, 'last_analysis_stats', 'last_analysis_date');
}

async function scanAsset(asset, client, { polls = 8, wait = sleep, now = () => new Date().toISOString(),
  deadline = Infinity, clock = Date.now, checkpoint, onProgress = () => {} } = {}) {
  let report;
  if (checkpoint) report = { ...validateProgressReport(checkpoint, asset.digest.slice(7)) };
  else {
    if (clock() >= deadline) throw resumableError();
    const analysisId = await client.submit(asset);
    report = { url: VT_URL + asset.digest.slice(7), status: 'queued', analysisId, submittedAt: now() };
    await onProgress(asset, report);
  }
  if (report.status === 'completed') return report;
  const pause = budgetWait(wait, deadline, clock);
  for (let poll = 0; poll < polls; poll++) {
    await pause(30000);
    let response;
    try { response = await client.analysis(report.analysisId); }
    catch (error) {
      if (error.status !== 404) throw error;
      report = { ...report, status: 'completed', ...await fileResults(asset, client) };
      await onProgress(asset, report);
      return report;
    }
    const status = response?.data?.attributes?.status;
    if (!SCAN_STATUSES.has(status)) throw new Error('VirusTotal returned an unrecognised analysis status.');
    const observedHash = response.meta?.file_info?.sha256;
    if (observedHash && observedHash !== asset.digest.slice(7)) throw new Error('VirusTotal analysis hash does not match the retained release file.');
    report = { ...report, status };
    if (status === 'completed') {
      let results;
      try { results = completedResults(response.data.attributes); }
      catch (error) {
        if (typeof client.file !== 'function') throw error;
        results = await fileResults(asset, client);
      }
      report = { ...report, ...results };
    }
    await onProgress(asset, report);
    if (status === 'completed') return report;
  }
  return report;
}

async function createMetadata({ tag, assets, client, scanOptions = {}, progress, now = () => new Date().toISOString(), log = console.log, scope = 'all' }) {
  const metadata = { schemaVersion: 2, ...(scope === 'linux' ? { scope } : {}), version: validateTag(tag), publishedAt: now(), platforms: {} };
  const options = { polls: Infinity, deadline: Date.now() + DEFAULT_BUDGET_MS, ...scanOptions };
  for (const [platform, filename] of Object.entries(scopedPackageNames(tag, scope))) {
    const asset = assets.find(value => value.name === filename);
    if (!asset) throw new Error(`Missing retained package: ${filename}`);
    const virusTotal = await scanAsset(asset, client, { ...options, checkpoint: progress?.get(asset),
      onProgress: async (asset, report) => { progress?.save(asset, report); await options.onProgress?.(asset, report); } });
    if (virusTotal.status !== 'completed') throw resumableError('VirusTotal analysis is still pending; retained scan progress can be resumed before publication.');
    metadata.platforms[platform] = { filename, url: `${RELEASES_URL}/${filename}`, size: asset.size, sha256: asset.digest.slice(7),
      checksumUrl: `${RELEASES_URL}/${filename}.sha256`, virusTotal };
    log(`${filename}: VirusTotal analysis completed; ${virusTotal.stats.malicious} malicious and ${virusTotal.stats.suspicious} suspicious engine results. ${virusTotal.url}`);
  }
  metadata.publishedAt = now();
  return validateMetadata(metadata, tag, assets);
}

async function main() {
  const tag = process.env.RELEASE_TAG;
  const directory = process.env.RELEASE_DIRECTORY || 'dist';
  const scope = releaseScope(tag, require('../changelog.json'));
  const minutes = Number(process.env.VIRUSTOTAL_SCAN_BUDGET_MINUTES || 55);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error('VIRUSTOTAL_SCAN_BUDGET_MINUTES must be between 1 and 60.');
  const deadline = Date.now() + minutes * 60000;
  const client = virusTotalClient({ apiKey: process.env.VIRUSTOTAL_API_KEY, deadline });
  const assets = releaseAssets(directory, tag, { scope, requireLinux: true, requirePortable: true, requireArch: true });
  const progress = scanProgress(process.env.VIRUSTOTAL_SCAN_PROGRESS_FILE || path.join(directory, `scan-progress-${validateTag(tag)}.json`), tag, assets);
  const metadata = await createMetadata({ tag, assets, client, progress, scanOptions: { deadline }, scope });
  fs.writeFileSync(path.join(directory, `release-${validateTag(tag)}.json`), JSON.stringify(metadata, null, 2) + '\n');
}

module.exports = { virusTotalClient, trustedUploadUrl, scanAsset, createMetadata, scanProgress, completedResults, retryAfterMilliseconds, STAT_CATEGORIES };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
