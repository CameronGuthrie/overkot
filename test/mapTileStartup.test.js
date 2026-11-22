'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const startup = main.slice(main.indexOf('let mapUpdatesStopped ='), main.indexOf('// Shared state'));
const settled = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createStartup() {
  const app = new EventEmitter();
  const manifest = deferred(), warmup = deferred();
  const calls = { refresh: 0, warm: [], stopped: 0, updates: [], cleared: false, unref: false };
  let callback;
  const timer = { unref: () => { calls.unref = true; } };
  const context = vm.createContext({
    app,
    config: { get: () => 'de' },
    refreshGameData: () => { calls.refresh++; return manifest.promise; },
    mapTileManager: {
      warmCache: options => { calls.warm.push(options.language); return warmup.promise; },
      getInfo: () => ({ version: 'map-version' }),
      stopWarmup: () => { calls.stopped++; },
    },
    broadcastMapTilesUpdated: info => calls.updates.push(JSON.parse(JSON.stringify(info))),
    setInterval: fn => { callback = fn; return timer; },
    clearInterval: handle => { assert.equal(handle, timer); calls.cleared = true; },
    log: () => {},
  });
  vm.runInContext(startup, context);
  return { app, calls, manifest, warmup, start: () => vm.runInContext('startMapTileUpdateCheck()', context), tick: () => callback() };
}

test('startup starts background map warmup without waiting for a game connection or delaying the app', async () => {
  const fixture = createStartup();
  assert.equal(fixture.start(), undefined, 'startup returns before manifest or image downloads resolve');
  assert.equal(fixture.calls.refresh, 1);
  assert.equal(fixture.calls.unref, true);
  assert.deepEqual(fixture.calls.warm, []);
  fixture.manifest.resolve();
  await settled();
  assert.deepEqual(fixture.calls.warm, ['de'], 'known manifest starts warmup in the selected locale');
  fixture.warmup.resolve({ updated: true });
  await settled();
  assert.deepEqual(fixture.calls.updates, [{ version: 'map-version', reload: true }], 'open maps can recover failed image loads from the cache');
  await fixture.tick();
  assert.equal(fixture.calls.refresh, 2, 'regular checks retry unfinished warmup');
  fixture.app.emit('will-quit');
  assert.equal(fixture.calls.cleared, true);
  assert.equal(fixture.calls.stopped, 1);
});

test('quitting before the initial manifest resolves cannot start background downloads later', async () => {
  const fixture = createStartup();
  fixture.start();
  fixture.app.emit('will-quit');
  fixture.manifest.resolve();
  await settled();
  assert.deepEqual(fixture.calls.warm, []);
  assert.deepEqual(fixture.calls.updates, []);
});
