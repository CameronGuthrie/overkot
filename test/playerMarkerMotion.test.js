'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayerMarkerMotion } = require('../src/modules/playerMarkerMotion');

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('heading wraps from 359 to 1 by two degrees through north and never spins backwards', () => {
  let now = 0; const motion = createPlayerMarkerMotion({ now: () => now });
  motion.setHeading(359); motion.setHeading(1);
  near(motion.sample(30).heading, 359.3125);
  near(motion.sample(60).heading, 0);
  near(motion.sample(90).heading, 0.6875);
  assert.equal(motion.sample(120).animating, false); near(motion.sample(120).heading, 1);
  now = 120; motion.setHeading(359);
  near(motion.sample(180).heading, 0);
  near(motion.sample(240).heading, 359);
});

test('retargeting starts at the currently displayed heading without jumping or restarting identical targets', () => {
  let now = 0; const motion = createPlayerMarkerMotion({ now: () => now });
  motion.setHeading(0); motion.setHeading(90);
  now = 60; near(motion.sample().heading, 45);
  motion.setHeading(180); near(motion.sample().heading, 45);
  now = 120; near(motion.sample().heading, 112.5);
  motion.setHeading(180);
  now = 180; near(motion.sample().heading, 180);
  assert.equal(motion.sample().animating, false);
});

test('context reset, unknown headings and immediate observations cancel pending motion', () => {
  let now = 0; const motion = createPlayerMarkerMotion({ now: () => now });
  motion.setHeading(20); motion.setHeading(120); now = 40;
  assert.equal(motion.sample().animating, true);
  assert.deepEqual(motion.reset(), { heading: null, animating: false });
  now = 200; assert.deepEqual(motion.sample(), { heading: null, animating: false });
  motion.setHeading(300); near(motion.sample().heading, 300);
  motion.setHeading(90, { immediate: true }); near(motion.sample().heading, 90);
  assert.equal(motion.sample().animating, false);
  motion.setHeading(NaN); assert.equal(motion.sample().heading, null);
});

test('heading interpolation normalizes turns, bounds time and rejects malformed options', () => {
  let now = 10; const motion = createPlayerMarkerMotion({ now: () => now });
  motion.reset(-90); near(motion.sample().heading, 270);
  motion.setHeading(450); near(motion.sample(-100).heading, 270);
  near(motion.sample(1000).heading, 90);
  const instant = createPlayerMarkerMotion({ duration: 0 }); instant.setHeading(14); instant.setHeading(28);
  assert.deepEqual(instant.sample(), { heading: 28, animating: false });
  for (const duration of [-1, NaN, Infinity]) assert.throws(() => createPlayerMarkerMotion({ duration }), RangeError);
  assert.throws(() => createPlayerMarkerMotion({ now: 1 }), TypeError);
});
