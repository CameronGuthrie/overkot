const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createHash } = require('node:crypto');
const { validateBatch } = require('./events');

initializeApp();
const apiSecret = defineSecret('GA_API_SECRET');
const MEASUREMENT_ID = 'G-K06RMTHN3P';
const hash = value => createHash('sha256').update(value).digest('hex');
const WINDOW_MS = 60_000;
const MAX_BATCHES_PER_INSTANCE = 60;
const admissions = [];

// Protect Firestore before opening a transaction, regardless of the sender's
// identity. A warm worker admits at most 60 valid requests in a rolling minute.
function reserveDatabaseWork(now) {
  while (admissions.length && admissions[0] <= now - WINDOW_MS) admissions.shift();
  if (admissions.length >= MAX_BATCHES_PER_INSTANCE) {
    throw new HttpsError('resource-exhausted', 'Try again later.');
  }
  admissions.push(now);
}

exports.collectUsage = onCall({ region: 'europe-west2', secrets: [apiSecret],
  invoker: 'public', maxInstances: 2, concurrency: 20, timeoutSeconds: 30, memory: '256MiB' }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before sending usage.');
  if ((request.rawRequest.rawBody?.length ?? JSON.stringify(request.data || {}).length) > 16_384) {
    throw new HttpsError('invalid-argument', 'Batch too large.');
  }
  const now = Date.now(), payload = validateBatch(request.data, now);
  if (!payload) throw new HttpsError('invalid-argument', 'Invalid usage batch.');
  reserveDatabaseWork(now);
  const db = getFirestore(), bucket = Math.floor(now / WINDOW_MS);
  const receipt = db.doc(`usageReceipts/${hash(request.data.client_id + ':' + request.data.batch_id)}`);
  // Aggregate counters only; no raw IPs, game identities or usage payloads in Firestore.
  const limits = [
    [hash(`client:${request.data.client_id}:${bucket}`), 4],
    [hash(`uid:${request.auth.uid}:${bucket}`), 4],
    [hash(`ip:${request.rawRequest.ip}:${bucket}`), 120],
  ].map(([key, max]) => ({ ref: db.doc(`usageLimits/${key}`), max }));
  const accepted = await db.runTransaction(async tx => {
    const saved = await tx.get(receipt);
    if (saved.exists && saved.data().status === 'sent') return false;
    if (saved.exists && saved.data().lockedUntil > now) throw new HttpsError('resource-exhausted', 'Batch already in progress.');
    const counts = await Promise.all(limits.map(item => tx.get(item.ref)));
    if (counts.some((snapshot, i) => (snapshot.data()?.count || 0) >= limits[i].max)) {
      throw new HttpsError('resource-exhausted', 'Try again later.');
    }
    limits.forEach((item, i) => tx.set(item.ref, { count: (counts[i].data()?.count || 0) + 1,
      expiresAt: Timestamp.fromMillis(now + 24 * 3600_000) }));
    tx.set(receipt, { status: 'pending', lockedUntil: now + 30_000, expiresAt: Timestamp.fromMillis(now + 72 * 3600_000) });
    return true;
  });
  if (!accepted) return { accepted: true };
  try {
    const url = new URL('https://region1.google-analytics.com/mp/collect');
    url.searchParams.set('measurement_id', MEASUREMENT_ID);
    url.searchParams.set('api_secret', apiSecret.value());
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) throw new Error('GA request failed');
    await receipt.update({ status: 'sent', lockedUntil: 0 });
    return { accepted: true };
  } catch {
    // Never log the request URL: it contains the GA secret.
    throw new HttpsError('unavailable', 'Usage delivery will retry.');
  }
});
