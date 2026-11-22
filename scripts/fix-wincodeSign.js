/**
 * fix-winCodeSign.js
 *
 * electron-builder downloads winCodeSign into a randomly-named numeric directory
 * (e.g. "628471747") but expects it at "winCodeSign-2.6.0". This script detects
 * the mismatch and renames it automatically before the build runs.
 */

const fs = require('fs');
const path = require('path');

const EXPECTED_NAME = 'winCodeSign-2.6.0';
const cacheDir = path.join(
  process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
  'electron-builder', 'Cache', 'winCodeSign'
);

if (!fs.existsSync(cacheDir)) {
  console.log('[fix-winCodeSign] Cache directory does not exist yet, skipping.');
  process.exit(0);
}

const expectedPath = path.join(cacheDir, EXPECTED_NAME);
if (fs.existsSync(expectedPath)) {
  console.log('[fix-winCodeSign] winCodeSign-2.6.0 already exists, nothing to do.');
  process.exit(0);
}

// Look for a numeric-named directory that contains the extracted winCodeSign files
const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
const candidate = entries.find(e => e.isDirectory() && /^\d+$/.test(e.name));

if (!candidate) {
  console.log('[fix-winCodeSign] No randomly-named directory found, skipping.');
  process.exit(0);
}

const srcPath = path.join(cacheDir, candidate.name);
console.log(`[fix-winCodeSign] Renaming "${candidate.name}" -> "${EXPECTED_NAME}"`);
fs.renameSync(srcPath, expectedPath);
console.log('[fix-winCodeSign] Done.');
