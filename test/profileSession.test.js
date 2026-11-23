const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const { InventoryPoller } = require('../src/modules/inventoryPoller');
const { LogWatcher } = require('../src/modules/logWatcher');
const { createProfileSessionCheck } = require('../src/modules/playerIdentity');

test('only the active game login and a matching live inventory can dispatch a profile GET', async t => {
  const a = 'a'.repeat(24), b = 'b'.repeat(24);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overkot-profile-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'EE.log');
  const login = id => `Sys [Info]: Logged in Envoy (${id})\n`;
  fs.writeFileSync(file, login(a));
  t.mock.method(LogWatcher, 'candidatePaths', () => [file]);
  t.mock.method(InventoryPoller.prototype, '_loadCache', () => {});
  const sent = [];
  t.mock.method(axios, 'get', async (_url, { params }) => {
    sent.push(params.playerId);
    return { status: 200, data: { Results: [{ AccountId: params.playerId }] } };
  });
  let active, gameRunning = true;
  const check = createProfileSessionCheck({ logWatcher: new LogWatcher(), processObservedAt: 0,
    getSession: () => active, isGameRunning: () => gameRunning });
  const first = new InventoryPoller(a, '', false, check);
  const second = new InventoryPoller(b, '', false, check);
  const read = (session, id = session.accountId) => session.api.fetchProfile(id, { force: true });
  function live(session, inventory) {
    active = session;
    session._rawInventory = inventory;
    session._running = true;
    session._inventoryFromCache = false;
    session._lastSuccessfulPollAt = Date.now();
  }

  live(first, {});
  fs.appendFileSync(file, 'Sys [Info]: unrelated activity\n');
  assert.equal(await read(first), null, 'an ownerless inventory cannot confirm a historical login');
  first._rawInventory = { AccountId: { $oid: a } };
  first._inventoryFromCache = true;
  assert.equal(await read(first), null);
  first._inventoryFromCache = false;
  first._lastSuccessfulPollAt -= 91_000;
  assert.equal(await read(first), null);
  live(first, { AccountId: a });
  assert.equal(await read(first, b), null);
  assert.ok(await read(first));
  const queued = Promise.resolve().then(() => read(first));
  fs.appendFileSync(file, 'Script [Info]: MainMenu.lua: Main menu - LogOut()\n');
  assert.equal(await queued, null);
  fs.appendFileSync(file, 'Sys [Info]: Logging in as Second\nSys [Info]: Logged in Second\n');
  assert.equal(await read(first), null);
  fs.appendFileSync(file, login(b.toUpperCase()));
  assert.equal(await read(first), null);
  live(second, { AccountId: a });
  assert.equal(await read(second), null);
  second._rawInventory = {};
  assert.ok(await read(second), 'a newly observed named login can confirm an ownerless live inventory');
  live(first, { AccountId: a });
  fs.appendFileSync(file, login(a));
  assert.equal(await read(second), null);
  first.stop();
  assert.equal(await read(first), null);
  live(first, { AccountId: a });
  gameRunning = false;
  assert.equal(await read(first), null);
  assert.deepEqual(sent, [a, b]);
});
