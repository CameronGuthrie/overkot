const semver = require('semver');

const releaseFamily = version => `${version.major}.${version.minor}.${version.patch}`;
const validEntries = data => (Array.isArray(data?.versions) ? data.versions : [])
  .filter(entry => typeof entry?.version === 'string' && semver.valid(entry.version));

// Prerelease builds share the notes for their stable release family.
// Retain exact prerelease notes when no consolidated family entry exists.
function findRelease(data, version) {
  const parsed = semver.parse(version);
  if (!parsed) return undefined;
  const entries = validEntries(data);
  return entries.find(entry => semver.eq(entry.version, releaseFamily(parsed)))
    || entries.find(entry => semver.eq(entry.version, parsed));
}

function mergeChangelog(local, remote) {
  const releases = new Map();
  for (const data of [local, remote]) for (const entry of validEntries(data)) {
    if (!Array.isArray(entry.changes)) continue;
    const version = semver.parse(entry.version);
    // Normalized keys deduplicate optional v prefixes and build metadata.
    // Bundled, curated notes win over matching older remote entries.
    if (!releases.has(version.version)) releases.set(version.version, {
      ...entry, changes: entry.changes.filter(change => typeof change === 'string'),
    });
  }
  const stableFamilies = new Set([...releases.keys()].filter(version => !semver.prerelease(version)));
  const versions = [...releases.values()].filter(entry => {
    const parsed = semver.parse(entry.version);
    return !parsed.prerelease.length || !stableFamilies.has(releaseFamily(parsed));
  }).sort((a, b) => semver.rcompare(a.version, b.version));
  return { versions };
}

module.exports = { findRelease, mergeChangelog };
