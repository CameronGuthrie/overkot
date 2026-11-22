'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const releaseOwnerId = 76098008;

function releaseArtifactName(sha, scope = 'all') {
  if (!['all', 'linux'].includes(scope)) throw new Error('Invalid release scope.');
  return `overkot-release${scope === 'linux' ? '-linux' : ''}-${sha}`;
}

function retainedState(artifacts, sha, scope = 'all') {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid source commit for retained release artifacts.');
  if (!Array.isArray(artifacts)) throw new Error('Invalid retained artifact inventory.');
  const names = new Set(artifacts.filter(artifact => !artifact.expired).map(artifact => artifact.name));
  const hasRelease = names.has(releaseArtifactName(sha, scope));
  return { has_release: hasRelease, has_windows: scope !== 'linux' && (hasRelease || names.has(`overkot-windows-${sha}`)),
    has_linux: hasRelease || names.has(`overkot-linux-${sha}`), has_scan_progress: names.has(`overkot-scan-progress-${sha}`),
    has_market_source: names.has(`overkot-market-source-${sha}`) };
}

function githubJson(args, run = spawnSync) {
  const result = run('gh', ['api', ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Could not verify retained files for this release run.');
  try { return JSON.parse(result.stdout); } catch { throw new Error('GitHub returned invalid release run data.'); }
}

function validateSourceRun(source, { repository, repositoryId, sha, runId, requireSuccess = true }) {
  if (String(source?.id) !== runId || source.path !== '.github/workflows/build-app.yml'
      || typeof source.repository?.full_name !== 'string' || source.repository.full_name.toLowerCase() !== repository.toLowerCase()
      || !/^[1-9]\d*$/.test(repositoryId) || String(source.repository.id) !== repositoryId
      || source.head_repository?.id !== source.repository.id || !['push', 'workflow_dispatch'].includes(source.event)
      || source.actor?.id !== releaseOwnerId || source.triggering_actor?.id !== releaseOwnerId
      || source.head_sha !== sha) {
    throw new Error('Source must be a Build & Release App run in this repository at the release commit.');
  }
  if (requireSuccess && (source.status !== 'completed' || source.conclusion !== 'success')) {
    throw new Error('Release promotion requires a successful completed source build.');
  }
  return source;
}

function inventoryRun(repository, runId, sha, run, scope = 'all') {
  const pages = githubJson(['--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/artifacts`], run);
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page?.artifacts))) throw new Error('Invalid retained artifact inventory.');
  return retainedState(pages.flatMap(page => page.artifacts), sha, scope);
}

function discoverRetainedSource({ repository, repositoryId, runId, sha, scope }, run) {
  const response = githubJson([`repos/${repository}/actions/workflows/build-app.yml/runs?head_sha=${sha}&status=success&per_page=20`], run);
  if (!Array.isArray(response?.workflow_runs)) throw new Error('Invalid release source run inventory.');
  const candidates = response.workflow_runs.slice(0, 20).filter(source => {
    const candidateId = String(source?.id);
    if (!/^\d+$/.test(candidateId) || candidateId === runId) return false;
    try {
      validateSourceRun(source, { repository, repositoryId, sha, runId: candidateId });
      return true;
    } catch { return false; }
  }).sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || Number(b.id) - Number(a.id));
  // Discovery is optional and bounded; source metadata and artifact contents
  // still pass the same verification as an explicitly selected staging run.
  for (const candidate of candidates.slice(0, 5)) {
    const sourceRunId = String(candidate.id);
    const source = githubJson([`repos/${repository}/actions/runs/${sourceRunId}`], run);
    try { validateSourceRun(source, { repository, repositoryId, sha, runId: sourceRunId }); }
    catch { continue; }
    const state = inventoryRun(repository, sourceRunId, sha, run, scope);
    if (state.has_release) return { ...state, source_run_id: sourceRunId };
  }
  return null;
}

function retainedInventory({ repository, repositoryId = process.env.GITHUB_REPOSITORY_ID, runId, sha,
  sourceRunId = '', autoReuse = false, scope = 'all' }, run = spawnSync) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[1-9]\d*$/.test(repositoryId)
      || !/^\d+$/.test(runId) || !/^[0-9a-f]{40}$/.test(sha)
      || (sourceRunId && !/^\d+$/.test(sourceRunId))) throw new Error('Missing or invalid release workflow context.');
  const selectedRunId = sourceRunId || runId;
  if (sourceRunId) {
    const source = githubJson([`repos/${repository}/actions/runs/${selectedRunId}`], run);
    validateSourceRun(source, { repository, repositoryId, sha, runId: selectedRunId });
  }
  const state = inventoryRun(repository, selectedRunId, sha, run, scope);
  if (sourceRunId && !state.has_release) throw new Error('The successful source run must retain its complete release artifact; promotion cannot rebuild it.');
  if (!sourceRunId && !state.has_release && autoReuse) {
    const discovered = discoverRetainedSource({ repository, repositoryId, runId, sha, scope }, run);
    if (discovered) return discovered;
  }
  return { ...state, source_run_id: selectedRunId };
}

function main() {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_SHA: sha, GITHUB_OUTPUT: output,
    RELEASE_SOURCE_RUN_ID: sourceRunId, RELEASE_AUTO_REUSE: autoReuse } = process.env;
  if (!output) throw new Error('Missing release workflow output path.');
  const { releaseScope } = require('./release-artifacts');
  const scope = releaseScope(process.env.RELEASE_TAG, require('../changelog.json'));
  const state = retainedInventory({ repository, runId, sha, sourceRunId, autoReuse: autoReuse === 'true', scope });
  fs.appendFileSync(output, Object.entries(state).map(([name, value]) => `${name}=${value}\n`).join(''));
}

module.exports = { retainedState, retainedInventory, validateSourceRun, githubJson, releaseArtifactName };
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
