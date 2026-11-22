'use strict';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6;
const level = value => typeof value === 'string' && /^\/SF\/Levels\/Procs\/[A-Za-z0-9_/-]{1,512}$/.test(value)
  && !value.includes('//');
const code = value => typeof value === 'string' && /^[A-Za-z0-9+\-]{1,4096}$/.test(value);
const EPSILON = .001;
const sources = new Set(['stream-region', 'level-info-fit']);

/** Validate only a proper upright engine world transform, never a guessed origin. */
function validateMatrix(value) {
  if (!Array.isArray(value) || value.length !== 16 || !Array.from(value).every(finite)) return null;
  const m = value;
  if (Math.abs(m[15] - 1) > EPSILON || [3, 7, 11].some(i => Math.abs(m[i]) > EPSILON)
    || [1, 4, 6, 9].some(i => Math.abs(m[i]) > EPSILON) || Math.abs(m[5] - 1) > EPSILON) return null;
  for (let axis = 0; axis < 3; axis++) {
    const dot = other => [0, 1, 2].reduce((sum, i) => sum + m[axis * 4 + i] * m[other * 4 + i], 0);
    if (Math.abs(dot(axis) - 1) > EPSILON) return null;
    for (let other = axis + 1; other < 3; other++) if (Math.abs(dot(other)) > EPSILON) return null;
  }
  const determinant = m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (Math.abs(determinant - 1) > EPSILON) return null;
  return [...m];
}

function validateRoot(value) {
  if (!plain(value) || !sources.has(value.source) || !level(value.levelPath)
    || (Object.hasOwn(value, 'layoutCode') && !code(value.layoutCode))) return null;
  const matrix = validateMatrix(value.matrix);
  if (!matrix) return null;
  return { source: value.source, levelPath: value.levelPath,
    ...(value.layoutCode !== undefined ? { layoutCode: value.layoutCode } : {}), matrix };
}

function validRootAlignment(value) {
  return plain(value) && value.schema === 2 && sources.has(value.source) && value.points === 0 && value.error === 0
    && level(value.levelPath) && code(value.layoutCode) && Number.isFinite(value.yaw) && Math.abs(value.yaw) <= Math.PI
    && plain(value.translation) && finite(value.translation.x) && finite(value.translation.z) && finite(value.height);
}

function alignmentFromRoot(value, state) {
  const root = validateRoot(value);
  if (!root || state?.active !== true || state.status !== 'ready' || !state.instanceId
    || !code(state.layoutCode) || root.levelPath !== state.levelPath
    || (root.layoutCode !== undefined && root.layoutCode !== state.layoutCode)) return null;
  // Placement belongs to the generator. Topology and discovery are separately
  // bound to the current trusted log entry, even when native has no fingerprint.
  return { schema: 2, source: root.source, levelPath: root.levelPath, layoutCode: state.layoutCode,
    yaw: Math.atan2(root.matrix[8], root.matrix[10]), translation: { x: root.matrix[12], z: root.matrix[14] },
    height: root.matrix[13], points: 0, error: 0 };
}

function selectRoot(values, state) {
  if (!Array.isArray(values) || values.length > 32) return null;
  const matching = values.map(validateRoot).filter(root => root && alignmentFromRoot(root, state));
  if (!matching.length) return null;
  const first = matching[0];
  if (matching.some(root => root.matrix.some((number, i) => Math.abs(number - first.matrix[i]) > 1e-4))) return null;
  return first;
}

module.exports = { validateMatrix, validateRoot, alignmentFromRoot, validRootAlignment, selectRoot };
