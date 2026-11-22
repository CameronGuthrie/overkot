'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateRoot, validateMatrix } = require('./dungeonRootAlignment');
const { normalizeWorldDropsMessage } = require('./worldDrops');

const HELPER = 'overkot-position-reader.exe';
const LINUX_HELPER = 'overkot-position-reader';
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6;
const vector = value => value && ['x', 'y', 'z'].every(key => finite(value[key]));
const STATUSES = new Set(['searching', 'tracking', 'unsupported-build', 'profile-mismatch', 'process-gone',
  'permission-denied', 'wrong-process', 'not-found', 'unavailable', 'scan-failed', 'scan-incomplete', 'ambiguous', 'invalid-arguments']);
const TERMINAL_STATUSES = new Set([...STATUSES].filter(status => !['searching', 'tracking'].includes(status)));
const MAX_LINE_BYTES = 32768;
const MAX_CARRY_BYTES = 131072;
const MAX_DUNGEON_ROOTS = 32;
const MAX_DUNGEON_FRAMES = 64;

function validatedRoots(value, legacy) {
  const roots = Array.isArray(value) && value.length <= MAX_DUNGEON_ROOTS ? value.map(validateRoot).filter(Boolean) : null;
  const byPath = new Map(), conflicts = new Set();
  for (const root of [...(roots || []), ...(legacy ? [legacy] : [])]) {
    if (conflicts.has(root.levelPath)) continue;
    const previous = byPath.get(root.levelPath);
    if (previous && (previous.layoutCode !== root.layoutCode || previous.matrix.some((number, index) => number !== root.matrix[index]))) {
      byPath.delete(root.levelPath); conflicts.add(root.levelPath);
    } else if (!previous) byPath.set(root.levelPath, root);
  }
  return { single: legacy && !conflicts.has(legacy.levelPath) ? legacy : null,
    multiple: roots ? [...new Set(roots.map(root => root.levelPath))].filter(level => byPath.has(level)).map(level => byPath.get(level)) : null };
}

function helperPath({ resourcesPath = process.resourcesPath, defaultApp = process.defaultApp,
  exists = fs.existsSync, root = path.resolve(__dirname, '..', '..'), platform = process.platform } = {}) {
  const name = platform === 'linux' ? LINUX_HELPER : HELPER;
  if (resourcesPath && !defaultApp) return path.join(resourcesPath, 'bin', name);
  const development = path.join(root, '.build', 'bin', name);
  try { if (exists(development)) return development; } catch { /* Fall back to the checked asset location. */ }
  return path.join(root, 'assets', 'bin', name);
}

function parseMessage(line, now = Date.now()) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
  let value; try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'status' && STATUSES.has(value.status)) {
    const start = typeof value.processStartUtcTicks === 'string' && /^[1-9]\d{0,18}$/.test(value.processStartUtcTicks)
      && BigInt(value.processStartUtcTicks) <= 3155378975999999999n ? value.processStartUtcTicks : null;
    const hash = typeof value.moduleHash === 'string' && /^[a-f0-9]{64}$/.test(value.moduleHash) ? value.moduleHash : null;
    return { type: 'status', status: value.status, processStartUtcTicks: start, moduleHash: hash };
  }
  if (value.type === 'world-drops') return normalizeWorldDropsMessage(value, now);
  if (value.type !== 'pose' || value.source !== 'memory' || !vector(value.position)
    || !Number.isSafeInteger(value.timestamp) || value.timestamp <= 0
    || !Number.isSafeInteger(now) || value.timestamp > now + 1000 || value.timestamp < now - 2000) return null;
  // Unknown orientation remains unknown; never manufacture facing from velocity.
  if (value.heading !== null && (typeof value.heading !== 'number' || !Number.isFinite(value.heading) || Math.abs(value.heading) > 360)) return null;
  const heading = value.heading === null ? null : ((value.heading % 360) + 360) % 360;
  // A missing or malformed optional dungeon root never invalidates a verified
  // world pose. Only the strict shared validator may add map-alignment data.
  // A packet using final room-frame telemetry cannot fall back to an earlier
  // loading-slot transform, including when its optional cloud is rejected.
  const hasFrames = Object.hasOwn(value, 'dungeonFrames');
  const { single: dungeonRoot, multiple: dungeonRoots } = hasFrames ? { single: null, multiple: null }
    : validatedRoots(value.dungeonRoots, validateRoot(value.dungeonRoot));
  let dungeonFrames = null;
  const capturedAt = value.dungeonFramesTimestamp;
  if (Array.isArray(value.dungeonFrames) && value.dungeonFrames.length <= MAX_DUNGEON_FRAMES
    && Number.isSafeInteger(capturedAt) && capturedAt > 0 && capturedAt <= now && capturedAt >= now - 2000
    && capturedAt <= value.timestamp + 100 && capturedAt >= value.timestamp - 2000) {
    const unique = new Map();
    for (const frame of value.dungeonFrames) {
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.source !== 'level-info') continue;
      const matrix = validateMatrix(frame.matrix);
      if (matrix) unique.set(JSON.stringify(matrix), { source: 'level-info', matrix });
    }
    dungeonFrames = [...unique.values()];
  }
  return { type: 'pose', source: 'memory', sampledAt: value.timestamp,
    position: { x: value.position.x, y: value.position.y, z: value.position.z }, heading,
    ...(dungeonRoot ? { dungeonRoot } : {}), ...(dungeonRoots ? { dungeonRoots } : {}),
    ...(dungeonFrames ? { dungeonFrames, dungeonFramesTimestamp: capturedAt } : {}) };
}

class PlayerMemoryReader extends EventEmitter {
  constructor({ executable, spawnImpl = spawn, exists = fs.existsSync, platform = process.platform, now = Date.now } = {}) {
    super(); Object.assign(this, { executable: executable ?? helperPath({ exists, platform }), spawnImpl, exists, platform, now });
    this.child = null; this.epoch = 0; this.pid = null; this.session = null; this.identity = null;
    this.lastSampleAt = null; this.lastDropSampleAt = null; this.lastStatus = null;
  }
  _status(status, session = this.session) {
    const next = { status, trackingSession: session };
    if (JSON.stringify(next) !== JSON.stringify(this.lastStatus)) { this.lastStatus = next; this.emit('status', next); }
  }
  start(pid) {
    if (this.child && this.pid === pid) return;
    this.stop();
    if (!['win32', 'linux'].includes(this.platform)) { this._status('unsupported-platform'); return; }
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) { this._status('process-gone'); return; }
    try { if (!this.exists(this.executable)) { this._status('helper-unavailable'); return; } }
    catch { this._status('helper-unavailable'); return; }
    this.pid = pid; const epoch = ++this.epoch;
    let child;
    try { child = this.spawnImpl(this.executable, ['--pid', String(pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { this.pid = null; this._status('unavailable'); return; }
    if (!child || typeof child.once !== 'function' || typeof child.stdout?.on !== 'function') {
      this.pid = null; try { child?.kill?.(); } catch { /* Best-effort cleanup. */ }
      this._status('unavailable'); return;
    }
    this.child = child; this._status('searching');
    let carry = '';
    const current = () => epoch === this.epoch && this.child === child;
    const finish = status => {
      if (!current()) return;
      this.epoch++; this.child = null; this.pid = null; this.session = null; this.identity = null;
      this.lastSampleAt = null; this.lastDropSampleAt = null;
      this._status(status, null);
    };
    const protocolFailure = () => {
      if (!current()) return;
      finish('unavailable');
      try { child.kill?.(); } catch { /* The failed child may already have exited. */ }
    };
    const onData = chunk => {
      if (!current()) return;
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) { protocolFailure(); return; }
      carry += String(chunk);
      let end;
      while ((end = carry.indexOf('\n')) >= 0) {
        if (!current()) return;
        const frame = carry.slice(0, end); carry = carry.slice(end + 1);
        // Cap individual frames, including completed lines in a larger chunk.
        if (Buffer.byteLength(frame) > MAX_LINE_BYTES) { protocolFailure(); return; }
        const line = frame.trim();
        const message = parseMessage(line, this.now());
        if (!message) continue;
        if (message.type === 'status') {
          const identity = message.processStartUtcTicks && message.moduleHash
            ? createHash('sha256').update(`${pid}:${message.processStartUtcTicks}:${message.moduleHash}`).digest('hex') : null;
          if (identity !== this.identity) { this.lastSampleAt = null; this.lastDropSampleAt = null; }
          this.identity = identity;
          this.session = message.status === 'tracking' ? identity : null;
          this._status(message.status === 'tracking' && !identity ? 'unavailable' : message.status);
        } else if (message.type === 'world-drops') {
          if (this.session && this.lastStatus?.status === 'tracking'
            && (this.lastDropSampleAt === null || message.sampledAt > this.lastDropSampleAt)) {
            this.lastDropSampleAt = message.sampledAt;
            this.emit('world-drops', { ...message, trackingSession: this.session });
          }
        } else if (this.session && this.lastStatus?.status === 'tracking'
          && (this.lastSampleAt === null || message.sampledAt > this.lastSampleAt)) {
          this.lastSampleAt = message.sampledAt;
          this.emit('pose', { ...message, trackingSession: this.session });
        }
      }
      if (current() && Buffer.byteLength(carry) > MAX_CARRY_BYTES) protocolFailure();
    };
    // Register spawn failure handling before touching child streams.
    child.once('error', () => {
      if (!current()) return;
      finish('unavailable');
      try { child.kill?.(); } catch { /* A failed spawn has no running process. */ }
    });
    child.once('exit', () => {
      if (!current()) return;
      finish(TERMINAL_STATUSES.has(this.lastStatus?.status) ? this.lastStatus.status : 'process-gone');
    });
    try {
      // Root refresh has one fixed command. Pipe closure must not terminate the
      // app or disturb an otherwise valid character telemetry stream.
      child.stdin?.on?.('error', () => {});
      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data', onData);
      // Drain diagnostics without copying process output into app logs or renderers.
      child.stderr?.on('data', () => {});
    } catch { protocolFailure(); }
  }
  refreshRoots() {
    const input = this.child?.stdin;
    if (!this.child || !this.session || this.lastStatus?.status !== 'tracking'
      || typeof input?.write !== 'function' || input.destroyed === true || input.writable === false || input.writableEnded === true) return false;
    try {
      // write(false) means queued with backpressure, not rejected.
      input.write('refresh-roots\n'); return true;
    } catch { return false; }
  }
  stop() {
    this.epoch++; const child = this.child; this.child = null; this.pid = null; this.session = null;
    this.identity = null; this.lastSampleAt = null; this.lastDropSampleAt = null;
    try { child?.kill(); } catch { /* Already exited. */ }
    this._status('stopped', null);
  }
  getState() { return this.lastStatus || { status: 'stopped', trackingSession: null }; }
}

module.exports = { PlayerMemoryReader, parseMessage, helperPath, HELPER, LINUX_HELPER, MAX_LINE_BYTES, MAX_CARRY_BYTES, MAX_DUNGEON_ROOTS, MAX_DUNGEON_FRAMES };
