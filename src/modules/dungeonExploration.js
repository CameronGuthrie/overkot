'use strict';

// Coordinate-only discovery data. The caller owns account/instance identity and
// must supply positions in the same coordinate system as the dungeon geometry.
(function(root, factory) {
  const exploration = factory();
  if (typeof module === 'object' && module.exports) module.exports = exploration;
  else root.DungeonExploration = exploration;
})(typeof window === 'object' ? window : globalThis, function() {
  const SCHEMA_VERSION = 1;
  const MAX_CELLS = 40000;
  const MAX_COORDINATE = 10000000;
  const finiteCoordinate = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
  const key = (x, z, scale) => `${Math.floor(x / scale)},${Math.floor(z / scale)}`;

  function createExploration({ radius = 45, cellSize = 8, maxCells = MAX_CELLS } = {}) {
    if (!Number.isFinite(radius) || radius < 0.01 || radius > 10000) throw new RangeError('Invalid exploration radius');
    if (!Number.isFinite(cellSize) || cellSize < 0.000001 || cellSize > radius / 2) throw new RangeError('Invalid exploration cell size');
    if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > MAX_CELLS) throw new RangeError('Invalid exploration capacity');

    // Fine buckets deduplicate stamps; coarse buckets keep point queries local.
    // Stored positions are circles, not square cells, so renderers can mask the
    // map with smooth arcs without exposing an entire room at once.
    let cells = new Map(), buckets = new Map(), previous = null;
    const radiusSquared = radius * radius;
    const spacing = Math.max(cellSize, radius / 4);

    function insert(targetCells, targetBuckets, point) {
      targetCells.set(key(point[0], point[1], cellSize), point);
      const bucketKey = key(point[0], point[1], radius);
      const bucket = targetBuckets.get(bucketKey);
      if (bucket) bucket.push(point);
      else targetBuckets.set(bucketKey, [point]);
    }

    // Invalid samples and explicit discontinuities break the trail. Teleports
    // reveal their destination only, rather than drawing a discovered corridor.
    function reveal(position, { continuous = true } = {}) {
      if (!position || !finiteCoordinate(position.x) || !finiteCoordinate(position.z)) {
        previous = null;
        return { changed: false, added: 0, limited: false };
      }
      const point = [position.x || 0, position.z || 0];
      let added = 0, limited = false;
      const add = candidate => {
        if (cells.has(key(candidate[0], candidate[1], cellSize))) return;
        if (cells.size >= maxCells) { limited = true; return; }
        insert(cells, buckets, candidate);
        added++;
      };

      if (continuous && previous) {
        const dx = point[0] - previous[0], dz = point[1] - previous[1];
        const distance = Math.hypot(dx, dz);
        if (distance <= radius * 4) {
          // At most 16 interpolation steps, independent of coordinate range or
          // a very small deduplication cell size. Adjacent circles overlap.
          const steps = Math.ceil(distance / spacing);
          for (let step = 1; step < steps; step++) {
            const t = step / steps;
            add([previous[0] + dx * t, previous[1] + dz * t]);
          }
        }
      }
      add(point);
      previous = point;
      return { changed: added > 0, added, limited };
    }

    function isRevealed(x, z) {
      if (!finiteCoordinate(x) || !finiteCoordinate(z)) return false;
      const bx = Math.floor(x / radius), bz = Math.floor(z / radius);
      for (let ix = bx - 1; ix <= bx + 1; ix++) {
        for (let iz = bz - 1; iz <= bz + 1; iz++) {
          const bucket = buckets.get(`${ix},${iz}`);
          if (!bucket) continue;
          for (const point of bucket) {
            const dx = x - point[0], dz = z - point[1];
            if (dx * dx + dz * dz <= radiusSquared) return true;
          }
        }
      }
      return false;
    }

    const circles = () => Array.from(cells.values(), point => point.slice());
    const snapshot = () => ({ schema: SCHEMA_VERSION, radius, cellSize, cells: circles() });

    // Validate the complete save before replacing anything. Reject mismatched
    // settings instead of silently changing the meaning of earlier discovery.
    function restore(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.schema !== SCHEMA_VERSION || value.radius !== radius || value.cellSize !== cellSize
        || !Array.isArray(value.cells) || value.cells.length > maxCells) return false;
      const nextCells = new Map(), nextBuckets = new Map();
      for (const point of value.cells) {
        if (!Array.isArray(point) || point.length !== 2 || !finiteCoordinate(point[0]) || !finiteCoordinate(point[1])) return false;
        const copy = [point[0] || 0, point[1] || 0];
        if (nextCells.has(key(copy[0], copy[1], cellSize))) return false;
        insert(nextCells, nextBuckets, copy);
      }
      cells = nextCells;
      buckets = nextBuckets;
      previous = null;
      return true;
    }

    function clear() {
      const changed = cells.size > 0;
      cells.clear();
      buckets.clear();
      previous = null;
      return changed;
    }

    return { reveal, isRevealed, snapshot, restore, clear, circles, get size() { return cells.size; } };
  }

  return { createExploration, SCHEMA_VERSION, MAX_CELLS };
});
