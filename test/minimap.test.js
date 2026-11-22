'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createMinimap({ dungeon = false, tracking = false, getLocation, getMapTiles, locate = false, width = 400, height = 300 } = {}) {
  const images = [];
  const frames = [];
  const handlers = {};
  const timers = new Map(), drawing = [], windowEvents = {};
  let now = 10000, timerId = 0, cancelledAnimations = 0;
  const classes = new Map();
  const ctx = new Proxy({ measureText: text => ({ width: text.length * 6 }) }, { get: (target, key) => target[key] || ((...args) => { drawing.push([key, ...args]); }) });
  const viewport = {
    clientWidth: width, clientHeight: height, getClientRects: () => [{}],
    addEventListener(name, callback) { this[name] = callback; }, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
  };
  const elements = {
    '#minimap-viewport': viewport,
    '#minimap-canvas': { width: 400, height: 300, getContext: () => ctx },
    '#minimap-tile-status': {}, '#minimap-connect': { hidden: true, addEventListener(type, handler) { this[type] = handler; } },
    '#minimap-loading': { querySelector: selector => elements[selector === 'button' ? '#minimap-connect' : '#minimap-tile-status'], classList: {
      remove: key => classes.set(key, false),
      toggle: (key, value) => classes.set(key, value),
    } },
  };
  for (const id of ['#minimap-zoom-in', '#minimap-zoom-out']) {
    elements[id] = { addEventListener(name, callback) { this[name] = callback; } };
  }
  const launches = [];
  const locationRequests = { captures: 0, cancellations: 0 };
  if (locate) {
    const node = initialClasses => {
      const names = new Set(initialClasses);
      return { classList: { add(...values) { values.forEach(value => names.add(value)); },
        remove(...values) { values.forEach(value => names.delete(value)); }, contains: value => names.has(value) },
      title: 'Where am I?', setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { this[name] = callback; } };
    };
    elements['#minimap-locate'] = node([]);
    elements['#minimap-locate-overlay'] = node(['hidden']);
  }
  const dungeonWidget = { active: false, destroy() {} };
  let dungeonOptions;
  if (dungeon) {
    const content = { appendChild() {}, classList: { toggle() {} } };
    viewport.closest = () => content;
    elements['#minimap-expand'] = { addEventListener(type, handler) { this[type] = handler; } };
  }
  class FakeImage {
    constructor() { images.push(this); this.complete = false; this.naturalWidth = 0; }
    set src(value) { this._src = value; }
    get src() { return this._src; }
  }
  const document = { hidden: false, addEventListener() {}, querySelector: key => elements[key] || null,
    createElement: () => ({}) };
  const context = vm.createContext({
    console, Image: FakeImage, document, performance: { now: () => now },
    Date: class extends Date { static now() { return now; } },
    requestAnimationFrame: callback => frames.push(callback), cancelAnimationFrame() { cancelledAnimations++; },
    setTimeout: (callback, delay) => { if (!tracking) throw new Error('Tile failures must not schedule polling'); timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    ResizeObserver: class { constructor(callback) { handlers.resize = callback; } observe() {} },
    window: { addEventListener(name, callback) { windowEvents[name] = callback; }, ...(dungeon ? { DungeonMapWidget: { mount: (_element, options) => { dungeonOptions = options; return dungeonWidget; } } } : {}), api: {
      getMapData: async name => name === 'boss_encounters' || name === 'named_locations' ? [] : {},
      ...(getMapTiles ? { getMapTiles } : {}),
      onMapTilesUpdated: callback => { handlers.update = callback; },
      openSettings: tab => launches.push(tab),
      onConfigChanged: callback => { handlers.config = callback; },
      onPlayerLocation: callback => { handlers.location = callback; return () => { delete handlers.location; }; },
      locatePlayer: async () => { locationRequests.captures++; return { status: 'watching' }; },
      cancelLocatePlayer() { locationRequests.cancellations++; },
      ...(tracking ? { getPlayerLocation: getLocation || (async () => null),
        onDungeonStateChanged: callback => { handlers.dungeon = callback; return () => { delete handlers.dungeon; }; } } : {}),
      getDungeonMap: async () => ({}), openMapWindow: () => launches.push('world'), openDungeonOverlay: () => launches.push('dungeon'),
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ancestor-markers.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'world-drop-markers.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'map-pois.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'playerMarkerMotion.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'mapAppearance.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'minimap.js'), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  run('Minimap.init({ config: {} })');
  return { images, frames, handlers, document, classes, viewport, run, elements, launches, dungeonWidget,
    dungeonOptions: () => dungeonOptions, timers, drawing, windowEvents, locationRequests,
    get cancelledAnimations() { return cancelledAnimations; }, setTime(value) { now = value; } };
}

test('minimap requests only visible tiles and does no work while hidden', () => {
  const map = createMinimap();
  assert.equal(map.images.length, 0);
  map.document.hidden = true;
  map.run('Minimap.render()');
  assert.equal(map.images.length, 0);
  map.document.hidden = false;
  map.run('Minimap.render()');
  assert.equal(map.images.length, 4, 'The nearby default requests only four central tiles');
  assert.match(map.images[0].src, /tile\/90.webp/);
});

test('minimap projects current weapon drops, removes pickups and honors visibility and entry changes', () => {
  const map = createMinimap({ tracking: true });
  const item = { id: 'weapon-a', kind: 'weapon', name: 'Stultin', shiny: null, position: { x: 10, y: 0, z: 5 } };
  const payload = items => playerLocation({ instanceId: 'world-a', worldDrops: { status: 'available', sampledAt: 10000, items } });
  map.handlers.location(payload([item])); map.drawing.length = 0; map.run('Minimap.render()');
  assert.ok(map.drawing.some(row => row[0] === 'fillText' && row[1] === 'Stultin'));
  const dot = map.drawing.find(row => row[0] === 'arc' && row[3] === 3);
  assert.ok(Math.abs(dot[1] - 213) < 1e-9 && Math.abs(dot[2] - 143.5) < 1e-9, 'World coordinates share the exact tile/player projection');
  map.handlers.config({ showWorldDrops: false }); map.drawing.length = 0; map.run('Minimap.render()');
  assert.equal(map.drawing.some(row => row[0] === 'fillText' && row[1] === 'Stultin'), false);
  map.handlers.config({ showWorldDrops: true }); map.handlers.location(payload([])); map.drawing.length = 0; map.run('Minimap.render()');
  assert.equal(map.drawing.some(row => row[0] === 'fillText' && row[1] === 'Stultin'), false, 'Pickup removes the complete old set');
  map.handlers.location(payload([item])); map.handlers.dungeon({ active: true, status: 'ready', instanceId: 'dungeon-b' });
  map.drawing.length = 0; map.run('Minimap.render()');
  assert.equal(map.drawing.some(row => row[0] === 'fillText' && row[1] === 'Stultin'), false, 'Dungeon transitions clear overworld drops');
});

test('failed minimap tiles show how to retry and do not start polling', () => {
  const map = createMinimap();
  map.run('Minimap.render()');
  const tile = map.images[0];
  tile.onerror();
  assert.equal(tile.src, 'overkot-map-tiles://tile/90.webp');
  for (const image of map.images) image.complete = true;
  tile.onerror();
  map.run('Minimap.render()');
  assert.equal(map.images.length, 4);
  assert.equal(map.classes.get('loaded'), false);
  assert.match(map.elements['#minimap-tile-status'].textContent, /Settings → Game files/);
  assert.equal(map.elements['#minimap-connect'].hidden, true);
});

test('minimap keeps cached imagery while signed out and recovers missing tiles on connection', async () => {
  let resolveInitial;
  const map = createMinimap({ getMapTiles: () => new Promise(resolve => { resolveInitial = resolve; }) });
  const info = { version: 'same-feed', source: 'remote' };
  map.handlers.update({ ...info, requiresSignIn: true });
  map.run('Minimap.render()');
  const [cached, ...missing] = map.images;
  for (const tile of missing) { tile.complete = true; tile.onerror(); }
  map.run('Minimap.render()');
  const connect = map.elements['#minimap-connect'];
  assert.equal(connect.hidden, false);
  assert.match(connect.textContent, /Sign in with avakot\.dev/);
  assert.equal(map.classes.get('tile-notice'), false, 'Center the button while the viewport has no imagery');
  let stopped = false;
  connect.pointerdown({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, 'Pressing the button must not start a map drag');
  connect.click();
  assert.deepEqual(map.launches, ['connections']);
  cached.complete = true; cached.naturalWidth = 512; cached.onload();
  resolveInitial(info);
  await new Promise(resolve => setImmediate(resolve));
  map.run('Minimap.render()');
  assert.equal(map.classes.get('tile-notice'), true, 'Move the action to the compact notice when cached imagery is visible');
  assert.match(map.elements['#minimap-tile-status'].textContent, /Settings → Connections/);
  assert.ok(map.drawing.some(([op, image]) => op === 'drawImage' && image === cached));
  map.handlers.update(info);
  map.run('Minimap.render()');
  assert.equal(connect.hidden, true, 'The button leaves keyboard navigation as soon as the user connects');
  assert.ok(cached.src);
  assert.equal(map.images.length, 7, 'Only the three missing tiles are requested again');
  for (const tile of map.images.slice(4)) { tile.complete = true; tile.naturalWidth = 512; tile.onload(); }
  map.run('Minimap.render()');
  assert.equal(map.classes.get('loaded'), true);
  assert.equal(map.elements['#minimap-tile-status'].textContent, '');
  map.handlers.update({ ...info, requiresSignIn: true });
  map.run('Minimap.render()');
  assert.equal(map.classes.get('loaded'), true, 'All visible tiles remain usable offline');
  assert.equal(connect.hidden, true);
  assert.equal(map.images.length, 7);
});

test('a map data update retries missing legend icons in place once access is available', () => {
  const map = createMinimap();
  const base = 'overkot-map-tiles://data/map-icons/';
  const tree = { src: base + 'Tree.png', naturalWidth: 32, complete: true };
  const vendor = { src: base + 'Vendor.png', naturalWidth: 0, complete: true };
  const dungeon = { src: base + 'EntranceDown.png', naturalWidth: 0, complete: false };
  map.elements['#minimap-legend-panel'] = {
    querySelectorAll(selector) { assert.equal(selector, 'img'); return [tree, vendor, dungeon]; },
  };
  const info = { version: 'same-feed', source: 'remote' };
  map.handlers.update({ ...info, requiresSignIn: true });
  assert.equal(vendor.src, base + 'Vendor.png');
  map.handlers.update(info);
  assert.notEqual(vendor.src, base + 'Vendor.png');
  assert.notEqual(dungeon.src, base + 'EntranceDown.png');
  assert.equal(tree.src, base + 'Tree.png');
  const attempted = vendor.src;
  map.handlers.update(info);
  assert.equal(vendor.src, attempted);
  vendor.naturalWidth = 32;
  map.handlers.update({ ...info, reload: true });
  assert.equal(vendor.src, attempted, 'Keep the recovered image on a later warmup');
});

test('map refresh retires old image handlers and zooming in releases off-screen tile images', () => {
  const map = createMinimap();
  map.run('Minimap.render()');
  const old = map.images[0];
  const oldError = old.onerror;
  map.handlers.update({ version: 'new-feed', source: 'remote' });
  assert.equal(old.src, '');
  assert.equal(old.onload, null);
  oldError();
  assert.equal(old.src, '');

  map.run('Minimap.fitToView(); Minimap.render()');
  assert.equal(map.images.filter(image => image.src.startsWith('overkot-map-tiles:')).length, 196);
  map.run('Minimap.zoomAt(100, 200, 150); Minimap.render()');
  assert.ok(map.images.filter(image => image.src.startsWith('overkot-map-tiles:')).length <= 64);
});

test('manual refresh retries a failed minimap tile at the same version', () => {
  const map = createMinimap();
  const info = { version: 'same-feed', source: 'remote' };
  map.handlers.update(info);
  map.run('Minimap.render()');
  const tile = map.images[0];
  tile.onerror();
  map.handlers.update(info);
  assert.notEqual(tile.src, '');
  map.handlers.update({ ...info, reload: true });
  map.run('Minimap.render()');
  assert.equal(tile.src, '');
  assert.ok(map.images.some(image => image !== tile && image.src.startsWith('overkot-map-tiles:')));
});

test('expansion opens the current map mode and the dungeon controls expose their own expand action', () => {
  const map = createMinimap({ dungeon: true });
  map.elements['#minimap-expand'].click();
  map.dungeonWidget.active = true;
  map.elements['#minimap-expand'].click();
  map.dungeonOptions().onExpand();
  map.dungeonWidget.active = false;
  map.elements['#minimap-expand'].click();
  assert.deepEqual(map.launches, ['world', 'dungeon', 'dungeon', 'world']);
});

const playerLocation = overrides => ({ status: 'found', source: 'memory', sampledAt: 10000,
  zone: '/SF/Levels/MidrathRedux', position: { x: 0, y: 0, z: 0 }, heading: 0,
  isOverworld: true, trackingSession: 'session-a', ...overrides });

test('live minimap headings rotate a small triangle and unknown facing draws a dot', () => {
  const map = createMinimap({ tracking: true });
  let time = 10000;
  for (const heading of [0, 90, 180, 270]) {
    map.setTime(time); map.handlers.location(playerLocation({ heading }));
    time += 200; map.setTime(time);
    map.run('Minimap.fitToView(); Minimap.render()');
    assert.ok(map.drawing.some(row => row[0] === 'rotate' && row[1] === heading * Math.PI / 180));
    assert.equal(map.run('Minimap.playerMarker.heading'), heading);
    map.drawing.length = 0;
  }
  map.handlers.location(playerLocation({ heading: null }));
  map.run('Minimap.fitToView(); Minimap.render()');
  assert.equal(map.drawing.filter(row => row[0] === 'rotate').length, 0);
  assert.ok(map.drawing.some(row => row[0] === 'arc' && row[1] === 0 && row[2] === 0));
});

test('live minimap updates retain manual pan and zoom after one initial recenter', () => {
  const map = createMinimap({ tracking: true });
  map.handlers.location(playerLocation());
  // Finish the one initial animation, then manually change the viewport.
  for (const frame of map.frames.splice(0)) frame(1000);
  map.run('Minimap.fitToView(); Minimap.zoomAt(2, 40, 50); Minimap.render()');
  map.drawing.length = 0; map.run('Minimap.render()');
  const viewportTransform = map.drawing.find(row => row[0] === 'translate');
  const cancellations = map.cancelledAnimations;
  map.handlers.location(playerLocation({ position: { x: 15, y: 0, z: 20 }, heading: 90, sampledAt: 10001 }));
  assert.equal(map.cancelledAnimations, cancellations, 'live movement does not restart centering');
  assert.equal(map.run('Minimap.playerMarker'), null, 'future samples are rejected');
  map.setTime(10001);
  map.handlers.location(playerLocation({ position: { x: 15, y: 0, z: 20 }, heading: 90, sampledAt: 10001 }));
  assert.equal(map.cancelledAnimations, cancellations);
  assert.equal(map.run('Minimap.playerMarker.x'), 15);
  map.drawing.length = 0; map.run('Minimap.render()');
  assert.deepEqual(map.drawing.find(row => row[0] === 'translate'), viewportTransform);
  map.handlers.location(playerLocation({ source: 'capture' }));
  assert.equal(map.run('Minimap.playerMarker'), null, 'dormant screenshot results never replace live tracking');
});

test('minimap expires memory samples, clears context transitions, and rejects stale initial getters', async () => {
  let resolveLocation;
  const map = createMinimap({ tracking: true, getLocation: () => new Promise(resolve => { resolveLocation = resolve; }) });
  map.handlers.location(playerLocation({ heading: 90 }));
  resolveLocation(playerLocation({ source: 'capture', heading: 180 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(map.run('Minimap.playerMarker.heading'), 90);
  assert.equal(map.timers.size, 1);
  [...map.timers.values()][0].callback();
  assert.equal(map.run('Minimap.playerMarker'), null);
  map.handlers.location(playerLocation());
  map.handlers.dungeon({ active: true, status: 'ready' });
  assert.equal(map.run('Minimap.playerMarker'), null);
  assert.equal(map.timers.size, 0);
  for (const bad of [{ status: 'unavailable' }, { sampledAt: 7999 }, { heading: NaN },
    { isOverworld: false }, { zone: '/SF/Levels/Tower' }, { position: { x: Infinity, z: 0 } }]) {
    map.handlers.location(playerLocation()); map.handlers.location(playerLocation(bad));
    assert.equal(map.run('Minimap.playerMarker'), null);
  }
  map.windowEvents.unload();
  assert.equal(map.handlers.location, undefined);
  assert.equal(map.handlers.dungeon, undefined);
});

test('a dungeon transition outranks an initial minimap capture and same-world events retain expiry', async () => {
  let resolveLocation;
  const map = createMinimap({ tracking: true, getLocation: () => new Promise(resolve => { resolveLocation = resolve; }) });
  map.handlers.dungeon({ active: true, status: 'ready', instanceId: 'dungeon-b' });
  resolveLocation(playerLocation({ source: 'capture' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(map.run('Minimap.playerMarker'), null);
  map.handlers.dungeon({ active: false, status: 'outside', levelPath: '/SF/Levels/MidrathRedux', instanceId: 'world-a' });
  map.handlers.location(playerLocation({ instanceId: 'world-a' }));
  map.handlers.dungeon({ active: false, status: 'outside', levelPath: '/SF/Levels/MidrathRedux', instanceId: 'world-a' });
  [...map.timers.values()][0].callback();
  assert.equal(map.run('Minimap.playerMarker'), null, 'context notifications cannot disable expiry');
});

function screenPlayer(map) {
  map.drawing.length = 0; map.run('Minimap.render()');
  const translations = map.drawing.filter(row => row[0] === 'translate');
  const scale = map.drawing.find(row => row[0] === 'scale')[1];
  const view = translations[0], marker = translations.at(-1);
  return { x: view[1] + marker[1] * scale, y: view[2] + marker[2] * scale };
}

test('center button uses the latest live arrow after every move and never starts screenshot capture', async () => {
  const map = createMinimap({ tracking: true, locate: true });
  const button = map.elements['#minimap-locate'];
  assert.equal(button.disabled, true); assert.match(button.title, /Waiting for live/);
  await button.click(); assert.equal(map.locationRequests.captures, 0);
  map.handlers.location(playerLocation());
  for (const frame of map.frames.splice(0)) frame(10000);
  assert.equal(button.disabled, false); assert.match(button.title, /Following player/);
  map.run('Minimap.zoomAt(2, 40, 50)');
  await button.click();
  assert.deepEqual(screenPlayer(map), { x: 200, y: 150 });
  map.setTime(10001);
  map.handlers.location(playerLocation({ sampledAt: 10001, position: { x: 80, y: 0, z: 30 } }));
  assert.deepEqual(screenPlayer(map), { x: 200, y: 150 }, 'Center also follows subsequent movement');
  await button.click();
  assert.deepEqual(screenPlayer(map), { x: 200, y: 150 });
  assert.equal(map.locationRequests.captures, 0); assert.equal(map.locationRequests.cancellations, 0);
  assert.equal(map.elements['#minimap-locate-overlay'].classList.contains('hidden'), true);
  assert.equal(button.classList.contains('watching'), false);
  // A delayed older sample cannot move the arrow or the next center target back.
  map.handlers.location(playerLocation({ sampledAt: 10000, position: { x: 0, y: 0, z: 0 } }));
  assert.equal(map.run('Minimap.playerMarker.x'), 80);
  await button.click(); assert.deepEqual(screenPlayer(map), { x: 200, y: 150 });
});

test('expired, unavailable and screenshot positions leave centering disabled without F6 prompts', async () => {
  const map = createMinimap({ tracking: true, locate: true });
  const button = map.elements['#minimap-locate'];
  map.handlers.location(playerLocation()); map.setTime(12001);
  await button.click();
  assert.equal(button.disabled, true); assert.match(button.title, /Waiting for live/);
  assert.doesNotMatch(button.title, /F6|capture/);
  map.handlers.location(playerLocation({ source: 'capture', sampledAt: 12001 }));
  assert.equal(button.disabled, true); assert.equal(map.run('Minimap.playerMarker'), null);
  assert.equal(map.locationRequests.captures, 0);
});

test('minimap heading moves across north on animation frames while position updates immediately', () => {
  const map = createMinimap({ tracking: true, locate: true });
  map.handlers.location(playerLocation({ heading: 359, instanceId: 'world-a' }));
  map.setTime(10010);
  map.handlers.location(playerLocation({ heading: 1, sampledAt: 10010, instanceId: 'world-a', position: { x: 20, y: 0, z: 15 } }));
  assert.equal(map.run('Minimap.playerMarker.x'), 20);
  map.setTime(10070); map.drawing.length = 0;
  map.run('Minimap.fitToView(); Minimap.render()');
  const angle = map.drawing.find(row => row[0] === 'rotate')[1];
  assert.ok(Math.abs(angle) < 1e-8, '359 to 1 interpolates through north');
  map.setTime(10130); map.drawing.length = 0; map.run('Minimap.render()');
  assert.ok(Math.abs(map.drawing.find(row => row[0] === 'rotate')[1] - Math.PI / 180) < 1e-8);
  map.handlers.location(playerLocation({ heading: 240, sampledAt: 10130, instanceId: 'world-b' }));
  map.drawing.length = 0; map.run('Minimap.render()');
  assert.ok(Math.abs(map.drawing.find(row => row[0] === 'rotate')[1] - 240 * Math.PI / 180) < 1e-8, 'new context snaps to its own heading');
  map.handlers.location({ status: 'unavailable', source: 'memory' });
  map.drawing.length = 0; map.run('Minimap.render()');
  assert.equal(map.drawing.some(row => row[0] === 'rotate'), false);
});

test('minimap recolours a live marker and its outline without changing its viewport', () => {
  const map = createMinimap({ tracking: true });
  map.handlers.location(playerLocation());
  map.run('Minimap.fitToView(); Minimap.zoomAt(2, 40, 50); Minimap.render()');
  const before = screenPlayer(map);
  map.handlers.config({ playerMarkerColor: '#d15b40' });
  const after = screenPlayer(map);
  assert.deepEqual(after, before);
  assert.equal(map.elements['#minimap-canvas'].getContext().fillStyle, '#d15b40');
  map.drawing.length = 0;
  map.handlers.config({ playerMarkerOutlineColor: '#160d03' });
  assert.deepEqual(screenPlayer(map), before);
  assert.equal(map.elements['#minimap-canvas'].getContext().strokeStyle, '#160d03');
  assert.equal(map.elements['#minimap-canvas'].getContext().fillStyle, '#d15b40', 'Changing the outline preserves the fill');
  map.handlers.config({ playerMarkerColor: 'url(invalid)' });
  map.run('Minimap.render()');
  assert.equal(map.elements['#minimap-canvas'].getContext().fillStyle, '#f4b642');
  map.handlers.config({ playerMarkerOutlineColor: 'url(invalid)' });
  map.run('Minimap.render()');
  assert.equal(map.elements['#minimap-canvas'].getContext().strokeStyle, '#241708');
  map.handlers.config({ playerMarkerColor: '#769d45', playerMarkerOutlineColor: '#2a1b13' });
  // A close zoom makes this distant live point use the clamped edge indicator.
  map.run('Minimap.zoomAt(100, 40, 50)');
  map.handlers.location(playerLocation({ position: { x: 1000, y: 0, z: 1000 } }));
  map.run('Minimap.render()');
  assert.equal(map.elements['#minimap-canvas'].getContext().fillStyle, '#769d45');
  assert.equal(map.elements['#minimap-canvas'].getContext().strokeStyle, '#2a1b13');
});

const zoomOf = map => {
  map.drawing.length = 0; map.run('Minimap.render()');
  return map.drawing.find(row => row[0] === 'scale')?.[1];
};
const nearCenter = map => {
  const point = screenPlayer(map);
  assert.ok(Math.abs(point.x - map.viewport.clientWidth / 2) < 1e-8);
  assert.ok(Math.abs(point.y - map.viewport.clientHeight / 2) < 1e-8);
};

test('the nearby default centers an initial live snapshot and follows movement, zoom controls and resize', async () => {
  const map = createMinimap({ tracking: true, locate: true, getLocation: async () => playerLocation({ instanceId: 'world-a', position: { x: 120, y: 0, z: -80 } }) });
  await new Promise(resolve => setImmediate(resolve));
  nearCenter(map); assert.equal(zoomOf(map), .65);
  assert.equal(map.run('Minimap.following'), true);
  assert.equal(map.elements['#minimap-locate']['aria-pressed'], 'true');
  map.setTime(10050);
  map.handlers.location(playerLocation({ sampledAt: 10050, instanceId: 'world-a', position: { x: 150, y: 0, z: -120 } }));
  nearCenter(map);
  map.viewport.wheel({ clientX: 10, clientY: 15, deltaY: -1, preventDefault() {} });
  nearCenter(map); assert.ok(Math.abs(zoomOf(map) - .65 * 1.2) < 1e-10);
  map.elements['#minimap-zoom-in'].click(); nearCenter(map);
  const zoomed = zoomOf(map);
  map.viewport.clientWidth = 620; map.viewport.clientHeight = 420; map.handlers.resize();
  nearCenter(map); assert.equal(zoomOf(map), zoomed, 'Resizing never resets the chosen zoom');
  map.elements['#minimap-zoom-out'].click(); nearCenter(map);
  assert.ok(Math.abs(zoomOf(map) - .65 * 1.2) < 1e-10);
});

test('hidden zero-size startup waits for a real viewport without losing default zoom or player following', async () => {
  const map = createMinimap({ tracking: true, locate: true, width: 0, height: 0,
    getLocation: async () => playerLocation({ instanceId: 'world-a' }) });
  await new Promise(resolve => setImmediate(resolve));
  for (const frame of map.frames.splice(0)) frame(10000);
  assert.equal(map.drawing.length, 0);
  map.viewport.clientWidth = 460; map.viewport.clientHeight = 340; map.handlers.resize();
  nearCenter(map); assert.equal(zoomOf(map), .65);
  map.run('Minimap.zoomAt(1.5, 10, 10)'); nearCenter(map);
  const chosen = zoomOf(map);
  for (const frame of map.frames.splice(0)) frame(10000);
  nearCenter(map); assert.equal(zoomOf(map), chosen, 'A delayed boot frame does not overwrite a user zoom');
});

test('manual drag pauses following only after movement, and Center resumes at the selected zoom', async () => {
  const map = createMinimap({ tracking: true, locate: true });
  map.handlers.location(playerLocation({ instanceId: 'world-a' }));
  map.viewport.pointerdown({ button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  map.viewport.pointermove({ clientX: 102, clientY: 101, buttons: 1 });
  assert.equal(map.run('Minimap.following'), true, 'A click or small hand movement retains following');
  map.viewport.pointermove({ clientX: 135, clientY: 120, buttons: 1 });
  map.viewport.pointerup();
  assert.equal(map.run('Minimap.following'), false);
  assert.equal(map.elements['#minimap-locate']['aria-pressed'], 'false');
  const view = zoomOf(map), panned = map.drawing.find(row => row[0] === 'translate');
  map.setTime(10010);
  map.handlers.location(playerLocation({ instanceId: 'world-a', sampledAt: 10010, position: { x: 80, y: 0, z: -25 } }));
  zoomOf(map); assert.deepEqual(map.drawing.find(row => row[0] === 'translate'), panned, 'Walking preserves a deliberately panned view');
  await map.elements['#minimap-locate'].click(); nearCenter(map);
  assert.equal(map.run('Minimap.following'), true); assert.equal(zoomOf(map), view);
  map.setTime(10020);
  map.handlers.location(playerLocation({ instanceId: 'world-a', sampledAt: 10020, position: { x: 120, y: 0, z: -50 } })); nearCenter(map);
  map.viewport.pointerdown({ button: 0, clientX: 100, clientY: 100, pointerId: 2 });
  map.windowEvents.blur(); map.viewport.pointermove({ clientX: 170, clientY: 160, buttons: 1 });
  assert.equal(map.run('Minimap.following'), true, 'Focus loss cancels the drag before forwarded movement can pause follow');
});

test('a paused view survives stale samples, while new sessions and world entries follow only fresh matching positions', async () => {
  const map = createMinimap({ tracking: true, locate: true });
  map.handlers.location(playerLocation({ instanceId: 'world-a' }));
  map.run('Minimap.fitToView()'); assert.equal(map.run('Minimap.following'), false);
  map.setTime(12001); [...map.timers.values()][0].callback();
  map.handlers.location(playerLocation({ instanceId: 'world-a', sampledAt: 12001 }));
  assert.equal(map.run('Minimap.following'), false, 'Restored same-entry tracking does not discard a manual overview');
  map.handlers.location(playerLocation({ trackingSession: 'session-b', instanceId: 'world-a', sampledAt: 12001 }));
  nearCenter(map); assert.equal(map.run('Minimap.following'), true);
  map.handlers.dungeon({ active: true, status: 'ready', instanceId: 'dungeon-a' });
  map.handlers.location(playerLocation({ trackingSession: 'session-b', instanceId: 'world-a', sampledAt: 12001 }));
  assert.equal(map.run('Minimap.playerMarker'), null, 'An old overworld packet cannot recenter over a dungeon');
  map.handlers.dungeon({ active: false, status: 'outside', levelPath: '/SF/Levels/Procs/MidrathProc', instanceId: 'world-b' });
  map.handlers.location(playerLocation({ trackingSession: 'session-b', instanceId: 'world-a', sampledAt: 12001 }));
  assert.equal(map.run('Minimap.playerMarker'), null, 'A previous entry cannot move the new world camera');
  map.handlers.location(playerLocation({ trackingSession: 'session-b', instanceId: 'world-b', sampledAt: 12001 }));
  nearCenter(map);
});

test('a delayed first position respects manual dragging or an explicit overview chosen while loading', async () => {
  for (const action of ['pan', 'fit']) {
    let resolve;
    const map = createMinimap({ tracking: true, locate: true, getLocation: () => new Promise(yes => { resolve = yes; }) });
    if (action === 'pan') {
      map.run('Minimap.render()');
      map.viewport.pointerdown({ button: 0, clientX: 100, clientY: 100, pointerId: 1 });
      map.viewport.pointermove({ clientX: 135, clientY: 125, buttons: 1 }); map.viewport.pointerup();
    } else map.run('Minimap.fitToView()');
    const zoom = zoomOf(map), view = map.drawing.find(row => row[0] === 'translate');
    resolve(playerLocation({ instanceId: 'first-world-entry', position: { x: 120, y: 0, z: 80 } }));
    await new Promise(yes => setImmediate(yes));
    assert.equal(map.run('Minimap.following'), false, `First snapshot preserves ${action}`);
    assert.equal(zoomOf(map), zoom);
    assert.deepEqual(map.drawing.find(row => row[0] === 'translate'), view);
    await map.elements['#minimap-locate'].click(); nearCenter(map);
    assert.equal(map.run('Minimap.following'), true);
  }
});
