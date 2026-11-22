/**
 * Firebase Configuration & Initialization
 * 
 * Hybrid setup:
 *   - Realtime Database → owners' live presence
 *   - Firestore         → listings, join requests, player profiles
 * 
 * ─── SETUP INSTRUCTIONS ──────────────────────────────────────
 * 1. Create a Firebase project at https://console.firebase.google.com
 * 2. Enable Anonymous Authentication (Auth → Sign-in method → Anonymous)
 * 3. Create a Realtime Database (Build → Realtime Database)
 * 4. Create a Firestore Database (Build → Firestore Database)
 * 5. Copy your web app config from Project Settings → General → Your apps
 * 6. Set groupFirebase in the build's service configuration file
 * ──────────────────────────────────────────────────────────────
 */

const { createHash } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { createGroupFinderPersistence } = require('./groupFinderAuthStore');
const { initializeAuth, signInAnonymously, inMemoryPersistence } = require('firebase/auth');
const {
  getDatabase, ref, set, get, update, remove,
  onValue, onDisconnect, serverTimestamp: rtdbServerTimestamp,
  push, child,
} = require('firebase/database');
const {
  getFirestore, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  serverTimestamp: firestoreServerTimestamp, Timestamp,
  addDoc, writeBatch, runTransaction,
} = require('firebase/firestore');

const FIREBASE_CONFIG = require('./serviceConfig').services.groupFirebase;

// ─── Validate config before initializing ─────────────────────
function isConfigured() {
  return !!FIREBASE_CONFIG?.apiKey &&
         FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY' &&
         FIREBASE_CONFIG.projectId &&
         FIREBASE_CONFIG.projectId !== 'YOUR_PROJECT_ID';
}

/**
 * Returns true only if Firebase has been fully initialized (app + auth + RTDB + Firestore).
 * Use this to guard operations that need live Firebase instances.
 */
function isInitialized() {
  return app !== null && firestore !== null && rtdb !== null;
}

// ─── Singleton instances ─────────────────────────────────────
let app = null;
let auth = null;
let rtdb = null;
let firestore = null;
let persistence = inMemoryPersistence;
let initialization = Promise.resolve();
let _debug = false;

function configureAuthStorage(options) {
  persistence = createGroupFinderPersistence(options);
}

function initializeFirebase(localAccountId) {
  if (!isConfigured() || !/^[a-f0-9]{24}$/i.test(localAccountId || '')) return Promise.resolve(null);
  const profile = createHash('sha256').update(localAccountId.toLowerCase()).digest('hex');
  const name = 'group-finder-' + profile;
  const next = initialization.then(async () => {
    if (app && app.name !== name) {
      const previous = app;
      app = null; auth = null; rtdb = null; firestore = null;
      await deleteApp(previous);
    }
    if (!app) {
      const nextApp = initializeApp(FIREBASE_CONFIG, name);
      try {
        auth = initializeAuth(nextApp, { persistence });
        rtdb = getDatabase(nextApp);
        firestore = getFirestore(nextApp);
        app = nextApp;
      } catch (error) {
        auth = null; rtdb = null; firestore = null;
        await deleteApp(nextApp);
        throw error;
      }
    }
    await auth.authStateReady();
    if (auth.currentUser) return auth.currentUser;
    return (await signInAnonymously(auth)).user;
  });
  initialization = next.catch(error => {
    if (_debug) console.warn('[GroupFinder] Could not sign in:', error.code || 'unavailable');
    return null;
  });
  return initialization;
}

function getAuthInstance() { return auth; }
function getRTDB() { return rtdb; }
function getFirestoreInstance() { return firestore; }

module.exports = {
  FIREBASE_CONFIG,
  isConfigured,
  isInitialized,
  configureAuthStorage,
  initializeFirebase,
  setDebug: (v) => { _debug = v; },
  getAuthInstance,
  getRTDB,
  getFirestoreInstance,
  // Re-export Firebase functions for convenience
  ref, set, get, update, remove, onValue, onDisconnect,
  rtdbServerTimestamp, push, child,
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  firestoreServerTimestamp, Timestamp, addDoc, writeBatch, runTransaction,
};
