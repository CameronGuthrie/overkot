/**
 * Overkot Group Finder – Firebase Cloud Functions
 * 
 * Server-side logic for:
 *   1. Stale listing detection — when host goes offline (via RTDB presence trigger)
 *   2. Auto-close expired listings — stale > 10min or age > 4h (scheduled safety net)
 *   3. Presence sync — RTDB presence → Firestore player profile
 *   4. Listing recovery — when host reconnects
 * 
 * QUOTA OPTIMIZATION:
 *   - onPresenceChange triggers ONLY on /presence/{playerId}/online changes
 *     (not on heartbeat writes), keeping Cloud Function invocations minimal.
 *   - Scheduled cleanup reads RTDB for heartbeat freshness instead of Firestore,
 *     runs every 5 minutes (not 1), and uses a single Firestore query.
 *   - No lastHostHeartbeat field in Firestore listings — stale state is managed
 *     entirely through the listing 'status' field.
 * 
 * Deploy: cd firebase && firebase deploy --only functions
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const axios = require('axios');

initializeApp();

// ─── Constants (must match client-side values) ───────────────
const STALE_THRESHOLD_MS = 2 * 60 * 1000;       // 2 minutes (grace period after disconnect)
const AUTO_CLOSE_THRESHOLD_MS = 10 * 60 * 1000;  // 10 minutes stale → auto-close
const LISTING_MAX_AGE_MS = 4 * 60 * 60 * 1000;   // 4 hours absolute expiry

// ─── 1. Scheduled: Safety-Net Cleanup (every 5 minutes) ─────
//     Catches edge cases where onPresenceChange didn't fire
//     (e.g., RTDB timeout, crash without clean disconnect).
//     Reads RTDB presence to check host liveness instead of
//     storing heartbeat timestamps in Firestore.
exports.cleanupListings = onSchedule('every 5 minutes', async (event) => {
  const db = getFirestore();
  const rtdb = getDatabase();
  const now = Date.now();

  // Single query: all non-closed listings
  const activeDocs = await db.collection('listings')
    .where('status', 'in', ['open', 'pending', 'full', 'in_progress', 'stale'])
    .get();

  if (activeDocs.empty) return;

  const batch = db.batch();
  let staleCount = 0;
  let closedCount = 0;

  for (const doc of activeDocs.docs) {
    const data = doc.data();

    // --- Auto-close expired listings (age > 4h) ---
    const createdAt = data.createdAt?.toMillis?.() || 0;
    if (createdAt > 0 && (now - createdAt) > LISTING_MAX_AGE_MS) {
      batch.update(doc.ref, { status: 'closed' });
      closedCount++;
      continue; // already closing, skip stale check
    }

    // --- Auto-close stale listings (stale > 10 min) ---
    if (data.status === 'stale') {
      const staleSince = data.staleSince?.toMillis?.() || 0;
      if (staleSince > 0 && (now - staleSince) > AUTO_CLOSE_THRESHOLD_MS) {
        batch.update(doc.ref, { status: 'closed' });
        closedCount++;
      }
      continue; // already stale, skip stale check
    }

    // --- Check RTDB presence for active listings ---
    try {
      const presenceSnap = await rtdb.ref(`presence/${data.hostPlayer}`).get();
      const presence = presenceSnap.val();

      if (!presence || presence.online !== true) {
        // Host is offline — check how long ago the last heartbeat was
        const lastHB = presence?.lastHeartbeat || 0;
        if (lastHB > 0 && (now - lastHB) > STALE_THRESHOLD_MS) {
          batch.update(doc.ref, {
            status: 'stale',
            staleSince: FieldValue.serverTimestamp(),
          });
          staleCount++;
        }
      }
    } catch (e) {
      console.warn(`[Cleanup] Failed to read RTDB presence for ${data.hostPlayer}:`, e.message);
    }
  }

  if (staleCount > 0 || closedCount > 0) {
    await batch.commit();
    console.log(`[Cleanup] Marked ${staleCount} stale, ${closedCount} closed`);
  }
});

// ─── 2. RTDB Trigger: Online Status Change → Listing State ──
//     Triggers ONLY when /presence/{playerId}/online changes
//     (connect or disconnect), NOT on heartbeat writes.
//     This keeps Cloud Function invocations to ~2-10 per player per day.
exports.onPresenceChange = onValueWritten(
  { ref: '/presence/{playerId}/online', instance: 'default' },
  async (event) => {
    const playerId = event.params.playerId;
    const wasOnline = event.data.before.val();
    const isOnline = event.data.after.val();

    // No actual change — early exit (no cost beyond invocation)
    if (wasOnline === isOnline) return;

    const db = getFirestore();

    // Update Firestore player profile
    const playerRef = db.collection('players').doc(playerId);
    await playerRef.set({
      onlineStatus: isOnline ? 'online' : 'offline',
      lastSeen: FieldValue.serverTimestamp(),
    }, { merge: true });

    // Handle listing state based on presence
    const listingsQuery = await db.collection('listings')
      .where('hostPlayer', '==', playerId)
      .where('status', 'in', ['open', 'pending', 'full', 'in_progress', 'stale'])
      .limit(1)
      .get();

    if (listingsQuery.empty) return;

    const listingDoc = listingsQuery.docs[0];
    const listing = listingDoc.data();

    if (isOnline) {
      // --- Host reconnected: recover listing from stale ---
      if (listing.status === 'stale') {
        const requestsSnap = await db.collection('listingRequests')
          .where('listingId', '==', listingDoc.id)
          .where('status', 'in', ['accepted', 'invited', 'joined'])
          .get();

        const acceptedCount = requestsSnap.size;
        const totalFilled = 1 + acceptedCount;

        let newStatus;
        if (totalFilled >= listing.slotsTotal) {
          newStatus = 'full';
        } else if (acceptedCount > 0) {
          newStatus = 'pending';
        } else {
          newStatus = 'open';
        }

        await listingDoc.ref.update({ status: newStatus });
        console.log(`[Presence] Host ${playerId} reconnected → listing ${newStatus}`);
      }
      // If listing is already active, no Firestore write needed
    } else {
      // --- Host went offline: mark listing stale after grace period ---
      // The actual stale marking is done by the scheduled cleanup
      // to provide a grace period. But for clean disconnects we can
      // mark immediately since onDisconnect fired.
      await listingDoc.ref.update({
        status: 'stale',
        staleSince: FieldValue.serverTimestamp(),
      });
      console.log(`[Presence] Host ${playerId} disconnected → listing stale`);
    }
  }
);

// ─── 3. Game-Presence Validation Helper ─────────────────────
//     Calls the live Soulframe inventory API server-side with the
//     caller's (accountId, nonce). Only an in-game Overkot client
//     holds a live nonce, so this gates listing/request writes to
//     genuine players. Cached per (accountId, nonce) for 10 min
//     to keep API call volume sane.

const SOULFRAME_BASE = 'https://api.soulframe.com/api';
const SOULFRAME_HEADERS = {
  'User-Agent': 'Soulframe.x64.exe',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};
const NONCE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _nonceCache = new Map(); // key: `${accountId}|${nonce}` → expiresAt epoch ms

function _isAccountIdShape(s) {
  return typeof s === 'string' && /^[a-f0-9]{16,32}$/i.test(s);
}
function _isNonceShape(s) {
  return typeof s === 'string' && s.length >= 5 && s.length <= 40 && /^[A-Za-z0-9]+$/.test(s);
}

async function verifyGamePresence(accountId, nonce) {
  if (!_isAccountIdShape(accountId) || !_isNonceShape(nonce)) return false;

  const key = `${accountId}|${nonce}`;
  const cached = _nonceCache.get(key);
  const now = Date.now();
  if (cached && cached > now) return true;
  if (cached && cached <= now) _nonceCache.delete(key);

  // Opportunistic GC so the map never grows unbounded
  if (_nonceCache.size > 5000) {
    for (const [k, exp] of _nonceCache) if (exp <= now) _nonceCache.delete(k);
  }

  try {
    const url = `${SOULFRAME_BASE}/inventory.php?accountId=${encodeURIComponent(accountId)}&nonce=${encodeURIComponent(nonce)}&ct=MSI`;
    const res = await axios.get(url, {
      timeout: 8000,
      headers: SOULFRAME_HEADERS,
      transformResponse: [(d) => d],
      validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data) return false;
    const body = typeof res.data === 'string' ? res.data : String(res.data);
    if (body.includes('INVALID_NONCE') || body.includes('Log-in expired') || body.length <= 10) {
      return false;
    }
    _nonceCache.set(key, now + NONCE_CACHE_TTL_MS);
    return true;
  } catch (_) {
    return false;
  }
}

// ─── 4. Allowed value tables (must mirror client) ──────────
const ACTIVITY_TYPES = new Set([
  'Boss / Encounter', 'Farming / Repeats', 'Quest / Progression',
  'Exploration', 'Help / Teaching', 'General Grouping',
]);
const GOAL_TYPES = new Set([
  'Kill / Clear', 'Farm / Grind', 'Complete Quest',
  'Explore / Discover', 'Learn / Teach', 'Just Hanging Out', 'Other',
]);
const REQUIREMENT_KINDS = new Set(['none', 'preferred', 'required']);
const MAX_GROUP_SIZE = 4;
const LISTING_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function _str(v, max = 200) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// ─── 5. Callable: gfCreateListing ──────────────────────────
//     The only path through which a `listings` document can be
//     created. Validates the caller's live game session, then
//     writes the listing with admin SDK (bypasses rules).
exports.gfCreateListing = onCall(
  { region: 'us-central1', cors: true, maxInstances: 20 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = request.data || {};
    const accountId = _str(data.accountId, 64);
    const nonce = _str(data.nonce, 64);
    const displayName = _str(data.displayName, 64) || accountId.slice(0, 8);

    if (!accountId || !nonce) {
      throw new HttpsError('invalid-argument', 'Missing accountId or nonce.');
    }

    const ok = await verifyGamePresence(accountId, nonce);
    if (!ok) {
      throw new HttpsError('permission-denied', 'Live game session could not be verified.');
    }

    const db = getFirestore();

    // One active listing per accountId
    const existing = await db.collection('listings')
      .where('hostPlayer', '==', accountId)
      .where('status', 'in', ['open', 'pending', 'full', 'in_progress', 'stale'])
      .limit(1)
      .get();
    if (!existing.empty) {
      throw new HttpsError('already-exists', 'You already have an active listing.');
    }

    const activityType = ACTIVITY_TYPES.has(data.activityType) ? data.activityType : 'General Grouping';
    const goalType = GOAL_TYPES.has(data.goalType) ? data.goalType : 'Other';
    const slotsNeededRaw = Number(data.slotsNeeded);
    const slotsNeeded = Number.isFinite(slotsNeededRaw)
      ? Math.max(1, Math.min(Math.trunc(slotsNeededRaw), MAX_GROUP_SIZE - 1))
      : MAX_GROUP_SIZE - 1;
    const languageRequirement = REQUIREMENT_KINDS.has(data.languageRequirement) ? data.languageRequirement : 'none';
    const regionRequirement = REQUIREMENT_KINDS.has(data.regionRequirement) ? data.regionRequirement : 'none';

    const now = Date.now();
    const listingData = {
      hostPlayer: accountId,                 // forced from validated value
      hostDisplayName: displayName,
      createdByUid: request.auth.uid,        // pin to the auth identity
      activityType,
      goalType,
      slotsTotal: slotsNeeded + 1,           // +1 for host
      slotsFilled: 1,
      status: 'open',
      languageRequirement,
      languageValue: _str(data.languageValue, 32),
      regionRequirement,
      regionValue: _str(data.regionValue, 32),
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + LISTING_MAX_AGE_MS),
    };

    const ref = await db.collection('listings').add(listingData);
    return { id: ref.id, ...listingData, createdAt: now, expiresAt: now + LISTING_MAX_AGE_MS };
  }
);

// ─── 6. Callable: gfRequestJoin ────────────────────────────
//     Same validation gate for join requests so the bot can't
//     spam every host with fake join requests.
exports.gfRequestJoin = onCall(
  { region: 'us-central1', cors: true, maxInstances: 20 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = request.data || {};
    const accountId = _str(data.accountId, 64);
    const nonce = _str(data.nonce, 64);
    const displayName = _str(data.displayName, 64) || accountId.slice(0, 8);
    const listingId = _str(data.listingId, 64);

    if (!accountId || !nonce || !listingId) {
      throw new HttpsError('invalid-argument', 'Missing accountId, nonce, or listingId.');
    }

    const ok = await verifyGamePresence(accountId, nonce);
    if (!ok) {
      throw new HttpsError('permission-denied', 'Live game session could not be verified.');
    }

    const db = getFirestore();
    const listingRef = db.collection('listings').doc(listingId);
    const listingSnap = await listingRef.get();
    if (!listingSnap.exists) throw new HttpsError('not-found', 'Listing not found.');
    const listing = listingSnap.data();
    if (listing.hostPlayer === accountId) {
      throw new HttpsError('failed-precondition', 'Cannot request to join your own listing.');
    }
    if (listing.status !== 'open') {
      throw new HttpsError('failed-precondition', 'Listing is not open.');
    }

    const requestId = `${listingId}_${accountId}`;
    const requestData = {
      playerId: accountId,                   // forced from validated value
      playerDisplayName: displayName,
      requesterUid: request.auth.uid,        // pin to the auth identity
      listingId,
      status: 'pending',
      requestedAt: FieldValue.serverTimestamp(),
      respondedAt: null,
    };

    await db.collection('listingRequests').doc(requestId).set(requestData);
    return { id: requestId, ...requestData, requestedAt: Date.now() };
  }
);

