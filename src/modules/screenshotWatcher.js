'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getGamePathResolver } = require('./gamePaths');
const SCREENSHOT_NAME = /^Soulframe\d+\.jpg$/i;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** Read a bounded JPEG COM segment; malformed/incomplete images are retained. */
function readJpegComment(filePath, fsImpl = fs) {
  try {
    const stat = fsImpl.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = fsImpl.readFileSync(filePath);
    if (bytes.length < 4 || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
    let offset = 2;
    while (offset < bytes.length - 1) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) return null;
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (marker === 0xfe) return bytes.subarray(offset + 2, offset + length).toString('utf8');
      offset += length;
    }
  } catch { /* Image may still be writing, removed, or inaccessible. */ }
  return null;
}

function parseMetadata(comment) {
  if (typeof comment !== 'string' || !comment.trimStart().startsWith('/SF/Levels/')) return null;
  const zone = /\bZ:\s*(\/SF\/Levels\/\S+)/.exec(comment)?.[1];
  const number = '([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)';
  const positionMatch = new RegExp(`\\bP:\\s*${number}\\s*,\\s*${number}\\s*,\\s*${number}(?=\\s|$)`).exec(comment);
  const headingMatch = new RegExp(`\\bH:\\s*${number}(?=\\s|$)`).exec(comment);
  if (!zone || !positionMatch || !headingMatch) return null;
  const [x, y, z] = positionMatch.slice(1).map(Number);
  const heading = Number(headingMatch[1]);
  if (![x, y, z, heading].every(Number.isFinite)) return null;
  return { zone, position: { x, y, z }, heading, isOverworld: zone.includes('MidrathRedux') };
}

function createScreenshotWatcher({ resolver = () => getGamePathResolver(), fsImpl = fs,
  settleDelayMs = 500, timeoutMs = 60000, maxAttempts = 6 } = {}) {
  let currentResolver = resolver, watchers = [], watchTimer = null, callback = null;
  let generation = 0, watching = false, lastLocation = null, signature = '';
  const pending = new Map();
  const resolve = () => typeof currentResolver === 'function' ? currentResolver() : currentResolver;
  const activeDirectories = () => resolve().status().screenshots.paths.map(directory => path.resolve(directory));
  const currentSignature = () => activeDirectories().join('\0');

  function stopWatching() {
    generation++; watching = false;
    for (const watcher of watchers) { try { watcher.close(); } catch {} }
    watchers = [];
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    for (const timeout of pending.values()) clearTimeout(timeout);
    pending.clear();
  }
  function deliver(result) { if (typeof callback === 'function') { try { callback(result); } catch {} } }
  function startWatching() {
    stopWatching();
    let dirs;
    try { dirs = activeDirectories(); } catch { dirs = []; }
    if (!dirs.length) return { status: 'error', message: 'Soulframe’s screenshot folder was not found. Take a screenshot in game, then choose its folder in Settings.' };
    const epoch = generation;
    signature = dirs.join('\0');
    const baselines = new Map(), realDirs = new Map();
    try {
      for (const dir of dirs) {
        baselines.set(dir, new Set(fsImpl.readdirSync(dir).filter(filename => SCREENSHOT_NAME.test(filename)).map(filename => filename.toLowerCase())));
        realDirs.set(dir, fsImpl.realpathSync(dir));
      }
    } catch {
      return { status: 'error', message: 'The screenshot folder cannot be read. Choose an accessible folder in Settings.' };
    }
    watching = true;
    const stillCurrent = () => {
      if (!watching || generation !== epoch) return false;
      try {
        if (currentSignature() !== signature) { stopWatching(); return false; }
      } catch { stopWatching(); return false; }
      return true;
    };
    function handleFile(dir, rawName, attempt = 0) {
      const filename = Buffer.isBuffer(rawName) ? rawName.toString('utf8') : rawName;
      if (!stillCurrent() || typeof filename !== 'string' || !SCREENSHOT_NAME.test(filename)) return;
      if (baselines.get(dir).has(filename.toLowerCase())) return;
      const fullPath = path.resolve(dir, filename);
      if (path.dirname(fullPath) !== dir || pending.has(fullPath)) return;
      const timeout = setTimeout(() => {
        pending.delete(fullPath);
        if (!stillCurrent()) return;
        try {
          // A replacement/symlink must not turn this selected directory into
          // access to another directory between notification and processing.
          if (fsImpl.realpathSync(dir) !== realDirs.get(dir)) { stopWatching(); return; }
          const before = fsImpl.lstatSync(fullPath);
          if (!before.isFile() || before.isSymbolicLink()) return;
          const meta = parseMetadata(readJpegComment(fullPath, fsImpl));
          if (!meta) {
            if (attempt + 1 < maxAttempts) handleFile(dir, filename, attempt + 1);
            return;
          }
          const after = fsImpl.lstatSync(fullPath);
          if (!stillCurrent() || after.isSymbolicLink() || !after.isFile()
            || ['dev', 'ino', 'size', 'mtimeMs', 'birthtimeMs'].some(key => before[key] !== after[key])) return;
          // Only a newly observed, successfully parsed game-location capture
          // can be removed. Existing and unrecognised images are never deleted.
          try { fsImpl.unlinkSync(fullPath); } catch { /* Location remains useful if cleanup is denied. */ }
          stopWatching();
          lastLocation = { status: 'found', ...meta };
          deliver(lastLocation);
        } catch { /* Files can disappear or still be in use while being written. */ }
      }, settleDelayMs);
      pending.set(fullPath, timeout);
    }
    try {
      for (const dir of dirs) {
        const watcher = fsImpl.watch(dir, (_event, filename) => handleFile(dir, filename));
        watcher.on?.('error', () => {
          if (!stillCurrent()) return;
          stopWatching();
          deliver({ status: 'error', message: 'The screenshot folder became unavailable. Check its location in Settings.' });
        });
        watchers.push(watcher);
        // Cover files created after the baseline but before fs.watch attached.
        for (const filename of fsImpl.readdirSync(dir)) handleFile(dir, filename);
      }
      watchTimer = setTimeout(() => {
        if (!stillCurrent()) return;
        stopWatching();
        deliver({ status: 'timeout', message: 'No location screenshot detected — press F6 in Soulframe or check the screenshot folder in Settings.' });
      }, timeoutMs);
      return { status: 'watching' };
    } catch {
      stopWatching();
      return { status: 'error', message: 'Cannot watch the screenshot folder. Choose an accessible folder in Settings.' };
    }
  }
  function setResolver(value) { stopWatching(); currentResolver = value; lastLocation = null; }
  return { startWatching, stopWatching, setResolver,
    onResult: value => { callback = value; }, getLastLocation: () => lastLocation };
}

const watcher = createScreenshotWatcher();
module.exports = { ...watcher, configureScreenshotPaths: watcher.setResolver, createScreenshotWatcher, readJpegComment, parseMetadata };
