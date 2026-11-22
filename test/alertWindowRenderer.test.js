'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/alert-window.js'), 'utf8');

function fixture(motionDuration = 350) {
  let now = 0, nextId = 0, alertData, dismisses = 0, motionCalls = 0;
  const timers = new Map(), frames = new Map(), events = new Map(), nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', style: {}, events: new Map(), classes: new Set(),
      classList: { remove(name) { nodes.get(id).classes.delete(name); } },
      addEventListener(name, callback) { this.events.set(name, callback); } });
    return nodes.get(id);
  };
  const context = vm.createContext({ performance: { now: () => now },
    document: { getElementById: node },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setInterval() { assert.fail('Expiry must not depend on a coarse recurring interval'); },
    window: { api: { onAlertData(callback) { alertData = callback; }, dismissAlert() { dismisses++; } },
      OverkotMotion: { duration() { motionCalls++; return motionDuration; } }, addEventListener: (name, callback) => events.set(name, callback) },
  });
  vm.runInContext(source, context);
  return { timers, frames, node, get dismisses() { return dismisses; }, get motionCalls() { return motionCalls; },
    data: value => alertData(value), click: () => node('alert-close').events.get('click')(), unload: () => events.get('unload')(),
    frame(at) { now = at; const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(now); },
    advance(at) { now = at; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    fraction() { return Number(node('progress-fill').style.transform.match(/^scaleX\(([^)]+)\)$/)?.[1]); } };
}

test('each alert starts an eight-second clock when its payload arrives and paints subsecond progress', () => {
  const f = fixture();
  assert.equal(f.timers.size, 0, 'Loading an alert page must not consume its display time');
  assert.equal(f.frames.size, 0);
  f.advance(500);
  f.data({ name: 'Crafted item', readyLabel: 'Ready now', duration: 60000 });
  assert.equal(f.node('alert-name').textContent, 'Crafted item');
  assert.equal(f.node('alert-label').textContent, 'Ready now');
  assert.equal(f.fraction(), 1);
  assert.equal([...f.timers.values()][0].at, 8500, 'The completed game timer duration is unrelated to popup lifetime');
  f.frame(516); assert.equal(f.fraction(), .998);
  f.frame(532); assert.equal(f.fraction(), .996);
  f.frame(2500); assert.equal(f.fraction(), .75);
  assert.equal(f.node('progress-fill').style.width, undefined, 'The paint path does not trigger width layout or stepped CSS transitions');
  assert.equal(f.frames.size, 1);
});

test('X dismisses synchronously exactly once and immediately cancels pending frame and expiry work', () => {
  const f = fixture(3500); f.data({ name: 'Timer' });
  const queuedFrame = [...f.frames.values()][0], queuedExpiry = [...f.timers.values()][0].callback;
  f.click();
  assert.equal(f.dismisses, 1, 'IPC must be sent in the click handler without waiting for animation');
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.motionCalls, 0);
  f.click(); queuedFrame(); queuedExpiry(); f.advance(100000);
  assert.equal(f.dismisses, 1);
});

test('the independent deadline closes without animation frames and ignores decorative motion speed', () => {
  for (const duration of [0, 175, 350, 3500]) {
    const f = fixture(duration); f.data({ name: 'Ready' });
    f.advance(7999); assert.equal(f.dismisses, 0);
    f.advance(8000); assert.equal(f.dismisses, 1); assert.equal(f.fraction(), 0);
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.motionCalls, 0);
  }
});

test('a resumed animation frame observes actual elapsed time instead of extending a throttled alert', () => {
  const f = fixture(); f.data({});
  f.frame(7999); assert.ok(f.fraction() > 0 && f.fraction() < .001);
  f.frame(9000); assert.equal(f.fraction(), 0); assert.equal(f.dismisses, 1);
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
});

test('a subsequent payload resets the bar and deadline and obsolete callbacks cannot dismiss the new alert', () => {
  const f = fixture(); f.data({ name: 'First' });
  const oldFrame = [...f.frames.values()][0], oldExpiry = [...f.timers.values()][0].callback;
  f.frame(4000); assert.equal(f.fraction(), .5);
  f.data({ name: 'Second' });
  assert.equal(f.node('alert-name').textContent, 'Second'); assert.equal(f.node('alert-label').textContent, 'Ready');
  assert.equal(f.fraction(), 1); assert.equal(f.timers.size, 1); assert.equal(f.frames.size, 1);
  oldFrame(); oldExpiry(); assert.equal(f.fraction(), 1); assert.equal(f.dismisses, 0);
  f.advance(8000); assert.equal(f.dismisses, 0, 'The earlier alert deadline has been cancelled');
  f.frame(10000); assert.equal(f.fraction(), .25);
  f.advance(12000); assert.equal(f.dismisses, 1);
});

test('unload cancels schedules and ignores queued work or later payloads', () => {
  const f = fixture(); f.data({ name: 'First' });
  const queuedFrame = [...f.frames.values()][0], queuedExpiry = [...f.timers.values()][0].callback;
  f.unload(); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  queuedFrame(); queuedExpiry(); f.data({ name: 'Late' }); f.click();
  assert.equal(f.node('alert-name').textContent, 'First'); assert.equal(f.dismisses, 0);
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
});

test('alert progress uses a fixed-width transform and has no independent CSS sixty-second countdown', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/alert-window.html'), 'utf8');
  assert.match(html, /transform-origin:\s*left center/);
  assert.doesNotMatch(html, /@keyframes countdown|animation:\s*countdown|60s/);
  assert.match(html, /class="alert-close"[^>]*aria-label="Dismiss alert"/);
});

test('the passive alert has no native caption drag region that can obscure its translated X hit target', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/alert-window.html'), 'utf8');
  assert.match(html, /body\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(html, /\.alert-close\s*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.doesNotMatch(html, /-webkit-app-region:\s*drag\s*;/);
});
