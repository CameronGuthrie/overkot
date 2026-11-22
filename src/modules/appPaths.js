/**
 * Centralized application paths – everything lives under a single directory.
 *
 * Windows: %LOCALAPPDATA%/Overkot/
 * Linux:   $XDG_DATA_HOME/Overkot/ (defaults to ~/.local/share/Overkot/)
 * macOS:   ~/Library/Application Support/Overkot/
 *
 * Directory layout:
 *   config.json              – user preferences
 *   bin/                     – native helper binaries
 *   lang/                    – downloaded language JSON files from GitHub
 *   cache/                   – derived name maps and inventory cache
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Resolve native application storage without depending on the current directory. */
function resolveAppDirectory({ platform = os.platform(), home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Overkot');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Overkot');
  const dataHome = typeof env.XDG_DATA_HOME === 'string' && path.posix.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : path.posix.join(home, '.local', 'share');
  return path.posix.join(dataHome, 'Overkot');
}

/** Root application data directory */
const APP_DIR = resolveAppDirectory();

/** Subdirectories */
const SCANNER_DIR = path.join(APP_DIR, 'bin');
const LANG_DIR = path.join(APP_DIR, 'lang');
const CACHE_DIR = path.join(APP_DIR, 'cache');

/** Key file paths */
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const INVENTORY_CACHE_PATH = path.join(CACHE_DIR, 'inventory-cache.json');

/** Ensure all directories exist */
function ensureDirectories() {
  for (const dir of [APP_DIR, SCANNER_DIR, LANG_DIR, CACHE_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      // Ignore – directory may already exist or be on a read-only FS
    }
  }
}

// Create directories on first import
ensureDirectories();

module.exports = {
  APP_DIR,
  SCANNER_DIR,
  LANG_DIR,
  CACHE_DIR,
  CONFIG_PATH,
  INVENTORY_CACHE_PATH,
  resolveAppDirectory,
  ensureDirectories,
};
