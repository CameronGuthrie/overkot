const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture() {
  const records = new Map();
  let queue = Promise.resolve();
  const fb = {
    isConfigured: () => true, isInitialized: () => false, getFirestoreInstance: () => ({}),
    getAuthInstance: () => ({ currentUser: { uid: 'host-uid' } }),
    collection: (_db, name) => name.split('/').at(-1),
    doc: (_db, type, id) => ({ path: type ? `${type.split('/').at(-1)}/${id}` : 'listings/listing', id: id || 'listing' }),
    Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: value => value },
    firestoreServerTimestamp: () => 1,
    writeBatch: () => ({ set: (ref, data) => records.set(ref.path, data), commit: async () => {} }),
    getRTDB: () => ({}), ref: (_db, key) => key, update: async () => {},
    runTransaction: (_db, action) => {
      const task = queue.then(() => action({
        get: async ref => ({ exists: () => records.has(ref.path), data: () => ({ ...records.get(ref.path) }) }),
        update: (ref, data) => records.set(ref.path, { ...records.get(ref.path), ...data }),
      }));
      queue = task.catch(() => {}); return task;
    },
  };
  const context = { module: { exports: {} }, require: name => name === './firebaseConfig' ? fb : require('../src/modules/playerIdentity'), console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/groupFinderService.js'), 'utf8') +
    "\nplayerId = 'host-uid'; displayName = 'TestEnvoy';", context);
  return { service: context.module.exports, records };
}

test('new listings default to four players and retain smaller party choices', async () => {
  for (const [slotsNeeded, expected] of [[undefined, 4], [1, 2], [2, 3], [3, 4], [99, 4], [2.5, 3]]) {
    const { service } = fixture();
    const listing = await service.createListing({ slotsNeeded });
    assert.equal(listing.slotsTotal, expected);
    assert.equal(service.getState().maxGroupSize, 4);
  }
});

test('four is full, and accepting the last seat concurrently cannot overfill the listing', async () => {
  const { service, records } = fixture();
  await service.createListing({ slotsNeeded: 3 });
  for (const id of ['a', 'b', 'c', 'd']) records.set(`listingRequests/listing_${id}`, { status: 'pending' });
  assert.equal(await service.acceptRequest('listing', 'a'), true);
  assert.equal(await service.acceptRequest('listing', 'a'), false);
  assert.equal(await service.acceptRequest('listing', 'b'), true);
  const result = await Promise.all(['c', 'd'].map(id => service.acceptRequest('listing', id)));
  assert.equal(result.filter(Boolean).length, 1);
  assert.equal(records.get('listings/listing').slotsFilled, 4);
  assert.equal(service.getState().myListing.status, 'full');
  assert.equal(records.get('listingRequests/listing_d').status, 'pending');
});

test('group presence preserves a four-person party and clamps invalid sizes', () => {
  const { service } = fixture();
  service.setGroupSize(4); assert.equal(service.getState().groupSize, 4);
  service.setGroupSize(5); assert.equal(service.getState().groupSize, 4);
  service.setGroupSize(NaN); assert.equal(service.getState().groupSize, 1);
});
