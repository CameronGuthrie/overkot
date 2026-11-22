const test = require('node:test');
const assert = require('node:assert/strict');
const AncestorMarkers = require('../src/renderer/ancestor-markers');

// Capture the public canvas drawing operations, including the paths being
// filled, so the tests check displayed geometry without inventing pixel data.
function canvas() {
  const calls = { fills: [], halos: [], gradients: [], strokes: [], text: [], rectangles: [], transforms: [] };
  let path = [];
  return {
    calls,
    save() {},
    restore() {},
    setTransform(...args) { calls.transforms.push(args); },
    beginPath() { path = []; },
    createRadialGradient(...args) {
      const gradient = { args, stops: [], addColorStop(offset, color) { this.stops.push({ offset, color }); } };
      calls.gradients.push(gradient);
      return gradient;
    },
    arc(x, y, radius) { path.push({ kind: 'arc', x, y, radius }); },
    roundRect(x, y, width, height, radius) { path.push({ kind: 'label', x, y, width, height, radius }); },
    fill() { (this.fillStyle?.stops ? calls.halos : calls.fills).push(...path.map(shape => ({ ...shape }))); },
    stroke() { calls.strokes.push(...path.map(shape => ({ ...shape }))); },
    strokeRect(x, y, width, height) { calls.rectangles.push({ x, y, width, height }); },
    measureText(value) { return { width: value.length * 7 }; },
    fillText(value, x, y) { calls.text.push({ value, x, y }); },
  };
}

const ancestor = (overrides = {}) => ({
  id: 'encounter-1', x: 42, z: -19, startedAt: 100, ancestorName: 'Orlick', ...overrides,
});
const viewport = { width: 600, height: 400, project: (x, z) => ({ x: 300 + x, y: 200 + z }) };
const dots = ctx => ctx.calls.fills.filter(shape => shape.kind === 'arc');
const labels = ctx => ctx.calls.fills.filter(shape => shape.kind === 'label');

test('ancestor dots use the exact projected x/z position and keep a six-pixel radius at every zoom', () => {
  const marker = ancestor();
  const layer = AncestorMarkers.create({ now: () => 1000, reducedMotion: () => true });
  layer.update([marker]);
  for (const zoom of [0.3, 1, 2]) {
    const ctx = canvas();
    const projected = Object.freeze({ x: 300 + marker.x * zoom, y: 200 + marker.z * zoom });
    const input = [];
    const active = layer.draw(ctx, {
      ...viewport,
      project: (x, z) => { input.push([x, z]); return projected; },
    });
    assert.equal(active, false);
    assert.deepEqual(input, [[42, -19], [92, -19]]);
    assert.deepEqual(dots(ctx), [{ kind: 'arc', ...projected, radius: 6 }]);
    assert.deepEqual(ctx.calls.transforms, [[1, 0, 0, 1, 0, 0]], 'dot size is measured in screen pixels');
    assert.equal(layer.titleAt(projected.x, projected.y), 'Orlick — approximate location; search nearby');
  }
  assert.deepEqual(marker, ancestor(), 'drawing must not move the world coordinate');
});

test('fuzzy search area covers a 50-world-unit radius at every zoom and fades to transparent', () => {
  const layer = AncestorMarkers.create({ now: () => 9000, reducedMotion: () => true });
  const marker = ancestor({ ancestorName: 'Bromius', x: 248.954, z: -391.512 });
  layer.update([marker], { notify: false });
  for (const zoom of [0.03, 0.3, 1, 2, 4]) {
    const ctx = canvas();
    const project = (x, z) => ({ x: 300 + (x - marker.x) * 2 * zoom, y: 200 - (z - marker.z) * 2 * zoom });
    assert.equal(layer.draw(ctx, { ...viewport, project }), false, 'a static search area needs no animation');
    const [halo] = ctx.calls.halos;
    assert.deepEqual(halo, { kind: 'arc', x: 300, y: 200, radius: 100 * zoom });
    assert.deepEqual(dots(ctx), [{ kind: 'arc', x: 300, y: 200, radius: 6 }]);
    const sighting = project(293, -387);
    assert.ok(Math.hypot(sighting.x - halo.x, sighting.y - halo.y) < halo.radius, 'the measured Bromius sighting falls inside the search area');
    const [gradient] = ctx.calls.gradients;
    assert.deepEqual(gradient.args, [300, 200, 0, 300, 200, 100 * zoom]);
    assert.equal(gradient.stops.at(-1).offset, 1);
    assert.equal(gradient.stops.at(-1).color, 'rgba(199, 146, 234, 0)');
    const alpha = gradient.stops.map(stop => Number(stop.color.match(/, ([\d.]+)\)$/)[1]));
    assert.ok(alpha[0] > 0 && alpha[0] < 1, 'terrain remains visible through the centre');
    assert.ok(alpha.every((a, i) => i === 0 || a < alpha[i - 1]), 'opacity decreases toward the edge');
  }
});

test('search area clips naturally at the viewport without relocating an offscreen centre dot', () => {
  const layer = AncestorMarkers.create({ reducedMotion: () => true });
  layer.update([ancestor({ x: -320, z: 0 })], { notify: false });
  const ctx = canvas();
  assert.equal(layer.draw(ctx, viewport), false);
  assert.deepEqual(ctx.calls.halos, [{ kind: 'arc', x: -20, y: 200, radius: 50 }]);
  assert.equal(dots(ctx).length, 0);
  assert.equal(ctx.calls.text.length, 0);
  assert.equal(layer.titleAt(0, 200), '');

  layer.update([ancestor({ x: -400, z: 0 })], { notify: false });
  const outside = canvas();
  layer.draw(outside, viewport);
  assert.equal(outside.calls.gradients.length, 0, 'fully offscreen areas are culled');
});

test('an isolated ancestor label appears below the dot and both expose its name on hover', () => {
  const layer = AncestorMarkers.create({ reducedMotion: () => true });
  layer.update([ancestor()]);
  const ctx = canvas();
  layer.draw(ctx, viewport);
  const [dot] = dots(ctx);
  const [label] = labels(ctx);
  const [text] = ctx.calls.text;
  assert.equal(text.value, 'Orlick');
  assert.ok(label.y > dot.y + dot.radius);
  assert.equal(text.x, dot.x);
  assert.ok(text.y > label.y && text.y < label.y + label.height);
  assert.equal(layer.titleAt(text.x, text.y), 'Orlick — approximate location; search nearby');
  assert.equal(layer.titleAt(0, 0), '');
});

test('overlapping label layout does not displace either encounter dot', () => {
  const layer = AncestorMarkers.create({ reducedMotion: () => true });
  layer.update([ancestor(), ancestor({ id: 'encounter-2', x: 44, z: -18, ancestorName: 'Avakot' })]);
  const ctx = canvas();
  layer.draw(ctx, viewport);
  assert.deepEqual(dots(ctx), [
    { kind: 'arc', x: 342, y: 181, radius: 6 },
    { kind: 'arc', x: 344, y: 182, radius: 6 },
  ]);
  const [first, second] = labels(ctx);
  assert.ok(first.y + first.height <= second.y || second.y + second.height <= first.y);
});

test('new discoveries pulse for six seconds and repeated snapshots do not restart the animation', () => {
  let time = 1000;
  const layer = AncestorMarkers.create({ now: () => time, reducedMotion: () => false });
  layer.update([ancestor()]);
  assert.equal(layer.draw(canvas(), viewport), true);
  time = 6999;
  assert.equal(layer.draw(canvas(), viewport), true);
  time = 7000;
  const expired = canvas();
  assert.equal(layer.draw(expired, viewport), false);
  assert.equal(expired.calls.strokes.filter(shape => shape.kind === 'arc').length, 1, 'only the dot outline remains');
  assert.equal(expired.calls.rectangles.length, 0);
  assert.equal(expired.calls.halos.length, 1, 'the fuzzy search area persists after the discovery pulse ends');
  time = 8000;
  layer.update([ancestor()]);
  assert.equal(layer.draw(canvas(), viewport), false);
  layer.update([ancestor({ startedAt: 200 })]);
  assert.equal(layer.draw(canvas(), viewport), true, 'a later encounter may attract attention again');
});

test('resolving an unknown ancestor attracts attention once and updates the displayed name', () => {
  let time = 1000;
  const layer = AncestorMarkers.create({ now: () => time, reducedMotion: () => false });
  layer.update([ancestor({ ancestorName: null })], { notify: false });
  const unknown = canvas();
  assert.equal(layer.draw(unknown, viewport), false);
  assert.equal(unknown.calls.text[0].value, 'Unknown Ancestor');
  time = 2000;
  layer.update([ancestor({ ancestorName: '  Orlick  ' })]);
  const named = canvas();
  assert.equal(layer.draw(named, viewport), true);
  assert.equal(named.calls.text[0].value, 'Orlick');
  time = 8000;
  layer.update([ancestor()]);
  assert.equal(layer.draw(canvas(), viewport), false);
});

test('reduced motion keeps the dot and label visible without animated rings or rim', () => {
  const layer = AncestorMarkers.create({ now: () => 1000, reducedMotion: () => true });
  layer.update([ancestor()]);
  const ctx = canvas();
  assert.equal(layer.draw(ctx, viewport), false);
  assert.equal(dots(ctx).length, 1);
  assert.equal(ctx.calls.text[0].value, 'Orlick');
  assert.equal(ctx.calls.strokes.filter(shape => shape.kind === 'arc').length, 1);
  assert.equal(ctx.calls.rectangles.length, 0);
});

test('initial snapshots draw quietly and request a repaint', async () => {
  let repaints = 0;
  const layer = AncestorMarkers.create({ now: () => 1000, reducedMotion: () => false, requestRender: () => repaints++ });
  layer.connect({ getAncestors: async () => [ancestor()] });
  await Promise.resolve();
  const ctx = canvas();
  assert.equal(layer.draw(ctx, viewport), false);
  assert.equal(dots(ctx).length, 1);
  assert.equal(repaints, 1);
});

test('a late initial snapshot cannot replace a live discovery or restore a removed marker', async () => {
  for (const liveMarkers of [[ancestor({ ancestorName: 'Avakot' })], []]) {
    let deliverLive;
    let resolveInitial;
    const initial = new Promise(resolve => { resolveInitial = resolve; });
    const layer = AncestorMarkers.create({ reducedMotion: () => true });
    layer.connect({
      onAncestors: callback => { deliverLive = callback; },
      getAncestors: () => initial,
    });
    deliverLive(liveMarkers);
    resolveInitial([ancestor()]);
    await initial;
    const ctx = canvas();
    layer.draw(ctx, viewport);
    assert.deepEqual(ctx.calls.text.map(item => item.value), liveMarkers.map(item => item.ancestorName));
  }
});

test('removal immediately clears the old hover targets and repaints the map', () => {
  let repaints = 0;
  const layer = AncestorMarkers.create({ reducedMotion: () => true, requestRender: () => repaints++ });
  layer.update([ancestor()]);
  const ctx = canvas();
  layer.draw(ctx, viewport);
  const [label] = ctx.calls.text;
  assert.equal(layer.titleAt(342, 181), 'Orlick — approximate location; search nearby');
  layer.update([]);
  assert.equal(layer.titleAt(342, 181), '');
  assert.equal(layer.titleAt(label.x, label.y), '');
  assert.equal(repaints, 2);
  const empty = canvas();
  assert.equal(layer.draw(empty, viewport), false);
  assert.equal(empty.calls.fills.length, 0);
});

test('offscreen discoveries briefly highlight the rim without creating a misplaced dot or permanent animation', () => {
  let time = 1000;
  const layer = AncestorMarkers.create({ now: () => time, reducedMotion: () => false });
  layer.update([ancestor({ x: 10000 })]);
  const initial = canvas();
  assert.equal(layer.draw(initial, viewport), true);
  assert.equal(dots(initial).length, 0);
  assert.equal(initial.calls.text.length, 0);
  assert.equal(initial.calls.rectangles.length, 1);
  assert.equal(layer.titleAt(342, 181), '');
  time = 7000;
  const expired = canvas();
  assert.equal(layer.draw(expired, viewport), false);
  assert.equal(expired.calls.rectangles.length, 0);
});

test('long names fit the map label while the dot and label hover preserve the full name', () => {
  const name = 'A particularly long ancestor name which does not fit on the minimap';
  const layer = AncestorMarkers.create({ reducedMotion: () => true });
  layer.update([ancestor({ ancestorName: name })]);
  const ctx = canvas();
  layer.draw(ctx, { width: 180, height: 140, project: () => ({ x: 90, y: 60 }) });
  const [label] = labels(ctx);
  const [text] = ctx.calls.text;
  assert.notEqual(text.value, name);
  assert.ok(text.value.endsWith('…'));
  assert.ok(label.x >= 0 && label.x + label.width <= 180);
  assert.equal(layer.titleAt(90, 60), `${name} — approximate location; search nearby`);
  assert.equal(layer.titleAt(text.x, text.y), `${name} — approximate location; search nearby`);
});

test('invalid locations are omitted and a rejected initial snapshot leaves live detection working', async () => {
  let deliverLive;
  const layer = AncestorMarkers.create({ reducedMotion: () => true });
  layer.connect({
    onAncestors: callback => { deliverLive = callback; },
    getAncestors: () => Promise.reject(new Error('IPC unavailable')),
  });
  await Promise.resolve();
  deliverLive([null, ancestor({ id: null }), ancestor({ x: NaN }), ancestor({ z: Infinity }), ancestor()]);
  const ctx = canvas();
  layer.draw(ctx, viewport);
  assert.equal(dots(ctx).length, 1);
  assert.deepEqual(ctx.calls.text.map(item => item.value), ['Orlick']);
});
