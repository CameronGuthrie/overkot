'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tag = 'UPGRADEGIVEN_GODANDGHOST';
const seconds = 23 * 3600;
function durations() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/timerDurations.js'), 'utf8'), { module });
  return module.exports;
}

test('Blessed Meeting is 23 hours before download and after old or incorrect duration feeds', () => {
  const api = durations();
  assert.equal(api.getTimerDuration(tag), seconds);
  for (const exact of [{}, { upgradegiven_godandghost: 86400 }]) {
    const feed = { defaultSeconds: 900, recipeDefaultSeconds: 8000, exact: { curlailsiege: 10000, ...exact },
      patterns: { collector: 20000 }, recipes: { sample: 400 } };
    assert.equal(api.setTimerDurations(feed), true);
    assert.equal(api.getTimerDuration(tag), seconds);
    assert.equal(api.getTimerDuration(tag.toLowerCase()), seconds);
    assert.equal(api.getTimerDurations().exact.upgradegiven_godandghost, seconds, 'Renderer state gets the same corrected total');
    assert.equal(api.getTimerDuration('CurlailSiege'), 10000);
    assert.equal(api.getTimerDuration('CollectorTimer'), 20000);
    assert.equal(api.getTimerDuration('PendingRecipe:Sample'), 400);
    assert.equal(api.getTimerDuration('Unrecognised'), 900);
    assert.equal(feed.exact.upgradegiven_godandghost, exact.upgradegiven_godandghost, 'Do not mutate downloaded data');
  }
  assert.equal(api.setTimerDurations({}), false);
  assert.equal(api.getTimerDuration(tag), seconds);
  assert.equal(require('../src/data/timerDurations.json').exact.upgradegiven_godandghost, seconds);
});

test('regular renderer timers use the corrected total and localized name without changing their category', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/timer-utils.js'), 'utf8'), context);
  context.data = durations().getTimerDurations();
  context.names = { [tag]: 'Rencontre Bénie' };
  vm.runInContext('setTimerDurationsData(data)', context);
  assert.equal(vm.runInContext(`getTimerDuration('${tag}')`, context), seconds);
  assert.equal(vm.runInContext(`lookupTimerName(names, '${tag}')`, context), 'Rencontre Bénie');
  assert.equal(vm.runInContext(`categorizeTimer('${tag}')`, context), 'other');
});

test('Blessed Meeting uses the server expiry and is never synthesized from its total duration', () => {
  const module = { exports: {} };
  const now = 1_800_000_000;
  class FixtureDate extends Date { static now() { return now * 1000; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/inventoryPoller.js'), 'utf8'), {
    module, Date: FixtureDate,
    require(name) {
      if (name === './appPaths') return { INVENTORY_CACHE_PATH: '' };
      if (name === './apiClient') return { ApiClient: class {} };
      if (name === './fileEncryption') return {};
      if (name === './affiliationProgress') return require('../src/modules/affiliationProgress');
      return require(name);
    },
  });
  const poller = Object.create(module.exports.InventoryPoller.prototype);
  poller._saveCache = () => {};
  poller._processInventory({ ExpiryTimeTrackers: [{ Tag: tag, ExpiryTime: now + 1234 }] });
  assert.equal(poller.getTimers()[0].expiryTime, now + 1234);
  poller._processInventory({ ExpiryTimeTrackers: [{ Tag: tag, ExpiryTime: now - 61 }] });
  assert.equal(poller.getTimers().length, 0);
  poller._processInventory({ ExpiryTimeTrackers: [] });
  assert.equal(poller.getTimers().length, 0);
});
