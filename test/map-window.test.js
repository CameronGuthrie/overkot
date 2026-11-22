'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createMapWindow({ tracking = false, getLocation, getState, getMapTiles, width = 400, height = 300 } = {}) {
  const frames = [];
  const images = [];
  const requests = [];
  const handlers = {};
  const timers = new Map(), drawing = [], windowEvents = {};
  let now = 10000, timerId = 0;
  const context2d = new Proxy({ measureText: text => ({ width: text.length * 6 }) }, { get: (target, key) => target[key] || ((...args) => { drawing.push([key, ...args]); }) });
  const element = () => ({
    clientWidth: width, clientHeight: height, width, height,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, dataset: {}, setAttribute(name, value) { this[name] = value; },
    getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {},
    addEventListener(name, callback) { this[name] = callback; }, appendChild() {},
    querySelectorAll() { return []; }, getContext() { return context2d; },
  });
  const elements = new Map();
  const status = element(), connect = { ...element(), hidden: true };
  elements.set('map-connect', connect);
  elements.set('map-tile-status', status);
  elements.set('map-loading', { ...element(), querySelector: selector => selector === 'button' ? connect : status });
  class FakeImage {
    constructor() { this.listeners = {}; this.complete = false; this.naturalWidth = 0; images.push(this); }
    addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); }
    set src(value) {
      this._src = value;
      if (value.includes('/map-icons/')) {
        this.complete = true;
        this.naturalWidth = 32;
        queueMicrotask(() => (this.listeners.load || []).forEach(fn => fn()));
      }
    }
    get src() { return this._src; }
  }
  const context = vm.createContext({
    console, Image: FakeImage, TRANSLATIONS: { en: {} }, performance: { now: () => now },
    Date: class extends Date { static now() { return now; } },
    requestAnimationFrame: callback => frames.push(callback),
    // Any recurring polling reintroduced into render should fail the test.
    setTimeout: (callback, delay) => { if (!tracking) throw new Error('Map rendering must wait for image events, not poll'); timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    window: {
      addEventListener(name, callback) { windowEvents[name] = callback; },
      api: {
        getMapData: name => new Promise(resolve => requests.push({ name, resolve })),
        ...(getMapTiles ? { getMapTiles } : {}),
        onMapTilesUpdated: callback => { handlers.mapUpdate = callback; },
        openSettings: tab => { handlers.openedSettings = tab; },
        onConfigChanged: callback => { handlers.config = callback; },
        ...(getState ? { getState } : {}),
        ...(tracking ? { getPlayerLocation: getLocation || (async () => null),
          onPlayerLocation: callback => { handlers.location = callback; return () => { delete handlers.location; }; },
          onDungeonStateChanged: callback => { handlers.dungeon = callback; return () => { delete handlers.dungeon; }; } } : {}),
      },
    },
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element, addEventListener() {},
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ancestor-markers.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'world-drop-markers.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'map-pois.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'playerMarkerMotion.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'mapAppearance.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'map-window.js'), 'utf8'), context);
  return { context, images, requests, handlers, timers, drawing, windowEvents, elements, frames,
    setTime(value) { now = value; }, run: code => vm.runInContext(code, context) };
}

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

const playerLocation = overrides => ({ status: 'found', source: 'memory', sampledAt: 10000,
  zone: '/SF/Levels/MidrathRedux', position: { x: 0, y: 0, z: 0 }, heading: 0,
  isOverworld: true, trackingSession: 'session-a', ...overrides });

test('expanded map triangle faces north, east, south and west with fixed screen size', () => {
  const map = createMapWindow({ tracking: true });
  for (const [heading, direction] of [[0, [0, -1]], [90, [1, 0]], [180, [0, 1]], [270, [-1, 0]]]) {
    map.drawing.length = 0;
    map.handlers.location(playerLocation({ heading }));
    map.run(`drawPlayerPin(ctx, 0, 0, 1, playerMarker.heading)`);
    const angle = map.drawing.find(row => row[0] === 'rotate')[1];
    const point = map.drawing.find(row => row[0] === 'moveTo').slice(1);
    const projected = [point[0] * Math.cos(angle) - point[1] * Math.sin(angle), point[0] * Math.sin(angle) + point[1] * Math.cos(angle)];
    assert.ok(Math.abs(projected[0] - direction[0] * 12) < 1e-10);
    assert.ok(Math.abs(projected[1] - direction[1] * 12) < 1e-10);
  }
  map.drawing.length = 0;
  map.handlers.location(playerLocation({ heading: null }));
  map.run('drawPlayerPin(ctx, 0, 0, 1, playerMarker.heading)');
  assert.equal(map.drawing.some(row => row[0] === 'rotate'), false);
  assert.ok(map.drawing.some(row => row[0] === 'arc' && row[3] === 4));
});

test('full map shares live drop projection and clears markers when hidden, picked up or stale', () => {
  const map = createMapWindow({ tracking: true });
  const item = { id: 'weapon-a', kind: 'weapon', name: 'Stultin', shiny: true, position: { x: 10, y: 0, z: 5 } };
  const payload = items => playerLocation({ instanceId: 'world-a', worldDrops: { status: 'available', sampledAt: 10000, items } });
  map.handlers.location(payload([item])); map.drawing.length = 0; map.run('render()');
  const label = map.drawing.find(row => row[0] === 'fillText' && row[1] === 'Stultin');
  assert.ok(label); assert.ok(Math.abs(label[2] - 213) < 1e-9 && label[3] >= 164, 'Keep the nearby weapon name beneath its dot and clear of the player arrow');
  map.handlers.config({ showWorldDrops: false }); map.drawing.length = 0; map.run('render()');
  assert.equal(map.drawing.some(row => row[0] === 'fillText' && row[1] === 'Stultin'), false);
  map.handlers.config({ showWorldDrops: true }); map.handlers.location(payload([])); map.drawing.length = 0; map.run('render()');
  assert.equal(map.drawing.some(row => row[0] === 'fillText' && row[1] === 'Stultin'), false);
  map.handlers.location(payload([item])); map.setTime(12001); map.drawing.length = 0; map.run('render()');
  assert.equal(map.drawing.some(row => row[0] === 'fillText' && row[1] === 'Stultin'), false, 'Stale data cannot remain visible while expiry timers are throttled');
});

test('expanded map applies colour changes immediately and a late initial state cannot restore an older colour', async () => {
  const initial = [];
  const map = createMapWindow({ tracking: true, getState: () => new Promise(resolve => initial.push(resolve)) });
  map.handlers.location(playerLocation()); map.run('centerOnPlayer(); render()');
  const before = map.run('JSON.stringify([panX, panY, zoom])');
  map.handlers.config({ playerMarkerColor: '#d15b40' });
  for (const resolve of initial) resolve({ config: { playerMarkerColor: '#112233' } });
  await flushPromises(); map.run('render()');
  assert.equal(map.run('ctx.fillStyle'), '#d15b40');
  assert.equal(map.run('JSON.stringify([panX, panY, zoom])'), before);
  map.handlers.config({ playerMarkerOutlineColor: '#160d03' }); map.run('render()');
  assert.equal(map.run('ctx.strokeStyle'), '#160d03');
  assert.equal(map.run('ctx.fillStyle'), '#d15b40');
  assert.equal(map.run('JSON.stringify([panX, panY, zoom])'), before);
  map.handlers.config({ playerMarkerColor: '#769d45', playerMarkerOutlineColor: '#382212' });
  map.run('drawPlayerEdgeIndicator(ctx, 0, 0, 10, 10, 1)');
  assert.equal(map.run('ctx.fillStyle'), '#769d45');
  assert.equal(map.run('ctx.strokeStyle'), '#382212');
});

test('expanded map expires live positions and clears stale markers on context changes', async () => {
  let resolveLocation;
  const map = createMapWindow({ tracking: true, getLocation: () => new Promise(resolve => { resolveLocation = resolve; }) });
  map.handlers.location(playerLocation({ heading: 90 }));
  resolveLocation(playerLocation({ source: 'capture', heading: 180 }));
  await flushPromises();
  assert.equal(map.run('playerMarker.heading'), 90, 'late initial snapshot cannot replace an event');
  assert.equal([...map.timers.values()][0].delay, 2001);
  [...map.timers.values()][0].callback();
  assert.equal(map.run('playerMarker'), null);
  for (const bad of [{ status: 'unavailable' }, { sampledAt: 7999 }, { heading: NaN },
    { sampledAt: 10001 }, { isOverworld: false }, { zone: '/SF/Levels/Tower' }, { position: { x: 0, z: NaN } }]) {
    map.handlers.location(playerLocation()); map.handlers.location(playerLocation(bad));
    assert.equal(map.run('playerMarker'), null);
  }
  for (const state of [{ active: true }, { status: 'unknown', active: false },
    { status: 'outside', active: false, levelPath: '/SF/Levels/Tower' }]) {
    map.handlers.dungeon({ active: false, status: 'outside', levelPath: '/SF/Levels/MidrathRedux' });
    map.handlers.location(playerLocation()); map.handlers.dungeon(state);
    assert.equal(map.run('playerMarker'), null);
  }
  map.handlers.location(playerLocation({ source: 'capture', sampledAt: 1 }));
  assert.equal(map.run('playerMarker'), null, 'dormant screenshot results do not replace live tracking');
  map.windowEvents.unload();
  assert.equal(map.handlers.location, undefined); assert.equal(map.handlers.dungeon, undefined);
  assert.equal(map.timers.size, 0);
});

test('a dungeon transition outranks an initial expanded-map capture and same-world events retain expiry', async () => {
  let resolveLocation;
  const map = createMapWindow({ tracking: true, getLocation: () => new Promise(resolve => { resolveLocation = resolve; }) });
  map.handlers.dungeon({ active: true, status: 'ready', instanceId: 'dungeon-b' });
  resolveLocation(playerLocation({ source: 'capture' }));
  await flushPromises();
  assert.equal(map.run('playerMarker'), null);
  map.handlers.dungeon({ active: false, status: 'outside', levelPath: '/SF/Levels/MidrathRedux', instanceId: 'world-a' });
  map.handlers.location(playerLocation({ instanceId: 'world-a' }));
  [...map.timers.values()][0].callback();
  assert.equal(map.run('playerMarker'), null, 'context notifications cannot disable expiry');
});

test('expanded-map center button enables continuous following at the current zoom', () => {
  const map = createMapWindow({ tracking: true });
  const button = map.elements.get('center-player-btn');
  assert.equal(button.disabled, true); assert.match(button.title, /Waiting for live/);
  map.handlers.location(playerLocation());
  assert.equal(button.disabled, false);
  map.run('zoom = .2; panX = 35; panY = 70'); button.click();
  assert.equal(map.run('zoom'), .2);
  assert.equal(map.run('panX + playerMarker.px * zoom'), 200);
  assert.equal(map.run('panY + playerMarker.py * zoom'), 150);
  map.setTime(10010);
  map.handlers.location(playerLocation({ sampledAt: 10010, position: { x: 90, y: 0, z: 60 } }));
  assert.equal(map.run('panX + playerMarker.px * zoom'), 200);
  assert.equal(map.run('panY + playerMarker.py * zoom'), 150);
  assert.equal(button['aria-pressed'], 'true');
  button.click();
  assert.equal(map.run('panX + playerMarker.px * zoom'), 200);
  assert.equal(map.run('panY + playerMarker.py * zoom'), 150);
  map.handlers.location(playerLocation({ sampledAt: 10000 }));
  assert.equal(map.run('playerMarker.px'), (90 + 1792) * 2, 'older samples cannot roll back the current center target');
  map.setTime(12011); button.click();
  assert.equal(button.disabled, true); assert.doesNotMatch(button.title, /F6|capture/);
});

test('expanded-map heading interpolates through north, keeps true positions and resets for context changes', () => {
  const map = createMapWindow({ tracking: true });
  map.handlers.location(playerLocation({ heading: 359, instanceId: 'world-a' }));
  map.setTime(10010);
  map.handlers.location(playerLocation({ heading: 1, sampledAt: 10010, instanceId: 'world-a', position: { x: 20, y: 0, z: 15 } }));
  assert.equal(map.run('playerMarker.px'), (20 + 1792) * 2);
  map.setTime(10070); map.drawing.length = 0; map.run('centerOnPlayer(); render()');
  assert.ok(Math.abs(map.drawing.find(row => row[0] === 'rotate')[1]) < 1e-8);
  map.setTime(10130); map.drawing.length = 0; map.run('render()');
  assert.ok(Math.abs(map.drawing.find(row => row[0] === 'rotate')[1] - Math.PI / 180) < 1e-8);
  map.handlers.location(playerLocation({ heading: 240, sampledAt: 10130, instanceId: 'world-b' }));
  map.drawing.length = 0; map.run('render()');
  assert.ok(Math.abs(map.drawing.find(row => row[0] === 'rotate')[1] - 240 * Math.PI / 180) < 1e-8);
  map.handlers.location({ status: 'unavailable', source: 'memory' });
  map.drawing.length = 0; map.run('render()');
  assert.equal(map.drawing.some(row => row[0] === 'rotate'), false);
});

function resolveLayers(requests, treeX) {
  for (const request of requests) {
    const payload = request.name === 'world_trees'
      ? { positions: [{ position: { x: treeX, z: 0 } }, { position: { x: treeX + 1, z: 0 } }] }
      : request.name === 'boss_encounters' || request.name === 'named_locations' ? []
        : { positions: [], enclaves: [], pools: [] };
    request.resolve(payload);
  }
}

test('full map loads visible tiles only and settles a missing tile without a packaged fallback', () => {
  const map = createMapWindow();
  assert.equal(map.images.length, 0);
  map.run('render()');
  const tiles = map.images.filter(image => image.src.startsWith('overkot-map-tiles:'));
  assert.equal(tiles.length, 4, 'The closer centered view loads its four intersecting tiles instead of the full atlas');
  tiles[0].onerror();
  const source = tiles[0].src;
  assert.match(source, /^overkot-map-tiles:\/\/tile\/\d+\.webp$/);
  tiles[0].onerror();
  map.run('render()');
  assert.equal(map.run('tilesLoaded'), 0, 'A failed image cannot count toward painted coverage');
  assert.match(map.elements.get('map-tile-status').textContent, /Settings → Game files/);
  assert.equal(map.elements.get('map-connect').hidden, true);
  assert.equal(map.images.length, 4);
});

test('expanded map refreshes missing tiles on sign-in and keeps decoded tiles available offline', async () => {
  let resolveInitial;
  const map = createMapWindow({ getMapTiles: () => new Promise(resolve => { resolveInitial = resolve; }) });
  const info = { version: 'same-feed', source: 'remote' };
  const markerUrl = 'overkot-map-tiles://data/map-icons/Vendor.png';
  const legendIcon = { src: markerUrl, naturalWidth: 0, complete: true };
  map.elements.get('map-legend-panel').querySelectorAll = selector => selector === 'img' ? [legendIcon] : [];
  map.handlers.mapUpdate({ ...info, requiresSignIn: true });
  assert.equal(legendIcon.src, markerUrl);
  map.run('render()');
  const [cached, ...missing] = map.images;
  cached.complete = true; cached.naturalWidth = 512; cached.onload();
  for (const tile of missing) { tile.complete = true; tile.onerror(); }
  resolveInitial(info);
  await flushPromises(); map.run('render()');
  assert.match(map.elements.get('map-tile-status').textContent, /Settings → Connections/);
  const connect = map.elements.get('map-connect');
  assert.equal(connect.hidden, false);
  connect.click();
  assert.equal(map.handlers.openedSettings, 'connections');
  assert.equal(map.run('tilesLoaded'), 1);
  map.handlers.mapUpdate(info);
  assert.notEqual(legendIcon.src, markerUrl, 'The expanded map retries its missing legend icon on sign-in');
  map.run('render()');
  assert.ok(cached.src);
  assert.equal(map.images.length, 7);
  for (const tile of map.images.slice(4)) { tile.complete = true; tile.naturalWidth = 512; tile.onload(); }
  map.run('render()');
  assert.equal(map.run('tilesLoaded'), 4);
  assert.equal(map.elements.get('map-tile-status').textContent, '');
  assert.equal(connect.hidden, true);
  map.handlers.mapUpdate({ ...info, requiresSignIn: true });
  map.run('render()');
  assert.equal(map.elements.get('map-tile-status').textContent, '');
  assert.equal(connect.hidden, true);
  assert.equal(map.images.length, 7);
});

const centered = map => {
  const node = map.elements.get('map-container');
  assert.ok(Math.abs(map.run('panX + playerMarker.px * zoom') - node.clientWidth / 2) < 1e-8);
  assert.ok(Math.abs(map.run('panY + playerMarker.py * zoom') - node.clientHeight / 2) < 1e-8);
};
const drag = (map, dx = 35, dy = 20) => {
  const node = map.elements.get('map-container');
  node.pointerdown({ button: 0, clientX: 100, clientY: 100, pointerId: 1, target: { closest: () => null } });
  node.pointermove({ clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
  node.pointerup();
};

test('expanded overworld starts at a close zoom and centers a first asynchronous live snapshot', async () => {
  const map = createMapWindow({ tracking: true, getLocation: async () => playerLocation({ position: { x: 70, y: 0, z: -35 } }) });
  await flushPromises();
  centered(map);
  assert.equal(map.run('zoom'), .65);
  assert.ok(map.run('zoom') > Math.min(400 / 7168, 300 / 7168) * 10);
  for (const callback of map.frames.splice(0)) callback();
  centered(map); assert.equal(map.run('zoom'), .65, 'Late boot callbacks cannot refit an already received player');
});

test('following keeps the player centered through wheel zoom, buttons and resize', () => {
  const map = createMapWindow({ tracking: true });
  map.handlers.location(playerLocation());
  const node = map.elements.get('map-container');
  node.wheel({ clientX: 20, clientY: 35, deltaY: -1, preventDefault() {} });
  centered(map); assert.ok(Math.abs(map.run('zoom') - .65 * 1.2) < 1e-8);
  map.elements.get('zoom-in-btn').click(); centered(map);
  const zoom = map.run('zoom');
  node.clientWidth = 650; node.clientHeight = 420; map.windowEvents.resize();
  centered(map); assert.equal(map.run('zoom'), zoom);
});

test('a drag pauses overworld following until Center and a click never pauses it', () => {
  const map = createMapWindow({ tracking: true }); map.handlers.location(playerLocation());
  drag(map, 2, 1); assert.equal(map.run('followingPlayer'), true); centered(map);
  drag(map); assert.equal(map.run('followingPlayer'), false);
  const before = map.run('JSON.stringify([panX, panY, zoom])');
  map.setTime(10100); map.handlers.location(playerLocation({ sampledAt: 10100, position: { x: 50, y: 0, z: -10 } }));
  assert.equal(map.run('JSON.stringify([panX, panY, zoom])'), before);
  map.elements.get('center-player-btn').click(); centered(map);
  assert.equal(map.run('followingPlayer'), true);
  map.setTime(10200); map.handlers.location(playerLocation({ sampledAt: 10200, position: { x: -100, y: 0, z: 80 } }));
  centered(map);
});

test('full-map fit pauses following while fresh poses keep their real position until recentered', () => {
  const map = createMapWindow({ tracking: true }); map.handlers.location(playerLocation());
  map.elements.get('zoom-fit-btn').click();
  assert.equal(map.run('followingPlayer'), false);
  assert.equal(map.elements.get('center-player-btn')['aria-pressed'], 'false');
  const before = map.run('JSON.stringify([panX, panY, zoom])');
  map.setTime(10100); map.handlers.location(playerLocation({ sampledAt: 10100, position: { x: 100, y: 0, z: 40 } }));
  assert.equal(map.run('JSON.stringify([panX, panY, zoom])'), before);
  map.elements.get('center-player-btn').click(); centered(map);
  assert.equal(map.run('zoom'), Math.min(400 / 7168, 300 / 7168) * .95);
});

test('a hidden zero-size map initializes once visible and does not overwrite a chosen zoom', async () => {
  const map = createMapWindow({ tracking: true, width: 0, height: 0, getLocation: async () => playerLocation() });
  await flushPromises();
  assert.equal(map.run('viewInitialized'), false);
  const node = map.elements.get('map-container'); node.clientWidth = 400; node.clientHeight = 300;
  map.windowEvents.resize(); centered(map); assert.equal(map.run('zoom'), .65);
  map.elements.get('zoom-in-btn').click(); const zoom = map.run('zoom');
  for (const callback of map.frames.splice(0)) callback();
  centered(map); assert.equal(map.run('zoom'), zoom);
});

test('stale poses cannot move a following map and new entries resume following after manual exploration', () => {
  const map = createMapWindow({ tracking: true });
  map.handlers.location(playerLocation({ instanceId: 'world-a' })); drag(map);
  const panned = map.run('JSON.stringify([panX, panY, zoom])');
  map.setTime(12101); map.handlers.location(playerLocation({ sampledAt: 10000, position: { x: 1000, y: 0, z: 0 }, instanceId: 'world-a' }));
  assert.equal(map.run('playerMarker'), null); assert.equal(map.run('JSON.stringify([panX, panY, zoom])'), panned);
  map.handlers.location(playerLocation({ sampledAt: 12101, instanceId: 'world-a' }));
  assert.equal(map.run('followingPlayer'), false, 'Freshness recovery preserves the paused view in the same entry');
  map.handlers.location(playerLocation({ sampledAt: 12101, instanceId: 'world-b' }));
  assert.equal(map.run('followingPlayer'), true); centered(map);
  map.handlers.dungeon({ active: true, status: 'ready', instanceId: 'dungeon' });
  assert.equal(map.run('playerMarker'), null);
  map.handlers.dungeon({ active: false, status: 'outside', levelPath: '/SF/Levels/Procs/MidrathProc', instanceId: 'world-c' });
  map.handlers.location(playerLocation({ sampledAt: 12101, instanceId: 'world-c' })); centered(map);
});

test('queued old-world packets cannot resurrect a marker after a dungeon or overworld entry change', async () => {
  let resolve;
  const map = createMapWindow({ tracking: true, getLocation: () => new Promise(yes => { resolve = yes; }) });
  map.handlers.location(playerLocation({ instanceId: 'world-a' })); centered(map);
  map.handlers.dungeon({ active: true, status: 'ready', instanceId: 'dungeon-b' });
  const duringDungeon = map.run('JSON.stringify([panX, panY, zoom])');
  map.handlers.location(playerLocation({ instanceId: 'world-a', position: { x: 500, y: 0, z: 100 } }));
  resolve(playerLocation({ instanceId: 'world-a' })); await flushPromises();
  assert.equal(map.run('playerMarker'), null);
  assert.equal(map.run('JSON.stringify([panX, panY, zoom])'), duringDungeon);
  map.handlers.dungeon({ active: false, status: 'outside', levelPath: '/SF/Levels/Procs/MidrathProc', instanceId: 'world-c' });
  map.handlers.location(playerLocation({ instanceId: 'world-a' }));
  assert.equal(map.run('playerMarker'), null, 'A previous overworld entry cannot restore the new entry marker');
  map.handlers.location(playerLocation({ instanceId: 'world-c', position: { x: -70, y: 0, z: 20 } })); centered(map);
  const current = map.run('JSON.stringify([panX, panY, zoom, playerMarker])');
  map.handlers.location(playerLocation({ instanceId: 'world-a' }));
  assert.equal(map.run('JSON.stringify([panX, panY, zoom, playerMarker])'), current, 'An old-entry packet cannot erase or move a current valid marker');
});

test('manual exploration before the first player snapshot stays paused until Center is chosen', async () => {
  let resolve;
  const map = createMapWindow({ tracking: true, getLocation: () => new Promise(yes => { resolve = yes; }) });
  drag(map);
  const panned = map.run('JSON.stringify([panX, panY, zoom])');
  resolve(playerLocation({ instanceId: 'world-a' })); await flushPromises();
  map.handlers.dungeon({ active: false, status: 'outside', levelPath: '/SF/Levels/Procs/MidrathProc', instanceId: 'world-a' });
  assert.equal(map.run('followingPlayer'), false);
  assert.equal(map.run('JSON.stringify([panX, panY, zoom])'), panned);
  map.elements.get('center-player-btn').click(); centered(map);
  assert.equal(map.run('followingPlayer'), true);
});

test('a map data update replaces markers and ignores stale in-flight POI loads', async () => {
  const map = createMapWindow();
  const initial = map.requests.slice();
  assert.equal(initial.length, 9);
  map.handlers.mapUpdate({ version: 'new-feed', source: 'remote' });
  const current = map.requests.slice(9);
  assert.equal(current.length, 9);
  resolveLayers(current, 200);
  await flushPromises();
  assert.equal(map.run('mapPOIs.length'), 2);
  assert.equal(map.run('mapPOIs[0].px'), (200 + 1792) * 2);
  const icons = map.images.filter(image => image.src.includes('/map-icons/'));
  assert.equal(icons.length, 1);
  assert.equal(icons[0].listeners.load.length, 1);
  assert.equal(icons[0].listeners.error.length, 1);

  resolveLayers(initial, 10);
  await flushPromises();
  assert.equal(map.run('mapPOIs.length'), 2);
  assert.equal(map.run('mapPOIs[0].px'), (200 + 1792) * 2);
});

test('manual refresh retries tiles and POIs even when the manifest version is unchanged', () => {
  const map = createMapWindow();
  const info = { version: 'same-feed', source: 'remote' };
  map.handlers.mapUpdate(info);
  map.run('render()');
  const tile = map.images.find(image => image.src.startsWith('overkot-map-tiles:'));
  tile.onerror();
  map.handlers.mapUpdate(info);
  assert.notEqual(tile.src, '', 'Automatic checks keep the existing tile at the same version');
  const requests = map.requests.length;
  map.handlers.mapUpdate({ ...info, reload: true });
  map.run('render()');
  assert.equal(map.requests.length, requests + 9);
  assert.equal(tile.src, '');
  assert.ok(map.images.some(image => image !== tile && image.src.startsWith('overkot-map-tiles:')));
});
