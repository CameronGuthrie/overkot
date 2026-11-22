'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function fixture(target = 'game') {
  const calls = [], deferred = [];
  const win = Object.assign(new EventEmitter(), {
    isFocused: () => true, isVisible: () => true, isDestroyed: () => false,
    close() { this.emit('close', {}); this.emit('closed'); },
  });
  const ctx = vm.createContext({ win, AbortController,
    setImmediate: fn => deferred.push(fn), mainWindow: { isDestroyed: () => false, isMinimized: () => false },
    config: { get: () => target }, platformSupport: { platform: 'win32' }, configureOverlayPopout() {},
    overlayHiddenByUser: false, marketShutdownStarted: false, appStatus: 'connected', gameFocusRequest: null,
    overlayInteractive: true, isAnyOverlayWindowFocused: () => true,
    applyOverlayMousePolicy: () => calls.push('input'), focusOverlay: () => calls.push('overlay'),
    toggleOverlayInteraction: () => { ctx.overlayInteractive = false; calls.push('release'); },
    detector: { async focusGameWindow() { calls.push('game'); return true; } },
    async focusDesktop() { calls.push('desktop'); return true; }, log() {},
  });
  for (const [start, end] of [['function attachOverlayBlurHandler(', 'function applyOverlayMousePolicy('],
    ['function closeWithoutChangingFocus(', '/** Restore native z-order']]) {
    vm.runInContext(main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start))), ctx);
  }
  ctx.attachOverlayBlurHandler(win);
  return { win, ctx, calls, flush() { deferred.splice(0).forEach(fn => fn()); } };
}

test('closing a foreground popout routes focus after it has closed', async () => {
  for (const target of ['overlay', 'game', 'desktop']) {
    const f = fixture(target);
    f.win.emit('close', {});
    f.flush(); assert.deepEqual(f.calls, []);
    f.win.emit('closed'); f.flush();
    assert.deepEqual(f.calls, target === 'overlay' ? ['input', 'overlay'] : ['release', target]);
    assert.equal(f.ctx.overlayInteractive, target === 'overlay');
  }
});

test('background, cancelled, layout and shutdown closes leave focus alone', () => {
  for (const reason of ['unfocused', 'invisible', 'cancelled', 'automatic', 'hidden', 'quit', 'destroy']) {
    const f = fixture();
    if (reason === 'unfocused') f.win.isFocused = () => false;
    if (reason === 'invisible') f.win.isVisible = () => false;
    if (reason === 'automatic') f.ctx.closeWithoutChangingFocus(f.win);
    else {
      const event = {};
      if (reason !== 'destroy') f.win.emit('close', event);
      if (reason === 'cancelled') event.defaultPrevented = true;
      if (reason === 'hidden') f.ctx.overlayHiddenByUser = true;
      if (reason === 'quit') f.ctx.marketShutdownStarted = true;
      f.win.emit('closed');
    }
    f.flush(); assert.deepEqual(f.calls, [], reason);
  }
});

test('the game preference returns an interactive overlay when Soulframe is absent', async () => {
  const f = fixture();
  f.ctx.appStatus = 'waiting'; f.ctx.overlayInteractive = false;
  await f.ctx.restoreWindowCloseFocus();
  assert.deepEqual(f.calls, ['input', 'overlay']);
  assert.equal(f.ctx.overlayInteractive, true);
});

test('a failed game activation cannot pull focus back from another app after the game exits', async () => {
  const f = fixture();
  let complete;
  f.ctx.detector.focusGameWindow = () => new Promise(resolve => { complete = resolve; });
  const pending = f.ctx.restoreWindowCloseFocus();
  f.ctx.appStatus = 'waiting';
  f.ctx.isAnyOverlayWindowFocused = () => false;
  complete(false); await pending;
  assert.deepEqual(f.calls, ['release']);
});

test('a new close cancels an older native handoff', async () => {
  const f = fixture('desktop');
  let signal, finish;
  f.ctx.focusDesktop = options => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  const first = f.ctx.restoreWindowCloseFocus();
  f.ctx.config.get = () => 'overlay';
  await f.ctx.restoreWindowCloseFocus();
  assert.equal(signal.aborted, true);
  finish(false); await first;
  assert.deepEqual(f.calls, ['release', 'input', 'overlay']);
});
