'use strict';

process.env.OVERKOT_SERVICES_FILE = require('node:path').resolve(__dirname, '../config/official-services.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const { MarketService } = require('../src/modules/marketService');

const accountId = '1234567890abcdef12345678';
const resourcePath = '/SF/Types/Items/Resource';
const resource = { id: 'resource', path: resourcePath, unique_name: 'Resource', name: 'Resource', slug: 'resource', category: 'resource' };
const weaponPath = '/SF/Weapons/Melee/Weapon';
const weapon = { id: 'weapon', path: weaponPath, unique_name: 'Weapon', name: 'Weapon', slug: 'weapon', category: 'weapon', possible_tempers: [] };
const runePath = '/SF/Upgrades/Runes/Weapon/Rune';
const rune = { id: 'rune', path: runePath, unique_name: 'Rune', name: 'Rune', slug: 'rune', category: 'rune' };
const motePath = '/SF/Upgrades/Totems/Mote';
const mote = { id: 'mote', path: motePath, unique_name: 'Mote', name: 'Mote', slug: 'mote', category: 'mote' };
const response = value => new Response(JSON.stringify(value), { status: 200 });
const listing = (id, attributes = {}) => ({ id, attributes: { itemId: 'resource', type: 'OFFER', status: 'ACTIVE', quantity: 1, ...attributes } });

function fixture(raw = { MiscItems: [{ ItemType: resourcePath, ItemCount: 10 }] }, catalogue = [resource]) {
  const f = { raw, own: [], calls: [], writes: [] };
  f.session = { accountId, nonce: 'nonce', getRawInventory: () => f.raw, isNonceExpired: () => false, isInventoryCached: () => false,
    api: { fetchInventory: async () => ({ data: f.raw }), fetchProfile: async () => ({ Results: [{ AccountId: accountId, DisplayName: 'TestEnvoy' }] }) } };
  f.service = new MarketService({ getSession: () => f.session, fetchImpl: async (url, options) => {
    const route = url.split('/v1/')[1]; f.calls.push(route);
    if (route.startsWith('me/listings?')) {
      const query = new URLSearchParams(route.split('?')[1]), state = query.get('state')?.toUpperCase();
      return response({ data: f.own.filter(row => !state || row.attributes.status === state).slice(0, 50) });
    }
    if (route === 'me/listings' && options.method === 'POST') {
      const body = JSON.parse(options.body); f.writes.push(body);
      const created = listing('created', body); f.own.unshift(created); return response({ data: created });
    }
    if (route.startsWith('me/listings/') && options.method === 'PATCH') {
      const body = JSON.parse(options.body); f.writes.push(body);
      return response({ data: listing(route.split('/').pop(), body) });
    }
    throw new Error('Unexpected route: ' + route);
  } });
  f.service.token = 'session'; f.service.initialized = true;
  f.service.user = { id: 'market-user', displayHandle: 'TestEnvoy', inGameVerified: true, platform: 'PC', restrictionState: 'NONE' };
  f.service.catalogue = catalogue;
  f.refreshListings = async () => {
    const loaded = await f.service.loadListings(); f.service.listings = loaded.rows; f.service.listingsComplete = loaded.complete; return loaded;
  };
  return f;
}

test('reservation summaries reflect remaining stock and only open, unexpired offers hold it', async () => {
  const f = fixture();
  f.own = [listing('active', { quantity: 2 }), listing('paused', { status: 'PAUSED', quantity: 3 }),
    listing('hidden', { status: 'HIDDEN', quantity: 5 }), listing('closed', { status: 'CLOSED', quantity: 100 }),
    listing('request', { type: 'REQUEST', quantity: 100 }), listing('expired', { status: 'EXPIRED', quantity: 100 }),
    listing('past-date', { expiresAt: '2000-01-01T00:00:00Z', quantity: 100 })];
  await f.refreshListings();
  const inventory = f.service.inventory();
  assert.equal(inventory.rows[0].listedQuantity, 10);
  assert.equal(inventory.rows[0].availableQuantity, 0);
  assert.equal(inventory.summary.availableQuantity, 0);
  assert.equal(inventory.summary.listableRows, 0);
  assert.equal(inventory.summary.totalQuantity, 10);
  const excluding = f.service.inventory(undefined, 'paused');
  assert.equal(excluding.rows[0].availableQuantity, 3);
  assert.equal(excluding.summary.availableQuantity, 3);
  assert.equal(excluding.summary.listableRows, 1);
});

test('unknown expiry dates and invalid commitment quantities never release inventory', async () => {
  const f = fixture();
  f.own = [listing('unknown-expiry', { expiresAt: 'not-a-date', quantity: 4 })];
  await f.refreshListings(); assert.equal(f.service.inventory().rows[0].availableQuantity, 6);
  for (const quantity of [-1, 0, 1.5, 'unknown', null]) {
    f.own = [listing('invalid-quantity', { quantity })]; await f.refreshListings();
    assert.equal(f.service.inventory().rows[0].availableQuantity, 0, String(quantity));
  }
});

test('unspecified legacy weapon variants reserve both normal and moonsteel copies', async () => {
  const f = fixture({ Melee: [
    { ItemType: weaponPath, ItemId: 'normal', Quality: 'IQ_WORN', Shiny: false },
    { ItemType: weaponPath, ItemId: 'moonsteel', Quality: 'IQ_WORN', Shiny: true },
  ] }, [weapon]);
  f.own = [listing('legacy', { itemId: 'weapon', quality: 'WORN', moonsteel: null, tempers: null })];
  await f.refreshListings();
  assert.ok(f.service.inventory().rows.every(row => row.availableQuantity === 0));
  f.own = [listing('specific', { itemId: 'weapon', quality: 'WORN', moonsteel: false, tempers: [] })];
  await f.refreshListings();
  const rows = f.service.inventory().rows;
  assert.equal(rows.find(row => row.attributes.weapon.moonsteel).availableQuantity, 1);
  assert.equal(rows.find(row => !row.attributes.weapon.moonsteel).availableQuantity, 0);
});

test('unspecified rune ranks reserve every possible rank while exact ranks reserve only their copies', async () => {
  const f = fixture({ RawUpgrades: [{ ItemType: runePath, ItemCount: 2 }],
    Upgrades: [{ ItemType: runePath, ItemId: 'ranked', UpgradeFingerprint: '{"lvl":3}' }] }, [rune]);
  f.own = [listing('legacy', { itemId: 'rune', runeUpgradeLevel: null })];
  await f.refreshListings();
  let rows = f.service.inventory().rows;
  assert.equal(rows.find(row => row.attributes.rune.upgradeLevel === 0).availableQuantity, 1);
  assert.equal(rows.find(row => row.attributes.rune.upgradeLevel === 3).availableQuantity, 0);
  f.own = [listing('specific', { itemId: 'rune', runeUpgradeLevel: 3 })];
  await f.refreshListings(); rows = f.service.inventory().rows;
  assert.equal(rows.find(row => row.attributes.rune.upgradeLevel === 0).availableQuantity, 2);
  assert.equal(rows.find(row => row.attributes.rune.upgradeLevel === 3).availableQuantity, 0);
});

test('unspecified mote virtue and grip reserve compatible variants without defaulting to Courage', async () => {
  const f = fixture({ Upgrades: ['GRACE', 'SPIRIT'].map(virtue => ({ ItemType: motePath, ItemId: virtue,
    UpgradeFingerprint: { lvl: 2, pol: 'AP_' + virtue, compat: '/SF/Upgrades/Techniques/GreatswordSkillTree' } })) }, [mote]);
  f.own = [listing('legacy', { itemId: 'mote', moteVirtue: null, moteUpgradeLevel: 2, moteGripType: null })];
  await f.refreshListings(); assert.ok(f.service.inventory().rows.every(row => row.availableQuantity === 0));
  f.own = [listing('specific', { itemId: 'mote', moteVirtue: 'GRACE', moteUpgradeLevel: 2, moteGripType: 'HeavySkill' })];
  await f.refreshListings();
  assert.equal(f.service.inventory().rows.find(row => row.attributes.mote.virtue === 'SPIRIT').availableQuantity, 1);
});

test('fifty completed trades do not hide older active commitments or block new listings', async () => {
  const f = fixture();
  f.own = [...Array.from({ length: 50 }, (_, index) => listing('history-' + index, { status: 'CLOSED' })),
    listing('old-active'), listing('old-paused', { status: 'PAUSED' }), listing('old-hidden', { status: 'HIDDEN' })];
  const loaded = await f.refreshListings();
  assert.equal(loaded.complete, true); assert.equal(loaded.rows.length, 53);
  assert.equal(f.service.inventory().rows[0].availableQuantity, 7);
  assert.deepEqual(f.calls, ['me/listings?limit=50', 'me/listings?limit=50&state=active',
    'me/listings?limit=50&state=paused', 'me/listings?limit=50&state=hidden']);
  const created = await f.service.createListing({ rowKey: f.service.inventory().rows[0].key, quantity: 2 });
  assert.equal(created.ok, true); assert.equal(f.writes.length, 1);
  assert.equal(created.state.inventory.rows[0].availableQuantity, 5);
});

test('open-state responses merge by ID and each query must be complete before inventory publication', async () => {
  const f = fixture(); f.own = [listing('same')];
  const loaded = await f.refreshListings();
  assert.equal(loaded.rows.length, 1); assert.equal(f.service.inventory().rows[0].listedQuantity, 1);
  for (const status of ['ACTIVE', 'PAUSED', 'HIDDEN']) {
    f.own = Array.from({ length: 50 }, (_, index) => listing('open-' + index, { status, itemId: 'other' }));
    const full = await f.refreshListings(); assert.equal(full.complete, false, status);
    const result = await f.service.createListing({ rowKey: f.service.inventory().rows[0].key, quantity: 1 });
    assert.equal(result.error, 'LISTING_LIMIT', status);
  }
  assert.equal(f.writes.length, 0);
});

test('a game session change immediately before reactivation is checked before sending the update', async () => {
  const f = fixture(); f.own = [listing('paused', { status: 'PAUSED' })];
  const original = f.service.terms.bind(f.service);
  let termsChecked = false;
  f.service.terms = (...args) => { const result = original(...args); termsChecked = true; f.session = null; return result; };
  const result = await f.service.updateListing({ id: 'paused', status: 'ACTIVE', acceptedItems: [{ type: 'ARCS', amount: 2 }] });
  assert.equal(termsChecked, true, 'The game session changes after fresh stock and accepted terms are validated');
  assert.equal(result.error, 'GAME_SESSION_CHANGED'); assert.equal(f.writes.length, 0);
});
