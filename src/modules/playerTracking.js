'use strict';

const { EventEmitter } = require('node:events');
const { PlayerMemoryReader } = require('./playerMemoryReader');
const { DungeonDiscoveryStore } = require('./dungeonDiscoveryStore');
const { selectRoot } = require('./dungeonRootAlignment');
const { fitDungeonFrames } = require('./dungeonFrameAlignment');
const { createWorldDropsStore } = require('./worldDrops');
const { validPosition: withinOverworld } = require('../renderer/map-pois');

const MAX_AGE = 2000;
const MAX_DROP_DISTANCE = 80;
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7;
const stateKey = state => JSON.stringify([state?.active, state?.status, state?.instanceId, state?.levelPath, state?.layoutCode]);
// MidrathProc is the streamed generator enclosing the MidrathRedux overworld.
function zoneOf(state) {
  const level = state?.levelPath;
  if (typeof level !== 'string' || !/^\/SF\/Levels\/[A-Za-z0-9_/-]{1,512}$/.test(level)) return null;
  return !state.active && level === '/SF/Levels/Procs/MidrathProc' ? '/SF/Levels/MidrathRedux' : level;
}

/** Connect read-only memory poses to the current log entry and map coordinates. */
class PlayerTracking extends EventEmitter {
  constructor({ directory, reader = new PlayerMemoryReader(), getState, getAccountId, getVersion,
    canShowAnonymousOverworld = () => false, getAnonymousDungeonVisit = () => null, isPlayerAreaCurrent = () => true,
    getLayoutSnapshot, getScene, getNames = () => ({}), now = Date.now }) {
    super(); Object.assign(this, { reader, getState, getVersion, canShowAnonymousOverworld, getAnonymousDungeonVisit, isPlayerAreaCurrent,
      getLayoutSnapshot, getScene, now });
    this.getAccountId = () => getAccountId(reader.processStartMs);
    this.pid = null; this.enabled = true; this.state = null; this.signature = null; this.epoch = 0;
    this.account = null; this.visit = null; this.session = null; this.processIdentity = null; this.context = null; this.pending = null; this.retryAt = 0;
    this.poseWait = 'waiting-for-area';
    this.rootRefreshEntry = null;
    this.frameLayout = null; this.frameCloud = null; this.frameFit = null; this.minimumFrameTime = 0;
    this.pose = null; this.capture = null; this.captureRequest = null; this.captureScope = null; this.lastStatus = null; this.timer = null;
    this.observations = new Set();
    this.worldDrops = createWorldDropsStore({ now, getNames });
    this.minimumDropTime = now();
    this.discovery = new DungeonDiscoveryStore({ directory, now,
      getContext: () => this.context, getOwner: () => this._discoveryOwner(), getPose: () => this.getLocation(),
      getScene: () => this.getScene(this.state) });
    this.discovery.on('changed', data => {
      this.emit('discovery', data);
      if (this.pose) this._publish(this.pose);
    });
    reader.on('status', state => {
      if (state.trackingSession) this.processIdentity = state.trackingSession;
      if (this.session !== state.trackingSession) {
        this.session = state.trackingSession || null; this.signature = null;
      }
      this.refresh();
      if (state.status !== 'tracking') { this.rootRefreshEntry = null; this._clear({ preserveCapture: true }); }
      this._status();
    });
    reader.on('pose', pose => this._receive(pose));
    reader.on('world-drops', snapshot => this._receiveDrops(snapshot));
  }
  _fresh(pose) {
    const age = this.now() - pose?.sampledAt;
    return !!this.session && pose?.source === 'memory' && Number.isFinite(age) && age >= 0 && age <= MAX_AGE
      && pose.trackingSession === this.session && pose.position && ['x', 'y', 'z'].every(key => finite(pose.position[key]));
  }
  _currentStatus() {
    const readerState = this.reader.getState();
    let status = this.enabled ? readerState.status : 'disabled';
    if (status === 'tracking') status = this.poseWait || (this._fresh(this.pose) ? 'tracking' : 'stale');
    const next = { status };
    if (this.enabled && readerState.scanProgress !== undefined) next.scanProgress = readerState.scanProgress;
    return next;
  }
  _status() {
    const next = this._currentStatus();
    if (this.lastStatus?.status !== next.status || this.lastStatus?.scanProgress !== next.scanProgress) {
      this.lastStatus = next;
      this.emit('status', next);
    }
    return next;
  }
  _clear({ preserveCapture = false } = {}) {
    const captureCompleted = !preserveCapture && this.captureRequest !== null;
    const changed = this.pose !== null || (!preserveCapture && this.capture !== null) || captureCompleted;
    this.pose = null;
    this.worldDrops.clear(); this.minimumDropTime = this.now();
    if (!preserveCapture) { this.capture = null; this.captureRequest = null; }
    if (changed) this.emit('location', this.capture || { status: 'unavailable', source: 'memory', ...(captureCompleted ? { captureCompleted: true } : {}) });
  }
  getOwner() {
    // Consult the live account provider even between the periodic refreshes.
    const account = this.getAccountId();
    return account && account === this.account && this.session && this.isPlayerAreaCurrent(this.reader.processStartMs)
      ? { account, process: this.session } : null;
  }
  _discoveryOwner() {
    if (!this.visit) return this.getOwner();
    if (!this.enabled || !this.pid || !this.session || this.getAccountId()
      || this.getAnonymousDungeonVisit(this.reader.processStartMs) !== this.visit
      || stateKey(this.getState()) !== stateKey(this.state)) return null;
    return { account: null, process: this.session, visit: this.visit };
  }
  refresh(state = this.getState()) {
    const captured = state && typeof state === 'object' ? { ...state } : { active: false, status: 'unknown' };
    const account = this.getAccountId() || null, version = String(this.getVersion() ?? '');
    const zone = zoneOf(captured), startMs = this.reader.processStartMs;
    const visit = !account && captured.active && captured.status === 'ready' ? this.getAnonymousDungeonVisit(startMs) : null;
    let poseWait = null;
    if (!zone || !this.isPlayerAreaCurrent(startMs)) poseWait = 'waiting-for-area';
    else if (!account && !visit && !(captured.active === false && captured.status === 'outside' && zone === '/SF/Levels/MidrathRedux'
      && this.canShowAnonymousOverworld(startMs))) poseWait = 'waiting-for-login';
    const signature = JSON.stringify([stateKey(captured), account, visit, this.session, version, poseWait]);
    if (signature !== this.signature) {
      const captureScope = JSON.stringify([stateKey(captured), account, visit, this.pid, this.processIdentity]);
      const preserveCapture = captureScope === this.captureScope;
      this.captureScope = captureScope;
      this.signature = signature; this.epoch++; this.context = null; this.pending = null; this.retryAt = 0;
      this.frameLayout = null; this.frameCloud = null; this.frameFit = null; this.minimumFrameTime = this.now();
      this.state = captured; this.account = account; this.visit = visit; this.poseWait = poseWait; this._clear({ preserveCapture });
    }
    this._status();
    if (!this.enabled || !this.pid || this.poseWait || !this.session || !captured.active || captured.status !== 'ready'
      || !captured.instanceId || !captured.layoutCode || this.context || this.pending || this.now() < this.retryAt) return this.pending;
    const epoch = this.epoch;
    const task = Promise.resolve().then(() => this.getLayoutSnapshot(captured)).then(async layout => {
      if (epoch !== this.epoch || this.getAccountId() !== account || !this.isPlayerAreaCurrent(this.reader.processStartMs)
        || (visit && this.getAnonymousDungeonVisit(this.reader.processStartMs) !== visit)
        || stateKey(this.getState()) !== stateKey(captured)) return;
      if (layout?.status !== 'ready' || stateKey(layout.state) !== stateKey(captured)
        || String(layout.version) !== String(this.getVersion() ?? '') || !['world', 'layout-local'].includes(layout.coordinateSpace)) {
        this.retryAt = this.now() + 5000; return;
      }
      this.context = { account, ...(visit ? { visit } : {}), process: this.session, instanceId: captured.instanceId, levelPath: captured.levelPath,
        layoutCode: captured.layoutCode, revision: String(layout.version), coordinateSpace: layout.coordinateSpace };
      this.frameLayout = layout;
      await this.discovery.load({ instanceId: captured.instanceId, revision: String(layout.version) });
      if (epoch === this.epoch && this.pose) {
        const root = this._frameRoot(this.pose.sampledAt);
        if (this.frameCloud) {
          delete this.pose.dungeonRoot;
          if (root) this.pose.dungeonRoot = root;
        }
        this._observe(this.pose); this._publish(this.pose);
      }
    }).catch(() => { if (epoch === this.epoch) this.retryAt = this.now() + 5000; })
      .finally(() => { if (this.pending === task) this.pending = null; });
    this.pending = task; return task;
  }
  _receive(pose) {
    this.refresh();
    if (!this.enabled || !this.pid || this.poseWait || !this._fresh(pose)
      || this.reader.getState().status !== 'tracking') return;
    // A cloud is private placement evidence, tied to both the current entry and
    // its capture time. Never let a legacy loading-slot root override it.
    const canPlace = this.account || this.visit;
    const hasFrames = canPlace && Object.hasOwn(pose, 'dungeonFrames');
    this.frameCloud = hasFrames ? { frames: pose.dungeonFrames, timestamp: pose.dungeonFramesTimestamp } : null;
    const dungeonRoot = hasFrames ? this._frameRoot(pose.sampledAt)
      : canPlace && selectRoot(pose.dungeonRoots || (pose.dungeonRoot ? [pose.dungeonRoot] : []), this.state);
    if (!dungeonRoot && this.state.active && this.state.status === 'ready') {
      const entry = JSON.stringify([this.session, this.state.instanceId]);
      if (entry !== this.rootRefreshEntry && this.reader.refreshRoots?.()) this.rootRefreshEntry = entry;
    }
    this.pose = { source: 'memory', sampledAt: pose.sampledAt, trackingSession: pose.trackingSession,
      position: { ...pose.position }, heading: finite(pose.heading) ? ((pose.heading % 360) + 360) % 360 : null,
      ...(dungeonRoot ? { dungeonRoot } : {}) };
    this.capture = null;
    this._observe(this.pose);
    this._publish(this.pose); this._status();
  }
  _receiveDrops(snapshot) {
    this.refresh();
    if (!this.enabled || !this.pid || this.poseWait || !this._fresh(this.pose)
      || this.reader.getState().status !== 'tracking' || snapshot?.trackingSession !== this.session
      || !Number.isSafeInteger(snapshot.sampledAt) || snapshot.sampledAt < this.minimumDropTime) return;
    if (this.worldDrops.receive(snapshot)) this._publish(this.pose);
  }
  _frameRoot(sampledAt) {
    const cloud = this.frameCloud;
    if (!cloud || !this.frameLayout || !Number.isSafeInteger(cloud.timestamp)
      || cloud.timestamp < this.minimumFrameTime || cloud.timestamp > sampledAt + 100
      || this.now() < cloud.timestamp || this.now() - cloud.timestamp > MAX_AGE) return null;
    // Room frames are sampled once per second; solve only when their contents
    // change, while requiring fresh evidence on every accepted player packet.
    const key = JSON.stringify(cloud.frames);
    if (!this.frameFit || this.frameFit.key !== key) this.frameFit = { key, root: fitDungeonFrames(cloud.frames, this.frameLayout) };
    return this.frameFit.root;
  }
  _observe(pose) {
    const epoch = this.epoch, context = this.context;
    if (!context) return;
    const observed = () => ({ ...this._location(pose), ...(pose.dungeonRoot ? { dungeonRoot: pose.dungeonRoot } : {}) });
    const task = Promise.resolve(pose.dungeonRoot ? this.discovery.applyRoot(pose.dungeonRoot, observed()) : false).then(() => {
      if (epoch !== this.epoch || context !== this.context || !this._fresh(pose)) return;
      return this.discovery.observePose(observed(), context);
    }).catch(() => {});
    this.observations.add(task);
    task.finally(() => this.observations.delete(task));
    return task;
  }
  _location(pose) {
    const zone = zoneOf(this.state);
    const { dungeonRoot, ...publicPose } = pose;
    const location = { ...publicPose, status: 'found', zone, isOverworld: !this.state.active && zone === '/SF/Levels/MidrathRedux',
      instanceId: this.state.instanceId || null };
    const dungeon = this.context && this.discovery.mappedPose({ ...location, ...(dungeonRoot ? { dungeonRoot } : {}) }, this.context);
    const located = dungeon ? { ...location, dungeon } : location;
    return { ...located, worldDrops: this._dropLocation(located, pose) };
  }
  _dropLocation(location, pose) {
    const snapshot = this.worldDrops.read(this.session);
    if (snapshot.status !== 'available') return snapshot;
    const items = snapshot.items.filter(item => Math.hypot(item.position.x - pose.position.x,
      item.position.y - pose.position.y, item.position.z - pose.position.z) <= MAX_DROP_DISTANCE).map(item => {
      // Placement is proved by the current player frame. A fresh static pickup
      // shares that world space; it must never reveal dungeon exploration.
      const mapped = location.dungeon && this.context ? this.discovery.mappedPose({ ...location,
        position: item.position, heading: null, ...(pose.dungeonRoot ? { dungeonRoot: pose.dungeonRoot } : {}) }, this.context) : null;
      return mapped ? { ...item, dungeon: mapped } : item;
    });
    return { ...snapshot, items };
  }
  _publish(pose) { if (this._fresh(pose)) this.emit('location', this._location(pose)); }
  getLocation() {
    this.refresh();
    if (this._fresh(this.pose)) return this._location(this.pose);
    return this.capture || { status: 'unavailable', source: 'memory' };
  }
  beginCapture() { this.refresh(); this.captureRequest = this.captureScope; }
  acceptCapture(data) {
    this.refresh();
    if (this.captureRequest === null || this.captureRequest !== this.captureScope) return;
    this.captureRequest = null;
    const zone = zoneOf(this.state);
    if (data?.status === 'found' && zone && data.zone !== zone) {
      this.emit('location', this._fresh(this.pose) ? { ...this._location(this.pose), captureCompleted: true }
        : { status: 'unavailable', source: 'capture' });
      return;
    }
    if (data?.status === 'found') this.capture = { ...data, source: 'capture', sampledAt: this.now() };
    // Memory tracking remains authoritative; explicit captures still complete the F6 UI.
    this.emit('location', this._fresh(this.pose) ? { ...this._location(this.pose), captureCompleted: true } : this.capture || data);
  }
  getStatus() { this.refresh(); return this._status(); }
  getDiagnostics() {
    const zone = zoneOf(this.state);
    let mapPlacement = 'no-live-sample';
    if (this._fresh(this.pose)) {
      if (this.state.active) mapPlacement = 'dungeon';
      else if (zone === '/SF/Levels/MidrathRedux') mapPlacement = withinOverworld(this.pose.position) ? 'overworld' : 'outside-overworld-bounds';
      else mapPlacement = 'other-area';
    }
    return { mapStatus: this._currentStatus().status, mapPlacement, loginRecognized: !!this.account, areaRecognized: !!zone && this.poseWait !== 'waiting-for-area',
      ...this.reader.getDiagnostics() };
  }
  async flush() {
    await Promise.allSettled([...this.observations]);
    await this.discovery.flush();
  }
  start(pid) {
    this.pid = pid;
    if (!this.timer) { this.timer = setInterval(() => {
      this.refresh();
      if (this.pose && !this._fresh(this.pose)) { this._clear(); this._status(); }
    }, 500); this.timer.unref?.(); }
    if (this.enabled) this.reader.start(pid);
  }
  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled && this.pid) this.reader.start(this.pid);
    else this.reader.stop();
    this.signature = null; this.refresh();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.pid = null; this.reader.stop(); this.signature = null; this.refresh(); this._clear();
  }
}

module.exports = { PlayerTracking, zoneOf, MAX_AGE, MAX_DROP_DISTANCE };
