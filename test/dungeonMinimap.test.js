'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DungeonExploration = require('../src/modules/dungeonExploration');
const PlayerMarkerMotion = require('../src/modules/playerMarkerMotion');
const MapAppearance = require('../src/modules/mapAppearance');

const dungeonState = { active: true, instanceId: 'instance-1', set: 'UnderCityMidrath', key: 'underCityMidrath', name: 'Cliff Cave', layoutCode: 'first' };
const scene = { mode: 'placed', version: 'fixture', state: dungeonState, coordinateSpace: 'layout-local',
  bounds: { x: [0, 10], z: [0, 10] }, rooms: [{ slot: 0, parent: null, label: 'Entrance', room: 'Entrance',
    transform: { x: 0, z: 0, rotation: 0 }, outline: [{ closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }] }] };

async function mount(initial, options = {}) {
  const nodes = new Map(), frames = [], events = {}, timers = new Map(), saves = [], alignmentPoints = [];
  const drawing = { strokes: 0, clears: 0, fills: 0, maskFills: 0, images: [], text: [], points: [], arcs: [], clips: 0, rotations: [], translations: [], colors: [], calls: [], outlineEnds: [] };
  let now = 100000, nextTimer = 0, animationTime = 0, resizeCallback;
  let focused = options.focused !== false;
  const element = { hidden: options.autoSwitch !== false, closest: () => null, querySelector(selector) { return nodes.get(selector); } };
  for (const selector of ['.dungeon-map', '.dungeon-map-viewport', 'canvas', '.dungeon-map-empty', '.dungeon-map-empty-title',
    '.dungeon-map-empty-detail', '.dungeon-map-footer', '.dungeon-map-guide', '.dungeon-map-name', '.dungeon-map-mode',
    '.dungeon-map-room-count', ...['zoom-in', 'zoom-out', 'fit', 'retry', ...(options.allowManualAlignment !== false ? ['align', 'reset-alignment'] : []), ...(options.overlay ? ['close'] : ['glass']), ...(options.onExpand ? ['expand'] : [])].map(action => `[data-action="${action}"]`)]) {
    nodes.set(selector, { dataset: {}, style: { setProperty() {} }, textContent: '', hidden: false, disabled: false,
      clientWidth: 300, clientHeight: 250, getClientRects: () => element.hidden ? [] : [{}],
      getBoundingClientRect: () => ({ left: 0, top: 0 }), setAttribute() {}, title: '', captures: new Set(), releases: [],
      setPointerCapture(id) { this.captures.add(id); }, hasPointerCapture(id) { return this.captures.has(id); },
      releasePointerCapture(id) { this.captures.delete(id); this.releases.push(id); this.lostpointercapture?.({ pointerId: id }); },
      addEventListener(name, callback) { this[name] = callback; },
      removeEventListener(name, callback) { if (this[name] === callback) delete this[name]; } });
  }
  const guideNodes = new Map([['strong', { textContent: '' }], ['span', { textContent: '' }]]);
  nodes.get('.dungeon-map-guide').querySelector = selector => guideNodes.get(selector);
  const makeContext = layer => new Proxy({ clearRect() { drawing.clears++; }, stroke() { drawing.strokes++; drawing.colors.push(this.strokeStyle); drawing.calls.push('stroke'); if (layer === 'map') drawing.outlineEnds.push([...drawing.points.at(-1)]); },
    fill() { if (layer === 'mask') drawing.maskFills++; else drawing.fills++; drawing.calls.push(`fill:${layer}`); }, fillText(text) { drawing.text.push(text); }, strokeText(text) { drawing.text.push(text); },
    moveTo(...point) { drawing.points.push(point); }, arc(...args) { drawing.arcs.push(args); drawing.calls.push('arc'); },
    drawImage(source) { drawing.images.push({ layer, source: source.layer, filter: this.filter, operation: this.globalCompositeOperation }); drawing.calls.push(`image:${layer}`); },
    clip() { drawing.clips++; drawing.calls.push('clip'); }, translate(...args) { drawing.translations.push(args); },
    rotate(value) { drawing.rotations.push(value); }, measureText: text => ({ width: text.length * 5 }) }, { get: (target, key) => target[key] || (() => {}) });
  nodes.get('canvas').layer = 'visible';
  const context = makeContext('visible'), layers = [];
  nodes.get('canvas').getContext = () => context;
  let response = initial;
  const api = { getDungeonMap: async () => typeof response === 'function' ? response() : response,
    getDungeonDiscovery: async target => typeof options.discovery === 'function' ? options.discovery(target) : options.discovery || {
      ok: true, scope: `scope:${target.instanceId}:${target.revision}`, alignment: { status: 'verified', points: 3 },
      exploration: { schema: 1, radius: 45, cellSize: 8, cells: [[5, 5]] } },
    saveDungeonDiscovery: async value => { saves.push(JSON.parse(JSON.stringify(value))); return options.save ? options.save(value) : { ok: true }; },
    addDungeonAlignmentPoint: async value => { alignmentPoints.push(value); return options.addPoint ? options.addPoint(value, alignmentPoints.length) : { ok: true, alignment: { status: 'collecting', points: alignmentPoints.length } }; },
    resetDungeonAlignment: async value => options.resetAlignment ? options.resetAlignment(value) : { ok: true, scope: 'reset-scope', alignment: { status: 'unavailable', points: 0 } },
    getPlayerLocation: async () => typeof options.player === 'function' ? options.player() : options.player,
    onPlayerLocation(callback) { events.player = callback; return () => { delete events.player; }; },
    onDungeonDiscoveryChanged(callback) { events.discovery = callback; return () => { delete events.discovery; }; },
    getState: options.getState || (async () => ({ overlayInteractive: options.interactive !== false })),
    onDungeonStateChanged(callback) { events.dungeon = callback; }, onConfigChanged(callback) { events.config = callback; },
    onOverlayInteraction(callback) { events.interaction = callback; return () => { if (events.interaction === callback) delete events.interaction; }; } };
  const document = { hidden: false, hasFocus: () => focused,
    createElement(name) { assert.equal(name, 'canvas'); const layer = { layer: layers.length ? 'mask' : 'map' }; const drawingContext = makeContext(layer.layer); layer.getContext = () => drawingContext; layers.push(layer); return layer; },
    addEventListener(name, callback) { events[name] = callback; },
    removeEventListener(name, callback) { if (events[name] === callback) delete events[name]; } };
  const sandbox = vm.createContext({ window: { api, devicePixelRatio: 1, DungeonExploration, PlayerMarkerMotion, MapAppearance,
    addEventListener(name, callback) { events[name] = callback; },
    removeEventListener(name, callback) { if (events[name] === callback) delete events[name]; } },
    document, Date: class extends Date { static now() { return now; } }, performance: { now: () => animationTime },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: callback => frames.push(callback), ResizeObserver: class { constructor(callback) { resizeCallback = callback; } observe() {} disconnect() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/world-drop-markers.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/dungeon-map.js'), 'utf8'), sandbox);
  // Existing geometry/gesture fixtures deliberately use an overview. Compact
  // following is exercised separately with an explicit production option.
  const widget = sandbox.window.DungeonMapWidget.mount(element, { api, autoSwitch: true, followPlayer: false, allowManualAlignment: true, ...options });
  const frame = async (ms = 16) => { animationTime += ms; for (const callback of frames.splice(0)) callback(animationTime); await new Promise(resolve => setImmediate(resolve)); };
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); for (let count = 0; frames.length; count++) { assert.ok(count < 100, 'Animation must settle'); await frame(); } };
  await flush();
  return { nodes, guideNodes, events, drawing, element, widget, document, flush, frame, layers, saves, alignmentPoints, timers,
    get pendingFrames() { return frames.length; },
    get now() { return now; },
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = until; await flush();
    },
    respond(value) { response = value; }, setFocused(value) { focused = value; },
    async resize(width, height) { const viewport = nodes.get('.dungeon-map-viewport'); viewport.clientWidth = width; viewport.clientHeight = height; resizeCallback(); await flush(); } };
}

test('minimap rejects an old room-atlas response and clears the previous dungeon drawing', async () => {
  const map = await mount(scene);
  assert.equal(map.element.hidden, false);
  assert.equal(map.nodes.get('.dungeon-map-room-count').textContent, 'Rooms: 1');
  assert.ok(map.drawing.strokes > 0);
  const before = map.drawing.strokes, clears = map.drawing.clears;
  map.respond({ ...scene, mode: 'gallery', reason: 'unsupported' });
  await map.widget.refresh({ ...dungeonState, layoutCode: 'unresolved' }); await map.flush();
  assert.equal(map.nodes.get('.dungeon-map').dataset.status, 'unavailable');
  assert.equal(map.nodes.get('.dungeon-map-empty').hidden, false);
  assert.equal(map.nodes.get('.dungeon-map-empty-title').textContent, 'Map unavailable');
  assert.equal(map.nodes.get('.dungeon-map-room-count').textContent, '');
  assert.equal(map.nodes.get('.dungeon-map-mode').textContent, '');
  assert.equal(map.nodes.get('.dungeon-map-footer').textContent, '');
  assert.equal(map.drawing.strokes, before, 'No atlas outline is ever painted');
  assert.ok(map.drawing.clears > clears, 'The previously displayed layout is cleared');
  for (const action of ['zoom-in', 'zoom-out', 'fit', 'align']) assert.equal(map.nodes.get(`[data-action="${action}"]`).disabled, true);
  assert.equal(map.nodes.get('[data-action="glass"]').disabled, false);
});

test('minimap shows a waiting state without rooms and restores layout controls when the fingerprint arrives', async () => {
  const map = await mount({ mode: 'unavailable', reason: 'waiting', rooms: [], state: dungeonState });
  assert.equal(map.nodes.get('.dungeon-map-empty-title').textContent, 'Reading dungeon layout…');
  assert.equal(map.nodes.get('.dungeon-map-room-count').textContent, '');
  assert.equal(map.drawing.strokes, 0);
  map.respond(scene); await map.widget.refresh(dungeonState); await map.flush();
  assert.equal(map.nodes.get('.dungeon-map-empty').hidden, true);
  assert.equal(map.nodes.get('[data-action="fit"]').disabled, false);
  assert.ok(map.drawing.strokes > 0);
});

test('a pending dungeon response cannot reopen the minimap after exit', async () => {
  const map = await mount(scene);
  let release;
  map.respond(() => new Promise(resolve => { release = resolve; }));
  const pending = map.widget.refresh(dungeonState);
  assert.equal(map.nodes.get('.dungeon-map-empty-title').textContent, 'Reading dungeon layout…');
  map.respond({ mode: 'unavailable', reason: 'outside', rooms: [], state: { active: false } });
  await map.widget.refresh({ active: false });
  release(scene); await pending; await map.flush();
  assert.equal(map.element.hidden, true);
  assert.equal(map.nodes.get('.dungeon-map').dataset.status, 'unavailable');
  assert.equal(map.nodes.get('.dungeon-map-room-count').textContent, '');
});

test('retry restores current dungeon data and cannot start duplicate in-flight requests', async () => {
  const map = await mount({ mode: 'unavailable', reason: 'data', rooms: [], state: dungeonState });
  const retry = map.nodes.get('[data-action="retry"]');
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, false);
  let release, requests = 0;
  map.respond(() => { requests++; return new Promise(resolve => { release = resolve; }); });
  const event = { target: { closest: () => ({ dataset: { action: 'retry' } }) } };
  const pending = map.nodes.get('.dungeon-map').click(event);
  assert.equal(retry.disabled, true);
  assert.equal(map.nodes.get('.dungeon-map-empty-title').textContent, 'Reading dungeon layout…');
  await map.nodes.get('.dungeon-map').click(event);
  assert.equal(requests, 1);
  release(scene); await pending; await map.flush();
  assert.equal(map.nodes.get('.dungeon-map-empty').hidden, true);
  assert.equal(retry.hidden, true);
  assert.equal(map.nodes.get('[data-action="fit"]').disabled, false);
  assert.ok(map.drawing.strokes > 0);
});

test('dungeon outlines never render room names or expose labels on hover', async () => {
  const map = await mount(scene);
  assert.doesNotMatch(map.element.innerHTML, /data-action="labels"|Show room names/);
  assert.deepEqual(map.drawing.text, []);
  map.nodes.get('.dungeon-map-viewport').pointermove({ clientX: 150, clientY: 125 });
  await map.flush();
  assert.equal(map.nodes.get('.dungeon-map-viewport').title, '');
  assert.deepEqual(map.drawing.text, []);
});

test('expanded dungeon mode keeps outlines unfilled and supports pan, zoom, fit and close', async () => {
  let closes = 0;
  const map = await mount(scene, { overlay: true, autoSwitch: false, onClose: () => closes++ });
  assert.doesNotMatch(map.element.innerHTML, /data-action="(?:labels|glass|locate)"/);
  assert.match(map.element.innerHTML, /data-action="close"/);
  assert.equal(map.nodes.get('.dungeon-map').dataset.seeThrough, 'true');
  assert.ok(map.drawing.strokes > 0);
  assert.equal(map.drawing.fills, 0);
  const viewport = map.nodes.get('.dungeon-map-viewport');
  const original = [...map.drawing.points.at(-1)];
  viewport.pointerdown({ button: 0, buttons: 1, pointerId: 1, clientX: 100, clientY: 100 });
  viewport.pointermove({ buttons: 1, pointerId: 1, clientX: 135, clientY: 120 }); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), [original[0] + 35, original[1] + 20]);
  viewport.lostpointercapture();
  const panned = [...map.drawing.points.at(-1)];
  viewport.pointermove({ pointerId: 1, clientX: 180, clientY: 180 }); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), panned);
  viewport.wheel({ deltaY: 1, clientX: 150, clientY: 125, preventDefault() {} }); await map.flush();
  assert.notDeepEqual(map.drawing.points.at(-1), panned);
  const click = action => map.nodes.get('.dungeon-map').click({ target: { closest: () => ({ dataset: { action } }) } });
  await click('fit'); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), original);
  await click('close'); assert.equal(closes, 1);
  assert.equal(map.drawing.fills, 0);
  assert.deepEqual(map.drawing.text, []);
});

const panDown = (viewport, pointerId = 1) => viewport.pointerdown({ button: 0, buttons: 1, pointerId, clientX: 100, clientY: 100 });
const panMove = (viewport, buttons = 1, pointerId = 1) => viewport.pointermove({ buttons, pointerId, clientX: 135, clientY: 120 });

test('dungeon pan releases capture on native blur and rejects forwarded moves outside focus', async () => {
  const map = await mount(scene, { overlay: true, autoSwitch: false });
  const viewport = map.nodes.get('.dungeon-map-viewport');
  panDown(viewport); panMove(viewport); await map.flush();
  const panned = [...map.drawing.points.at(-1)];
  map.setFocused(false); map.events.blur();
  assert.deepEqual(viewport.releases, [1]);
  assert.equal(viewport.captures.size, 0);
  panDown(viewport); panMove(viewport); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), panned, 'Forwarded input cannot start another gesture while the game has focus');
});

test('interaction-off cancels fullscreen pan and zoom until explicit interaction resumes', async () => {
  const map = await mount(scene, { overlay: true, autoSwitch: false });
  const viewport = map.nodes.get('.dungeon-map-viewport');
  panDown(viewport); panMove(viewport); await map.flush();
  const panned = [...map.drawing.points.at(-1)];
  map.events.interaction(false);
  assert.deepEqual(viewport.releases, [1]);
  panDown(viewport); panMove(viewport);
  let prevented = false;
  viewport.wheel({ deltaY: 1, clientX: 150, clientY: 125, preventDefault() { prevented = true; } }); await map.flush();
  assert.equal(prevented, false, 'Inactive fullscreen map never consumes scrolling');
  assert.deepEqual(map.drawing.points.at(-1), panned);
  map.events.interaction(true); panDown(viewport); panMove(viewport); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), [panned[0] + 35, panned[1] + 20]);
});

test('Mini-Map can start a new focused pan after interaction-off with click-through disabled', async () => {
  const map = await mount(scene, { config: { clickThrough: false } });
  const viewport = map.nodes.get('.dungeon-map-viewport');
  panDown(viewport); map.events.interaction(false);
  assert.deepEqual(viewport.releases, [1]);
  const original = [...map.drawing.points.at(-1)];
  panDown(viewport); panMove(viewport); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), [original[0] + 35, original[1] + 20]);
});

test('a click-through Mini-Map rejects captured gestures outside explicit interaction mode', async () => {
  const map = await mount(scene, { config: { clickThrough: true }, interactive: false });
  const viewport = map.nodes.get('.dungeon-map-viewport');
  panDown(viewport); panMove(viewport); await map.flush();
  assert.equal(viewport.captures.size, 0, 'Focus alone cannot override configured pass-through');
  map.events.interaction(true); panDown(viewport);
  assert.equal(viewport.captures.has(1), true);
  map.events.interaction(false);
  assert.deepEqual(viewport.releases, [1]);
  panDown(viewport);
  assert.equal(viewport.captures.size, 0);
});

test('missing mouse-up stops on lost-button motion and unrelated pointers cannot move or end pan', async () => {
  const map = await mount(scene);
  const viewport = map.nodes.get('.dungeon-map-viewport');
  const original = [...map.drawing.points.at(-1)];
  panDown(viewport); panMove(viewport, 1, 2); viewport.pointerup({ pointerId: 2 });
  assert.equal(viewport.captures.has(1), true, 'Another pointer cannot end the captured gesture');
  panMove(viewport, 0); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), original);
  assert.deepEqual(viewport.releases, [1]);
  panMove(viewport); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), original, 'A later button-down move cannot revive a cancelled gesture');
});

test('destroy and visibility loss release pan capture and detach gesture subscriptions', async () => {
  const map = await mount(scene);
  const viewport = map.nodes.get('.dungeon-map-viewport');
  panDown(viewport);
  map.document.hidden = true; map.events.visibilitychange();
  assert.deepEqual(viewport.releases, [1]);
  map.document.hidden = false; panDown(viewport, 3);
  map.widget.destroy(); map.widget.destroy();
  assert.deepEqual(viewport.releases, [1, 3]);
  assert.equal(viewport.captures.size, 0);
  for (const event of ['wheel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) assert.equal(viewport[event], undefined);
  assert.equal(map.events.blur, undefined);
  assert.equal(map.events.visibilitychange, undefined);
  assert.equal(map.events.interaction, undefined);
});

test('a stale fullscreen interaction snapshot cannot override a newer interaction-off event', async () => {
  let release;
  const map = await mount(scene, { overlay: true, autoSwitch: false,
    getState: () => new Promise(resolve => { release = resolve; }) });
  const viewport = map.nodes.get('.dungeon-map-viewport');
  map.events.interaction(false);
  release({ overlayInteractive: true }); await map.flush();
  panDown(viewport); panMove(viewport); await map.flush();
  assert.equal(viewport.captures.size, 0);
  assert.deepEqual(viewport.releases, []);
  map.events.interaction(true); panDown(viewport);
  assert.equal(viewport.captures.has(1), true);
});

test('dungeon minimap expansion delegates to its dungeon overlay callback', async () => {
  let expands = 0;
  const map = await mount(scene, { onExpand: () => expands++ });
  assert.match(map.element.innerHTML, /data-action="expand"/);
  await map.nodes.get('.dungeon-map').click({ target: { closest: () => ({ dataset: { action: 'expand' } }) } });
  assert.equal(expands, 1);
});

test('centering and expanding the dungeon have distinct icons and accessible labels', async () => {
  const map = await mount(scene, { onExpand() {} });
  assert.match(map.element.innerHTML, /data-action="fit"[^>]+aria-label="Center and fit dungeon"><span class="icon-map-center"/);
  assert.match(map.element.innerHTML, /data-action="expand"[^>]+aria-label="Expand dungeon overlay"><span class="icon-expand"/);
  assert.doesNotMatch(map.element.innerHTML, /⛶/);
});

test('releasing fullscreen interaction preserves its visible map and pan while ending capture', async () => {
  let closes = 0;
  const map = await mount(scene, { overlay: true, autoSwitch: false, onClose: () => closes++ });
  const viewport = map.nodes.get('.dungeon-map-viewport');
  panDown(viewport); panMove(viewport); await map.flush();
  const panned = [...map.drawing.points.at(-1)];
  map.widget.releaseInteraction();
  assert.deepEqual(viewport.releases, [1]);
  assert.equal(viewport.captures.size, 0);
  panDown(viewport); panMove(viewport);
  viewport.wheel({ deltaY: 1, clientX: 150, clientY: 125, preventDefault() { assert.fail('Released map must not consume scroll'); } });
  await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), panned);
  assert.equal(map.widget.active, true);
  assert.equal(map.element.hidden, false);
  assert.equal(closes, 0);
  map.events.interaction(true);
  panDown(viewport); panMove(viewport); await map.flush();
  assert.deepEqual(map.drawing.points.at(-1), [panned[0] + 35, panned[1] + 20]);
});

test('explicit interaction release supersedes a pending startup interaction snapshot', async () => {
  let release;
  const map = await mount(scene, { overlay: true, autoSwitch: false,
    getState: () => new Promise(resolve => { release = resolve; }) });
  const viewport = map.nodes.get('.dungeon-map-viewport');
  map.widget.releaseInteraction();
  release({ overlayInteractive: true }); await map.flush();
  panDown(viewport);
  assert.equal(viewport.captures.size, 0, 'A late initial state cannot re-enable input after Escape');
});

const emptyDiscovery = { ok: true, scope: 'scope:instance-1:fixture', alignment: { status: 'unavailable', points: 0 },
  exploration: { schema: 1, radius: 45, cellSize: 8, cells: [] } };
const memoryPose = (sampledAt, extra = {}, dungeon = {}) => ({ status: 'found', source: 'memory', sampledAt,
  position: { x: 9999, y: 0, z: 9999 }, heading: 270, isOverworld: false, instanceId: 'instance-1', trackingSession: 'session-1',
  dungeon: { instanceId: 'instance-1', revision: 'fixture', scope: 'scope:instance-1:fixture', alignmentVerified: true,
    coordinateSpace: 'layout-local', position: { x: 3, z: 4 }, heading: 90, ...dungeon }, ...extra });
const clickAction = (map, action) => map.nodes.get('.dungeon-map').click({ target: { closest: () => ({ dataset: { action } }) } });
const clickMap = async (map, x = 150, y = 125) => {
  const viewport = map.nodes.get('.dungeon-map-viewport');
  viewport.pointerdown({ button: 0, buttons: 1, pointerId: 1, clientX: x, clientY: y });
  viewport.pointerup({ button: 0, buttons: 0, pointerId: 1, clientX: x, clientY: y });
  await map.flush();
};

test('disabling progressive reveal fits the whole dungeon in both map views without tracking or discovery', async () => {
  const fullScene = { ...scene, bounds: { x: [-5000, 5000], z: [-5000, 5000] },
    rooms: [{ ...scene.rooms[0], outline: [{ closed: true, points: [[-5000, -5000], [5000, -5000], [5000, 5000], [-5000, 5000]] }] }] };
  for (const options of [{ followPlayer: true }, { overlay: true, autoSwitch: false }]) {
    const map = await mount(fullScene, { ...options, allowManualAlignment: false, discovery: emptyDiscovery,
      config: { dungeonMapProgressiveReveal: false } });
    assert.ok(map.drawing.strokes > 0);
    assert.equal(map.drawing.clips, 0);
    assert.equal(map.drawing.maskFills, 0);
    assert.equal(map.drawing.fills, 0, 'Full-map display does not invent a player marker');
    assert.ok(map.drawing.points.every(([x, y]) => x >= 0 && x <= 300 && y >= 0 && y <= 250), 'The entire generated layout fits on entry');
    assert.equal(map.nodes.get('.dungeon-map-guide').hidden, true);
    assert.equal(map.nodes.get('[data-action="fit"]').disabled, false);
    assert.equal(map.nodes.get('[data-action="fit"]').title, 'Center and fit dungeon');
    assert.equal(map.nodes.get('.dungeon-map').dataset.following, 'false');
    assert.match(map.nodes.get('.dungeon-map-footer').textContent, /Full dungeon/);
    const strokes = map.drawing.strokes;
    map.events.config({ dungeonMapProgressiveReveal: true }); await map.flush();
    assert.equal(map.drawing.strokes, strokes, 'Enabling reveal returns an unexplored map to its empty view');
    assert.equal(map.nodes.get('.dungeon-map-guide').hidden, false);
    map.events.config({ dungeonMapProgressiveReveal: false }); await map.flush();
    assert.ok(map.drawing.strokes > strokes);
    await map.advance(1000);
    assert.equal(map.saves.length, 0, 'Showing the full layout never records it as explored');
    map.widget.destroy();
  }
});

test('placed Glades doorway caps draw on the full map and inside the player reveal without increasing the room count', async () => {
  const caps = [
    { room: 'GoAxCapOpeningCorruptedFlow', parent: 0, parentDoor: 0, transform: { x: 94, z: 4, rotation: Math.PI / 2 },
      outline: [{ points: [[0, 2], [0, 4]] }] },
    { room: 'GoAxCapOpeningSpiritTrees', parent: 0, parentDoor: 1, transform: { x: 116, z: 8, rotation: 0 },
      outline: [{ points: [[3, 0], [5, 0]] }] },
  ];
  const map = await mount({ ...scene, bounds: { x: [0, 128], z: [0, 10] }, capOutlines: caps },
    { discovery: emptyDiscovery, config: { dungeonMapProgressiveReveal: false } });
  // The fitted canvas maps each layout unit to two pixels. The two strokes start
  // at distinct transformed points away from the tree room at the origin.
  const assertCapStrokes = strokes => {
    for (const [x, y] of [[214, 127], [260, 119]]) {
      assert.ok(strokes.some(point => point[0] === x && point[1] === y), `Missing cap outline at ${x}, ${y}`);
    }
  };
  assertCapStrokes(map.drawing.outlineEnds);
  assert.equal(map.drawing.clips, 0);
  assert.equal(map.nodes.get('.dungeon-map-room-count').textContent, 'Rooms: 1');

  map.events.config({ dungeonMapProgressiveReveal: true }); await map.flush();
  const strokes = map.drawing.outlineEnds.length, calls = map.drawing.calls.length;
  map.events.player(memoryPose(map.now, {}, { position: { x: 106, z: 6 } })); await map.flush();
  assertCapStrokes(map.drawing.outlineEnds.slice(strokes));
  assert.ok(map.drawing.arcs.some(([x, y, radius]) => x === 234 && y === 123 && radius === 90),
    'The reveal circle at the player covers both cap outlines');
  const redraw = map.drawing.calls.slice(calls);
  assert.ok(redraw.includes('clip') && redraw.indexOf('clip') < redraw.indexOf('stroke'));
  assert.equal(map.nodes.get('.dungeon-map-room-count').textContent, 'Rooms: 1');
  map.widget.destroy();
});

test('full-map display keeps recording real exploration and toggling restores discovery and player following', async () => {
  const map = await mount(scene, { followPlayer: true, allowManualAlignment: false, discovery: emptyDiscovery,
    config: { dungeonMapProgressiveReveal: false } });
  map.events.player(memoryPose(map.now)); await map.flush();
  assert.deepEqual(map.drawing.translations.at(-1), [110, 145], 'Full-map mode keeps its fitted view while tracking the actual player');
  assert.equal(map.drawing.maskFills, 0);
  await map.advance(750);
  assert.deepEqual(map.saves.at(-1).exploration.cells, [[3, 4]]);
  const savedCount = map.saves.length;
  map.events.config({ dungeonMapProgressiveReveal: true }); await map.flush();
  assert.ok(map.drawing.maskFills > 0);
  assert.deepEqual(map.drawing.translations.at(-1), [150, 125]);
  assert.equal(map.nodes.get('.dungeon-map').dataset.following, 'true');
  map.events.config({ dungeonMapProgressiveReveal: false }); await map.flush();
  assert.deepEqual(map.drawing.translations.at(-1), [110, 145]);
  await map.advance(750);
  assert.equal(map.saves.length, savedCount);
  assert.deepEqual(map.saves.at(-1).exploration.cells, [[3, 4]], 'Toggle changes do not clear or manufacture exploration');
  map.widget.destroy();
});

test('full-map mode clears an exited dungeon and fits the next current layout', async () => {
  const map = await mount(scene, { followPlayer: true, allowManualAlignment: false, discovery: emptyDiscovery,
    config: { dungeonMapProgressiveReveal: false } });
  const strokes = map.drawing.strokes;
  map.respond({ mode: 'outside', state: { active: false }, rooms: [] });
  map.events.dungeon({ active: false }); await map.flush();
  assert.equal(map.element.hidden, true);
  const next = { ...scene, state: { ...dungeonState, instanceId: 'instance-2' },
    bounds: { x: [100, 110], z: [200, 210] }, rooms: [{ ...scene.rooms[0], transform: { x: 100, z: 200, rotation: 0 } }] };
  map.respond(next); await map.widget.refresh(next.state); await map.flush();
  assert.equal(map.element.hidden, false);
  assert.ok(map.drawing.strokes > strokes);
  assert.deepEqual(map.drawing.outlineEnds.at(-1), [50, 225]);
  assert.equal(map.nodes.get('.dungeon-map-guide').hidden, true);
  assert.equal(map.drawing.fills, 0);
  map.widget.destroy();
});

test('compact and large dungeon maps render only current discovered drop projections and remove pickups', async () => {
  for (const options of [{ followPlayer: true }, { overlay: true, autoSwitch: false }]) {
    const map = await mount(scene, options);
    const mapped = { ...memoryPose(map.now).dungeon, position: { x: 5, z: 5 } };
    const item = { id: 'drop-a', kind: 'weapon', name: 'Stultin', shiny: null,
      position: { x: 10000, y: 0, z: 10000 }, dungeon: mapped };
    const pose = items => memoryPose(map.now, { worldDrops: { status: 'available', sampledAt: map.now, items } });
    map.events.player(pose([item])); await map.flush();
    assert.ok(map.drawing.text.includes('Stultin'));
    const dot = map.drawing.arcs.find(arc => arc[2] === 3);
    assert.ok(dot && dot[0] >= 0 && dot[0] <= 300 && dot[1] >= 0 && dot[1] <= 250, 'Layout-local projection is visible; raw world coordinates would be far offscreen');
    if (options.followPlayer) {
      assert.ok(Math.abs(dot[0] - (150 + 2 * 250 / 90)) < 1e-9);
      assert.ok(Math.abs(dot[1] - (125 - 250 / 90)) < 1e-9);
    }
    map.drawing.text.length = 0;
    map.events.player(pose([{ ...item, dungeon: { ...mapped, scope: 'old-scope' } }])); await map.flush();
    assert.equal(map.drawing.text.includes('Stultin'), false, 'An earlier alignment cannot paint drops over the current map');
    map.events.player(pose([item])); await map.flush();
    map.drawing.text.length = 0; map.events.config({ showWorldDrops: false }); await map.flush();
    assert.equal(map.drawing.text.includes('Stultin'), false);
    map.events.config({ showWorldDrops: true }); map.events.player(pose([])); map.drawing.text.length = 0; await map.flush();
    assert.equal(map.drawing.text.includes('Stultin'), false, 'A complete empty frame removes the pickup immediately');
    map.events.player(pose([item])); await map.flush(); map.drawing.text.length = 0;
    await map.advance(2001); assert.equal(map.drawing.text.includes('Stultin'), false, 'Expired drops disappear with stale player tracking');
    map.widget.destroy();
  }
});

test('unaligned maps remain hidden and an explicit alignment preview uses neutral, unfilled outlines', async () => {
  const withKinds = { ...scene, rooms: [scene.rooms[0], { ...scene.rooms[0], room: 'ExitBoss', kind: 'boss' },
    { ...scene.rooms[0], room: 'DeadEnd', kind: 'dead_end' }] };
  const map = await mount(withKinds, { discovery: emptyDiscovery });
  assert.equal(map.drawing.strokes, 0);
  assert.equal(map.guideNodes.get('strong').textContent, 'Align player position');
  await clickAction(map, 'align'); await map.flush();
  assert.equal(map.nodes.get('.dungeon-map').dataset.aligning, 'true');
  assert.ok(map.drawing.strokes >= 3);
  assert.deepEqual([...new Set(map.drawing.colors)], ['#d8d8d8']);
  assert.equal(map.drawing.fills, 0, 'Room tiles have no fill or kind-based colour');
  await map.advance(1000);
  assert.equal(map.saves.length, 0, 'Previewing never discovers rooms');
  const strokes = map.drawing.strokes;
  await clickAction(map, 'align'); await map.flush();
  assert.equal(map.drawing.strokes, strokes, 'Ending preview returns to a blank undiscovered map');
});

test('fresh, verified dungeon poses clip outlines to circles and rotate a small triangle using mapped heading', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  map.events.player(memoryPose(map.now)); await map.flush();
  assert.ok(map.drawing.arcs.some(args => args[2] === 45 * 20), 'Discovery radius follows map zoom');
  assert.ok(map.drawing.calls.indexOf('clip') < map.drawing.calls.indexOf('stroke'));
  assert.equal(map.drawing.rotations.at(-1), Math.PI / 2, 'World heading is never substituted for the mapped heading');
  assert.equal(map.drawing.fills, 1, 'Only the player triangle is filled');
  assert.deepEqual(map.drawing.translations.at(-1), [110, 145], 'Marker uses the verified layout position, not raw world coordinates');
  await map.advance(750);
  assert.deepEqual(map.saves[0].exploration.cells, [[3, 4]]);
});

test('stale tracking clears the triangle after two seconds while retaining discovered geometry', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  map.events.player(memoryPose(map.now)); await map.flush();
  const fills = map.drawing.fills;
  await map.advance(2001);
  assert.equal(map.drawing.fills, fills);
  assert.ok(map.drawing.strokes > 1, 'Previously revealed outlines remain painted');
  assert.match(map.nodes.get('.dungeon-map-footer').textContent, /Discovered areas saved/);
  map.widget.destroy();
  assert.equal(map.timers.size, 0);
  assert.equal(map.events.player, undefined);
  assert.equal(map.events.discovery, undefined);
});

test('only exact instance, revision, coordinate space and fresh memory data may reveal a map', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  const invalid = [
    memoryPose(map.now, { source: 'screenshot' }), memoryPose(map.now - 2001), memoryPose(map.now + 1),
    memoryPose(map.now, { isOverworld: true }), memoryPose(map.now, { instanceId: 'other' }),
    memoryPose(map.now, {}, { instanceId: 'other' }), memoryPose(map.now, {}, { revision: 'old' }),
    memoryPose(map.now, {}, { coordinateSpace: 'world' }), memoryPose(map.now, {}, { alignmentVerified: false }), memoryPose(map.now, {}, { alignmentVerified: 'true' }),
    memoryPose(map.now, {}, { position: { x: NaN, z: 0 } }), memoryPose(map.now, {}, { scope: null }),
  ];
  for (const value of invalid) { map.events.player(value); await map.flush(); }
  assert.equal(map.drawing.strokes, 0);
  assert.equal(map.drawing.fills, 0);
  await map.advance(750);
  assert.equal(map.saves.length, 0);
});

test('a position without verified facing draws a dot without inventing a triangle heading', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  map.events.player(memoryPose(map.now, {}, { heading: null })); await map.flush();
  assert.deepEqual(map.drawing.rotations, []);
  assert.ok(map.drawing.arcs.some(args => args[0] === 0 && args[1] === 0 && args[2] === 4));
  assert.match(map.nodes.get('.dungeon-map-footer').textContent, /facing unavailable/);
});

test('a late discovery load merges with newly revealed circles instead of erasing progress', async () => {
  let release;
  const map = await mount(scene, { discovery: () => new Promise(resolve => { release = resolve; }) });
  map.events.player(memoryPose(map.now)); await map.flush();
  release({ ...emptyDiscovery, exploration: { ...emptyDiscovery.exploration, cells: [[100, 100]] } }); await map.flush();
  await map.advance(750);
  assert.deepEqual(map.saves[0].exploration.cells, [[3, 4], [100, 100]]);
});

test('scene exit flushes the captured scope and rejects a previous instance discovery response', async () => {
  let release;
  const map = await mount(scene, { discovery: target => target.instanceId === 'instance-1'
    ? new Promise(resolve => { release = resolve; })
    : { ...emptyDiscovery, scope: 'scope:instance-2:fixture-2' } });
  map.events.player(memoryPose(map.now)); await map.flush();
  const next = { ...scene, version: 'fixture-2', state: { ...dungeonState, instanceId: 'instance-2' } };
  map.respond(next); await map.widget.refresh(next.state); await map.flush();
  assert.equal(map.saves[0].scope, 'scope:instance-1:fixture');
  assert.deepEqual(map.saves[0].exploration.cells, [[3, 4]]);
  release({ ...emptyDiscovery, exploration: { ...emptyDiscovery.exploration, cells: [[800, 800]] } }); await map.flush();
  assert.equal(map.nodes.get('.dungeon-map-guide').hidden, false);
  map.events.player(memoryPose(map.now, { instanceId: 'instance-2' }, { instanceId: 'instance-2', revision: 'fixture-2', scope: 'scope:instance-2:fixture-2' }));
  await map.advance(750);
  assert.equal(map.saves.at(-1).scope, 'scope:instance-2:fixture-2');
  assert.deepEqual(map.saves.at(-1).exploration.cells, [[3, 4]]);
});

test('discovery broadcasts merge both windows and a reset rotates scope without resurrecting old circles', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  map.events.player(memoryPose(map.now)); await map.flush();
  map.events.discovery({ instanceId: 'instance-1', revision: 'fixture', scope: emptyDiscovery.scope,
    exploration: { ...emptyDiscovery.exploration, cells: [[80, 80]] } }); await map.flush();
  await map.advance(750);
  assert.deepEqual(map.saves[0].exploration.cells, [[3, 4], [80, 80]]);
  map.events.discovery({ instanceId: 'instance-1', revision: 'fixture', scope: 'reset-scope', previousScope: emptyDiscovery.scope,
    reset: true, exploration: emptyDiscovery.exploration, alignment: { status: 'unavailable', points: 0 } });
  const strokes = map.drawing.strokes;
  map.events.discovery({ instanceId: 'instance-1', revision: 'fixture', scope: emptyDiscovery.scope,
    exploration: { ...emptyDiscovery.exploration, cells: [[90, 90]] } });
  map.events.player(memoryPose(map.now)); await map.flush();
  assert.equal(map.drawing.strokes, strokes, 'Old scoped updates cannot reveal the reset map');
  await map.advance(1);
  map.events.player(memoryPose(map.now, {}, { scope: 'reset-scope', position: { x: 30, z: 30 } })); await map.advance(750);
  assert.equal(map.saves.at(-1).scope, 'reset-scope');
  assert.deepEqual(map.saves.at(-1).exploration.cells, [[30, 30]]);
});

test('live movement retains user pan and zoom and does not refit the map', async () => {
  const map = await mount(scene);
  const viewport = map.nodes.get('.dungeon-map-viewport');
  panDown(viewport); panMove(viewport); viewport.pointerup({ pointerId: 1 });
  viewport.wheel({ deltaY: 1, clientX: 150, clientY: 125, preventDefault() {} }); await map.flush();
  const panned = map.drawing.outlineEnds.at(-1);
  map.events.player(memoryPose(map.now)); await map.flush();
  assert.deepEqual(map.drawing.outlineEnds.at(-1), panned);
  await map.advance(100);
  map.events.player(memoryPose(map.now, {}, { position: { x: 9, z: 9 } })); await map.flush();
  assert.deepEqual(map.drawing.outlineEnds.at(-1), panned);
});

test('alignment marks require fresh tracking and use inverse map coordinates while dragging remains a pan', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  await clickAction(map, 'align'); await map.flush();
  await clickMap(map);
  assert.equal(map.alignmentPoints.length, 0);
  assert.match(map.guideNodes.get('span').textContent, /Waiting for live player tracking/);
  map.events.player(memoryPose(map.now, {}, { alignmentVerified: false })); await map.flush();
  await clickMap(map);
  assert.equal(map.alignmentPoints.length, 1);
  assert.equal(map.alignmentPoints[0].instanceId, 'instance-1');
  assert.equal(map.alignmentPoints[0].revision, 'fixture');
  assert.deepEqual(JSON.parse(JSON.stringify(map.alignmentPoints[0].map)), { x: 5, z: 5 });
  assert.match(map.guideNodes.get('strong').textContent, /1\/3/);
  const viewport = map.nodes.get('.dungeon-map-viewport');
  panDown(viewport); panMove(viewport); viewport.pointerup({ pointerId: 1, clientX: 135, clientY: 120 }); await map.flush();
  assert.equal(map.alignmentPoints.length, 1, 'Dragging must not submit an alignment point');
  await clickAction(map, 'reset-alignment'); await map.flush();
  assert.match(map.guideNodes.get('strong').textContent, /0\/3/);
  assert.equal(map.saves.length, 0, 'Alignment and its full map preview never count as exploration');
});

test('schematic layouts remain unavailable for player exploration instead of claiming false coordinates', async () => {
  const map = await mount({ ...scene, mode: 'schematic' });
  map.events.player(memoryPose(map.now)); await map.flush();
  assert.equal(map.drawing.strokes, 0);
  assert.equal(map.drawing.fills, 0);
  assert.equal(map.nodes.get('[data-action="align"]').disabled, true);
  assert.match(map.guideNodes.get('strong').textContent, /Positioned map unavailable/);
});

test('three verified alignment points end the preview and live discovery starts from the mapped player', async () => {
  let verified = false;
  const map = await mount(scene, { discovery: emptyDiscovery,
    player: () => memoryPose(100000, {}, { alignmentVerified: verified }),
    addPoint: (_value, count) => {
      verified = count === 3;
      return { ok: true, alignment: { status: verified ? 'verified' : 'collecting', points: count } };
    } });
  await clickAction(map, 'align'); await map.flush();
  await clickMap(map, 100, 100); await clickMap(map, 150, 125);
  assert.equal(map.drawing.fills, 0, 'Collecting anchors does not create a player marker');
  await clickMap(map, 200, 150);
  assert.equal(map.nodes.get('.dungeon-map').dataset.aligning, 'false');
  assert.ok(map.drawing.clips > 0);
  assert.ok(map.drawing.fills > 0);
  await map.advance(750);
  assert.deepEqual(map.saves[0].exploration.cells, [[3, 4]], 'Anchor clicks never become exploration positions');
});

test('world-coordinate maps can reveal from a verified memory datum without manual alignment', async () => {
  const map = await mount({ ...scene, coordinateSpace: 'world' }, { discovery: emptyDiscovery });
  assert.equal(map.nodes.get('[data-action="align"]').disabled, true);
  map.events.player(memoryPose(map.now, {}, { coordinateSpace: 'world' })); await map.flush();
  assert.equal(map.drawing.fills, 1);
  assert.equal(map.nodes.get('.dungeon-map-guide').hidden, true);
});

test('a late initial player-location snapshot cannot replace a newer live event', async () => {
  let release;
  const map = await mount(scene, { discovery: emptyDiscovery, player: () => new Promise(resolve => { release = resolve; }) });
  map.events.player(memoryPose(map.now)); await map.flush();
  const translations = map.drawing.translations.length;
  release({ status: 'unavailable' }); await map.flush();
  assert.equal(map.drawing.translations.length, translations);
  assert.match(map.nodes.get('.dungeon-map-footer').textContent, /Live player position/);
});

test('failed discovery saves retry without movement and destroy flushes the latest circles once', async () => {
  let attempts = 0;
  const map = await mount(scene, { discovery: emptyDiscovery, save: () => ({ ok: ++attempts > 1 }) });
  map.events.player(memoryPose(map.now)); await map.advance(750);
  assert.equal(map.saves.length, 1);
  await map.advance(3000);
  assert.equal(map.saves.length, 2, 'A stationary player does not lose discovery after a temporary storage failure');
  await map.advance(1);
  map.events.player(memoryPose(map.now, {}, { position: { x: 12, z: 12 } }));
  map.widget.destroy(); map.widget.destroy(); await map.flush();
  assert.equal(map.saves.length, 3);
  assert.ok(map.saves.at(-1).exploration.cells.some(point => point[0] === 12 && point[1] === 12));
  assert.equal(map.timers.size, 0);
});

test('discovery startup failures retry, while slow in-flight loads are not repeatedly superseded', async () => {
  let attempts = 0;
  const map = await mount(scene, { discovery: () => {
    if (++attempts === 1) throw new Error('Storage temporarily unavailable');
    return { ...emptyDiscovery, exploration: { ...emptyDiscovery.exploration, cells: [[5, 5]] } };
  } });
  assert.equal(map.drawing.strokes, 0);
  await map.advance(3000);
  assert.equal(attempts, 2);
  assert.ok(map.drawing.strokes > 0);
  map.widget.destroy();

  let release, pendingRequests = 0;
  const slow = await mount(scene, { discovery: () => { pendingRequests++; return new Promise(resolve => { release = resolve; }); } });
  await slow.advance(6000);
  assert.equal(pendingRequests, 1, 'Periodic retries wait for the active request to finish');
  release({ ...emptyDiscovery, exploration: { ...emptyDiscovery.exploration, cells: [[5, 5]] } }); await slow.flush();
  assert.ok(slow.drawing.strokes > 0);
  slow.widget.destroy();
});

test('discovery feathers only the offscreen neutral map and draws the player after the masked layer', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  map.events.player(memoryPose(map.now)); await map.flush();
  assert.equal(map.layers.length, 2, 'Reuses one map layer and one bounded reveal mask');
  assert.ok(map.drawing.images.some(call => call.layer === 'map' && call.source === 'mask'
    && call.operation === 'destination-in' && /^blur\([\d.]+px\)$/.test(call.filter)));
  assert.ok(map.drawing.calls.indexOf('clip') < map.drawing.calls.indexOf('image:map'), 'Exact discovery circle clips the blurred mask');
  assert.ok(map.drawing.calls.lastIndexOf('image:visible') < map.drawing.calls.lastIndexOf('fill:visible'), 'Player marker remains outside the feather mask');
  assert.equal(map.drawing.fills, 1);
  assert.equal(map.drawing.maskFills, 1);
  assert.ok(map.layers[1].width <= map.nodes.get('canvas').width + 48);
  assert.ok(map.layers[1].height <= map.nodes.get('canvas').height + 48);
});

test('dungeon heading animates the shortest turn on frames while position updates immediately and masks stay cached', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  map.events.player(memoryPose(map.now, {}, { heading: 350 })); await map.flush();
  map.events.player(memoryPose(map.now, {}, { heading: 10, position: { x: 9, z: 9 } }));
  await map.frame(0);
  const outlines = map.drawing.outlineEnds.length, masks = map.drawing.maskFills;
  assert.ok(Math.abs(map.drawing.rotations.at(-1) * 180 / Math.PI - 350) < 1e-8);
  assert.deepEqual(map.drawing.translations.at(-1), [230, 45], 'Latest real position is never delayed by heading interpolation');
  await map.frame(60);
  assert.ok(Math.abs(map.drawing.rotations.at(-1)) < 1e-8, '350° → 10° crosses north rather than rotating around the long way');
  assert.equal(map.drawing.outlineEnds.length, outlines);
  assert.equal(map.drawing.maskFills, masks, 'Heading-only frames do not rebuild large discovery masks');
  await map.frame(60);
  assert.ok(Math.abs(map.drawing.rotations.at(-1) * 180 / Math.PI - 10) < 1e-8);
  assert.equal(map.pendingFrames, 0, 'Animation scheduling stops when facing settles');
});

test('unavailable tracking and scene changes cancel dungeon heading interpolation', async () => {
  const map = await mount(scene, { discovery: emptyDiscovery });
  map.events.player(memoryPose(map.now, {}, { heading: 0 })); await map.flush();
  map.events.player(memoryPose(map.now, {}, { heading: 120 })); await map.frame(30);
  const fills = map.drawing.fills;
  map.events.player({ status: 'unavailable' }); await map.flush();
  assert.equal(map.drawing.fills, fills); assert.equal(map.pendingFrames, 0);
  const next = { ...scene, version: 'new', state: { ...dungeonState, instanceId: 'next-entry' } };
  map.respond(next); await map.widget.refresh(next.state); await map.flush();
  map.events.player(memoryPose(map.now, { instanceId: 'next-entry' }, { instanceId: 'next-entry', revision: 'new', scope: 'new-scope', heading: 270 }));
  await map.frame(0);
  assert.ok(Math.abs(map.drawing.rotations.at(-1) * 180 / Math.PI - 270) < 1e-8);
  assert.equal(map.pendingFrames, 0, 'A new instance starts at its actual facing without an old-scene turn');
});

test('normal dungeon setup waits for automatic placement without manual calibration controls or exposing geometry', async () => {
  const map = await mount(scene, { allowManualAlignment: false, discovery: { ...emptyDiscovery, alignment: { status: 'detecting', source: 'stream-region', points: 0 } } });
  assert.doesNotMatch(map.element.innerHTML, /data-action="(?:align|reset-alignment)"/);
  assert.equal(map.guideNodes.get('strong').textContent, 'Finding dungeon position…');
  assert.match(map.guideNodes.get('span').textContent, /Waiting for live dungeon placement/);
  assert.doesNotMatch(map.guideNodes.get('span').textContent, /click|three|mark/i);
  assert.equal(map.drawing.strokes, 0); assert.equal(map.drawing.fills, 0);
  map.events.player(memoryPose(map.now, {}, { alignmentVerified: false })); await map.flush();
  assert.equal(map.drawing.strokes, 0);
  map.events.player(memoryPose(map.now)); await map.flush();
  assert.ok(map.drawing.strokes > 0); assert.equal(map.drawing.fills, 1);
  assert.equal(map.nodes.get('.dungeon-map-guide').hidden, true);
});

const compactOptions = { followPlayer: true, allowManualAlignment: false, discovery: emptyDiscovery };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, message || `${actual} != ${expected}`);
const markerPoint = map => map.drawing.translations.at(-1);
const assertMarkerAt = (map, x, y) => { near(markerPoint(map)[0], x); near(markerPoint(map)[1], y); };
const revealRadius = map => Math.max(...map.drawing.arcs.map(args => args[2]));

test('the compact reveal circle fits the viewport edges independently of dungeon bounds and aspect ratio', async () => {
  for (const bounds of [{ x: [0, 10], z: [0, 10] }, { x: [-5000, 5000], z: [-9000, 9000] }]) for (const [width, height] of [[300, 250], [240, 420], [600, 320]]) {
    const map = await mount({ ...scene, bounds }, compactOptions);
    await map.resize(width, height);
    assert.match(map.element.innerHTML, /data-action="fit"[^>]+aria-label="Center on player"/);
    assert.equal(map.nodes.get('[data-action="fit"]').disabled, true);
    assert.equal(map.drawing.fills, 0, 'The camera never invents a player location');
    map.events.player(memoryPose(map.now)); await map.flush();
    assertMarkerAt(map, width / 2, height / 2);
    const radius = revealRadius(map), shortEdge = Math.min(width, height);
    near(radius * 2, shortEdge, 'The reveal circle touches both edges of the shorter viewport dimension');
    near((width <= height ? markerPoint(map)[0] : markerPoint(map)[1]) - radius, 0);
    assert.equal(map.nodes.get('.dungeon-map').dataset.followPlayer, 'true');
    assert.equal(map.nodes.get('.dungeon-map').dataset.following, 'true');
    assert.equal(map.nodes.get('[data-action="fit"]').disabled, false);
    map.widget.destroy();
  }
});

test('compact following recentres walking and teleports without changing its chosen zoom', async () => {
  const map = await mount(scene, compactOptions);
  for (const position of [{ x: 3, z: 4 }, { x: 12, z: 8 }, { x: 1000, z: -800 }]) {
    map.drawing.arcs.length = 0;
    map.events.player(memoryPose(map.now, {}, { position })); await map.flush();
    assertMarkerAt(map, 150, 125); near(revealRadius(map), 125);
    await map.advance(100);
  }
  await map.advance(750);
  const circles = map.saves.at(-1).exploration.cells;
  assert.ok(circles.some(([x, z]) => x === 1000 && z === -800));
  assert.ok(circles.length < 20, 'A teleport never discovers a connecting path across the dungeon');
  map.widget.destroy();
});

test('compact zoom buttons, off-centre scrolling and resize keep the player anchored at the centre', async () => {
  const map = await mount(scene, compactOptions), viewport = map.nodes.get('.dungeon-map-viewport');
  map.events.player(memoryPose(map.now)); await map.flush();
  map.drawing.arcs.length = 0;
  viewport.wheel({ deltaY: -1, clientX: 20, clientY: 30, preventDefault() {} }); await map.flush();
  assertMarkerAt(map, 150, 125); near(revealRadius(map), 125 * 1.2);
  map.drawing.arcs.length = 0;
  await clickAction(map, 'zoom-in'); await map.flush();
  assertMarkerAt(map, 150, 125); near(revealRadius(map), 125 * 1.2 * 1.4);
  map.drawing.arcs.length = 0;
  await map.resize(500, 400);
  assertMarkerAt(map, 250, 200); near(revealRadius(map), 45 * 400 / 90 * 1.2 * 1.4);
  map.drawing.arcs.length = 0;
  await clickAction(map, 'zoom-out'); await map.flush();
  assertMarkerAt(map, 250, 200); near(revealRadius(map), 45 * 400 / 90 * 1.2);
  map.widget.destroy();
});

test('only an authorised drag pauses compact following and Center resumes at the current zoom', async () => {
  const map = await mount(scene, compactOptions), viewport = map.nodes.get('.dungeon-map-viewport');
  map.events.player(memoryPose(map.now)); await map.flush();
  await clickAction(map, 'zoom-in'); await map.flush();
  map.setFocused(false); panDown(viewport); panMove(viewport); await map.flush();
  assert.equal(map.nodes.get('.dungeon-map').dataset.following, 'true');
  assertMarkerAt(map, 150, 125);
  map.setFocused(true); panDown(viewport); panMove(viewport); viewport.pointerup({ pointerId: 1 }); await map.flush();
  assert.equal(map.nodes.get('.dungeon-map').dataset.following, 'false');
  assertMarkerAt(map, 185, 145);
  await map.advance(100);
  map.events.player(memoryPose(map.now, {}, { position: { x: 13, z: 4 } })); await map.flush();
  near(markerPoint(map)[0], 185 + 10 * 250 / 90 * 1.4); near(markerPoint(map)[1], 145);
  map.drawing.arcs.length = 0;
  await clickAction(map, 'fit'); await map.flush();
  assert.equal(map.nodes.get('.dungeon-map').dataset.following, 'true');
  assertMarkerAt(map, 150, 125); near(revealRadius(map), 125 * 1.4);
  map.widget.destroy();
});

test('compact colour updates repaint outlines and player without resetting a panned view or discovered circles', async () => {
  const map = await mount(scene, compactOptions), viewport = map.nodes.get('.dungeon-map-viewport');
  map.events.player(memoryPose(map.now)); await map.flush();
  await map.advance(100);
  map.events.player(memoryPose(map.now, {}, { position: { x: 20, z: 20 } })); await map.flush();
  await clickAction(map, 'zoom-in'); await map.flush();
  panDown(viewport); panMove(viewport); viewport.pointerup({ pointerId: 1 }); await map.flush();
  await map.advance(750);
  const before = [...markerPoint(map)], cells = JSON.stringify(map.saves.at(-1).exploration.cells);
  map.drawing.arcs.length = 0;
  map.events.config({ playerMarkerColor: '#a34d90', playerMarkerOutlineColor: '#2e1b10', dungeonMapOutlineColor: '#729b44' }); await map.flush();
  assert.deepEqual(markerPoint(map), before); near(revealRadius(map), 125 * 1.4);
  assert.equal(map.nodes.get('canvas').getContext().fillStyle, '#a34d90');
  assert.equal(map.nodes.get('canvas').getContext().strokeStyle, '#2e1b10');
  assert.equal(map.layers[0].getContext().strokeStyle, '#729b44');
  assert.equal(map.nodes.get('.dungeon-map').dataset.following, 'false');
  map.widget.destroy(); await map.flush();
  assert.equal(JSON.stringify(map.saves.at(-1).exploration.cells), cells);
});

test('compact cameras clear stale or wrong-entry markers and wait for the next verified live position', async () => {
  const map = await mount(scene, compactOptions);
  map.events.player(memoryPose(map.now)); await map.flush();
  await map.advance(2001);
  const fills = map.drawing.fills;
  assert.equal(map.nodes.get('[data-action="fit"]').disabled, true);
  for (const value of [memoryPose(map.now, {}, { position: { x: NaN, z: 0 } }), memoryPose(map.now, { instanceId: 'other' }),
    memoryPose(map.now, {}, { alignmentVerified: false }), memoryPose(map.now - 2001)]) {
    map.events.player(value); await map.flush(); assert.equal(map.drawing.fills, fills);
  }
  const next = { ...scene, version: 'next', state: { ...dungeonState, instanceId: 'next-entry' } };
  map.respond(next); await map.widget.refresh(next.state); await map.flush();
  map.events.player(memoryPose(map.now)); await map.flush();
  assert.equal(map.drawing.fills, fills, 'A previous instance cannot place a marker in the next dungeon');
  map.events.player(memoryPose(map.now, { instanceId: 'next-entry' }, { instanceId: 'next-entry', revision: 'next', scope: 'next-scope' })); await map.flush();
  assertMarkerAt(map, 150, 125); assert.ok(map.drawing.fills > fills);
  assert.equal(map.nodes.get('.dungeon-map').dataset.following, 'true');
  map.widget.destroy();
});
