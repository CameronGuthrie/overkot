const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { resolveBuildChannel, STABLE_CHANNEL, TITLE_TRACKER_BETA_CHANNEL } = require('../src/modules/buildChannel');

const betaEnv = { OVERKOT_BUILD_CHANNEL: TITLE_TRACKER_BETA_CHANNEL };
const sourceFile = path.resolve(__dirname, '../src/modules/buildChannel.js');

function evaluate(source, { isPackaged, env }) {
  const context = { module: { exports: {} }, process: { env },
    require: name => {
      assert.equal(name, 'electron');
      return { app: { isPackaged } };
    },
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

test('Title Tracker is enabled in source and normal packaged builds without a beta switch', () => {
  assert.equal(resolveBuildChannel({ env: {} }), STABLE_CHANNEL);
  assert.equal(resolveBuildChannel({ env: betaEnv }), TITLE_TRACKER_BETA_CHANNEL);
  assert.equal(resolveBuildChannel({ env: { OVERKOT_BUILD_CHANNEL: 'beta' } }), STABLE_CHANNEL);
  const source = fs.readFileSync(sourceFile, 'utf8');
  assert.equal(evaluate(source, { isPackaged: false, env: betaEnv }).TITLE_TRACKER_ENABLED, true);
  assert.equal(evaluate(source, { isPackaged: false, env: {} }).TITLE_TRACKER_ENABLED, true);
  assert.equal(evaluate(source, { isPackaged: true, env: {} }).TITLE_TRACKER_ENABLED, true);
  assert.equal(evaluate(source, { isPackaged: true, env: betaEnv }).IS_BETA, false);
});

test('an embedded stable channel cannot be overridden by a beta environment switch', () => {
  assert.equal(resolveBuildChannel({ bundledChannel: STABLE_CHANNEL, isPackaged: true, env: betaEnv }), STABLE_CHANNEL);
  assert.equal(resolveBuildChannel({ bundledChannel: 'unknown', env: betaEnv }), STABLE_CHANNEL);
  assert.equal(resolveBuildChannel({ bundledChannel: TITLE_TRACKER_BETA_CHANNEL, isPackaged: true, env: {} }), TITLE_TRACKER_BETA_CHANNEL);
});

test('packaged stable and beta channels both include Title Tracker while retaining their update identity', async () => {
  for (const channel of [STABLE_CHANNEL, TITLE_TRACKER_BETA_CHANNEL]) {
    const output = await esbuild.build({
      entryPoints: [sourceFile], bundle: true, platform: 'node', format: 'cjs',
      external: ['electron'], write: false, minify: true,
      define: { __OVERKOT_BUILD_CHANNEL__: JSON.stringify(channel) },
    });
    const result = evaluate(output.outputFiles[0].text, { isPackaged: true, env: betaEnv });
    assert.equal(result.BUILD_CHANNEL, channel);
    assert.equal(result.TITLE_TRACKER_ENABLED, true);
    assert.equal(result.IS_BETA, channel === TITLE_TRACKER_BETA_CHANNEL);
  }
});
