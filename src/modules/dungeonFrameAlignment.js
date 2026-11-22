'use strict';

const { validateMatrix, validateRoot } = require('./dungeonRootAlignment');

const LIMIT = 64;
// Engine matrices are float32. These bounds admit their rounding error while
// requiring the entire decoded layout, including height and facing, to agree.
const POSITION_TOLERANCE = .02;
const ANGLE_TOLERANCE = .0002;
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6;
const angle = value => Math.atan2(Math.sin(value), Math.cos(value));
const distance2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const close = (a, b, position, rotation) => distance2(a, b) <= position ** 2
  && Math.abs(angle(a.rotation - b.rotation)) <= rotation;

function distinct(frames) {
  return frames.filter((frame, i) => !frames.slice(0, i).some(other => close(frame, other, 1e-5, 1e-6)));
}

function transform(frame, root) {
  const c = Math.cos(root.rotation), s = Math.sin(root.rotation);
  return { x: c * frame.x + s * frame.z + root.x, y: frame.y + root.y,
    z: -s * frame.x + c * frame.z + root.z, rotation: angle(frame.rotation + root.rotation) };
}

function match(expected, observed, root) {
  const options = expected.map(frame => {
    const world = transform(frame, root), indices = [];
    for (let i = 0; i < observed.length; i++) {
      if (close(world, observed[i], POSITION_TOLERANCE, ANGLE_TOLERANCE)) indices.push(i);
    }
    return indices;
  });
  if (options.some(indices => !indices.length)) return null;
  // A native entity can prove only one room. An augmenting match also handles
  // nearby frames without depending on entity or room ordering.
  const owners = new Map();
  function assign(room, visited) {
    for (const index of options[room]) {
      if (visited.has(index)) continue;
      visited.add(index);
      if (!owners.has(index) || assign(owners.get(index), visited)) {
        owners.set(index, room); return true;
      }
    }
    return false;
  }
  for (let room = 0; room < expected.length; room++) if (!assign(room, new Set())) return null;
  const result = [];
  for (const [native, room] of owners) result[room] = native;
  return result;
}

function matrix(root) {
  const c = Math.cos(root.rotation), s = Math.sin(root.rotation);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, root.x, root.y, root.z, 1];
}

/** Register a complete current layout against independently loaded world frames.
 * No player position, entity order, or streaming-input origin chooses the fit.
 */
function fitDungeonFrames(frames, layout) {
  const state = layout?.state;
  if (layout?.status !== 'ready' || layout.coordinateSpace !== 'layout-local'
    || state?.active !== true || state.status !== 'ready' || !state.instanceId
    || !Array.isArray(layout.rooms) || layout.rooms.length < 3 || layout.rooms.length > LIMIT
    || !Array.isArray(frames) || frames.length > LIMIT) return null;
  const expected = [];
  for (const room of layout.rooms) {
    const t = room?.transform;
    if (!t || !['x', 'y', 'z', 'rotation'].every(key => finite(t[key]))) return null;
    expected.push({ x: t.x, y: t.y, z: t.z, rotation: angle(t.rotation) });
  }
  const rooms = distinct(expected);
  if (rooms.length < 3) return null;
  const observed = distinct(frames.flatMap(frame => {
    const m = frame?.source === 'level-info' && validateMatrix(frame.matrix);
    return m ? [{ x: m[12], y: m[13], z: m[14], rotation: Math.atan2(m[8], m[10]) }] : [];
  }));
  if (observed.length < rooms.length) return null;
  let solution = null, matches = null;
  for (const room of rooms) for (const world of observed) {
    const rotation = angle(world.rotation - room.rotation), c = Math.cos(rotation), s = Math.sin(rotation);
    const candidate = { rotation, x: world.x - c * room.x - s * room.z,
      y: world.y - room.y, z: world.z + s * room.x - c * room.z };
    const matching = match(rooms, observed, candidate);
    if (!matching) continue;
    if (solution) {
      // Several anchor pairs normally describe the same fit. A second complete
      // but spatially different graph is ambiguous, so do not choose either.
      if (!rooms.every(frame => close(transform(frame, candidate), transform(frame, solution),
        POSITION_TOLERANCE * 2 + 1e-9, ANGLE_TOLERANCE * 2 + 1e-9))) return null;
    } else { solution = candidate; matches = matching; }
  }
  if (!solution) return null;
  // Average all independent frame pairs instead of retaining one anchor's
  // float32 translation error. Validate the resulting fit again before use.
  const rotations = rooms.map((room, i) => angle(observed[matches[i]].rotation - room.rotation));
  const rotation = Math.atan2(rotations.reduce((sum, value) => sum + Math.sin(value), 0),
    rotations.reduce((sum, value) => sum + Math.cos(value), 0));
  const c = Math.cos(rotation), s = Math.sin(rotation), refined = { x: 0, y: 0, z: 0, rotation };
  rooms.forEach((room, i) => {
    const world = observed[matches[i]];
    refined.x += (world.x - c * room.x - s * room.z) / rooms.length;
    refined.y += (world.y - room.y) / rooms.length;
    refined.z += (world.z + s * room.x - c * room.z) / rooms.length;
  });
  if (!match(rooms, observed, refined)) return null;
  return validateRoot({ source: 'level-info-fit', levelPath: state.levelPath, layoutCode: state.layoutCode, matrix: matrix(refined) });
}

module.exports = { fitDungeonFrames };
