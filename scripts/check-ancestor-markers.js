// Run with node scripts/check-ancestor-markers.js. Uses the real map renderers
// and preload in hidden Electron windows, with isolated storage and fixture IPC.
// A synthetic tile supplies the background for the marker screenshots.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 40000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, net, protocol, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { serveMapAsset } = require('../test/fixtures/map-assets');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output', 'ancestor-check');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, `profile-${process.pid}`));
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'overkot-map-tiles', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const windows = [];
const errors = [];
const screenshots = [];
const marker = { id: 'ancestor-fixture', x: 385, z: -217, ancestorName: 'Orlick', startedAt: 100 };
const mapDataFixture = name => name === 'world_trees' ? { positions: [
  { position: { x: marker.x, z: marker.z } }, { position: { x: marker.x + 1, z: marker.z + 1 } },
] } : {};

async function until(fn, description) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await fn()) return;
    await pause(50);
  }
  throw new Error('Timed out: ' + description);
}

// Capture canvas operations while still forwarding every operation to Chromium.
// The resulting PNGs are real renderer captures, not images made from the test.
function installRecorder(isMini) {
  const target = document.getElementById(isMini ? 'minimap-canvas' : 'map-canvas');
  const context = target.getContext('2d');
  window.__ancestorClock = 1000;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => window.__ancestorClock });
  window.__ancestorCapture = { dots: [], rings: [], text: [], rim: [], pois: [] };
  let currentPath = [];
  const transform = () => {
    const m = context.getTransform();
    return [m.a, m.b, m.c, m.d, m.e, m.f];
  };
  const wrap = (name, observe) => {
    const original = context[name];
    context[name] = function (...args) { observe(...args); return original.apply(this, args); };
  };
  wrap('clearRect', () => { window.__ancestorCapture = { dots: [], rings: [], text: [], rim: [], pois: [] }; });
  wrap('beginPath', () => { currentPath = []; });
  wrap('arc', (x, y, radius) => { currentPath.push({ x, y, radius, transform: transform() }); });
  wrap('fill', () => {
    if (context.fillStyle === '#c792ea') window.__ancestorCapture.dots.push(...currentPath);
  });
  wrap('stroke', () => {
    window.__ancestorCapture.rings.push(...currentPath.filter(shape => shape.radius > 6));
  });
  wrap('fillText', (value, x, y) => { window.__ancestorCapture.text.push({ value, x, y }); });
  wrap('strokeRect', (x, y, width, height) => { window.__ancestorCapture.rim.push({ x, y, width, height }); });
  wrap('drawImage', (image, ...args) => {
    if (image.tagName === 'CANVAS') window.__ancestorCapture.pois.push({ args, transform: transform() });
  });
  window.__ancestorRender = () => {
    if (isMini) Minimap.render(); else render();
    return window.__ancestorCapture;
  };
}

async function capture(win, name) {
  win.webContents.invalidate();
  await pause(100);
  const file = path.join(out, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  screenshots.push(file);
}

async function checkRenderer(isMini) {
  const name = isMini ? 'minimap' : 'expanded-map';
  const canvasId = isMini ? 'minimap-canvas' : 'map-canvas';
  const viewportId = isMini ? 'minimap-viewport' : 'map-container';
  const win = new BrowserWindow({ show: false, frame: false, width: isMini ? 420 : 1100, height: isMini ? 400 : 760,
    webPreferences: { preload: path.join(root, 'src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  });
  windows.push(win);
  win.webContents.on('console-message', ({ level, message }) => {
    if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push({ name, message });
  });
  await win.loadFile(path.join(root, 'src/renderer', isMini ? 'widget-host.html' : 'map-window.html'), isMini ? { query: { widget: 'minimap' } } : {});
  await until(() => win.webContents.executeJavaScript(`typeof AncestorMarkers !== 'undefined' && ${isMini ? 'Minimap.inited' : 'mapPOIsLoaded'}`), name + ' initialization');
  await win.webContents.executeJavaScript(`(${installRecorder.toString()})(${isMini})`);
  await win.webContents.executeJavaScript(isMini ? 'Minimap.fitToView()' : 'fitToView()');
  await until(() => win.webContents.executeJavaScript(`document.getElementById('${isMini ? 'minimap-loading' : 'map-loading'}').classList.contains('loaded')`), name + ' fixture tiles');
  await until(() => win.webContents.executeJavaScript('__ancestorRender().pois.length === 2'), name + ' fixture marker icons');
  const dimensions = await win.webContents.executeJavaScript(`(() => { const c = document.getElementById('${canvasId}'); return { width: c.width, height: c.height }; })()`);
  assert.ok(dimensions.width > 0 && dimensions.height > 0, name + ' has a visible canvas layout');
  const fittedZoom = Math.min(dimensions.width, dimensions.height) / 7168 * 0.95;
  const expectedAt = factor => ({ x: dimensions.width / 2 + marker.x * 2 * fittedZoom * factor, y: dimensions.height / 2 - marker.z * 2 * fittedZoom * factor });
  const verifyDot = (frame, factor) => {
    assert.equal(frame.dots.length, 1, name + ' draws one ancestor dot');
    const dot = frame.dots[0];
    const expected = expectedAt(factor);
    assert.ok(Math.abs(dot.x - expected.x) < 0.01 && Math.abs(dot.y - expected.y) < 0.01,
      `${name}: expected (${expected.x}, ${expected.y}), got (${dot.x}, ${dot.y})`);
    assert.equal(dot.radius, 6, name + ' keeps the dot at six screen pixels');
    assert.deepEqual(dot.transform, [1, 0, 0, 1, 0, 0], name + ' draws ancestors in screen coordinates');
    return dot;
  };
  const initial = await win.webContents.executeJavaScript('__ancestorRender()');
  const initialDot = verifyDot(initial, 1);
  assert.equal(initial.rings.length, 0, name + ' startup snapshot does not flash');
  assert.equal(initial.rim.length, 0);
  assert.ok(initial.text.some(text => text.value === 'Orlick' && text.y > initialDot.y), name + ' places its label below the dot');
  assert.equal(initial.pois.length, 2, name + ' renders the overlapping fixture POIs');
  await capture(win, name + '-initial');

  win.webContents.send('ancestor-markers', [{ ...marker, ancestorName: 'Bromius', startedAt: 200 }]);
  await until(() => win.webContents.executeJavaScript('__ancestorRender().text.some(item => item.value === "Bromius")'), name + ' live discovery');
  const live = await win.webContents.executeJavaScript('__ancestorRender()');
  verifyDot(live, 1);
  assert.equal(live.rings.length, 1, name + ' live discovery pulses');
  assert.equal(live.rim.length, 1, name + ' live discovery highlights the rim');
  assert.deepEqual(live.pois, initial.pois, name + ' ancestor updates do not move map POIs');
  await capture(win, name + '-discovered');

  await win.webContents.executeJavaScript(`window.__ancestorClock = 7000; ${isMini ? 'Minimap.zoomAt' : 'zoomAt'}(3, ${dimensions.width / 2}, ${dimensions.height / 2});`);
  await pause(100);
  const zoomed = await win.webContents.executeJavaScript('__ancestorRender()');
  const zoomedDot = verifyDot(zoomed, 3);
  assert.equal(zoomed.rings.length, 0, name + ' pulse ends after six seconds');
  assert.equal(zoomed.rim.length, 0);

  const longName = 'Bromius with an intentionally long ancestor name for hover verification';
  win.webContents.send('ancestor-markers', [{ ...marker, ancestorName: longName, startedAt: 200 }]);
  await until(() => win.webContents.executeJavaScript('__ancestorRender().text.some(item => item.value.includes("…"))'), name + ' truncated long label');
  const hover = await win.webContents.executeJavaScript(`(() => {
    const viewport = document.getElementById('${viewportId}');
    const rect = viewport.getBoundingClientRect();
    viewport.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + ${zoomedDot.x}, clientY: rect.top + ${zoomedDot.y} }));
    const tip = document.getElementById('map-tooltip');
    const bounds = tip?.getBoundingClientRect();
    return { title: viewport.title, tooltip: tip?.textContent || '',
      tooltipFits: !bounds || (bounds.left >= rect.left && bounds.right <= rect.right && bounds.top >= rect.top && bounds.bottom <= rect.bottom) };
  })()`);
  assert.ok(hover.title.includes(longName) || hover.tooltip.includes(longName), name + ' hover exposes the full ancestor name');
  assert.equal(hover.tooltipFits, true, name + ' keeps the full-name tooltip inside the map');
  await capture(win, name + '-zoomed-hover');
  win.webContents.send('ancestor-markers', []);
  await until(() => win.webContents.executeJavaScript('__ancestorRender().dots.length === 0'), name + ' marker removal');
  const stationary = await win.webContents.executeJavaScript(`({ title: document.getElementById('${viewportId}').title,
    tooltip: document.getElementById('map-tooltip')?.classList.contains('visible') ? document.getElementById('map-tooltip').textContent : '' })`);
  assert.ok(!stationary.title.includes(longName) && !stationary.tooltip.includes(longName), name + ' removal clears hover without moving the pointer');
  const cleared = await win.webContents.executeJavaScript(`(() => {
    const viewport = document.getElementById('${viewportId}');
    const rect = viewport.getBoundingClientRect();
    viewport.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + ${zoomedDot.x}, clientY: rect.top + ${zoomedDot.y} }));
    return { title: viewport.title, tooltip: document.getElementById('map-tooltip')?.classList.contains('visible') ? document.getElementById('map-tooltip').textContent : '' };
  })()`);
  assert.ok(!cleared.title.includes(longName) && !cleared.tooltip.includes(longName), name + ' removal clears ancestor hover');
  win.destroy();
  return { name, dimensions, fittedZoom, initialDot, zoomedDot, hover, checks: ['quiet startup', 'exact x/z projection', 'fixed dot radius at two zooms', 'unchanged overlapping POIs', 'six-second live pulse', 'full-name hover', 'removal'] };
}

async function checkDock() {
  const dock = new BrowserWindow({ show: false, frame: false, width: 420, height: 440, webPreferences: {
    preload: path.join(root, 'src/preload.js'), contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInSubFrames: true, backgroundThrottling: false, offscreen: true,
  } });
  windows.push(dock);
  await dock.loadFile(path.join(root, 'src/renderer/dock-window.html'));
  let frame;
  await until(async () => {
    frame = dock.webContents.mainFrame.framesInSubtree.find(candidate => candidate.url.includes('widget=minimap'));
    return frame && await frame.executeJavaScript('typeof Minimap !== "undefined" && Minimap.inited');
  }, 'docked minimap initialization');
  await frame.executeJavaScript(`(${installRecorder.toString()})(true); Minimap.fitToView();`);
  await until(() => frame.executeJavaScript('__ancestorRender().dots.length === 1'), 'docked minimap startup snapshot');
  await pause(200);
  const dimensions = await frame.executeJavaScript('({ width: document.getElementById("minimap-canvas").width, height: document.getElementById("minimap-canvas").height })');
  assert.ok(dimensions.width >= 160 && dimensions.height >= 160,
    `Docked minimap must retain a usable map viewport, got ${dimensions.width}×${dimensions.height}`);

  // Exercise the real main-process broadcaster without launching the app or
  // its watchers. Only its window list and current markers are substituted.
  const declaration = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8')
    .match(/^function broadcastAncestors\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(declaration, 'Production ancestor broadcaster is available');
  const broadcast = values => require('node:vm').runInNewContext(declaration + '\nbroadcastAncestors();', {
    BrowserWindow: { getAllWindows: () => [dock] }, ancestorMarkers: values,
  });
  broadcast([{ ...marker, ancestorName: 'Bromius', startedAt: 200 }]);
  await until(() => frame.executeJavaScript('__ancestorRender().text.some(item => item.value === "Bromius")'), 'production broadcast reaches the dock iframe');
  await capture(dock, 'docked-minimap-discovered');
  broadcast([]);
  await until(() => frame.executeJavaScript('__ancestorRender().dots.length === 0'), 'production removal reaches the dock iframe');
  await capture(dock, 'docked-minimap-removed');
  dock.destroy();
  return { name: 'docked-minimap', dimensions, checks: ['usable viewport size', 'initial snapshot', 'production live broadcast reaches iframe', 'production removal reaches iframe'] };
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  // Support both bundled-file fetches and map-data IPC, so this focused check
  // does not require the separate data-feed implementation to be present.
  protocol.handle('file', request => {
    const name = new URL(request.url).pathname.match(/\/assets\/map-json\/([^/]+)\.json$/)?.[1];
    if (name) return new Response(JSON.stringify(mapDataFixture(name)), { headers: { 'Content-Type': 'application/json' } });
    return net.fetch(request.url, { bypassCustomProtocolHandlers: true });
  });
  protocol.handle('overkot-map-tiles', serveMapAsset);
  const translations = { en: JSON.parse(fs.readFileSync(path.join(root, 'langs/en.json'), 'utf8')) };
  ipcMain.on('get-i18n', event => { event.returnValue = { translations, languages: [] }; });
  ipcMain.handle('get-state', () => ({ config: { language: 'en', widgetVisibility: { minimap: true } }, timers: [], namesMap: {} }));
  ipcMain.handle('dock-get-max-height', () => 600);
  ipcMain.on('dock-resize-request', (event, width, height) => BrowserWindow.fromWebContents(event.sender)?.setSize(width, height));
  ipcMain.handle('get-map-tiles', () => ({ source: 'bundled', version: 'ancestor-check' }));
  ipcMain.handle('get-map-data', (_event, name) => mapDataFixture(name));
  ipcMain.handle('resolve-location-names', () => ({}));
  ipcMain.handle('get-player-location', () => null);
  ipcMain.handle('dungeon:map', () => ({ mode: 'inactive', state: { active: false }, rooms: [] }));
  ipcMain.handle('get-ancestors', () => [marker]);
  ipcMain.handle('save-config', () => true);
  const results = [];
  for (const isMini of [true, false]) results.push(await checkRenderer(isMini));
  results.push(await checkDock());
  assert.deepEqual(errors, [], 'Both renderers run without uncaught errors');
  const summary = { ok: true, results, screenshots, errors };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  app.exit(0);
}).catch(error => {
  console.error(error.stack);
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, errors, screenshots }, null, 2));
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  app.exit(1);
});
setTimeout(() => { console.error('Ancestor renderer check timed out'); app.exit(1); }, 35000).unref();
