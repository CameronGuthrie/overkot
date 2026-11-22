/**
 * Group Finder Service — Main Process
 * 
 * Manages all Firebase interactions for the Group Finder widget:
 *   - Presence (RTDB) — online status, heartbeats, onDisconnect
 *   - Players (Firestore) — profiles, preferences
 *   - Listings (Firestore) — create, browse, update, close
 *   - Requests (Firestore) — join requests, accept/decline
 *   - Matching — lightweight suggestion engine
 * 
 * All operations are called from the main process via IPC handlers.
 * Real-time updates are pushed to the renderer via webContents.send().
 */

const fb = require('./firebaseConfig');
const { validName } = require('./playerIdentity');

// ─── Constants ───────────────────────────────────────────────
const MAX_GROUP_SIZE = 4;
const HEARTBEAT_INTERVAL_MS = 30_000;       // 30s
const HOST_OFFLINE_THRESHOLD_MS = 45_000;   // 45s — host considered offline
const STALE_THRESHOLD_MS = 2 * 60_000;      // 2min — listing becomes Stale
const AUTO_CLOSE_THRESHOLD_MS = 10 * 60_000;// 10min — stale listing auto-closes
const LISTING_MAX_AGE_MS = 4 * 60 * 60_000; // 4h — absolute expiry
const HOST_OFFLINE_EXPIRY_MS = 60 * 60_000; // 1h — auto-close if host offline
// Server-enforced cooldowns. Mirror these in firestore.rules.
const LISTING_CREATE_COOLDOWN_MS = 60_000;
const REQUEST_JOIN_COOLDOWN_MS = 30_000;

const ACTIVITY_TYPES = [
  'Boss / Encounter',
  'Farming / Repeats',
  'Quest / Progression',
  'Exploration',
  'Help / Teaching',
  'General Grouping',
];

const GOAL_TYPES = [
  'Kill / Clear',
  'Farm / Grind',
  'Complete Quest',
  'Explore / Discover',
  'Learn / Teach',
  'Just Hanging Out',
  'Other',
];

const REGIONS = ['EU', 'NA', 'APAC', 'No preference'];

// ─── Service State ───────────────────────────────────────────
let playerId = null;          // Authenticated Group Finder UID
let displayName = null;       // in-game display name
let groupSize = 1;            // detected group size (1 = solo)
// Local mirror of server-enforced cooldowns. We track our own last-write
// timestamps so the UI can show a countdown without waiting for a rules
// rejection. Server rules are the source of truth.
let _lastListingAt = 0;
let _lastRequestAt = 0;
let heartbeatTimer = null;
let presenceRef = null;
let connectedRef = null;
let unsubConnected = null;
let initialCleanupTimer = null;
let identityGeneration = 0;

// Real-time listener unsubscribe functions
let unsubListings = null;
let unsubMyRequests = null;
let unsubMyListingRequests = null;
let offlineCleanupTimer = null;

// Cached data
let cachedListings = [];
let cachedMyRequests = [];         // requests I've made on other listings
let cachedIncomingRequests = [];   // requests on my listing
let cachedOnlinePlayers = {};      // playerId → presence data
let myListing = null;              // my active listing document

// Window reference for pushing updates
let groupFinderWindow = null;
let mainWindow = null; // main overlay window — receives lightweight GF state for the widget
let widgetWindowsRef = null; // Map of widget windows from main.js
const players = 'groupFinder/v2/players';
const listings = 'groupFinder/v2/listings';
const requests = 'groupFinder/v2/listingRequests';
const presence = 'groupFinder/v2/presence';
let _debug = false;
function _gfLog(...args) { if (_debug) console.log(...args); }

// ─── Initialization ──────────────────────────────────────────

/**
 * Initialize the Group Finder service.
 * @param {string} accountId — player's account ID from game log
 * @param {string} name — player's display name (from log or manual)
 * @param {number} detectedGroupSize — detected in-game group size (1-4)
 */
async function initialize(accountId, name, detectedGroupSize = 1) {
  if (!validName(name)) return false;
  if (!fb.isConfigured()) {
    _gfLog('[GroupFinder] Firebase not configured -- service disabled.');
    return false;
  }

  const generation = ++identityGeneration;
  // The game ID only selects an encrypted local sign-in. Firebase supplies the record owner.
  const user = await fb.initializeFirebase(accountId);
  if (generation !== identityGeneration) return false;
  if (!user?.uid) {
    console.error('[GroupFinder] Firebase auth failed -- service disabled.');
    return false;
  }

  playerId = user.uid;
  displayName = name;
  groupSize = Math.min(MAX_GROUP_SIZE, Math.max(1, Math.trunc(Number(detectedGroupSize)) || 1));

  // Set up presence
  await setupPresence();
  if (generation !== identityGeneration) return false;

  // Create/update player profile
  await updatePlayerProfile();
  if (generation !== identityGeneration) return false;

  // Start heartbeat
  startHeartbeat();

  // Start offline listing cleanup
  startOfflineCleanup();

  return true;
}

/**
 * Shut down the service (on app close or game disconnect).
 */
async function shutdown() {
  identityGeneration++;
  const oldPresence = presenceRef, oldPlayerId = playerId;
  stopHeartbeat();
  stopOfflineCleanup();
  stopAllListeners();
  if (unsubConnected) { unsubConnected(); unsubConnected = null; }
  // Clear the visible identity before waiting for any offline network writes.
  playerId = null;
  displayName = null;
  groupSize = 1;
  cachedListings = [];
  cachedMyRequests = [];
  cachedIncomingRequests = [];
  cachedOnlinePlayers = {};
  myListing = null;
  presenceRef = null;
  connectedRef = null;
  _lastListingAt = 0;
  _lastRequestAt = 0;
  pushUpdate();
  if (oldPlayerId && fb.isInitialized()) {
    try {
      await fb.update(fb.ref(fb.getRTDB(), `${presence}/${oldPlayerId}`), {
        online: false, lastSeen: fb.rtdbServerTimestamp(),
      });
      if (oldPresence) await fb.onDisconnect(oldPresence).cancel();
    } catch { _gfLog('[GroupFinder] Offline presence cleanup deferred to onDisconnect'); }
  }
}

// ─── Presence (RTDB) ────────────────────────────────────────

async function setupPresence() {
  const rtdb = fb.getRTDB();
  presenceRef = fb.ref(rtdb, `${presence}/${playerId}`);
  connectedRef = fb.ref(rtdb, '.info/connected');

  // When we connect, set online and configure onDisconnect
  const generation = identityGeneration, target = presenceRef;
  unsubConnected = fb.onValue(connectedRef, async (snapshot) => {
    if (generation !== identityGeneration || snapshot.val() !== true) return;
    try {
      // We're connected — set online, configure disconnect handler
      const disconnectRef = fb.onDisconnect(target);
      await disconnectRef.update({
        online: false,
        lastSeen: fb.rtdbServerTimestamp(),
      });

      // Now set our online state
      if (generation !== identityGeneration) return;
      await fb.update(target, {
        online: true,
        displayName: displayName,
        groupSize: groupSize,
        lastHeartbeat: fb.rtdbServerTimestamp(),
      });

      _gfLog('[GroupFinder] Presence set: online');
    } catch { _gfLog('[GroupFinder] Presence connection will retry'); }
  });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!playerId || !fb.isConfigured()) return;
    // Skip if anon auth isn't ready yet (or got revoked) — RTDB rules require it.
    const auth = fb.getAuthInstance();
    if (auth?.currentUser?.uid !== playerId) return;
    try {
      // Heartbeat writes to RTDB only — never to Firestore.
      // This avoids triggering onSnapshot for all listing listeners every 30s.
      const rtdb = fb.getRTDB();
      await fb.update(fb.ref(rtdb, `${presence}/${playerId}`), {
        lastHeartbeat: fb.rtdbServerTimestamp(),
        groupSize: groupSize,
        online: true,
      });
    } catch (e) {
      console.error('[GroupFinder] Heartbeat failed:', e.message);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── Offline Listing Cleanup ─────────────────────────────────

/**
 * Periodically check our OWN listing and auto-close it if stale.
 * Other people's listings are left alone — Firestore rules now restrict
 * `listings` updates to the original creator's auth uid, so the old
 * distributed cleanup pattern would just fail. Stale third-party listings
 * are filtered out of the UI by the host-online check instead.
 */
function startOfflineCleanup() {
  stopOfflineCleanup();
  // Run every 5 minutes
  offlineCleanupTimer = setInterval(() => cleanupOfflineListings(), 5 * 60_000);
  // Also run once shortly after startup
  initialCleanupTimer = setTimeout(() => cleanupOfflineListings().catch(() => {}), 30_000);
}

function stopOfflineCleanup() {
  clearTimeout(initialCleanupTimer);
  initialCleanupTimer = null;
  if (offlineCleanupTimer) {
    clearInterval(offlineCleanupTimer);
    offlineCleanupTimer = null;
  }
}

async function cleanupOfflineListings() {
  if (!fb.isConfigured()) return;
  if (!myListing || myListing.status === 'closed') return;
  const firestore = fb.getFirestoreInstance();
  const current = myListing;
  const generation = identityGeneration;
  const now = Date.now();

  const createdAt = myListing.createdAt?.toMillis?.()
    || (typeof myListing.createdAt === 'number' ? myListing.createdAt : 0);
  if (createdAt > 0 && (now - createdAt) > LISTING_MAX_AGE_MS) {
    try {
      await fb.updateDoc(fb.doc(firestore, listings, current.id), { status: 'closed' });
      if (generation !== identityGeneration || current !== myListing) return;
      _gfLog(`[GroupFinder] Auto-closed own listing ${current.id} -- exceeded max age (4h)`);
      cleanupOwnListing(current.id);
      pushUpdate();
    } catch (e) {
      if (generation !== identityGeneration || current !== myListing) return;
      _gfLog(`[GroupFinder] Self-cleanup failed: ${e.message}`);
      // PERMISSION_DENIED means our current Firebase auth uid no longer
      // matches the listing's createdByUid. This happens after a fresh
      // install / cleared app data / revoked anon credential -- the local
      // anon uid rotates, but the old listing still references the old uid.
      // Without this guard we'd retry every 5min forever. Drop the local
      // reference so we stop trying. The listing will be closed server-side
      // via the `expiresAt` Firestore TTL policy, or by another client that
      // still holds the original uid.
      const code = e.code || '';
      if (code === 'permission-denied' || /PERMISSION_DENIED/i.test(e.message || '')) {
        _gfLog(`[GroupFinder] Orphaned listing ${myListing.id} -- forgetting local ref (uid mismatch)`);
        cleanupOwnListing(myListing.id);
        pushUpdate();
      }
    }
  }
}

/** If the closed listing was ours, clean up local state. */
function cleanupOwnListing(listingId) {
  if (myListing && myListing.id === listingId) {
    if (unsubMyListingRequests) {
      unsubMyListingRequests();
      unsubMyListingRequests = null;
    }
    myListing = null;
    cachedIncomingRequests = [];
  }
}

/**
 * Batch-read RTDB presence for all listing hosts.
 * Called after the listings listener fires — cheap one-time reads (no persistent listeners).
 * RTDB reads are bandwidth-based (not per-read priced), so this is essentially free.
 */
async function refreshHostPresence() {
  if (!fb.isConfigured()) return;
  const generation = identityGeneration, rows = cachedListings;
  const rtdb = fb.getRTDB();
  const uniqueHosts = [...new Set(cachedListings.map(l => l.hostPlayer))];
  const newPresence = {};

  try {
    await Promise.all(uniqueHosts.map(async (hostId) => {
      try {
        const snap = await fb.get(fb.ref(rtdb, `${presence}/${hostId}/online`));
        newPresence[hostId] = snap.val() === true;
      } catch (_) {
        newPresence[hostId] = false;
      }
    }));
  } catch (_) {
    // If the batch fails, keep existing data
    return;
  }

  if (generation === identityGeneration && rows === cachedListings) cachedOnlinePlayers = newPresence;
}

// ─── Player Profile (Firestore) ─────────────────────────────

async function updatePlayerProfile(prefs = {}) {
  if (!playerId || !fb.isConfigured()) return;
  const firestore = fb.getFirestoreInstance();

  const profileData = {
    displayName: displayName,
    onlineStatus: 'online',
    groupSize: groupSize,
    lastSeen: fb.firestoreServerTimestamp(),
    ...prefs,
  };

  // Merge so we don't overwrite existing preferences
  await fb.setDoc(fb.doc(firestore, players, playerId), profileData, { merge: true });
  _gfLog('[GroupFinder] Player profile updated');
}

async function getPlayerProfile() {
  if (!playerId || !fb.isConfigured()) return null;
  const generation = identityGeneration;
  const firestore = fb.getFirestoreInstance();
  const snap = await fb.getDoc(fb.doc(firestore, players, playerId));
  return generation === identityGeneration && snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

async function savePlayerPreferences(prefs) {
  if (!playerId || !fb.isConfigured()) return;
  await updatePlayerProfile({
    primaryLanguage: prefs.primaryLanguage || 'en',
    secondaryLanguage: prefs.secondaryLanguage || null,
    regionPreference: prefs.regionPreference || 'No preference',
  });
}

// ─── Listings (Firestore) ────────────────────────────────────

/**
 * Create a new group listing. Only one active listing per player.
 *
 * Writes the listing document AND bumps `players/{uid}.lastListingAt`
 * in a single Firestore batch. Firestore rules enforce that:
 *   - the player doc's lastListingAt was previously >60s old (or absent),
 *   - the new lastListingAt equals request.time (i.e. came from the same batch),
 *   - hostPlayer and createdByUid both match the signed-in Firebase UID,
 *   - all string fields are length-capped and value-set-validated.
 * This is what gates abuse since we don't have Cloud Functions.
 */
async function createListing(data) {
  if (!playerId || !fb.isConfigured()) return null;
  const generation = identityGeneration;
  const firestore = fb.getFirestoreInstance();
  const auth = fb.getAuthInstance();
  const uid = auth && auth.currentUser ? auth.currentUser.uid : null;
  if (uid !== playerId) {
    console.warn('[GroupFinder] Firebase auth not ready -- cannot create listing.');
    return null;
  }

  // Check for existing active listing
  if (myListing) {
    console.warn('[GroupFinder] Player already has an active listing.');
    return null;
  }

  // Local cooldown enforcement (server is the source of truth, but this
  // gives instant UI feedback without a round-trip).
  const remaining = getCreateCooldownRemainingMs();
  if (remaining > 0) {
    console.warn(`[GroupFinder] Listing create on cooldown (${Math.ceil(remaining / 1000)}s left).`);
    return null;
  }

  const now = fb.Timestamp.now();
  const expiresAt = fb.Timestamp.fromMillis(now.toMillis() + LISTING_MAX_AGE_MS);

  const listingData = {
    hostPlayer: playerId,
    hostDisplayName: displayName,
    createdByUid: uid,
    activityType: data.activityType || 'General Grouping',
    goalType: data.goalType || 'Other',
    slotsTotal: Math.max(1, Math.min(Math.trunc(Number(data.slotsNeeded)) || MAX_GROUP_SIZE - 1, MAX_GROUP_SIZE - 1)) + 1,
    slotsFilled: 1,
    status: 'open',
    languageRequirement: data.languageRequirement || 'none',
    languageValue: data.languageValue || '',
    regionRequirement: data.regionRequirement || 'none',
    regionValue: data.regionValue || '',
    createdAt: fb.firestoreServerTimestamp(),
    expiresAt,
  };

  const newDocRef = fb.doc(fb.collection(firestore, listings));
  const playerRef = fb.doc(firestore, players, playerId);
  const batch = fb.writeBatch(firestore);
  batch.set(playerRef, {
    displayName,
    onlineStatus: 'online',
    groupSize,
    lastSeen: fb.firestoreServerTimestamp(),
    lastListingAt: fb.firestoreServerTimestamp(),
    lastListingId: newDocRef.id,
  }, { merge: true });
  batch.set(newDocRef, listingData);

  try {
    await batch.commit();
  } catch (e) {
    console.error('[GroupFinder] createListing batch failed:', e.code || '', e.message || e);
    return null;
  }

  if (generation !== identityGeneration) return null;
  _lastListingAt = Date.now();
  myListing = { id: newDocRef.id, ...listingData };
  _gfLog(`[GroupFinder] Listing created: ${newDocRef.id}`);

  startMyListingRequestsListener();
  pushUpdate();

  return myListing;
}

/**
 * Update an existing listing (host only).
 */
async function updateListing(updates) {
  if (!myListing || !fb.isConfigured()) return false;
  const current = myListing;
  const firestore = fb.getFirestoreInstance();

  const allowed = ['activityType', 'goalType', 'languageRequirement',
    'languageValue', 'regionRequirement', 'regionValue'];
  const filtered = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) filtered[key] = updates[key];
  }

  if (Object.keys(filtered).length === 0) return false;

  await fb.updateDoc(fb.doc(firestore, listings, myListing.id), filtered);
  if (current !== myListing) return false;
  Object.assign(current, filtered);
  pushUpdate();
  return true;
}

/**
 * Close own listing.
 */
async function closeListing() {
  if (!myListing || !fb.isConfigured()) return;
  const current = myListing;
  const firestore = fb.getFirestoreInstance();

  await fb.updateDoc(fb.doc(firestore, listings, myListing.id), {
    status: 'closed',
  });

  if (current !== myListing) return;
  cleanupOwnListing(current.id);
  pushUpdate();
  _gfLog('[GroupFinder] Listing closed');
}

// ─── Join Requests (Firestore) ───────────────────────────────

/**
 * Request to join a listing.
 *
 * Writes the request document AND bumps `players/{uid}.lastRequestAt`
 * in a single batch. Rules enforce a 30s per-UID cooldown plus the
 * usual shape validation.
 */
async function requestJoin(listingId) {
  if (!playerId || !fb.isConfigured()) return null;
  const generation = identityGeneration;
  const firestore = fb.getFirestoreInstance();
  const auth = fb.getAuthInstance();
  const uid = auth && auth.currentUser ? auth.currentUser.uid : null;
  if (uid !== playerId) return null;

  // Don't allow joining own listing or non-open listings
  const listingSnap = await fb.getDoc(fb.doc(firestore, listings, listingId));
  if (generation !== identityGeneration || !listingSnap.exists()) return null;
  const listing = listingSnap.data();
  if (listing.hostPlayer === playerId) return null;
  if (listing.status !== 'open') return null;

  const remaining = getJoinCooldownRemainingMs();
  if (remaining > 0) {
    console.warn(`[GroupFinder] Join request on cooldown (${Math.ceil(remaining / 1000)}s left).`);
    return null;
  }

  const requestId = `${listingId}_${playerId}`;
  const requestData = {
    playerId,
    playerDisplayName: displayName,
    requesterUid: uid,
    listingId,
    status: 'pending',
    requestedAt: fb.firestoreServerTimestamp(),
    respondedAt: null,
  };

  const playerRef = fb.doc(firestore, players, playerId);
  const requestRef = fb.doc(firestore, requests, requestId);
  const batch = fb.writeBatch(firestore);
  batch.set(playerRef, {
    displayName,
    onlineStatus: 'online',
    groupSize,
    lastSeen: fb.firestoreServerTimestamp(),
    lastRequestAt: fb.firestoreServerTimestamp(),
    lastRequestId: requestId,
  }, { merge: true });
  batch.set(requestRef, requestData);

  try {
    await batch.commit();
  } catch (e) {
    console.error('[GroupFinder] requestJoin batch failed:', e.code || '', e.message || e);
    return null;
  }

  if (generation !== identityGeneration) return null;
  _lastRequestAt = Date.now();
  _gfLog(`[GroupFinder] Join request sent for listing: ${listingId}`);
  return requestData;
}

// ─── Cooldown helpers (mirror server-enforced limits) ───────
function getCreateCooldownRemainingMs() {
  if (!_lastListingAt) return 0;
  return Math.max(0, LISTING_CREATE_COOLDOWN_MS - (Date.now() - _lastListingAt));
}
function getJoinCooldownRemainingMs() {
  if (!_lastRequestAt) return 0;
  return Math.max(0, REQUEST_JOIN_COOLDOWN_MS - (Date.now() - _lastRequestAt));
}

/**
 * Cancel own join request.
 */
async function cancelRequest(listingId) {
  if (!playerId || !fb.isConfigured()) return;
  const firestore = fb.getFirestoreInstance();
  const requestId = `${listingId}_${playerId}`;
  await fb.deleteDoc(fb.doc(firestore, requests, requestId));
  _gfLog(`[GroupFinder] Join request cancelled for listing: ${listingId}`);
}

/**
 * Host accepts a join request.
 */
async function acceptRequest(listingId, requestPlayerId) {
  if (!myListing || myListing.id !== listingId || !fb.isConfigured()) return false;
  const firestore = fb.getFirestoreInstance();

  const generation = identityGeneration;
  const listingRef = fb.doc(firestore, listings, listingId);
  const requestRef = fb.doc(firestore, requests, `${listingId}_${requestPlayerId}`);
  const updated = await fb.runTransaction(firestore, async transaction => {
    const listingSnap = await transaction.get(listingRef);
    const requestSnap = await transaction.get(requestRef);
    if (generation !== identityGeneration || !listingSnap.exists() || !requestSnap.exists()) return null;
    const listing = listingSnap.data(), request = requestSnap.data();
    if (request.status !== 'pending' || !['open', 'pending'].includes(listing.status) ||
      listing.slotsFilled >= listing.slotsTotal || listing.slotsTotal > MAX_GROUP_SIZE) return null;
    const slotsFilled = listing.slotsFilled + 1;
    const status = slotsFilled >= listing.slotsTotal ? 'full' : 'pending';
    // Reserve the seat and accept the request atomically. Concurrent accepts
    // retry against the latest count, so the last seat can only be taken once.
    transaction.update(requestRef, { status: 'accepted', respondedAt: fb.firestoreServerTimestamp() });
    transaction.update(listingRef, { slotsFilled, status });
    return { slotsFilled, status };
  });
  if (!updated || generation !== identityGeneration || myListing?.id !== listingId) return false;
  Object.assign(myListing, updated);

  pushUpdate();
  _gfLog(`[GroupFinder] Accepted request from ${requestPlayerId}`);
  return true;
}

/**
 * Host declines a join request.
 */
async function declineRequest(listingId, requestPlayerId) {
  if (!myListing || myListing.id !== listingId || !fb.isConfigured()) return false;
  const firestore = fb.getFirestoreInstance();

  const requestId = `${listingId}_${requestPlayerId}`;
  await fb.updateDoc(fb.doc(firestore, requests, requestId), {
    status: 'declined',
    respondedAt: fb.firestoreServerTimestamp(),
  });

  pushUpdate();
  _gfLog(`[GroupFinder] Declined request from ${requestPlayerId}`);
  return true;
}

/**
 * Host marks a player as invited (after copying their name).
 */
async function markInvited(listingId, requestPlayerId) {
  if (!myListing || myListing.id !== listingId || !fb.isConfigured()) return false;
  const firestore = fb.getFirestoreInstance();

  const requestId = `${listingId}_${requestPlayerId}`;
  await fb.updateDoc(fb.doc(firestore, requests, requestId), {
    status: 'invited',
  });

  pushUpdate();
  return true;
}

/**
 * Mark a player as joined (when group detection confirms it).
 */
async function markJoined(listingId, requestPlayerId) {
  if (!myListing || myListing.id !== listingId || !fb.isConfigured()) return false;
  const firestore = fb.getFirestoreInstance();

  const requestId = `${listingId}_${requestPlayerId}`;
  await fb.updateDoc(fb.doc(firestore, requests, requestId), {
    status: 'joined',
  });

  pushUpdate();
  return true;
}

// ─── Real-Time Listeners ─────────────────────────────────────

/**
 * Start background Firestore listeners (called once after service init).
 * These keep the widget updated even when the Group Finder window is closed.
 * Firestore onSnapshot is server-push, so it only fires when data changes.
 */
function startBackgroundListeners() {
  startListingsListener();
  startMyRequestsListener();
  if (myListing) startMyListingRequestsListener();
}

/**
 * Attach the Group Finder window so it also receives state pushes.
 * Listeners are already running in the background.
 */
function startListeners(window) {
  groupFinderWindow = window;
  // Ensure listeners are running (idempotent — each start* checks first)
  startBackgroundListeners();
}

/**
 * Detach the Group Finder window. Background listeners keep running
 * so the widget continues to receive updates.
 */
function stopListeners() {
  groupFinderWindow = null;
}

/**
 * Fully stop all Firestore listeners (called on shutdown only).
 */
function stopAllListeners() {
  if (unsubListings) { unsubListings(); unsubListings = null; }
  if (unsubMyRequests) { unsubMyRequests(); unsubMyRequests = null; }
  if (unsubMyListingRequests) { unsubMyListingRequests(); unsubMyListingRequests = null; }
}

function startListingsListener() {
  if (unsubListings) unsubListings();
  if (!playerId || !fb.isInitialized()) return;

  const generation = identityGeneration;
  const firestore = fb.getFirestoreInstance();
  const q = fb.query(
    fb.collection(firestore, listings),
    fb.where('status', 'in', ['open', 'pending', 'full', 'in_progress']),
    fb.orderBy('createdAt', 'desc'),
    fb.limit(50)
  );

  unsubListings = fb.onSnapshot(q, async (snapshot) => {
    if (generation !== identityGeneration) return;
    cachedListings = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

    // Refresh host online status from RTDB (cheap one-time reads, no listeners)
    await refreshHostPresence();

    if (generation === identityGeneration) pushUpdate();
  }, (err) => {
    console.error('[GroupFinder] Listings listener error:', err.message);
  });
}

function startMyRequestsListener() {
  if (unsubMyRequests) unsubMyRequests();
  if (!playerId || !fb.isInitialized()) return;

  const generation = identityGeneration;
  const firestore = fb.getFirestoreInstance();
  const q = fb.query(
    fb.collection(firestore, requests),
    fb.where('playerId', '==', playerId),
    fb.orderBy('requestedAt', 'desc'), fb.limit(50)
  );

  unsubMyRequests = fb.onSnapshot(q, (snapshot) => {
    if (generation !== identityGeneration) return;
    cachedMyRequests = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    pushUpdate();
  }, (err) => {
    console.error('[GroupFinder] My requests listener error:', err.message);
  });
}

function startMyListingRequestsListener() {
  if (unsubMyListingRequests) unsubMyListingRequests();
  if (!myListing || !fb.isInitialized()) return;

  const generation = identityGeneration, listingId = myListing.id;
  const firestore = fb.getFirestoreInstance();
  const q = fb.query(
    fb.collection(firestore, requests),
    fb.where('listingId', '==', myListing.id),
    fb.orderBy('requestedAt', 'desc'), fb.limit(50)
  );

  unsubMyListingRequests = fb.onSnapshot(q, (snapshot) => {
    if (generation !== identityGeneration || myListing?.id !== listingId) return;
    cachedIncomingRequests = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    pushUpdate();
  }, (err) => {
    console.error('[GroupFinder] Listing requests listener error:', err.message);
  });
}

// ─── Match Suggestions ───────────────────────────────────────

/**
 * Generate match suggestions for the current player.
 * Returns listings sorted by compatibility score.
 */
async function getSuggestions() {
  if (!playerId || !fb.isConfigured()) return [];

  const profile = await getPlayerProfile();
  if (!profile) return [];

  const suggestions = [];

  for (const listing of cachedListings) {
    // Skip own listing
    if (listing.hostPlayer === playerId) continue;
    // Skip stale, closed, or full listings
    if (listing.status === 'stale' || listing.status === 'closed') continue;
    if (listing.slotsFilled >= listing.slotsTotal) continue;
    // Skip if player already in a full group
    if (groupSize >= MAX_GROUP_SIZE) continue;

    let score = 0;

    // Active listing base
    score += 10;

    // Host online (from RTDB presence cache)
    if (cachedOnlinePlayers[listing.hostPlayer]) {
      score += 30; // host online
    }

    // Player is solo (more available)
    if (groupSize === 1) score += 20;

    // Slots available
    const slotsOpen = listing.slotsTotal - listing.slotsFilled;
    score += slotsOpen * 5;

    // Language compatibility
    if (listing.languageRequirement !== 'none' && listing.languageValue) {
      const langMatch = (profile.primaryLanguage === listing.languageValue) ||
                         (profile.secondaryLanguage === listing.languageValue);
      if (listing.languageRequirement === 'required' && !langMatch) {
        continue; // hard filter
      }
      if (langMatch) score += 15;
    }

    // Region compatibility
    if (listing.regionRequirement !== 'none' && listing.regionValue &&
        listing.regionValue !== 'No preference') {
      const regionMatch = profile.regionPreference === listing.regionValue;
      if (listing.regionRequirement === 'required' && !regionMatch) {
        continue; // hard filter
      }
      if (regionMatch) score += 10;
    }

    // Already requested? Deprioritize
    const alreadyRequested = cachedMyRequests.some(
      r => r.listingId === listing.id && r.status !== 'declined'
    );
    if (alreadyRequested) score -= 50;

    suggestions.push({ listing, score });
  }

  // Sort by score descending
  suggestions.sort((a, b) => b.score - a.score);

  // Serialize Firestore Timestamps before returning to renderer
  const serializeTs = (ts) => {
    if (!ts) return null;
    if (ts.toMillis) return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    return ts;
  };

  return suggestions.slice(0, 8).map(s => ({
    ...s.listing,
    createdAt: serializeTs(s.listing.createdAt),
    expiresAt: serializeTs(s.listing.expiresAt),
  }));
}

// ─── State Push ──────────────────────────────────────────────

function pushUpdate() {
  const stateData = getState();
  if (groupFinderWindow && !groupFinderWindow.isDestroyed()) {
    groupFinderWindow.webContents.send('gf:state-update', stateData);
  }
  // Also push to main window so the compact GF widget stays in sync
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gf:state-update', stateData);
  }
  // Push to standalone widget windows (e.g. popped-out groupfinder widget)
  if (widgetWindowsRef) {
    for (const [, wWin] of widgetWindowsRef) {
      if (wWin && !wWin.isDestroyed()) {
        wWin.webContents.send('gf:state-update', stateData);
      }
    }
  }
}

/**
 * Get the complete current state for the renderer.
 */
function getState() {
  // Serialize Firestore Timestamps to milliseconds for the renderer
  const serializeTs = (ts) => {
    if (!ts) return null;
    if (ts.toMillis) return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    return ts;
  };

  const serializeListing = (l) => ({
    ...l,
    createdAt: serializeTs(l.createdAt),
    expiresAt: serializeTs(l.expiresAt),
  });

  const serializeRequest = (r) => ({
    ...r,
    requestedAt: serializeTs(r.requestedAt),
    respondedAt: serializeTs(r.respondedAt),
  });

  return {
    configured: fb.isConfigured(),
    playerId,
    displayName,
    groupSize,
    maxGroupSize: MAX_GROUP_SIZE,
    listings: cachedListings.map(serializeListing),
    myListing: myListing ? serializeListing(myListing) : null,
    myRequests: cachedMyRequests.map(serializeRequest),
    incomingRequests: cachedIncomingRequests.map(serializeRequest),
    onlinePlayers: { ...cachedOnlinePlayers },
    activityTypes: ACTIVITY_TYPES,
    goalTypes: GOAL_TYPES,
    regions: REGIONS,
    cooldowns: {
      createMs: LISTING_CREATE_COOLDOWN_MS,
      joinMs: REQUEST_JOIN_COOLDOWN_MS,
      createRemainingMs: getCreateCooldownRemainingMs(),
      joinRemainingMs: getJoinCooldownRemainingMs(),
    },
    thresholds: {
      hostOffline: HOST_OFFLINE_THRESHOLD_MS,
      stale: STALE_THRESHOLD_MS,
      autoClose: AUTO_CLOSE_THRESHOLD_MS,
    },
  };
}

/**
 * Update detected group size (called from main loop when group detection changes).
 */
function setGroupSize(size) {
  groupSize = Math.min(Math.max(Math.trunc(Number(size)) || 1, 1), MAX_GROUP_SIZE);
  if (fb.isConfigured() && playerId) {
    const rtdb = fb.getRTDB();
    fb.update(fb.ref(rtdb, `${presence}/${playerId}`), { groupSize }).catch(() => {});
  }
  pushUpdate();
}

/**
 * Update display name (called when name is detected from game).
 */
async function setDisplayName(name) {
  if (!validName(name) || !playerId || !fb.isInitialized()) return;
  const generation = identityGeneration;
  displayName = name;
  pushUpdate();
  const uid = fb.getAuthInstance()?.currentUser?.uid;
  const firestore = fb.getFirestoreInstance();
  await fb.update(fb.ref(fb.getRTDB(), `${presence}/${playerId}`), { displayName });
  if (generation !== identityGeneration) return;
  await updatePlayerProfile();
  if (generation !== identityGeneration) return;
  if (myListing && myListing.createdByUid === uid && myListing.hostDisplayName !== name) {
    const current = myListing;
    await fb.updateDoc(fb.doc(firestore, listings, current.id), { hostDisplayName: name });
    if (generation !== identityGeneration) return;
    current.hostDisplayName = name;
  }
  for (const request of cachedMyRequests) {
    if (request.requesterUid === uid && request.playerDisplayName !== name) {
      await fb.updateDoc(fb.doc(firestore, requests, request.id), { playerDisplayName: name });
      if (generation !== identityGeneration) return;
      request.playerDisplayName = name;
    }
  }
  pushUpdate();
}

/**
 * Restore own listing on startup (if one exists in Firestore).
 */
async function restoreMyListing() {
  if (!playerId || !fb.isConfigured()) return;
  const generation = identityGeneration;
  const firestore = fb.getFirestoreInstance();

  const q = fb.query(
    fb.collection(firestore, listings),
    fb.where('hostPlayer', '==', playerId),
    fb.where('status', 'in', ['open', 'pending', 'full', 'in_progress', 'stale']),
    fb.limit(1)
  );

  const snap = await fb.getDocs(q);
  if (generation !== identityGeneration) return;
  if (!snap.empty) {
    const docSnap = snap.docs[0];
    myListing = { id: docSnap.id, ...docSnap.data() };

    // Restore the current host's own listing when reconnecting.
    if (myListing.status === 'stale') {
      const newStatus = myListing.slotsFilled >= myListing.slotsTotal
        ? 'full'
        : cachedIncomingRequests.some(r => r.status === 'accepted')
          ? 'pending'
          : 'open';
      await fb.updateDoc(fb.doc(firestore, listings, myListing.id), {
        status: newStatus,
      });
      if (generation !== identityGeneration || myListing?.id !== docSnap.id) return;
      myListing.status = newStatus;
      _gfLog(`[GroupFinder] Recovered stale listing -> ${newStatus}`);
    }

    _gfLog(`[GroupFinder] Restored existing listing: ${myListing.id}`);
  }
}

module.exports = {
  initialize,
  shutdown,
  getState,
  getCreateCooldownRemainingMs,
  getJoinCooldownRemainingMs,
  setGroupSize,
  setDisplayName,
  setDebug: (v) => { _debug = v; },
  updatePlayerProfile,
  savePlayerPreferences,
  getPlayerProfile,
  createListing,
  updateListing,
  closeListing,
  requestJoin,
  cancelRequest,
  acceptRequest,
  declineRequest,
  markInvited,
  markJoined,
  getSuggestions,
  startBackgroundListeners,
  startListeners,
  stopListeners,
  restoreMyListing,
  pushUpdate,
  setMainWindow: (win) => { mainWindow = win; },
  setWidgetWindows: (map) => { widgetWindowsRef = map; },
  // Constants for external use
  ACTIVITY_TYPES,
  GOAL_TYPES,
  REGIONS,
  MAX_GROUP_SIZE,
};
