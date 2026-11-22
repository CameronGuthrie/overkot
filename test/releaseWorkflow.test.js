'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');

const workflow = name => fs.readFileSync(path.join(__dirname, '../.github/workflows', name), 'utf8');

test('workflow entry points reject forks, other repositories, unprotected refs and unauthorized reruns', () => {
  const owner = { repository_id: '1467149183', repository: 'CameronGuthrie/overkot',
    repository_owner_id: '76098008', repository_owner: 'CameronGuthrie',
    actor_id: '76098008', triggering_actor: 'CameronGuthrie', ref_protected: true };
  const rejected = [
    ['fork owner running their own workflow', { repository: 'Contributor/overkot', repository_id: '200',
      repository_owner_id: '300', repository_owner: 'Contributor', actor_id: '300', triggering_actor: 'Contributor' }],
    ['repository recreated under the original name', { repository_id: '200' }],
    ['different repository belonging to the same owner', { repository: 'CameronGuthrie/elsewhere', repository_id: '200' }],
    ['repository transferred to another owner', { repository_owner_id: '300' }],
    ['outside collaborator starting a run', { actor_id: '300', triggering_actor: 'Contributor' }],
    ['owner rerunning a collaborator’s run', { actor_id: '300' }],
    ['collaborator rerunning the owner’s run', { triggering_actor: 'Contributor' }],
    ['unprotected ref', { ref_protected: false }],
  ];
  for (const file of fs.readdirSync(path.join(__dirname, '../.github/workflows'))) {
    const config = yaml.load(workflow(file));
    assert.ok(Object.keys(config.on).every(key => ['push', 'workflow_dispatch', 'workflow_call'].includes(key)), file);
    for (const job of Object.values(config.jobs)) {
      if (!job.needs) {
        // These entry guards only compare strings and booleans and use &&.
        // Evaluate the actual parsed YAML so a permissive alternative also fails.
        const condition = new vm.Script('(' + job.if + ')');
        const evaluate = github => condition.runInNewContext({ github }, { timeout: 1000 });
        assert.equal(evaluate(owner), file !== 'build-platforms.yml', file + ' owner-only entry or explicit pause');
        for (const [scenario, override] of rejected) {
          assert.equal(evaluate({ ...owner, ...override }), false, file + ': ' + scenario);
        }
      }
      for (const step of job.steps || []) {
        if (step.uses && !step.uses.startsWith('./')) assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/);
        if (step.env?.VIRUSTOTAL_API_KEY || step.uses?.startsWith('aws-actions/configure-aws-credentials@')) {
          assert.equal(job.environment, 'production-release', file);
        }
        if (step.with?.['ssh-key']) assert.equal(job.environment, 'official-market-source', file);
      }
    }
  }
});

function publicationCondition(name) {
  const source = workflow('build-app.yml');
  const block = source.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm'))?.[1];
  const expression = block?.match(/if: >-\s*\$\{\{([\s\S]*?)\}\}/)?.[1];
  assert.ok(expression?.includes('!cancelled()'), `${name} must override implicit success() when ancestors are skipped`);
  return new Function('needs', 'github', 'inputs', 'cancelled', `return ${expression};`);
}

test('release builds use one private Market source commit with a read-only checkout key', () => {
  const source = workflow('build-app.yml');
  const job = name => source.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm'))?.[1];
  const validate = job('validate');
  for (const name of ['validate', 'windows', 'linux']) {
    assert.match(job(name), /environment: official-market-source/);
  }
  assert.match(validate, /github\.repository_id == '1467149183' && github\.repository == 'CameronGuthrie\/overkot' && github\.ref_protected/);
  assert.match(validate, /market_commit: \$\{\{ steps\.market_source\.outputs\.commit \}\}/);
  assert.match(validate, /MARKET_SOURCE_READ_KEY: \$\{\{ secrets\.MARKET_SOURCE_READ_KEY != '' && 'configured' \|\| '' \}\}/);
  assert.doesNotMatch(source, /^\s+MARKET_SOURCE_READ_KEY: \$\{\{ secrets\.MARKET_SOURCE_READ_KEY \}\}/m);
  assert.match(validate, /ref: new-redesign-preview/);
  assert.match(validate, /'git', \['-C', '\.build\/market-upstream', 'rev-parse', 'HEAD'\]/);
  assert.match(validate, /steps\.retained\.outputs\.has_market_source == 'true'/);
  assert.match(validate, /name: overkot-market-source-\$\{\{ github\.sha \}\}/);
  assert.ok(validate.indexOf('actions/upload-artifact@') > validate.indexOf('id: market_source'));
  for (const platform of ['windows', 'linux']) {
    const build = job(platform);
    assert.match(build, /OVERKOT_SERVICES_FILE: config\/official-services\.json/);
    assert.match(build, /repository: CameronGuthrie\/avakot-market/);
    assert.match(build, /ref: \$\{\{ needs\.validate\.outputs\.market_commit \}\}/);
    assert.match(build, /ssh-key: \$\{\{ secrets\.MARKET_SOURCE_READ_KEY \}\}/);
    assert.match(build, /path: \.build\/market-upstream\r?\n\s+ssh-key: [^\r\n]+\r?\n\s+persist-credentials: false/);
    assert.match(build, /OVERKOT_MARKET_REPOSITORY: \$\{\{ github\.workspace \}\}\/\.build\/market-upstream/);
    assert.match(build, /OVERKOT_MARKET_SOURCE_COMMIT: \$\{\{ needs\.validate\.outputs\.market_commit \}\}/);
  }
});

test('retained-file publication runs after skipped build ancestors and stops on failed immediate dependencies', () => {
  const needs = { validate: { result: 'success' }, prepare_release: { result: 'success' }, publish: { result: 'success' },
    windows: { result: 'skipped' }, linux: { result: 'skipped' }, linux_qa: { result: 'skipped' } };
  const github = { event_name: 'workflow_dispatch' };
  for (const job of ['publish', 'github_release']) {
    const condition = publicationCondition(job);
    assert.equal(condition(needs, github, { publish: true }, () => false), true);
    assert.equal(condition(needs, github, { publish: true }, () => true), false);
    assert.equal(condition(needs, github, { publish: false }, () => false), false);
    assert.equal(condition(needs, { event_name: 'push' }, { publish: true }, () => false), false);
    for (const dependency of job === 'publish' ? ['validate', 'prepare_release'] : ['validate', 'prepare_release', 'publish']) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        assert.equal(condition({ ...needs, [dependency]: { result } }, github, { publish: true }, () => false), false);
      }
    }
  }
});

test('standalone promotion verifies the tag checkout rather than the newer workflow commit', () => {
  const source = workflow('promote-release.yml');
  const script = source.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/)?.[1];
  assert.ok(script, 'the source verification step must resolve the checked-out commit');
  const sha = 'a'.repeat(40), calls = [], outputs = [];
  const env = { RELEASE_TAG: 'v0.0.13', GITHUB_REPOSITORY: 'example/app', GITHUB_RUN_ID: '100',
    RELEASE_SOURCE_RUN_ID: '42', GITHUB_SHA: 'b'.repeat(40), GITHUB_OUTPUT: '/test/output' };
  vm.runInNewContext(script, { process: { env }, require(module) {
    if (module === 'node:fs') return { appendFileSync(file, content) { outputs.push({ file, content }); } };
    if (module === 'node:child_process') return { execFileSync(command, args) {
      assert.equal(command, 'git'); assert.deepEqual(Array.from(args), ['rev-parse', 'HEAD^{commit}']); return sha + '\n';
    } };
    if (module === './scripts/validate-release') return { validateSourceTag(tag, _run, options) {
      assert.equal(tag, env.RELEASE_TAG); assert.equal(options.requireTag, true);
    } };
    if (module === './scripts/release-artifacts') return { releaseScope() { return 'all'; } };
    if (module === './changelog.json') return {};
    if (module === './scripts/retained-release') return { releaseArtifactName(value) { return `overkot-release-${value}`; }, retainedInventory(context) {
      calls.push({ ...context }); return { has_release: true, source_run_id: '42' };
    } };
    throw new Error(`Unexpected source verification dependency ${module}`);
  } });
  assert.deepEqual(calls, [{ repository: 'example/app', runId: '100', sha, sourceRunId: '42', scope: 'all' }]);
  assert.deepEqual(outputs, [{ file: '/test/output', content: `artifact=overkot-release-${sha}\nsource_run_id=42\n` }]);
  assert.match(source, /ref: refs\/tags\/\$\{\{ inputs\.version \}\}/);
  const gate = source.indexOf('[[ "$RELEASE_TAG" =~ ^v');
  assert.ok(gate >= 0 && gate < source.indexOf('uses: actions/checkout'));
  assert.ok(source.indexOf('run: node scripts/publish-cdn.js') < source.indexOf('run: node scripts/publish-release.js'));
  assert.doesNotMatch(source, /run: (?:npm run build|node scripts\/scan-release)/);
});

test('Linux-only releases skip Windows and retain their own scoped publication artifact', () => {
  const source = workflow('build-app.yml');
  const windows = source.match(/^  windows:\r?\n([\s\S]*?)(?=^  linux:)/m)[1];
  assert.match(windows, /if: needs\.validate\.outputs\.scope != 'linux' && needs\.validate\.outputs\.has_windows != 'true'/);
  const prepare = source.match(/^  prepare_release:\r?\n([\s\S]*?)(?=^  publish:)/m)[1];
  assert.match(prepare, /if: steps\.retained\.outputs\.has_release != 'true' && needs\.validate\.outputs\.scope != 'linux'/);
  assert.match(prepare, /name: overkot-release\$\{\{ needs\.validate\.outputs\.artifact_suffix \}\}-\$\{\{ github\.sha \}\}/);
  assert.match(source, /scope: \$\{\{ needs\.validate\.outputs\.scope \}\}/);
  assert.match(source, /dotnet-version: '8\.0\.x'/);
  assert.match(source, /build-essential clang zlib1g-dev/);
  assert.match(source, /libssl-dev cmake/);
});
