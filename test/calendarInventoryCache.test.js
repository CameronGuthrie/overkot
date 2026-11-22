const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const encryption = require('../src/modules/fileEncryption');

test('cached ancestor inventory is tagged with its account and never reused for another login', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-inventory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'inventory-cache.json');
  const commonjs = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/inventoryPoller.js'), 'utf8'), {
    module: commonjs, console,
    require(name) {
      if (name === './appPaths') return { INVENTORY_CACHE_PATH: filename };
      if (name === './apiClient') return { ApiClient: class {} };
      if (name === './fileEncryption') return encryption;
      if (name === './affiliationProgress') return require('../src/modules/affiliationProgress');
      return require(name);
    },
  });
  const { InventoryPoller, loadCachedTimers } = commonjs.exports;
  const first = new InventoryPoller('player-a', 'fixture');
  first._rawInventory = { Ancestors: [{ ItemType: '/SF/Types/Game/Ancestors/Orlick/OrlickAncestor', Rank: 2 }] };
  first._saveCache();
  assert.equal(loadCachedTimers().accountId, 'player-a');
  const same = new InventoryPoller('player-a', 'fixture');
  assert.equal(same.getRawInventory().Ancestors[0].Rank, 2);
  assert.equal(same.isInventoryCached(), true);
  assert.equal(new InventoryPoller('player-b', 'fixture').getRawInventory(), null);
  same._processInventory({ Ancestors: [] });
  assert.equal(same.isInventoryCached(), false);
  // Legacy caches remain usable for startup, but cannot prove a login's identity.
  fs.writeFileSync(filename, encryption.encryptData(JSON.stringify({ rawInventory: first._rawInventory }), encryption.deriveCacheKey()));
  assert.ok(loadCachedTimers().rawInventory);
  assert.equal(new InventoryPoller('player-a', 'fixture').getRawInventory(), null);
});
