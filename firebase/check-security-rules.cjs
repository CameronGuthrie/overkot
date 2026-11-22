// Run with firebase emulators:exec. See docs/group-finder-ownership.md.
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase/app');
const db = require('firebase/database');
const fs = require('firebase/firestore');
const { createMockUserToken } = require('@firebase/util');

const projectId = 'demo-overkot-rules';
const hostId = 'host-firebase-uid';
const guestId = 'guest-firebase-uid';
const players = 'groupFinder/v2/players';
const listings = 'groupFinder/v2/listings';
const requests = 'groupFinder/v2/listingRequests';

function emulatorPort(variable) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(process.env[variable] || '');
  assert.ok(match, 'Start the local emulator with firebase emulators:exec');
  return Number(match[1]);
}

function client(name) {
  const app = initializeApp({
    projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
  }, name);
  const rtdb = db.getDatabase(app);
  const firestore = fs.getFirestore(app);
  const mockUserToken = {
    sub: name,
    firebase: { sign_in_provider: 'anonymous', identities: {} },
  };
  const options = name === 'signed-out' ? {} : { mockUserToken };
  db.connectDatabaseEmulator(rtdb, '127.0.0.1', emulatorPort('FIREBASE_DATABASE_EMULATOR_HOST'), options);
  fs.connectFirestoreEmulator(firestore, '127.0.0.1', emulatorPort('FIRESTORE_EMULATOR_HOST'), options);
  return { rtdb, firestore };
}

async function denied(operation) {
  await assert.rejects(operation, error => /permission.denied/i.test(`${error.code} ${error.message}`));
}

async function profile(user, id, name) {
  const ref = fs.doc(user.firestore, players, id);
  await fs.setDoc(ref, {
    displayName: name, onlineStatus: 'online', groupSize: 1, lastSeen: fs.serverTimestamp(),
  }, { merge: true });
  await fs.updateDoc(ref, { primaryLanguage: 'en', secondaryLanguage: null, regionPreference: 'No preference' });
  return ref;
}

async function checkListingReads(user, signedOut) {
  const listingCollection = fs.collection(user.firestore, listings);
  const statuses = ['open', 'pending', 'full', 'in_progress'];
  const browse = fs.query(listingCollection, fs.where('status', 'in', statuses), fs.orderBy('createdAt', 'desc'), fs.limit(50));
  const restore = fs.query(listingCollection, fs.where('hostPlayer', '==', hostId),
    fs.where('status', 'in', [...statuses, 'stale']), fs.limit(1));
  const page = await fs.getDocs(browse);
  assert.equal(page.docs[0].id, 'listing');
  assert.equal((await fs.getDocs(restore)).docs[0].id, 'listing');
  assert.equal((await fs.getDoc(fs.doc(listingCollection, 'listing'))).exists(), true);
  assert.equal((await fs.getDocs(fs.query(browse, fs.startAfter(page.docs[0])))).size, 0);
  await denied(fs.getDocs(listingCollection));
  await denied(fs.getDocs(fs.query(listingCollection, fs.limit(51))));
  await denied(fs.getDocs(fs.query(fs.collection(signedOut.firestore, listings), fs.limit(1))));
  await denied(fs.getDoc(fs.doc(signedOut.firestore, listings, 'listing')));

  // The web SDK exposes cursor pagination. StructuredQuery also supports offset.
  const port = emulatorPort('FIRESTORE_EMULATOR_HOST');
  const endpoint = `http://127.0.0.1:${port}/v1/projects/${projectId}/databases/(default)/documents/groupFinder/v2:runQuery`;
  const token = createMockUserToken({ sub: 'query-reader' }, projectId);
  for (const [limit, offset, allowed] of [[50, 0, true], [1, 1, false], [0, 0, false]]) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'listings' }], limit, offset } }),
    });
    assert.equal(response.status, allowed ? 200 : 403, `limit ${limit}, offset ${offset}`);
  }
}

async function run() {
  assert.equal(process.env.GCLOUD_PROJECT, projectId, 'Use the demo-overkot-rules emulator project');
  const host = client(hostId);
  const guest = client(guestId);
  const observer = client('observer');
  const signedOut = client('signed-out');
  const presence = user => db.ref(user.rtdb, `groupFinder/v2/presence/${hostId}`);

  // The installed app registers onDisconnect before creating its presence row.
  await db.onDisconnect(presence(host)).update({ online: false, lastSeen: db.serverTimestamp() });
  await db.update(presence(host), {
    online: true, displayName: 'TestHost', groupSize: 1, lastHeartbeat: db.serverTimestamp(),
  });
  await db.update(presence(host), { online: true, groupSize: 2, lastHeartbeat: db.serverTimestamp() });
  await db.update(presence(host), { online: false, lastSeen: db.serverTimestamp() });
  const online = user => db.child(presence(user), 'online');
  assert.equal((await db.get(online(guest))).val(), false);
  await denied(db.get(presence(guest)));
  await denied(db.get(db.child(presence(guest), 'lastHeartbeat')));
  await denied(db.get(online(signedOut)));
  await denied(db.get(db.ref(guest.rtdb, 'heartbeats/' + hostId)));
  await denied(db.set(db.ref(guest.rtdb, 'heartbeats/' + guestId), { tick: 1 }));

  const hostProfile = await profile(host, hostId, 'TestHost');
  const guestProfile = await profile(guest, guestId, 'TestGuest');
  const observerProfile = await profile(observer, 'observer', 'TestHost');
  await denied(fs.getDocs(fs.collection(host.firestore, players)));
  await denied(db.update(presence(guest), { online: true }));
  await denied(db.update(presence(observer), { online: true }));
  await denied(fs.getDoc(fs.doc(guest.firestore, players, hostId)));
  await denied(fs.updateDoc(fs.doc(guest.firestore, players, hostId), { displayName: 'TestGuest' }));
  await denied(fs.setDoc(fs.doc(observer.firestore, players, 'c'.repeat(24)), { displayName: 'TestOther' }));

  const listing = fs.writeBatch(host.firestore);
  listing.set(hostProfile, { lastListingAt: fs.serverTimestamp(), lastListingId: 'listing' }, { merge: true });
  const listingFields = {
    hostPlayer: hostId, hostDisplayName: 'TestHost', createdByUid: hostId,
    activityType: 'Exploration', goalType: 'Other', slotsTotal: 4, slotsFilled: 1, status: 'open',
    languageRequirement: 'none', languageValue: '', regionRequirement: 'none', regionValue: '',
    createdAt: fs.serverTimestamp(), expiresAt: fs.Timestamp.fromMillis(Date.now() + 3600000),
  };
  listing.set(fs.doc(host.firestore, listings, 'listing'), listingFields);
  await listing.commit();
  await checkListingReads(guest, signedOut);

  function newListings(user, profileRef, lastListingId, rows) {
    const batch = fs.writeBatch(user.firestore);
    batch.update(profileRef, { lastListingId, lastListingAt: fs.serverTimestamp() });
    for (const [id, fields] of rows) batch.set(fs.doc(user.firestore, listings, id), fields);
    return batch.commit();
  }
  const observerListing = { ...listingFields, hostPlayer: 'observer', createdByUid: 'observer' };
  await denied(newListings(observer, observerProfile, 'wrongHost', [
    ['wrongHost', { ...observerListing, hostPlayer: hostId }],
  ]));
  await denied(newListings(observer, observerProfile, 'wrongCreator', [
    ['wrongCreator', { ...observerListing, createdByUid: hostId }],
  ]));
  await denied(newListings(observer, observerProfile, 'first', [['first', observerListing], ['second', observerListing]]));
  await denied(newListings(host, hostProfile, 'tooSoon', [['tooSoon', listingFields]]));
  await denied(fs.deleteDoc(fs.doc(observer.firestore, listings, 'listing')));

  const request = user => fs.doc(user.firestore, requests, 'listing_' + guestId);
  const join = fs.writeBatch(guest.firestore);
  join.set(guestProfile, { lastRequestAt: fs.serverTimestamp(), lastRequestId: 'listing_' + guestId }, { merge: true });
  const requestFields = {
    playerId: guestId, playerDisplayName: 'TestGuest', requesterUid: guestId, listingId: 'listing',
    status: 'pending', requestedAt: fs.serverTimestamp(), respondedAt: null,
  };
  join.set(request(guest), requestFields);
  await join.commit();
  const observerRequestId = 'listing_observer';
  async function observerJoin(id, fields) {
    const batch = fs.writeBatch(observer.firestore);
    batch.update(observerProfile, { lastRequestAt: fs.serverTimestamp(), lastRequestId: id });
    batch.set(fs.doc(observer.firestore, requests, id), fields);
    return batch.commit();
  }
  const observerRequest = { ...requestFields, playerId: 'observer', requesterUid: 'observer' };
  await denied(observerJoin(observerRequestId, { ...observerRequest, playerId: guestId }));
  await denied(observerJoin(observerRequestId, { ...observerRequest, requesterUid: guestId }));
  await denied(observerJoin('listing_wrong', observerRequest));
  for (const [user, field, value] of [[guest, 'playerId', guestId], [host, 'listingId', 'listing']]) {
    const query = fs.query(fs.collection(user.firestore, requests), fs.where(field, '==', value),
      fs.orderBy('requestedAt', 'desc'), fs.limit(50));
    assert.equal((await fs.getDocs(query)).size, 1);
  }
  await denied(fs.getDoc(request(observer)));
  await denied(fs.getDocs(fs.query(fs.collection(observer.firestore, requests), fs.where('playerId', '==', guestId), fs.limit(50))));
  await denied(fs.getDocs(fs.query(fs.collection(guest.firestore, requests), fs.where('playerId', '==', guestId))));
  await denied(fs.updateDoc(fs.doc(guest.firestore, listings, 'listing'), { status: 'closed' }));
  await denied(fs.updateDoc(request(guest), { requesterUid: hostId }));
  await denied(fs.updateDoc(request(guest), { playerId: hostId }));
  await denied(fs.deleteDoc(request(observer)));
  await denied(fs.deleteDoc(request(host)));
  await fs.updateDoc(request(guest), { playerDisplayName: 'GuestRenamed' });
  await denied(fs.updateDoc(request(observer), { status: 'accepted', respondedAt: fs.serverTimestamp() }));
  await denied(fs.updateDoc(request(guest), { status: 'accepted', respondedAt: fs.serverTimestamp() }));
  await fs.updateDoc(request(host), { status: 'accepted', respondedAt: fs.serverTimestamp() });
  await fs.updateDoc(request(host), { status: 'invited' });
  await fs.updateDoc(request(host), { status: 'joined' });
  await fs.deleteDoc(request(guest));
  await denied(fs.updateDoc(hostProfile, { lastListingAt: fs.deleteField() }));

  const oldId = 'a'.repeat(24);
  if (process.argv.includes('--verify-temporary-overlap')) {
    await db.update(db.ref(host.rtdb, 'presence/' + oldId), { online: true });
    await fs.setDoc(fs.doc(host.firestore, 'players', oldId), { displayName: 'TestHost' });
    await fs.setDoc(fs.doc(host.firestore, 'authSessions', hostId), { accountId: oldId });
    console.log('Passed owner and participant checks for v2, with legacy compatibility during the deployment window.');
    return;
  }
  await denied(db.update(db.ref(host.rtdb, 'presence/' + oldId), { online: true }));
  for (const [collection, data] of [['players', { displayName: 'TestHost' }], ['authSessions', { accountId: oldId }],
      ['listings', { hostPlayer: oldId }], ['listingRequests', { playerId: oldId }]]) {
    await denied(fs.setDoc(fs.doc(host.firestore, collection, oldId), data));
  }
  console.log('Passed owner, participant, cooldown, pagination and legacy-path rules checks.');
}

run().then(() => process.exit(0), error => {
  console.error(error);
  process.exit(1);
});
