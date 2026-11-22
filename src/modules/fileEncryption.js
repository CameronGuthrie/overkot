/**
 * Shared file encryption utilities – AES-256-GCM with a machine-derived key.
 * Files encrypted with these helpers are only decryptable on the same machine.
 *
 * Used for: lang/*.json, cache/*.json, config.json, inventory-cache.json
 */

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const APP_SALT = 'Overkot-v1';

/** Cached key so we only derive once per process */
let _cachedKey = null;

/**
 * Derive a 256-bit key from stable machine identifiers.
 * @returns {Buffer}
 */
function deriveCacheKey() {
  if (_cachedKey) return _cachedKey;
  const machineId = [
    os.hostname(),
    os.homedir(),
    os.platform(),
    os.arch(),
    (os.cpus()[0] || {}).model || '',
  ].join('|');
  _cachedKey = crypto.scryptSync(`${APP_SALT}:${machineId}`, APP_SALT, 32);
  return _cachedKey;
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 * Returns a Buffer: IV (12) + AuthTag (16) + Ciphertext.
 * @param {string} plaintext
 * @param {Buffer} key
 * @returns {Buffer}
 */
function encryptData(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a packed buffer produced by encryptData().
 * @param {Buffer} packed
 * @param {Buffer} key
 * @returns {string|null} – plaintext or null on failure
 */
function decryptData(packed, key) {
  if (!Buffer.isBuffer(packed) || packed.length < 28) return null;
  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

/**
 * Write a JSON-serializable value to disk as an encrypted binary file.
 * @param {string} filePath
 * @param {*} data – any JSON-serializable value
 */
function writeEncryptedJSON(filePath, data) {
  const plaintext = JSON.stringify(data);
  const encrypted = encryptData(plaintext, deriveCacheKey());
  fs.writeFileSync(filePath, encrypted);
}

/**
 * Read an encrypted JSON file from disk.
 * If the file is still plaintext JSON (pre-migration), it will be
 * transparently re-encrypted and saved back.
 *
 * @param {string} filePath
 * @returns {*} – parsed JSON value, or null if file missing / corrupt
 */
function readEncryptedJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath);

  // Try decrypting first (expected path)
  try {
    const plaintext = decryptData(raw, deriveCacheKey());
    if (plaintext !== null) return JSON.parse(plaintext);
  } catch { /* not encrypted or wrong key – fall through */ }

  // Fallback: try reading as plain-text JSON (migration from unencrypted)
  try {
    const text = raw.toString('utf-8');
    const data = JSON.parse(text);
    // Re-save encrypted for next time
    try { writeEncryptedJSON(filePath, data); } catch { /* best effort */ }
    return data;
  } catch { /* truly corrupt */ }

  return null;
}

/**
 * Write a plain string to disk as an encrypted binary file.
 * @param {string} filePath
 * @param {string} text
 */
function writeEncryptedText(filePath, text) {
  const encrypted = encryptData(text, deriveCacheKey());
  fs.writeFileSync(filePath, encrypted);
}

/**
 * Read an encrypted text file from disk.
 * Falls back to plain-text if not yet encrypted (migration).
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readEncryptedText(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath);

  // Try decrypting first
  try {
    const plaintext = decryptData(raw, deriveCacheKey());
    if (plaintext !== null) return plaintext;
  } catch { /* fall through */ }

  // Fallback: plain-text migration
  try {
    const text = raw.toString('utf-8');
    // Verify it's valid text, then re-encrypt
    try { writeEncryptedText(filePath, text); } catch { /* best effort */ }
    return text;
  } catch { /* corrupt */ }

  return null;
}

module.exports = {
  deriveCacheKey,
  encryptData,
  decryptData,
  writeEncryptedJSON,
  readEncryptedJSON,
  writeEncryptedText,
  readEncryptedText,
};
