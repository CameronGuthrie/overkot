'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

// Firebase Auth's persistence adapter stores its refresh credential in the main
// process. Never fall back to writing it unencrypted on headless Linux.
function createGroupFinderPersistence({ directory, safeStorage }) {
  const folder = path.join(directory, 'group-finder-auth');
  const memory = new Map();
  const filename = key => path.join(folder, createHash('sha256').update(key).digest('hex') + '.bin');
  return class GroupFinderPersistence {
    static type = 'LOCAL';
    type = 'LOCAL';
    // Firebase instantiates this after app readiness. Keep the choice fixed for
    // this session so a locked keyring cannot overwrite a saved identity.
    durable = Boolean(safeStorage?.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text'));
    async _isAvailable() { return true; }
    async _set(key, value) {
      if (!this.durable) { memory.set(key, value); return; }
      const bytes = safeStorage.encryptString(JSON.stringify(value));
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const dest = filename(key), tmp = dest + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
        await fs.rename(tmp, dest);
        memory.delete(key);
      } finally { await fs.rm(tmp, { force: true }); }
    }
    async _get(key) {
      if (memory.has(key)) return memory.get(key);
      if (!this.durable) return null;
      try { return JSON.parse(safeStorage.decryptString(await fs.readFile(filename(key)))); }
      catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    }
    async _remove(key) {
      memory.delete(key);
      if (this.durable) await fs.rm(filename(key), { force: true });
    }
    // Overkot has one main process and owns the only writer for this store.
    _addListener() {}
    _removeListener() {}
  };
}

module.exports = { createGroupFinderPersistence };
