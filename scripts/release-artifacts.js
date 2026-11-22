'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RELEASES_URL = 'https://releases.overkot.com/releases';
const VT_URL = 'https://www.virustotal.com/gui/file/';
const SCAN_STATUSES = new Set(['queued', 'in-progress', 'completed']);
const SCAN_CATEGORIES = ['harmless', 'malicious', 'suspicious', 'undetected', 'timeout', 'confirmed-timeout', 'failure', 'type-unsupported'];

function validateTag(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(tag)) {
    throw new Error('Expected a release tag such as v0.0.12-beta.1.');
  }
  return tag.slice(1);
}

function readAsset(directory, name) {
  const file = path.resolve(directory, name);
  const bytes = fs.readFileSync(file);
  return { name, path: file, size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') };
}

function checkedPackage(directory, name, blockmap = false) {
  const assets = [name, ...(blockmap ? [name + '.blockmap'] : []), name + '.sha256'].map(file => readAsset(directory, file));
  const checksum = fs.readFileSync(assets.at(-1).path, 'utf8').trim().split(/\s+/);
  if (checksum.length !== 2 || checksum[0] !== assets[0].digest.slice(7) || checksum[1] !== name) {
    throw new Error('Package and retained SHA-256 checksum do not match.');
  }
  return assets;
}

function packageNames(tag) {
  const version = validateTag(tag);
  return { windows: `overkot-setup-${version}.exe`, linuxDeb: `overkot-${version}-linux-amd64.deb`,
    linuxAppImage: `overkot-${version}-linux-x86_64.AppImage`, linuxArch: `overkot-${version}-linux-x64.pkg.tar.xz` };
}

// Release scope belongs to the versioned notes so tag pushes, manual staging
// and recovery all select the same platforms without a dispatch-only override.
function releaseScope(tag, changelog) {
  const version = validateTag(tag);
  const normalized = entry => typeof entry?.version === 'string' ? entry.version.replace(/^v/, '') : '';
  const entry = changelog?.versions?.find(value => normalized(value) === version.split('-')[0])
    || changelog?.versions?.find(value => normalized(value) === version);
  if (entry?.platforms === undefined) return 'all';
  if (Array.isArray(entry.platforms) && entry.platforms.length === 1 && entry.platforms[0] === 'linux') return 'linux';
  throw new Error('Release platforms must be omitted for all platforms or set to ["linux"].');
}

function scopedPackageNames(tag, scope = 'all') {
  if (!['all', 'linux'].includes(scope)) throw new Error('Invalid release scope.');
  return Object.fromEntries(Object.entries(packageNames(tag)).filter(([platform]) => scope !== 'linux' || platform !== 'windows'));
}

function validateMetadata(metadata, tag, assets) {
  const scope = metadata?.scope || 'all';
  const names = scopedPackageNames(tag, scope);
  const utcDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
  if (![1, 2].includes(metadata?.schemaVersion) || (scope === 'linux' && metadata.schemaVersion !== 2)
      || metadata.version !== validateTag(tag) || !utcDate(metadata.publishedAt)) {
    throw new Error('Invalid release metadata version or publication date.');
  }
  if (!metadata.platforms || Array.isArray(metadata.platforms) || typeof metadata.platforms !== 'object'
      || (metadata.schemaVersion === 2 && Object.keys(metadata.platforms).some(platform => !Object.hasOwn(names, platform)))) {
    throw new Error('Invalid release metadata platforms.');
  }
  for (const [platform, name] of Object.entries(names)) {
    const asset = assets.find(value => value.name === name);
    const record = metadata.platforms?.[platform];
    // Retained releases can predate a package format. A present package or
    // manifest entry must always have its matching counterpart.
    if (!asset && !record && platform !== 'windows' && metadata.schemaVersion === 1) continue;
    const sha256 = asset?.digest.slice(7);
    if (!asset || !record || record.filename !== name || record.size !== asset.size || !Number.isSafeInteger(record.size) || record.size <= 0 || record.sha256 !== sha256
        || record.url !== `${RELEASES_URL}/${name}` || record.checksumUrl !== `${RELEASES_URL}/${name}.sha256`
        || record.virusTotal?.url !== VT_URL + sha256 || !SCAN_STATUSES.has(record.virusTotal?.status)
        || typeof record.virusTotal?.analysisId !== 'string' || !record.virusTotal.analysisId
        || !utcDate(record.virusTotal?.submittedAt)) {
      throw new Error(`Release metadata does not match the retained ${platform} package and VirusTotal submission.`);
    }
    if (metadata.schemaVersion === 2) {
      const scan = record.virusTotal;
      if (scan.status !== 'completed' || !utcDate(scan.analysedAt)
          || !scan.stats || Array.isArray(scan.stats) || typeof scan.stats !== 'object'
          || SCAN_CATEGORIES.some(category => !Number.isSafeInteger(scan.stats[category]) || scan.stats[category] < 0)
          || !SCAN_CATEGORIES.some(category => scan.stats[category] > 0)
          || Object.keys(scan.stats).some(category => !SCAN_CATEGORIES.includes(category))) {
        throw new Error(`Release metadata requires completed VirusTotal results for ${platform}.`);
      }
    }
  }
  return metadata;
}

function validatePublication(metadata, { requireCurrentSchema = false } = {}) {
  if (requireCurrentSchema && metadata.schemaVersion !== 2) throw new Error('New releases require schemaVersion 2 and completed VirusTotal results.');
  if (metadata.schemaVersion === 2) {
    for (const [platform, record] of Object.entries(metadata.platforms)) {
      const scan = record.virusTotal;
      if (scan.status !== 'completed' || !scan.stats) throw new Error(`VirusTotal analysis for ${platform} is incomplete; release pointers were not updated.`);
      if (scan.stats.malicious > 0 || scan.stats.suspicious > 0) {
        throw new Error(`VirusTotal reported ${scan.stats.malicious} malicious and ${scan.stats.suspicious} suspicious detections for ${platform}; review the retained scan results before publishing. Release pointers were not updated.`);
      }
    }
  }
  return metadata;
}

function releaseAssets(directory, tag, { requireLinux = false, requirePortable = false, requireArch = false, requireMetadata = false, scope = 'all' } = {}) {
  const names = scopedPackageNames(tag, scope);
  const assets = scope === 'linux' ? [] : checkedPackage(directory, names.windows, true);
  const hasLinux = fs.existsSync(path.join(directory, names.linuxDeb));
  if (requireLinux || hasLinux) assets.push(...checkedPackage(directory, names.linuxDeb));
  const hasPortable = fs.existsSync(path.join(directory, names.linuxAppImage));
  if (requirePortable || hasPortable) assets.push(...checkedPackage(directory, names.linuxAppImage));
  const hasArch = fs.existsSync(path.join(directory, names.linuxArch));
  if (requireArch || hasArch) assets.push(...checkedPackage(directory, names.linuxArch));
  const metadataName = `release-${validateTag(tag)}.json`;
  if (requireMetadata || fs.existsSync(path.join(directory, metadataName))) {
    const asset = readAsset(directory, metadataName);
    const metadata = JSON.parse(fs.readFileSync(asset.path, 'utf8'));
    if ((metadata.scope || 'all') !== scope) throw new Error('Retained release metadata scope does not match this publication.');
    validateMetadata(metadata, tag, assets);
    assets.push(asset);
  }
  return assets;
}

module.exports = { RELEASES_URL, VT_URL, SCAN_STATUSES, SCAN_CATEGORIES, validateTag, readAsset, packageNames, scopedPackageNames, releaseScope, releaseAssets, validateMetadata, validatePublication };
