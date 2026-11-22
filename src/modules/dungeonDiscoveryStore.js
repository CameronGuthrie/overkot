'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createExploration } = require('./dungeonExploration');
const { fitAlignment, validAlignment, worldToMap, headingToMap, pointInScene } = require('./mapAlignment');
const { validateRoot, alignmentFromRoot, validRootAlignment } = require('./dungeonRootAlignment');

const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const validContext = value => plain(value) && ['account', 'process', 'instanceId', 'levelPath', 'layoutCode', 'revision'].every(key => text(value[key]))
  && ['world', 'layout-local'].includes(value.coordinateSpace);
const point = value => plain(value) && ['x', 'z'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && Math.abs(value[key]) <= 1e7);
const copyPoint = value => ({ x: value.x, z: value.z });
const fail = message => ({ ok: false, message });
const contextKey = context => hash(JSON.stringify([context.account, context.process, context.instanceId,
  context.levelPath, context.layoutCode, context.revision, context.coordinateSpace]));
const rootState = record => ({ ...record.context, active: true, status: 'ready' });
const sameRootAlignment = (a, b) => validRootAlignment(a) && validRootAlignment(b)
  && a.levelPath === b.levelPath && a.layoutCode === b.layoutCode
  && Math.abs(Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw))) <= 1e-4
  && Math.abs(a.translation.x - b.translation.x) <= 1e-4 && Math.abs(a.translation.z - b.translation.z) <= 1e-4
  && Math.abs(a.height - b.height) <= 1e-4;

function samples(value) {
  if (!Array.isArray(value) || value.length > 3 || value.some(sample => !point(sample?.world) || !point(sample?.map))) return null;
  const result = value.map(sample => ({ world: copyPoint(sample.world), map: copyPoint(sample.map) }));
  for (let a = 0; a < result.length; a++) for (let b = a + 1; b < result.length; b++) {
    const actual = Math.hypot(result[a].world.x - result[b].world.x, result[a].world.z - result[b].world.z);
    const marked = Math.hypot(result[a].map.x - result[b].map.x, result[a].map.z - result[b].map.z);
    if (Math.min(actual, marked) < 8 || Math.abs(actual - marked) > 3 + Math.min(actual, marked) * .1) return null;
  }
  return result;
}

/** Account/entry-scoped discovery. Renderers never supply paths or account IDs. */
class DungeonDiscoveryStore extends EventEmitter {
  constructor({ directory, getContext, getOwner, getPose, getScene, fsImpl = fs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    super(); Object.assign(this, { directory, getContext, getOwner, getPose, getScene, fs: fsImpl, now, setTimer, clearTimer });
    this.records = new Map(); this.scopes = new Map(); this.pending = new Map(); this.writes = new Map(); this.operations = new Set();
    this.observed = new Set();
  }
  _owner(record) {
    const owner = this.getOwner();
    return plain(owner) && owner.account === record.context.account && owner.process === record.context.process;
  }
  _context(input) {
    const context = this.getContext();
    if (!validContext(context)) return null;
    if (!plain(input) || input.instanceId !== context.instanceId || input.revision !== context.revision || !this._owner({ context })) return null;
    return { account: context.account, process: context.process, instanceId: context.instanceId,
      levelPath: context.levelPath, layoutCode: context.layoutCode, revision: context.revision, coordinateSpace: context.coordinateSpace };
  }
  _current(record) {
    const context = this._context({ instanceId: record.context.instanceId, revision: record.context.revision });
    return !!context && contextKey(context) === record.key;
  }
  _freshPose(pose, record, maximumAge) {
    const age = Number.isFinite(pose?.sampledAt) ? this.now() - pose.sampledAt : Infinity;
    return pose?.status === 'found' && pose.source === 'memory' && pose.instanceId === record.context.instanceId
      && pose.trackingSession === record.context.process && pose.isOverworld === false && point(pose.position)
      && Number.isFinite(pose.sampledAt) && age >= 0 && age <= maximumAge;
  }
  _alignment(record) {
    if (record.context.coordinateSpace === 'layout-local' && (record.alignment?.schema === 2 || !record.alignment && !record.points.length)) {
      return { status: record.rootVerified ? 'verified' : 'detecting', source: record.alignment?.source || 'level-info-fit', points: 0 };
    }
    return { status: record.context.coordinateSpace === 'world' || validAlignment(record.alignment) ? 'verified'
      : record.points.length ? 'collecting' : 'unavailable', points: record.context.coordinateSpace === 'world' ? 3 : record.points.length };
  }
  _snapshot(record) {
    return { ok: true, instanceId: record.context.instanceId, revision: record.context.revision,
      scope: record.scope, exploration: record.exploration.snapshot(), alignment: this._alignment(record) };
  }
  _scope(record) {
    record.scope = hash(`${record.key}:${record.generation}`); this.scopes.set(record.scope, record);
  }
  _restore(record, saved) {
    if (!plain(saved) || saved.schema !== 1 || saved.key !== record.key || !Number.isSafeInteger(saved.generation)
      || saved.generation < 0 || saved.generation >= 1e9) return;
    const exploration = createExploration();
    if (!exploration.restore(saved.exploration)) return;
    const observations = samples(saved.points);
    if (record.context.coordinateSpace === 'layout-local') {
      if (!observations) return;
      if (saved.alignment?.schema === 2) {
        if (!validRootAlignment(saved.alignment) || observations.length || saved.alignment.levelPath !== record.context.levelPath
          || saved.alignment.layoutCode !== record.context.layoutCode) return;
        const a = saved.alignment;
        record.alignment = { schema: 2, source: a.source, levelPath: a.levelPath, layoutCode: a.layoutCode,
          yaw: a.yaw, translation: copyPoint(a.translation), height: a.height, points: 0, error: 0 };
      } else if (observations.length === 3) {
        const fitted = fitAlignment(observations);
        if (saved.alignment?.schema !== 1 || !validAlignment(saved.alignment) || !fitted.ok
          || Math.abs(fitted.alignment.yaw - saved.alignment.yaw) > 1e-6
          || Math.hypot(fitted.alignment.translation.x - saved.alignment.translation.x, fitted.alignment.translation.z - saved.alignment.translation.z) > 1e-6
          || Math.abs(fitted.alignment.error - saved.alignment.error) > 1e-6) return;
        record.alignment = fitted.alignment;
      } else if (saved.alignment !== null || exploration.size) return;
      record.points = observations;
    }
    record.exploration = exploration; record.generation = saved.generation;
  }
  async _record(input) {
    const context = this._context(input); if (!context) return null;
    const key = contextKey(context);
    if (!this.records.has(key)) {
      if (!this.pending.has(key)) this.pending.set(key, (async () => {
        const record = { key, context, generation: 0, alignment: null, points: [], exploration: createExploration(), dirty: false, observationTimer: null, lastObservation: null,
          rootVerified: false, rootSampledAt: null, rootProofAlignment: null };
        try {
          await this.writes.get(key)?.catch(() => {});
          const filename = path.join(this.directory, `${key}.json`), stat = await this.fs.stat(filename);
          if (Number.isFinite(stat.size) && stat.size >= 0 && stat.size <= 4 * 1024 * 1024) {
            this._restore(record, JSON.parse(await this.fs.readFile(filename, 'utf8')));
          }
        } catch { /* A new, missing or invalid file starts unexplored. */ }
        this._scope(record); this.records.set(key, record);
        // Retain a bounded number of issued scopes for closing maps' final saves.
        if (this.records.size > 24) {
          const current = this.getContext(), currentKey = validContext(current) ? contextKey(current) : null;
          const first = [...this.records.keys()].find(candidate => candidate !== currentKey);
          const old = this.records.get(first);
          this.records.delete(first); if (old) this.scopes.delete(old.scope);
        }
        return record;
      })().finally(() => this.pending.delete(key)));
      await this.pending.get(key);
    }
    const record = this.records.get(key);
    return record && this._current(record) ? record : null;
  }
  peek(context = this.getContext()) {
    return validContext(context) ? this.records.get(contextKey(context)) || null : null;
  }
  async load(input) {
    const record = await this._record(input);
    return record ? this._snapshot(record) : fail('Enter a dungeon and wait for live player tracking.');
  }
  _operate(record, action) {
    const task = (record.operation || Promise.resolve()).catch(() => {}).then(action);
    record.operation = task; this.operations.add(task);
    const cleanup = () => { this.operations.delete(task); if (record.operation === task) record.operation = null; };
    task.then(cleanup, cleanup); return task;
  }
  _persist(record) {
    const saved = JSON.stringify({ schema: 1, key: record.key, generation: record.generation, alignment: record.alignment,
      points: record.points, exploration: record.exploration.snapshot() });
    // A complete candidate is written before it becomes observable. Serialize
    // by filename as well, including a recently evicted and reloaded record.
    const previous = this.writes.get(record.key) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const target = path.join(this.directory, `${record.key}.json`), temporary = `${target}.${process.pid}.tmp`;
      try {
        await this.fs.mkdir(this.directory, { recursive: true });
        await this.fs.writeFile(temporary, saved); await this.fs.rename(temporary, target);
      } catch (error) {
        try { if (this.fs.unlink) await this.fs.unlink(temporary); } catch { /* No temporary file may have been created. */ }
        throw error;
      }
    }).finally(() => { if (this.writes.get(record.key) === task) this.writes.delete(record.key); });
    this.writes.set(record.key, task); return task;
  }
  _cleanObservation(record) {
    if (record.observationTimer !== null) this.clearTimer(record.observationTimer);
    record.observationTimer = null; record.dirty = false; this.observed.delete(record);
  }
  _saveObservation(record) {
    return this._operate(record, async () => {
      if (!record.dirty) return false;
      try { await this._persist(record); } catch { return false; }
      this._cleanObservation(record);
      if (this._current(record)) this.emit('changed', this._snapshot(record));
      return true;
    });
  }
  _scheduleObservation(record) {
    if (!record.dirty || record.observationTimer !== null) return;
    record.observationTimer = this.setTimer(() => {
      record.observationTimer = null;
      this._saveObservation(record).catch(() => {});
    }, 750);
    record.observationTimer?.unref?.();
  }
  async applyRoot(root, pose) {
    const checked = validateRoot(root);
    if (!checked) return false;
    pose = plain(pose) ? { ...pose, position: point(pose.position) ? copyPoint(pose.position) : null } : null;
    const context = this.getContext();
    if (!validContext(context) || context.coordinateSpace !== 'layout-local') return false;
    const record = await this._record({ instanceId: context.instanceId, revision: context.revision });
    if (!record || record.key !== contextKey(context)) return false;
    const requestedScope = record.scope;
    return this._operate(record, async () => {
      if (!this._current(record) || record.scope !== requestedScope || !this._freshPose(pose, record, 750)) return false;
      const alignment = alignmentFromRoot(checked, rootState(record));
      if (!alignment) return false;
      if (record.rootSampledAt !== null && (pose.sampledAt < record.rootSampledAt
        || pose.sampledAt === record.rootSampledAt && record.rootProofAlignment && !sameRootAlignment(record.rootProofAlignment, alignment))) return false;
      record.rootSampledAt = pose.sampledAt; record.rootProofAlignment = alignment;
      if (sameRootAlignment(record.alignment, alignment)) {
        const changed = !record.rootVerified;
        record.rootVerified = true;
        if (changed) this.emit('changed', this._snapshot(record));
        return true;
      }
      // A newly observed transform immediately revokes the previous proof.
      // Its replacement scope and geometry become visible only after the write.
      record.rootVerified = false;
      const replacing = !!record.alignment || record.exploration.size > 0;
      const previousScope = record.scope;
      const candidate = { ...record, alignment, points: [], generation: record.generation + (replacing ? 1 : 0), exploration: createExploration() };
      try { await this._persist(candidate); } catch { return false; }
      if (replacing) this.scopes.delete(previousScope);
      Object.assign(record, { alignment, points: [], generation: candidate.generation, exploration: candidate.exploration });
      this._cleanObservation(record); record.lastObservation = null;
      if (replacing) this._scope(record);
      record.rootVerified = this._current(record) && this._freshPose(pose, record, 750);
      if (!this._current(record)) return false;
      const snapshot = this._snapshot(record);
      this.emit('changed', replacing ? { ...snapshot, reset: true, previousScope } : snapshot);
      return record.rootVerified;
    });
  }
  async observePose(pose, context = this.getContext()) {
    if (!validContext(context)) return false;
    context = { ...context };
    pose = plain(pose) ? { ...pose, position: point(pose.position) ? copyPoint(pose.position) : null } : null;
    const record = await this._record({ instanceId: context.instanceId, revision: context.revision });
    if (!record || record.key !== contextKey(context)) return false;
    const requestedScope = record.scope;
    return this._operate(record, () => {
      if (record.scope !== requestedScope) return false;
      const mapped = this.mappedPose(pose, context);
      if (!mapped) { record.lastObservation = null; record.exploration.reveal(null); return false; }
      const previous = record.lastObservation;
      if (previous && pose.sampledAt <= previous.sampledAt) return false;
      const continuous = previous && pose.sampledAt - previous.sampledAt <= 2000;
      // Renderer merges may replace the model's interpolation anchor. Restore
      // only the previous accepted server point before extending this trail.
      if (continuous) record.exploration.reveal(previous.position, { continuous: false });
      const result = record.exploration.reveal(mapped.position, { continuous: !!continuous });
      record.lastObservation = { position: copyPoint(mapped.position), sampledAt: pose.sampledAt };
      if (result.changed) { record.dirty = true; this.observed.add(record); }
      this._scheduleObservation(record);
      return result.changed;
    });
  }
  async save(input) {
    if (!plain(input) || typeof input.scope !== 'string') return fail('Invalid discovery scope.');
    const record = this.scopes.get(input.scope);
    if (!record || !this._owner(record)) return fail('This discovery belongs to another game session.');
    const incoming = createExploration();
    if (!incoming.restore(input.exploration)) return fail('Invalid exploration data.');
    const requestedScope = input.scope;
    return this._operate(record, async () => {
      if (record.scope !== requestedScope || this.scopes.get(requestedScope) !== record || !this._owner(record)) return fail('This discovery belongs to another game session.');
      if (record.context.coordinateSpace !== 'world' && (!validAlignment(record.alignment)
        || record.alignment.schema === 2 && !record.rootVerified)) return fail('Waiting for live dungeon placement.');
      const exploration = createExploration(); exploration.restore(record.exploration.snapshot());
      for (const [x, z] of incoming.circles()) exploration.reveal({ x, z }, { continuous: false });
      try { await this._persist({ ...record, exploration }); } catch { return fail('Discovery could not be saved. Try again.'); }
      record.exploration = exploration;
      this._cleanObservation(record);
      if (!this._owner(record)) return fail('This discovery belongs to another game session.');
      const snapshot = this._snapshot(record);
      if (this._current(record)) this.emit('changed', snapshot);
      return snapshot;
    });
  }
  async addPoint(input) {
    const captured = this.getPose();
    const pose = plain(captured) ? { ...captured, position: point(captured.position) ? copyPoint(captured.position) : null } : null;
    const map = point(input?.map) ? copyPoint(input.map) : null;
    const record = await this._record(input);
    if (!record || !map) return fail('Choose a point in the current dungeon.');
    const requestedScope = record.scope;
    return this._operate(record, async () => {
      if (!this._current(record) || record.scope !== requestedScope) return fail('The dungeon changed. Start alignment again.');
      if (validAlignment(record.alignment) || record.context.coordinateSpace === 'world') return fail('Reset alignment before choosing new points.');
      if (!this._freshPose(pose, record, 750)) return fail('Waiting for a fresh live player position.');
      let scene;
      try { scene = await this.getScene(); } catch { return fail('The dungeon map could not be loaded. Try again.'); }
      if (!this._current(record) || scene?.state?.instanceId !== record.context.instanceId || scene.version !== record.context.revision
        || scene.coordinateSpace !== record.context.coordinateSpace) return fail('The dungeon changed. Start alignment again.');
      if (!this._freshPose(pose, record, 750)) return fail('Waiting for a fresh live player position.');
      if (!pointInScene(scene, map)) return fail('Choose a point inside a known room outline.');
      const next = { world: copyPoint(pose.position), map };
      for (const old of record.points) {
        const actual = Math.hypot(next.world.x - old.world.x, next.world.z - old.world.z);
        const marked = Math.hypot(next.map.x - old.map.x, next.map.z - old.map.z);
        if (Math.min(actual, marked) < 8) return fail('Move at least 8 game units before marking another point.');
        if (Math.abs(actual - marked) > 3 + Math.min(actual, marked) * .1) return fail('The marked distance does not match your movement. Try this point again.');
      }
      const observations = [...record.points, next];
      let alignment = null;
      if (observations.length === 3) {
        const fitted = fitAlignment(observations); if (!fitted.ok) return fitted;
        alignment = fitted.alignment;
      }
      try { await this._persist({ ...record, points: observations, alignment }); } catch { return fail('Alignment could not be saved. Try again.'); }
      record.points = observations; record.alignment = alignment; record.rootVerified = false;
      if (!this._current(record)) return fail('The dungeon changed. Start alignment again.');
      const snapshot = this._snapshot(record); this.emit('changed', snapshot); return snapshot;
    });
  }
  async reset(input) {
    const record = await this._record(input); if (!record) return fail('The dungeon is no longer active.');
    const requestedScope = record.scope;
    return this._operate(record, async () => {
      if (!this._current(record) || record.scope !== requestedScope) return fail('The dungeon is no longer active.');
      const previousScope = record.scope;
      const candidate = { ...record, generation: record.generation + 1, alignment: null, points: [], exploration: createExploration() };
      try { await this._persist(candidate); } catch { return fail('Alignment could not be reset. Try again.'); }
      this.scopes.delete(previousScope);
      Object.assign(record, { generation: candidate.generation, alignment: null, points: [], exploration: candidate.exploration });
      record.rootVerified = false; record.rootSampledAt = null; record.rootProofAlignment = null;
      this._cleanObservation(record); record.lastObservation = null;
      this._scope(record);
      if (!this._current(record)) return fail('The dungeon is no longer active.');
      const snapshot = { ...this._snapshot(record), reset: true, previousScope };
      this.emit('changed', snapshot); return snapshot;
    });
  }
  mappedPose(pose, context = this.getContext()) {
    const record = this.peek(context);
    if (!record || !this._current(record) || !this._freshPose(pose, record, 2000)) return null;
    const identity = record.context.coordinateSpace === 'world';
    if (!identity && !validAlignment(record.alignment)) return null;
    if (!identity && record.alignment.schema === 2 && (!record.rootVerified
      || record.rootSampledAt !== null && pose.sampledAt < record.rootSampledAt
      || !sameRootAlignment(record.alignment, alignmentFromRoot(pose.dungeonRoot, rootState(record))))) return null;
    const position = identity ? copyPoint(pose.position) : worldToMap(pose.position, record.alignment);
    if (!point(position)) return null;
    return { instanceId: record.context.instanceId, revision: record.context.revision, scope: record.scope,
      position, heading: identity ? Number.isFinite(pose.heading) ? pose.heading : null : headingToMap(pose.heading, record.alignment),
      coordinateSpace: record.context.coordinateSpace, alignmentVerified: true };
  }
  async flush() {
    for (const record of this.observed) {
      if (record.observationTimer !== null) this.clearTimer(record.observationTimer);
      record.observationTimer = null;
      this._saveObservation(record).catch(() => {});
    }
    while (this.operations.size || this.writes.size) await Promise.allSettled([...this.operations, ...this.writes.values()]);
  }
}

module.exports = { DungeonDiscoveryStore, contextKey };
