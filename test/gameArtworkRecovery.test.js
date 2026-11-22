'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bind } = require('../src/renderer/game-artwork-recovery');

const art = 'overkot-game-data://images/SF/Interface/Graphics/Item.png';
const temper = 'overkot-map-tiles://data/temper-icons/' + '0'.repeat(64) + '.png';
function image(source, { complete = true, naturalWidth = 0 } = {}) {
  return { complete, naturalWidth, requests: 0, isConnected: true, hidden: false, loading: 'lazy',
    get src() { return source; },
    set src(value) { source = value; this.requests++; this.complete = false; },
  };
}
function fixture(images) {
  const listeners = new Map(), api = {};
  const document = {
    querySelectorAll(selector) {
      const prefix = /^img\[src\^="([^"]+)"\]$/.exec(selector)[1];
      return images.filter(img => img.isConnected && img.src.startsWith(prefix));
    },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  };
  const dispose = bind(document, {
    onGameArtworkAvailable(fn) { api.signIn = fn; return () => { delete api.signIn; }; },
    onMapTilesUpdated(fn) { api.refresh = fn; return () => { delete api.refresh; }; },
  });
  return { api, dispose, emit: (type, target) => listeners.get(type)?.({ target }) };
}

test('sign-in and data refresh retry only missing mounted artwork from the corresponding source', () => {
  const failed = image(art), loaded = image(art, { naturalWidth: 16 }), detached = image(art);
  failed.hidden = true; detached.isConnected = false;
  const hashIcon = image(temper), tile = image('overkot-map-tiles://tile/90.webp'), external = image('https://other.example/item.png');
  const f = fixture([failed, loaded, detached, hashIcon, tile, external]);
  f.api.signIn();
  assert.equal(failed.requests, 1);
  assert.equal(failed.loading, 'eager', 'hidden lazy fallbacks can load in place');
  f.api.refresh({ requiresSignIn: true });
  assert.equal(hashIcon.requests, 0, 'no temper retries on a signed-out notification');
  f.api.refresh({ requiresSignIn: false });
  assert.equal(hashIcon.requests, 1);
  for (const img of [loaded, detached, tile, external]) assert.equal(img.requests, 0);
  f.dispose();
  assert.deepEqual(f.api, {});
});

test('a pending signed-out failure racing sign-in gets one retry; removed or changed images get none', async () => {
  const pending = image(art, { complete: false }), removed = image(art, { complete: false }), replaced = image(art, { complete: false });
  const f = fixture([pending, removed, replaced]);
  f.api.signIn();
  for (const img of [pending, removed, replaced]) { img.complete = true; f.emit('error', img); }
  removed.isConnected = false;
  replaced.src = 'https://other.example/moved.png';
  await Promise.resolve();
  assert.equal(pending.requests, 1);
  assert.equal(removed.requests, 0);
  assert.equal(replaced.requests, 1, 'only the explicit source change');
  pending.complete = true;
  f.emit('error', pending);
  await Promise.resolve();
  assert.equal(pending.requests, 1, 'a genuine network error waits for a new availability event');
});
