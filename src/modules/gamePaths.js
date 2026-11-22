'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Resolves only the current user's game files; no log or image contents are read. */
function createGamePathResolver({ getConfig = () => ({}), picturesPath = '', env = process.env,
  home = os.homedir(), platform = os.platform(), fsImpl = fs } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const clean = value => typeof value === 'string' ? value.trim() : '';
  const absolute = value => paths.isAbsolute(value) && !/[\u0000-\u001f]/.test(value)
    && (platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value))
    && !/^\\\\[?.]\\/.test(value);
  const unique = values => [...new Map(values.filter(Boolean).map(value => [platform === 'win32' ? value.toLowerCase() : value, value])).values()];
  const join = (root, ...parts) => clean(root) && absolute(root) ? paths.join(root, ...parts) : '';
  const readable = (filename, directory) => {
    if (!filename || !absolute(filename)) return false;
    try {
      const stat = fsImpl.statSync(filename);
      if (directory ? !stat.isDirectory() : !stat.isFile()) return false;
      fsImpl.accessSync(filename, fs.constants.R_OK);
      return true;
    } catch { return false; }
  };
  const override = key => clean(getConfig()?.[key]);
  function logCandidates() {
    const custom = override('eeLogPath');
    if (custom) return absolute(custom) && paths.basename(custom).toLowerCase() === 'ee.log' ? [custom] : [];
    if (platform === 'win32') {
      const user = clean(env.USERPROFILE) || home;
      return unique([join(env.LOCALAPPDATA, 'Soulframe', 'EE.log'),
        join(user, 'AppData', 'Local', 'Soulframe', 'EE.log'), join(user, 'Documents', 'Soulframe', 'EE.log'),
        join(env.APPDATA, 'Soulframe', 'EE.log')]);
    }
    // There is no verified native macOS game layout. Explicit overrides still
    // allow users to select logs from their own compatibility environment.
    if (platform !== 'linux') return [];
    const result = [join(home, '.local', 'share', 'Soulframe', 'EE.log')];
    const username = clean(env.USER) || paths.basename(home);
    result.push(join(home, '.wine', 'drive_c', 'users', username, 'AppData', 'Local', 'Soulframe', 'EE.log'));
    for (const steam of [join(home, '.steam', 'steam', 'steamapps', 'compatdata'), join(home, '.local', 'share', 'Steam', 'steamapps', 'compatdata')]) {
      try {
        for (const id of fsImpl.readdirSync(steam).filter(value => /^\d+$/.test(value))) {
          result.push(join(steam, id, 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Soulframe', 'EE.log'));
        }
      } catch { /* Steam/Proton need not be installed. */ }
    }
    return unique(result);
  }
  function screenshotCandidates() {
    const custom = override('screenshotDir');
    if (custom) return absolute(custom) ? [custom] : [];
    const nativePictures = typeof picturesPath === 'function' ? picturesPath() : picturesPath;
    const user = clean(env.USERPROFILE) || home;
    // The Windows Known Folder path takes priority over conventional locations.
    return unique([join(nativePictures, 'Soulframe'), join(env.OneDrive, 'Pictures', 'Soulframe'),
      join(env.OneDriveConsumer, 'Pictures', 'Soulframe'), join(env.OneDriveCommercial, 'Pictures', 'Soulframe'),
      join(user, 'Pictures', 'Soulframe'), join(home, 'Pictures', 'Soulframe'), join(user, 'OneDrive', 'Pictures', 'Soulframe')]);
  }
  function status() {
    const logs = logCandidates(), directories = screenshotCandidates();
    const log = logs.find(filename => readable(filename, false)) || null;
    const screenshots = directories.filter(filename => readable(filename, true));
    return {
      eeLog: { override: override('eeLogPath'), path: log, found: !!log, candidates: logs },
      screenshots: { override: override('screenshotDir'), path: screenshots[0] || null,
        paths: screenshots, found: screenshots.length > 0, candidates: directories },
    };
  }
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Choose a game file or screenshot folder.' };
    const values = {};
    for (const field of ['eeLogPath', 'screenshotDir']) {
      if (!Object.hasOwn(input, field)) continue;
      if (typeof input[field] !== 'string' || input[field].length > 32767 || /[\u0000-\u001f]/.test(input[field])) {
        return { ok: false, message: 'Choose a valid absolute path.', field };
      }
      const value = clean(input[field]);
      if (!value) { values[field] = ''; continue; }
      if (!absolute(value)) return { ok: false, message: 'Choose a complete file or folder path.', field };
      const normalized = paths.normalize(value);
      if (field === 'eeLogPath' && paths.basename(normalized).toLowerCase() !== 'ee.log') {
        return { ok: false, message: 'Choose Soulframe’s EE.log file.', field };
      }
      if (!readable(normalized, field === 'screenshotDir')) {
        return { ok: false, message: field === 'eeLogPath' ? 'The EE.log file is missing or cannot be read.' : 'The screenshot folder is missing or cannot be read.', field };
      }
      values[field] = normalized;
    }
    return { ok: true, values };
  }
  return { logCandidates, screenshotCandidates, status, validate };
}

let sharedResolver = createGamePathResolver();
function setGamePathResolver(resolver) {
  if (!resolver || !['logCandidates', 'screenshotCandidates', 'status', 'validate'].every(key => typeof resolver[key] === 'function')) {
    throw new TypeError('A complete game path resolver is required.');
  }
  sharedResolver = resolver;
}
function getGamePathResolver() { return sharedResolver; }

module.exports = { createGamePathResolver, setGamePathResolver, getGamePathResolver };
