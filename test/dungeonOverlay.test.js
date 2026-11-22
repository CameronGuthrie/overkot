'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function setup(interactive = true) {
  const events = {}, calls = [], hint = { textContent: '' };
  let mounted;
  const api = {
    getState: async () => ({ config: { interactionHotkey: 'Alt+F1', dockEdge: 'left' }, overlayInteractive: interactive }),
    closeDungeonOverlay() { calls.push('close'); },
    exitDungeonOverlayInteraction() { calls.push('return-to-game'); },
    onOverlayInteraction(callback) { events.interaction = callback; },
    onConfigChanged(callback) { events.config = callback; },
  };
  const document = {
    body: { dataset: {} },
    getElementById(id) { return id === 'dungeon-overlay-hint' ? hint : {}; },
    addEventListener(name, callback) { events[name] = callback; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/dungeon-overlay.js'), 'utf8'), {
    window: { api, addEventListener(name, callback) { events[name] = callback; } }, document,
    OverkotTheme: { apply() {} },
    DungeonMapWidget: { mount(_element, options) {
      mounted = options;
      return { releaseInteraction() { calls.push('release-pan'); }, destroy() { calls.push('destroy'); } };
    } },
  });
  await events.DOMContentLoaded();
  const key = name => events.keydown({ key: name, preventDefault() { calls.push('prevent'); }, stopPropagation() { calls.push('stop'); } });
  return { calls, events, hint, document, key, get mounted() { return mounted; } };
}

test('Escape returns interactive dungeon input to the game while preserving the map', async () => {
  const overlay = await setup();
  assert.match(overlay.hint.textContent, /Escape to return to game/);
  overlay.key('Escape');
  assert.deepEqual(overlay.calls, ['prevent', 'stop', 'release-pan', 'return-to-game']);
  assert.equal(overlay.hint.textContent, 'Alt + F1 to interact');
  overlay.key('Escape');
  assert.equal(overlay.calls.length, 4, 'Inactive Escape is not consumed or sent to the app again');
  overlay.events.interaction(true);
  overlay.key('Escape');
  assert.equal(overlay.calls.filter(call => call === 'return-to-game').length, 2);
  assert.equal(overlay.calls.includes('close'), false);
  assert.equal(overlay.calls.includes('destroy'), false);
});

test('inactive Escape and unrelated keys pass through, while the close control remains explicit', async () => {
  const overlay = await setup(false);
  overlay.key('Escape'); overlay.key('F6');
  assert.deepEqual(overlay.calls, []);
  overlay.mounted.onClose();
  assert.deepEqual(overlay.calls, ['close']);
  overlay.events.unload();
  assert.deepEqual(overlay.calls, ['close', 'destroy']);
});
