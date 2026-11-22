'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/renderer/motion');

function fixture(storage, reduced = false) {
  const listeners = new Map(), mediaListeners = new Map(), timers = new Map(), all = [];
  let timestamp = 10000, nextTimer = 0;
  const eventTarget = callbacks => ({
    addEventListener(type, callback) { callbacks.set(type, callback); },
    removeEventListener(type, callback) { if (callbacks.get(type) === callback) callbacks.delete(type); },
  });
  function element(parent) {
    const value = { dataset: {}, children: [], parentElement: parent, isConnected: true, attributes: {},
      style: { setProperty() {} },
      setAttribute(key, entry) { this.attributes[key] = entry; },
      appendChild(child) { this.children.push(child); child.parentElement = this; },
      remove() { this.isConnected = false; this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
      closest(selector) {
        for (let current = this; current; current = current.parentElement) {
          if (selector === '[data-motion-level]' && current.dataset.motionLevel) return current;
          if (selector === '[data-appearance-preview]' && current.preview) return current;
          if (selector === '[hidden], .hidden, .collapsed' && current.hidden) return current;
        }
        return null;
      },
    };
    all.push(value); return value;
  }
  const root = element(), card = element(root);
  const document = { ...eventTarget(listeners), documentElement: root, hidden: false,
    querySelectorAll: () => all.filter(node => node.dataset.motionRequested), createElement: () => element() };
  const media = { matches: reduced, ...eventTarget(mediaListeners) };
  const windowListeners = new Map();
  const window = { ...eventTarget(windowListeners), matchMedia: () => media };
  const controller = create({ document, window, storage, now: () => timestamp,
    setTimer(callback, ms) { timers.set(++nextTimer, { callback, until: timestamp + ms }); return nextTimer; },
    clearTimer(id) { timers.delete(id); } });
  controller.configure({}, root);
  return { controller, document, root, card, element, timers, listeners, mediaListeners, windowListeners,
    advance(ms = 1000) { timestamp += ms; for (const [id, entry] of [...timers]) if (entry.until <= timestamp) { timers.delete(id); entry.callback(); } },
    reduced(value) { media.matches = value; mediaListeners.get('change')?.(); },
    visibility(hidden) { document.hidden = hidden; listeners.get('visibilitychange')?.(); },
  };
}

test('initial states and remounts never celebrate; real progress, urgency and completion transitions do', () => {
  const f = fixture(), m = f.controller;
  assert.equal(m.sample('timer:a', { value: .1, element: f.card }), false);
  assert.equal(m.sample('timer:a', { value: .3, element: f.card }), true);
  assert.equal(f.card.children.length, 1); assert.equal(f.card.children[0].attributes['aria-hidden'], 'true');
  f.advance();
  assert.equal(m.sample('timer:a', { value: .3, element: f.card }), false, 'unchanged refresh');
  assert.equal(m.sample('timer:a', { value: .3, urgent: true, element: f.card }), true);
  f.advance();
  assert.equal(m.sample('timer:a', { value: 1, complete: true, element: f.card }), true);
  f.advance();
  assert.equal(m.sample('timer:a', { value: 1, complete: true, element: f.card }), false);
  assert.equal(m.sample('remounted:a', { value: 1, complete: true, element: f.card }), false);
  m.destroy();
});

test('Off updates state immediately without building a later animation backlog', () => {
  const f = fixture(), m = f.controller;
  m.configure({ motionLevel: 'off' });
  m.sample('timer', { value: .1, element: f.card });
  assert.equal(m.sample('timer', { value: 1, complete: true, element: f.card }), false);
  assert.equal(f.timers.size, 0); assert.equal(m.duration(500), 0);
  m.configure({ motionLevel: 'standard' });
  assert.equal(m.sample('timer', { value: 1, complete: true, element: f.card }), false);
  m.destroy();
});

test('system reduced motion, explicit overrides, scope inheritance and speed have predictable precedence', () => {
  const f = fixture(), m = f.controller;
  m.configure({ motionLevel: 'off' }, f.root);
  m.configure({ motionLevel: 'standard', motionSpeed: 200 }, f.card);
  assert.equal(m.enabled(), false); assert.equal(m.enabled(f.card), true); assert.equal(m.duration(800, f.card), 400);
  f.reduced(true); assert.equal(f.card.dataset.motionLevel, 'off');
  m.configure({ motionLevel: 'expressive', respectReducedMotion: false }, f.card);
  assert.equal(m.enabled(f.card), true);
  m.configure({ motionLevel: 'off', respectReducedMotion: false }, f.card);
  assert.equal(m.enabled(f.card), false);
  f.reduced(false); assert.equal(m.enabled(f.card), false, 'explicit Off always wins');
  m.configure({ motionLevel: 'subtle', ambientMotion: true });
  assert.equal(m.duration(1000), 800); assert.equal(f.root.dataset.ambientMotion, 'true');
  m.destroy();
});

test('hidden and event-disabled widgets allocate no decorations, timers or pending work', () => {
  const f = fixture(), m = f.controller;
  m.configure({ eventEmphasis: false }); assert.equal(m.emphasize(f.card), false);
  m.configure({}); f.card.hidden = true; assert.equal(m.emphasize(f.card), false);
  f.card.hidden = false; f.document.hidden = true; assert.equal(m.emphasize(f.card), false);
  f.document.hidden = false; assert.equal(m.emphasize(f.card, 'complete', 'one'), true);
  assert.equal(m.emphasize(f.element(f.root), 'complete', 'two'), false, 'one emphasis at a time per document');
  f.visibility(true); assert.equal(f.card.children.length, 0); assert.equal(f.timers.size, 0);
  f.visibility(false); assert.equal(m.emphasize(f.card, 'complete', 'one'), false, 'deduplicated even after visibility changes');
  m.destroy();
});

test('a shared lease limits simultaneous emphasis across windows without continuous work', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const a = fixture(storage), b = fixture(storage), c = fixture(storage);
  assert.equal(a.controller.emphasize(a.card, 'complete', 'one'), true);
  assert.equal(b.controller.emphasize(b.card, 'complete', 'two'), true);
  assert.equal(c.controller.emphasize(c.card, 'complete', 'three'), false);
  a.advance(); b.advance(); c.advance();
  assert.equal(c.controller.emphasize(c.card, 'complete', 'three'), true);
  a.controller.destroy(); b.controller.destroy(); c.controller.destroy();
});

test('inventory acquisition, goal completion and rank changes ignore ordinary repaint and initial data', () => {
  const f = fixture(), m = f.controller;
  const inventory = (owned, completed = false, rank = 1) => ({ status: 'live', currentRank: rank, rankSource: 'inventory-mastery', rows: [{ id: 'sword', owned, completed }] });
  assert.equal(m.inventory('collection', inventory(false), f.card), false);
  assert.equal(m.inventory('collection', inventory(true), f.card), true);
  f.advance(); assert.equal(m.inventory('collection', inventory(true), f.card), false);
  assert.equal(m.inventory('collection', inventory(true, true), f.card), true);
  f.advance(); assert.equal(m.inventory('collection', inventory(true, true, 2), f.card), true);
  f.advance(); assert.equal(m.inventory('collection', inventory(true, true, 2), f.card), false);
  assert.equal(m.inventory('newly-opened', inventory(true, true, 2), f.card), false);
  m.destroy();
});

test('reported level changes cannot trigger inventory-rank celebrations', () => {
  const f = fixture(), m = f.controller;
  const snapshot = reportedRank => ({status:'live', currentRank:19, rankSource:'inventory-mastery', reportedRank, rows:[]});
  assert.equal(m.inventory('rank', snapshot(19), f.card), false);
  assert.equal(m.inventory('rank', snapshot(21), f.card), false);
  assert.equal(m.inventory('rank', {...snapshot(21), currentRank:20}, f.card), true);
  f.advance();
  assert.equal(m.inventory('unknown', {status:'live', reportedRank:19, rows:[]}, f.card), false);
  assert.equal(m.inventory('unknown', {status:'live', reportedRank:21, rows:[]}, f.card), false);
  m.destroy();
});

test('destroy cancels active decoration and removes listeners exactly once', () => {
  const f = fixture(), m = f.controller;
  m.emphasize(f.card, 'complete'); assert.equal(f.timers.size, 1);
  m.destroy(); m.destroy();
  assert.equal(f.timers.size, 0); assert.equal(f.card.children.length, 0);
  assert.equal(f.listeners.size, 0); assert.equal(f.mediaListeners.size, 0); assert.equal(f.windowListeners.size, 0);
  assert.equal(m.emphasize(f.card), false); assert.equal(m.sample('after-destroy', { value: 1 }), false);
});
