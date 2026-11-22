'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rendererRoot = path.join(__dirname, '../src/renderer');
const source = fs.readFileSync(path.join(rendererRoot, 'world-drop-markers.js'), 'utf8');

const drop = (overrides = {}) => ({ id: 'drop-a', kind: 'weapon', name: 'Stultin', shiny: null, position: { x: 10, y: 0, z: 5 }, ...overrides });
const sample = (items = [drop()], overrides = {}) => ({ status: 'found', source: 'memory', sampledAt: 10000,
  trackingSession: 'game-a', instanceId: 'world-a', isOverworld: true, zone: '/SF/Levels/MidrathRedux',
  position: { x: 0, y: 0, z: 0 }, worldDrops: { status: 'available', sampledAt: 10000, items }, ...overrides });

function fixture({ reducedMotion = false } = {}) {
  let now = 10000, nextTimer = 0, redraws = 0;
  const timers = new Map(), calls = [];
  const context = vm.createContext({ module: { exports: {} }, Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  const layer = context.module.exports.create({ requestRender() { redraws++; }, reducedMotion: () => reducedMotion });
  const canvas = new Proxy({ measureText: text => ({ width: text.length * 6 }),
    fill() { calls.push(['fill', this.fillStyle, this.shadowBlur, this.shadowColor]); },
    stroke() { calls.push(['stroke', this.strokeStyle, this.lineWidth]); },
    fillText(text, x, y) { calls.push(['fillText', text, x, y, this.fillStyle, this.font]); },
    strokeText(text, x, y) { calls.push(['strokeText', text, x, y, this.strokeStyle, this.lineWidth]); },
  }, { get: (target, key) => target[key] || ((...args) => calls.push([key, ...args])) });
  const draw = (options = {}) => layer.draw(canvas, { width: 300, height: 200, project: (x, z) => ({ x: 150 + x, y: 100 - z }), ...options });
  return { layer, calls, timers, draw, get redraws() { return redraws; }, setTime(value) { now = value; }, setReducedMotion(value) { reducedMotion = value; },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } } };
}

test('ordinary drops keep white dots while verified Moonsteel uses the selected purple star and actual weapon name', () => {
  const f = fixture();
  f.layer.update(sample([drop(), drop({ id: 'shiny', name: 'Moonsteel Stultin', shiny: true, position: { x: -10, y: 0, z: 5 } })]));
  assert.equal(f.draw(), 2);
  assert.deepEqual(f.calls.filter(call => call[0] === 'arc').map(call => call[3]), [3]);
  assert.ok(f.calls.some(call => call[0] === 'fill' && call[1] === '#da75ff' && call[2] === 9 && call[3] === '#da75ff'), 'Shiny star has the selected purple fill and glow');
  assert.ok(f.calls.some(call => call[0] === 'stroke' && call[1] === '#ffffff' && call[2] === 2.5), 'Shiny star uses the selected white outline');
  assert.equal(f.calls.filter(call => call[0] === 'lineTo').length, 11, 'Five-point star and small corner sparkle have distinct silhouettes');
  const labels = f.calls.filter(call => call[0] === 'fillText');
  assert.deepEqual(labels.map(call => [call[1], call[4], call[5]]), [['Stultin', '#fff', '600 11px system-ui'], ['Moonsteel Stultin', '#e098fb', '700 12px system-ui']]);
  assert.ok(f.calls.some(call => call[0] === 'strokeText' && call[1] === 'Moonsteel Stultin' && call[4] === '#000000' && call[5] === 2), 'Shiny name uses the selected solid black text outline');
  assert.ok(labels.every(call => call[3] > 95), 'Names remain under their actual anchors');
  assert.ok(f.calls.some(call => call[0] === 'clip'), 'Drawings are clipped to the map viewport');
  f.layer.clear();
});

test('breathing advances through fresh telemetry without moving the weapon label', () => {
  const f = fixture(), item = drop({ shiny: true, name: 'Palladino', position: { x: 50, y: 0, z: 5 } });
  const refresh = time => { f.setTime(time); f.layer.update(sample([item], { sampledAt: time, worldDrops: { status: 'available', sampledAt: time, items: [item] } })); };
  refresh(10000); f.draw();
  const firstLabel = f.calls.find(call => call[0] === 'fillText');
  assert.equal(firstLabel[1], 'Palladino', 'The preview sample name is never hardcoded into live drops');
  assert.equal(firstLabel[3], 109, 'The selected text offset is fourteen pixels below the anchor');
  assert.ok(f.calls.some(call => call[0] === 'scale' && call[1] === 1.15));
  f.calls.length = 0; refresh(10500); f.draw();
  assert.ok(f.calls.some(call => call[0] === 'scale' && call[1] === 1.3), 'Telemetry refresh does not restart the breathing cycle');
  assert.ok(f.calls.some(call => call[0] === 'translate' && call[1] === 200 && call[2] === 92), 'The selected float rises three pixels');
  assert.deepEqual(f.calls.find(call => call[0] === 'fillText'), firstLabel, 'Text remains still during icon motion');
  assert.equal(f.redraws, 2, 'Each painted shiny frame asks the host for one next animation frame');
  f.layer.clear();
});

test('animation stops when shiny drops are hidden, offscreen, stale, removed or motion is reduced', () => {
  const f = fixture(), shiny = drop({ shiny: true });
  f.layer.update(sample([shiny])); f.draw(); assert.equal(f.redraws, 1);
  assert.equal(f.draw({ enabled: false }), 0);
  assert.equal(f.draw({ project: () => ({ x: -1, y: 10 }) }), 0);
  assert.equal(f.draw({ dungeon: { instanceId: 'different' } }), 0);
  assert.equal(f.redraws, 1, 'Invisible or unverified drops never keep animation running');
  f.setReducedMotion(true); f.calls.length = 0; f.draw();
  assert.ok(f.calls.some(call => call[0] === 'scale' && call[1] === 1), 'Reduced motion preserves the static star at its selected size');
  assert.equal(f.redraws, 1, 'Reduced motion never schedules animation frames');
  f.setReducedMotion(false); f.setTime(12001); assert.equal(f.draw(), 0);
  assert.equal(f.redraws, 1, 'A throttled expiry callback cannot keep a stale shiny animating');
  f.setTime(10000); f.layer.update(sample([])); assert.equal(f.draw(), 0);
  f.layer.update(sample([drop({ shiny: false })])); f.draw();
  f.layer.update(sample([drop()])); f.draw();
  assert.equal(f.redraws, 1, 'Pickups, ordinary weapons and unknown-shiny observations stop the animation chain');
  f.layer.clear(); assert.equal(f.draw(), 0); assert.equal(f.timers.size, 0);
});

test('complete snapshots remove pickups immediately and missing or unavailable feeds never retain detections', () => {
  const f = fixture();
  for (const next of [sample([]), sample([], { worldDrops: { status: 'unavailable', sampledAt: 10000, items: [] } }), sample([], { worldDrops: undefined }), { status: 'unavailable' }]) {
    f.layer.update(sample()); assert.equal(f.draw(), 1);
    f.layer.update(next); assert.equal(f.draw(), 0); assert.equal(f.timers.size, 0);
  }
});

test('drop timestamps expire independently of player timestamps, including throttled native-window timers', () => {
  const f = fixture();
  f.layer.update(sample([drop()], { worldDrops: { status: 'available', sampledAt: 9000, items: [drop()] } }));
  assert.equal([...f.timers.values()][0].at, 11001);
  f.setTime(11001); assert.equal(f.draw(), 0, 'A delayed expiry callback cannot paint an old drop');
  f.advance(0); assert.equal(f.redraws, 1);
  assert.equal(f.timers.size, 0);
  for (const invalid of [sample([drop()], { sampledAt: 8000 }), sample([drop()], { sampledAt: 12000 }), sample([drop()], { source: 'capture' })]) {
    f.layer.update(invalid); assert.equal(f.draw(), 0);
  }
});

test('fresh complete frames replace prior sessions and reject older frames from the same session', () => {
  const f = fixture();
  f.layer.update(sample());
  f.layer.update(sample([drop({ name: 'Old item' })], { worldDrops: { status: 'available', sampledAt: 9999, items: [drop({ name: 'Old item' })] } }));
  f.draw(); assert.equal(f.calls.find(call => call[0] === 'fillText')[1], 'Stultin');
  f.layer.update(sample([], { trackingSession: 'new-game', instanceId: 'new-entry' }));
  assert.equal(f.draw(), 0);
});

test('only nearby finite weapon anchors are eligible, and an unresolved name remains explicit', () => {
  const f = fixture();
  f.layer.update(sample([drop({ name: null }), drop({ id: 'far', position: { x: 81, y: 0, z: 0 } }),
    drop({ id: 'up', position: { x: 0, y: 81, z: 0 } }), drop({ id: 'not-weapon', kind: 'resource' }), drop({ id: 'invalid', position: { x: NaN, y: 0, z: 0 } })]));
  assert.equal(f.draw(), 1); assert.equal(f.calls.find(call => call[0] === 'fillText')[1], 'Dropped weapon');
  assert.equal(f.draw({ enabled: false }), 0);
  assert.equal(f.draw({ project: () => ({ x: -1, y: 100 }) }), 0, 'Offscreen drops never become edge indicators');
  f.layer.clear();
});

test('dungeon drops use only verified per-item alignment in the current discovered scope', () => {
  const f = fixture(), target = { instanceId: 'dungeon-a', revision: 'v1', coordinateSpace: 'layout-local', scope: 'alignment-a' };
  const mapped = { ...target, alignmentVerified: true, position: { x: 20, z: 30 } };
  const payload = extra => sample([drop({ position: { x: 1010, y: 0, z: 2005 }, dungeon: { ...mapped, ...extra } })],
    { isOverworld: false, instanceId: target.instanceId, position: { x: 1000, y: 0, z: 2000 } });
  const projected = [];
  const options = { dungeon: target, pixelRatio: 2, project: (x, z) => { projected.push([x, z]); return { x: x + 100, y: 100 - z }; }, isRevealed: (x, z) => x === 20 && z === 30 };
  f.layer.update(payload()); assert.equal(f.draw(options), 1); assert.deepEqual(projected, [[20, 30]], 'Raw world coordinates must never be used as layout-local coordinates');
  assert.ok(f.calls.some(call => call[0] === 'setTransform' && call[1] === 2 && call[4] === 2), 'Retina canvases retain screen-sized markers');
  assert.equal(f.draw({ ...options, isRevealed: () => false }), 0, 'Drop detection never reveals unexplored geometry');
  for (const bad of [{ alignmentVerified: false }, { instanceId: 'old-instance' }, { revision: 'old-revision' }, { coordinateSpace: 'world' }, { scope: 'old-alignment' }]) {
    f.layer.update(payload(bad)); assert.equal(f.draw(options), 0, JSON.stringify(bad));
  }
  f.layer.clear();
});

test('drop symbols retain the same screen size at different map zooms', () => {
  const f = fixture(); f.layer.update(sample());
  for (const zoom of [.2, 1, 3]) {
    f.calls.length = 0;
    assert.equal(f.draw({ project: (x, z) => ({ x: 100 + x * zoom, y: 100 - z * zoom }) }), 1);
    assert.equal(f.calls.find(call => call[0] === 'arc')[3], 3);
  }
  f.layer.clear();
});

test('every map document loads the common drop layer before its renderer', () => {
  for (const [html, renderer] of [['widget-host.html', 'dungeon-map.js'], ['widget-host.html', 'minimap.js'], ['dungeon-overlay.html', 'dungeon-map.js'], ['map-window.html', 'map-window.js']]) {
    const markup = fs.readFileSync(path.join(rendererRoot, html), 'utf8');
    const helper = markup.indexOf('<script src="world-drop-markers.js"');
    assert.ok(helper >= 0 && helper < markup.indexOf(`<script src="${renderer}"`), `${html} loads the layer before ${renderer}`);
  }
});
