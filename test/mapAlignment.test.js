'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transformPoint } = require('../src/modules/dungeonLayout');
const { fitAlignment, validAlignment, worldToMap, mapToWorld, headingToMap, pointInScene } = require('../src/modules/mapAlignment');

const localPoints = [{ x: -20, z: -10 }, { x: 30, z: 0 }, { x: 10, z: 40 }];
const worldPoint = (point, yaw = 0, translation = { x: 120, z: -320 }) => {
  const [x, , z] = transformPoint([point.x, 0, point.z], { ...translation, y: 0, rotation: yaw });
  return { x, z };
};
const samples = (yaw = 0) => localPoints.map(map => ({ map: { ...map }, world: worldPoint(map, yaw) }));
const near = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
};

test('three points verify cardinal and arbitrary rotations using the dungeon engine convention', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.63]) {
    const result = fitAlignment(samples(yaw));
    assert.equal(result.ok, true);
    assert.equal(validAlignment(result.alignment), true);
    near(Math.sin(result.alignment.yaw), Math.sin(yaw));
    near(Math.cos(result.alignment.yaw), Math.cos(yaw));
    near(result.alignment.translation.x, 120); near(result.alignment.translation.z, -320);
    near(result.alignment.error, 0);
    assert.equal(result.alignment.points, 3);
    for (const map of [...localPoints, { x: 83, z: -71 }]) {
      const expected = worldPoint(map, yaw), actual = mapToWorld(map, result.alignment);
      near(actual.x, expected.x); near(actual.z, expected.z);
      const inverse = worldToMap(actual, result.alignment);
      near(inverse.x, map.x); near(inverse.z, map.z);
    }
    near(headingToMap(47, result.alignment), 47 - result.alignment.yaw * 180 / Math.PI);
  }
});

test('heading alignment maps the world facing back into the layout frame', () => {
  const { alignment } = fitAlignment(samples(Math.PI / 2));
  near(headingToMap(90, alignment), 0);
  near(headingToMap(0, alignment), -90);
  near(headingToMap(180, alignment), 90);
});

test('small map-click rounding errors are tolerated without fitting scale', () => {
  const observations = samples(0.63);
  const offsets = [[0.5, -0.5], [-0.5, 0.5], [0.8, 0.4]];
  observations.forEach((sample, index) => { sample.map.x += offsets[index][0]; sample.map.z += offsets[index][1]; });
  const result = fitAlignment(observations);
  assert.equal(result.ok, true);
  assert.ok(result.alignment.error > 0 && result.alignment.error < 1.5);
  const a = mapToWorld({ x: 0, z: 0 }, result.alignment);
  const b = mapToWorld({ x: 100, z: 0 }, result.alignment);
  near(Math.hypot(a.x - b.x, a.z - b.z), 100);
  assert.equal(Object.hasOwn(result.alignment, 'scale'), false);
});

test('calibration requires three separated non-collinear observations', () => {
  for (const points of [null, [], samples().slice(0, 2), [...samples(), samples()[0]],
    [{ map: null, world: { x: 0, z: 0 } }, ...samples().slice(1)],
    samples().map((sample, index) => index ? sample : { ...sample, world: { x: NaN, z: 0 } })]) {
    const result = fitAlignment(points);
    assert.equal(result.ok, false); assert.equal(typeof result.message, 'string');
  }
  const matching = points => points.map(map => ({ map, world: { ...map } }));
  assert.match(fitAlignment(matching([{ x: 0, z: 0 }, { x: 7.9, z: 0 }, { x: 0, z: 20 }])).message, /8 game units/);
  assert.match(fitAlignment(matching([{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 40, z: 0 }])).message, /turn/);
  assert.match(fitAlignment(matching([{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 40, z: 2 }])).message, /turn/);
});

test('scaled, reflected and incorrectly matched third observations are rejected', () => {
  const scaled = samples().map(sample => ({ ...sample, world: { x: sample.map.x * 1.5, z: sample.map.z * 1.5 } }));
  assert.equal(fitAlignment(scaled).ok, false);
  const reflected = samples().map(sample => ({ ...sample, world: { x: sample.map.x, z: -sample.map.z } }));
  assert.equal(fitAlignment(reflected).ok, false);
  const wrongThird = samples(); wrongThird[2].world.x += 8;
  const result = fitAlignment(wrongThird);
  assert.equal(result.ok, false); assert.match(result.message, /third point/);
});

test('unverified or malformed transforms and nonfinite positions never produce a location', () => {
  const { alignment } = fitAlignment(samples());
  for (const invalid of [null, {}, { ...alignment, schema: 2 }, { ...alignment, points: 2 },
    { ...alignment, yaw: Infinity }, { ...alignment, yaw: 8 }, { ...alignment, translation: { x: 0, z: NaN } },
    { ...alignment, error: -1 }, { ...alignment, error: 5 }]) {
    assert.equal(validAlignment(invalid), false);
    assert.equal(worldToMap({ x: 0, z: 0 }, invalid), null);
    assert.equal(mapToWorld({ x: 0, z: 0 }, invalid), null);
    assert.equal(headingToMap(0, invalid), null);
  }
  for (const value of [null, {}, { x: Infinity, z: 0 }, { x: 0, z: NaN }, { x: 1e20, z: 0 }]) {
    assert.equal(worldToMap(value, alignment), null);
    assert.equal(mapToWorld(value, alignment), null);
  }
  assert.equal(headingToMap(null, alignment), null);
  assert.equal(headingToMap(NaN, alignment), null);
});

const square = { closed: true, points: [[0, 0], [30, 0], [30, 30], [0, 30]] };
const hole = { closed: true, points: [[10, 10], [10, 20], [20, 20], [20, 10]] };
const scene = (outline = [square], transform = { x: 120, z: -320, rotation: Math.PI / 2 }) => ({ mode: 'placed', rooms: [{ outline, transform }] });

test('walkable-floor checks use placed room rotation, translation and optional scale', () => {
  const map = scene();
  assert.equal(pointInScene(map, worldPoint({ x: 5, z: 15 }, Math.PI / 2)), true);
  assert.equal(pointInScene(map, worldPoint({ x: 0, z: 15 }, Math.PI / 2)), true, 'floor boundaries are included');
  assert.equal(pointInScene(map, worldPoint({ x: -0.1, z: 15 }, Math.PI / 2)), false);
  const scaled = scene([square], { x: 0, z: 0, rotation: 0, scale: 2 });
  assert.equal(pointInScene(scaled, { x: 50, z: 50 }), true);
  assert.equal(pointInScene(scaled, { x: 61, z: 50 }), false);
});

test('walkable-floor checks preserve holes with the renderer nonzero winding convention', () => {
  const map = scene([square, hole], { x: 0, z: 0, rotation: 0 });
  assert.equal(pointInScene(map, { x: 5, z: 15 }), true);
  assert.equal(pointInScene(map, { x: 15, z: 15 }), false);
  assert.equal(pointInScene(map, { x: 10, z: 15 }), true, 'hole edge belongs to the floor boundary');
  assert.equal(pointInScene(scene([square, { ...hole, points: [...hole.points].reverse() }], { x: 0, z: 0, rotation: 0 }), { x: 15, z: 15 }), true,
    'same-direction rings are filled by the actual renderer');
});

test('schematics, missing/open/degenerate geometry and malformed transforms cannot verify a floor click', () => {
  for (const invalid of [null, { ...scene(), mode: 'schematic' }, { mode: 'placed', rooms: [] },
    scene([]), scene([{ ...square, closed: false }]), scene([{ closed: true, points: [[0, 0], [10, 0], [20, 0]] }]),
    scene([{ closed: true, points: [[0, 0], [10, NaN], [0, 20]] }]),
    scene([square], { x: 0, z: 0, rotation: NaN }), scene([square], { x: 0, z: 0, rotation: 0, scale: 0 })]) {
    assert.equal(pointInScene(invalid, { x: 0, z: 0 }), false);
  }
  assert.equal(pointInScene(scene(), null), false);
});
