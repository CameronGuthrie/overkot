const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { createGroupFinderPersistence } = require('../src/modules/groupFinderAuthStore');

function testKeyring() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test_keyring',
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(ciphertext) {
      const cipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
      cipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([cipher.update(ciphertext.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

async function directoryFor(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overkot-group-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('encrypted Group Finder sessions survive restarts, separate profile keys, and stay intact with a locked keyring', async t => {
  const directory = await directoryFor(t);
  const safeStorage = testKeyring();
  const store = () => new (createGroupFinderPersistence({ directory, safeStorage }))();
  await store()._set('profile-a', { session: 'test-session-value' });
  const locked = new (createGroupFinderPersistence({
    directory, safeStorage: { isEncryptionAvailable: () => false },
  }))();
  await locked._set('profile-a', { session: 'temporary' });
  assert.deepEqual(await locked._get('profile-a'), { session: 'temporary' });
  await locked._remove('profile-a');
  assert.deepEqual(await store()._get('profile-a'), { session: 'test-session-value' });
  assert.equal(await store()._get('profile-b'), null);
  const folder = path.join(directory, 'group-finder-auth');
  const files = await fs.readdir(folder);
  assert.equal(files.length, 1);
  assert.equal((await fs.readFile(path.join(folder, files[0]))).includes('test-session-value'), false);
  await store()._remove('profile-a');
  assert.equal(await store()._get('profile-a'), null);
});

test('Firebase Auth restores the same owner after restart and assigns different owners to different profiles', {
  skip: !process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.GCLOUD_PROJECT !== 'demo-overkot-rules'
    && 'run with the local Firebase Auth emulator',
}, async t => {
  const endpoint = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  assert.match(endpoint, /^127\.0\.0\.1:\d+$/);
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-overkot-rules');
  const { initializeApp, deleteApp } = require('firebase/app');
  const { initializeAuth, connectAuthEmulator, signInAnonymously } = require('firebase/auth');
  const directory = await directoryFor(t);
  const safeStorage = testKeyring();
  const options = { apiKey: 'demo-emulator-only', projectId: 'demo-overkot-rules' };
  async function signIn(name) {
    const app = initializeApp(options, name);
    try {
      const auth = initializeAuth(app, { persistence: createGroupFinderPersistence({ directory, safeStorage }) });
      connectAuthEmulator(auth, 'http://' + endpoint, { disableWarnings: true });
      await auth.authStateReady();
      const restored = Boolean(auth.currentUser);
      const user = auth.currentUser || (await signInAnonymously(auth)).user;
      await user.getIdToken(true);
      return { uid: user.uid, restored };
    } finally {
      await deleteApp(app);
    }
  }
  const first = await signIn('profile-a');
  assert.equal(first.restored, false);
  const second = await signIn('profile-b');
  assert.notEqual(second.uid, first.uid);
  assert.deepEqual(await signIn('profile-a'), { uid: first.uid, restored: true });
});
