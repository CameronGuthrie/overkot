'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const settings = require('../src/modules/moonsteelAlertSettings');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/moonsteel-alert.js'), 'utf8');

function fixture({ brokenAudio = false } = {}) {
  let data, nextTimer = 0, unsubscribed = false;
  const nodes = new Map(), timers = new Map(), events = new Map(), contexts = [];
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set(); nodes.set(id, { classes, offsetWidth: 100,
        classList: { add: value => classes.add(value), remove: value => classes.delete(value) } });
    }
    return nodes.get(id);
  };
  const style = new Map(), root = { dataset: {}, style: { setProperty: (key, value) => style.set(key, value) } };
  class AudioContext {
    constructor() { if (brokenAudio) throw new Error('Audio hardware unavailable'); this.state = 'suspended'; this.currentTime = 10; this.oscillators = []; this.gains = []; this.destination = {}; contexts.push(this); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createGain() {
      const ramps = [], gain = { gain: { value: 1, setValueAtTime: (...args) => ramps.push(['set', ...args]), exponentialRampToValueAtTime: (...args) => ramps.push(['ramp', ...args]) }, connect() {}, ramps };
      this.gains.push(gain); return gain;
    }
    createOscillator() {
      const oscillator = { frequency: { value: 0 }, connect() {}, start(at) { this.startAt = at; }, stop(at) { this.stopAt = at; } };
      this.oscillators.push(oscillator); return oscillator;
    }
  }
  const context = vm.createContext({
    document: { getElementById: node, documentElement: root },
    window: { MoonsteelAlertSettings: settings, AudioContext,
      moonsteelAlert: { onData(callback) { data = callback; return () => { unsubscribed = true; }; } },
      addEventListener: (name, callback) => events.set(name, callback) },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  return { node, root, style, timers, contexts, get unsubscribed() { return unsubscribed; },
    receive: async value => { data({ settings: value }); await new Promise(resolve => setImmediate(resolve)); },
    unload: async () => { events.get('unload')(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('the edge glow uses the chosen colour, inward softness and independent pulse and lifetime controls', async () => {
  const f = fixture(); await f.receive({ color: '#da75ff', borderWidth: 42, blur: 29, opacity: .8, duration: 6, pulseSpeed: 2, soundEnabled: false });
  assert.equal(f.style.get('--edge-color'), '#da75ff');
  assert.equal(f.style.get('--edge-width'), '42px'); assert.equal(f.style.get('--edge-spread'), '71px');
  assert.equal(f.style.get('--edge-opacity'), '0.8'); assert.equal(f.style.get('--alert-duration'), '6s'); assert.equal(f.style.get('--pulse-period'), '0.5s');
  assert(f.node('edge-glow').classes.has('active')); assert(f.node('flash-envelope').classes.has('active'));
  assert.equal(f.contexts.length, 0, 'Visual alerts do not require an audio device');
  await f.receive({ flashEnabled: false, soundEnabled: false });
  assert.equal(f.node('edge-glow').classes.has('active'), false);
  assert.equal(f.node('flash-envelope').classes.has('active'), false);
});

test('each sound preset has distinct bounded synthesized notes and obeys the chosen volume', async () => {
  const signatures = [];
  for (const sound of ['chime', 'soft', 'beacon']) {
    const f = fixture(); await f.receive({ sound, volume: .35, flashEnabled: false });
    const context = f.contexts[0];
    assert.equal(context.state, 'running'); assert.equal(context.gains[0].gain.value, .35);
    assert.equal(context.oscillators.length, 3);
    assert(context.oscillators.every(note => note.stopAt > note.startAt && note.stopAt < 11.5));
    assert.equal(f.root.dataset.soundPlayed, sound); assert.equal(f.root.dataset.audioState, 'running');
    signatures.push(context.oscillators.map(note => note.frequency.value).join(','));
    [...f.timers.values()][0].callback(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.state, 'closed');
  }
  assert.equal(new Set(signatures).size, 3);
});

test('muted sounds create no audio context, and replacement or unload cleans up previous audio work', async () => {
  const f = fixture(); await f.receive({ volume: 0 }); assert.equal(f.contexts.length, 0);
  await f.receive({ soundEnabled: false }); assert.equal(f.contexts.length, 0);
  await f.receive({ volume: .5 }); const previous = f.contexts[0]; assert.equal(f.timers.size, 1);
  await f.receive({ volume: .7 }); assert.equal(previous.state, 'closed'); assert.equal(f.timers.size, 1);
  const current = f.contexts[1]; await f.unload();
  assert.equal(current.state, 'closed'); assert.equal(f.timers.size, 0); assert.equal(f.unsubscribed, true);
  await f.receive({}); assert.equal(f.contexts.length, 2, 'Late payloads cannot recreate a disposed alert');
});

test('audio device failures leave the visual edge alert active', async () => {
  const f = fixture({ brokenAudio: true }); await f.receive({});
  assert.equal(f.root.dataset.audioState, 'failed'); assert(f.node('edge-glow').classes.has('active'));
});

test('transparent edge-only CSS has a reduced-motion fade instead of flashing', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/moonsteel-alert.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/moonsteel-alert.html'), 'utf8');
  assert.equal((css.match(/linear-gradient\(/g) || []).length, 4);
  assert.match(css, /background:\s*transparent/); assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /#edge-glow\.active\s*\{\s*animation:\s*none/);
  assert.match(html, /default-src 'none'; script-src 'self'/);
  assert.doesNotMatch(html, /<script[^>]*>[\s\S]*?\b(?:eval|require)\(/);
});

test('the dedicated sandbox preload only receives payloads and never exposes app mutations', () => {
  const ipc = new EventEmitter(); let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/moonsteel-alert-preload.js'), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'moonsteelAlert'); api = value; } } }; },
  });
  assert.deepEqual(Object.keys(api), ['onData']);
  let received; const unsubscribe = api.onData(value => { received = value; });
  const payload = { settings: { color: '#da75ff' } }; ipc.emit('moonsteel-alert:data', { sender: 'private' }, payload);
  assert.equal(received, payload); unsubscribe(); assert.equal(ipc.listenerCount('moonsteel-alert:data'), 0);
});
