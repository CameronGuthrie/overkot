'use strict';

const { validRootAlignment } = require('./dungeonRootAlignment');
// Prefer the loaded region's verified world matrix. The legacy three-point fit
// remains available to development tools and saved manual alignment records.
const MIN_MOVEMENT = 8;
const MIN_ALTITUDE = 3;
const MAX_RESIDUAL = 4.5;
const finite = value => Number.isFinite(value) && Math.abs(value) <= 1e7;
const point = value => !!value && finite(value.x) && finite(value.z);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const failure = message => ({ ok: false, message });

function validAlignment(alignment) {
  return validRootAlignment(alignment) || (!!alignment && alignment.schema === 1 && alignment.points === 3
    && Number.isFinite(alignment.yaw) && Math.abs(alignment.yaw) <= Math.PI && point(alignment.translation)
    && Number.isFinite(alignment.error) && alignment.error >= 0 && alignment.error <= MAX_RESIDUAL);
}

function mapToWorld(value, alignment) {
  if (!point(value) || !validAlignment(alignment)) return null;
  const c = Math.cos(alignment.yaw), s = Math.sin(alignment.yaw);
  return { x: c * value.x + s * value.z + alignment.translation.x,
    z: -s * value.x + c * value.z + alignment.translation.z };
}

function worldToMap(value, alignment) {
  if (!point(value) || !validAlignment(alignment)) return null;
  const c = Math.cos(alignment.yaw), s = Math.sin(alignment.yaw);
  const x = value.x - alignment.translation.x, z = value.z - alignment.translation.z;
  return { x: c * x - s * z, z: s * x + c * z };
}

function headingToMap(degrees, alignment) {
  if (!Number.isFinite(degrees) || !validAlignment(alignment)) return null;
  return degrees - alignment.yaw * 180 / Math.PI;
}

function rigidFit(samples) {
  const center = name => samples.reduce((sum, sample) => ({ x: sum.x + sample[name].x / samples.length,
    z: sum.z + sample[name].z / samples.length }), { x: 0, z: 0 });
  const world = center('world'), map = center('map');
  let dot = 0, cross = 0;
  for (const sample of samples) {
    const wx = sample.world.x - world.x, wz = sample.world.z - world.z;
    const mx = sample.map.x - map.x, mz = sample.map.z - map.z;
    dot += wx * mx + wz * mz;
    cross += wx * mz - wz * mx;
  }
  const yaw = Math.atan2(cross, dot), c = Math.cos(yaw), s = Math.sin(yaw);
  return { schema: 1, yaw, translation: { x: world.x - c * map.x - s * map.z,
    z: world.z + s * map.x - c * map.z }, error: 0, points: 3 };
}

function fitAlignment(samples) {
  if (!Array.isArray(samples) || samples.length !== 3 || samples.some(sample => !point(sample?.world) || !point(sample?.map))) {
    return failure('Choose three matching player positions and points on the dungeon floor.');
  }
  const pairs = [[0, 1], [0, 2], [1, 2]];
  const lengths = pairs.map(([a, b]) => ({ world: distance(samples[a].world, samples[b].world),
    map: distance(samples[a].map, samples[b].map) }));
  if (lengths.some(length => Math.min(length.world, length.map) < MIN_MOVEMENT)) {
    return failure('Move at least 8 game units between each calibration point.');
  }
  for (const name of ['world', 'map']) {
    const [a, b, c] = samples.map(sample => sample[name]);
    const area = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    const longest = Math.max(...lengths.map(length => length[name]));
    if (area / longest < MIN_ALTITUDE) return failure('Take a turn before the third point so the three positions form a triangle.');
  }
  if (lengths.some(length => Math.abs(length.world - length.map) > 3 + 0.1 * Math.min(length.world, length.map))) {
    return failure('The distances do not match this dungeon map. Choose matching floor positions without changing map scale.');
  }
  // The first two points establish the candidate; the third independently
  // verifies it before all three refine the least-squares unit rigid fit.
  const candidate = rigidFit(samples.slice(0, 2));
  if (!validAlignment(candidate)) return failure('The map alignment could not be verified.');
  if (distance(mapToWorld(samples[2].map, candidate), samples[2].world) > MAX_RESIDUAL) {
    return failure('The third point does not confirm the map alignment. Choose three matching positions again.');
  }
  const alignment = rigidFit(samples);
  if (!validAlignment(alignment)) return failure('The map alignment could not be verified.');
  const residuals = samples.map(sample => distance(mapToWorld(sample.map, alignment), sample.world));
  if (residuals.some(error => error > MAX_RESIDUAL)) return failure('The positions do not agree closely enough to track this dungeon.');
  alignment.error = Math.sqrt(residuals.reduce((sum, error) => sum + error * error, 0) / samples.length);
  if (!validAlignment(alignment)) return failure('The map alignment could not be verified.');
  return { ok: true, alignment };
}

function pointInScene(scene, value) {
  if (scene?.mode !== 'placed' || !Array.isArray(scene.rooms) || !point(value)) return false;
  for (const room of scene.rooms) {
    const transform = room?.transform;
    const scale = transform?.scale ?? 1;
    if (!point(transform) || !Number.isFinite(transform.rotation) || !Number.isFinite(scale) || scale <= 0
      || !Array.isArray(room.outline)) continue;
    const c = Math.cos(transform.rotation), s = Math.sin(transform.rotation);
    const dx = value.x - transform.x, dz = value.z - transform.z;
    const local = { x: (c * dx - s * dz) / scale, z: (s * dx + c * dz) / scale };
    let winding = 0;
    for (const chain of room.outline) {
      if (chain?.closed !== true || !Array.isArray(chain.points) || chain.points.length < 3
        || !chain.points.every(p => Array.isArray(p) && p.length === 2 && p.every(finite))) continue;
      const area = chain.points.reduce((sum, [x, z], index) => {
        const next = chain.points[(index + 1) % chain.points.length];
        return sum + x * next[1] - next[0] * z;
      }, 0);
      if (Math.abs(area) < 1e-8) continue;
      for (let index = 0; index < chain.points.length; index++) {
        const [ax, az] = chain.points[index], [bx, bz] = chain.points[(index + 1) % chain.points.length];
        const vx = bx - ax, vz = bz - az, lengthSquared = vx * vx + vz * vz;
        const t = lengthSquared ? Math.max(0, Math.min(1, ((local.x - ax) * vx + (local.z - az) * vz) / lengthSquared)) : 0;
        if (Math.hypot(local.x - ax - t * vx, local.z - az - t * vz) <= 1e-6) return true;
        const side = vx * (local.z - az) - (local.x - ax) * vz;
        if (az <= local.z && bz > local.z && side > 0) winding++;
        else if (az > local.z && bz <= local.z && side < 0) winding--;
      }
    }
    if (winding !== 0) return true;
  }
  return false;
}

module.exports = { fitAlignment, validAlignment, worldToMap, mapToWorld, headingToMap, pointInScene };
