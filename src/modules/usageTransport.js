const { initializeApp } = require('firebase/app');
const { getAuth, signInAnonymously } = require('firebase/auth');
const { getFunctions, httpsCallable } = require('firebase/functions');

// Public Firebase app configuration. GA's Measurement Protocol secret is server-only.
const FIREBASE_CONFIG = require('./serviceConfig').services.usageFirebase;
let app, signingIn;
async function sendUsage(batch) {
  if (!FIREBASE_CONFIG) return;
  app ||= initializeApp(FIREBASE_CONFIG, 'overkot-usage');
  const auth = getAuth(app);
  if (!auth.currentUser) {
    signingIn ||= signInAnonymously(auth).finally(() => { signingIn = null; });
    await signingIn;
  }
  const result = await httpsCallable(getFunctions(app, 'europe-west2'), 'collectUsage', { timeout: 15_000 })(batch);
  if (!result.data?.accepted) throw new Error('Usage batch was not accepted');
}
module.exports = { sendUsage, FIREBASE_CONFIG };
