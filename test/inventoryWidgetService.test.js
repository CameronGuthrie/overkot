'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { InventoryWidgetService } = require('../src/modules/inventoryWidgetService');

test('inventory widget projection distinguishes connection/cache and preserves saved timestamp', () => {
  let session = null, expired = false, cached = true, raw = null;
  const contexts = [];
  const model = { read(inventory, context) { contexts.push(context); return { present: !!inventory }; } };
  const service = new InventoryWidgetService({ id: 'fixture', model, getSession: () => session, getNames: () => names, now: () => 99 });
  const names = {};
  assert.equal(service.getSnapshot().status, 'connect');
  session = { accountId: 'secret', isNonceExpired: () => expired, isInventoryCached: () => cached,
    getRawInventory: () => raw, getInventorySavedAt: () => 42 };
  assert.equal(service.getSnapshot().status, 'waiting');
  raw = { Nonce: 'private' };
  assert.deepEqual(service.getSnapshot(), { present: true, status: 'cached', updatedAt: 42 });
  const calls = contexts.length; service.getSnapshot(); assert.equal(contexts.length, calls);
  cached = false; assert.equal(service.getSnapshot().status, 'live');
  const epoch = contexts.at(-1).sessionEpoch;
  session = { ...session }; service.update(); assert.ok(contexts.at(-1).sessionEpoch > epoch);
  expired = true; assert.deepEqual(service.getSnapshot(), { present: false, status: 'connect', updatedAt: null });
  assert.equal(JSON.stringify(service.snapshot).includes('secret'), false);
  assert.equal(JSON.stringify(service.snapshot).includes('private'), false);
});
test('only supported model actions run and force a fresh projection', () => {
  let resets = 0;
  const model = { read: () => ({ resets }), action(action) { assert.equal(action, 'reset'); resets++; } };
  const service = new InventoryWidgetService({ id: 'fixture', model, getSession: () => null });
  assert.equal(service.action('reset').resets, 1);
  assert.throws(() => service.action('delete'), /Unsupported/);
  assert.equal(resets, 1);
});
