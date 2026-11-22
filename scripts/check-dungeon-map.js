// Real Chromium windows, production preload and widget host under app CSP.
// Source: node scripts/check-dungeon-map.js --source
// Packaged: node scripts/check-dungeon-map.js --packaged (after npm run pack)
if (!process.versions.electron) {
  const args = process.argv.slice(2), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = args.includes('--packaged') ? require('./run-packaged-check').runPackagedCheck(__filename, args, 90000, { windowsHide: false })
    : require('node:child_process').spawnSync(require('electron'), [__filename, ...args], { env, stdio: 'inherit', windowsHide: false, timeout: 90000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { serveMapAsset } = require('../test/fixtures/map-assets');
const { decodeLayout, FALLEN_FORTRESS_TABLE } = require('../src/modules/dungeonLayout');
const { DungeonMap, makeScene } = require('../src/modules/dungeonMap');
const { DungeonWatcher } = require('../src/modules/dungeonWatcher');
const { DungeonDiscoveryStore } = require('../src/modules/dungeonDiscoveryStore');
// Match the public projection's count-only serialization metadata when the
// native smoke uses local raw pipeline fixtures instead of downloaded data.
const withSerialization = value => !value?.extra_components || value.serialization ? value : { ...value, serialization: {
  format: 'tree-caps-attachments-v1', attachment_type_bits: 3,
  attachment_counts: ['fitting', 'exit_gate', 'boss_gate', 'objective_gate', 'special_gate'].map(name => value.extra_components[name]?.length || 0),
  cinematic_count: value.extra_components.cinematic?.length || 0, backdrop_count: value.extra_components.backdrop?.length || 0,
} };
const root = path.resolve(__dirname, '..'), packaged = process.argv.includes('--packaged');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const appRoot = packaged ? path.join(root, 'dist/win-unpacked/resources/app.asar') : root;
// Node modules are bundled into main.js; this isolated backend fixture uses
// source modules while the windows load the actual packaged renderer/preload.
const { fitDungeonFrames } = require('../src/modules/dungeonFrameAlignment');
const output = path.join(root, 'output', `dungeon-map-check-${packaged ? 'packaged' : 'source'}-${Date.now()}`);
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'overkot-map-tiles', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const levelPath = '/SF/Levels/Procs/FallenFortress/FallenFortressProcLevel', layoutCode = 'SSMCETyBURHUPG29PZBAQAAAAIAIIgA';
const activeState = { active: true, status: 'ready', name: 'Fallen Fortress', set: 'FallenFortress', key: 'fallenFortress', levelPath, layoutCode, instanceId: 'fixture-fallen-fortress-1' };
let state = { status: 'outside', active: false }, delayNext = false, playerLocation = null, privateLocation = null, discoveryScene = null, discoverySaves = 0;
let config = { clickThrough: false, language: 'en', theme: 'dark-mint', backgroundOpacity: 75, dungeonMapAutoSwitch: true, dungeonMapSeeThrough: false, dungeonMapBackgroundOpacity: 45 };
const fixtures = path.resolve(root, '../../soulframe-pipeline-runner/output/map/dungeons/fallenFortress');
const legacyFixtures = path.resolve(root, '../../soulframe-pipeline-runner/output/maps/fallenFortress');
let table, document, fixtureSource;
const fixtureDirectory = fs.existsSync(path.join(fixtures, 'layouts.json')) ? fixtures : legacyFixtures;
if (fs.existsSync(path.join(fixtureDirectory, 'layouts.json'))) {
  table = withSerialization(JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'layouts.json'), 'utf8')).layouts.find(entry => entry.level_path === levelPath));
  document = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'rooms.json'), 'utf8')); fixtureSource = 'extracted game room outlines and portal transforms';
} else {
  const component = entry => ({ ...entry, portals: Array.from({ length: entry.portal_count }, (_, i) => ({ position: i === 0 ? [0, 0, -5] : i === 1 ? [0, 0, 5] : [8, 0, 0], normal: i === 0 ? [0, 0, -1] : i === 1 ? [0, 0, 1] : [1, 0, 0] })) });
  table = { ...FALLEN_FORTRESS_TABLE, spawns: FALLEN_FORTRESS_TABLE.spawns.map(component), components: FALLEN_FORTRESS_TABLE.components.map(component) };
  document = { rooms: [...table.spawns, ...table.components].map(entry => ({ room: entry.room, outline: [{ closed: true, points: [[-8, -5], [8, -5], [8, 5], [-8, 5]] }] })) };
  fixtureSource = 'synthetic geometric fixture with verified FF fingerprint';
}
const scene = makeScene(decodeLayout(layoutCode, table), table, document);
assert.equal(scene.mode, 'placed'); assert.equal(scene.missingRooms.length, 0);
const captures = [
  { name: 'Cliff Cave', key: 'underCityMidrath', fixture: 'underCityCliffCave', codes: [['KhGCACHMpRNZ3fAghiCAAQjA', 8], ['ShGaIa5IZlKJq676AAGIIAhAEYA', 9]] },
  { name: 'Cliff Town', key: 'underCityMidrath', fixture: 'underCityCliffTown', codes: [['ShF45xiBqkiijMpxNZ2XU-QAGIIQACEAABGA', 13], ['SeJaAJFQ5lSJqxhhy-AkBiAAAAgCMA', 10]] },
  { name: 'Glades', key: 'gladesofAndurin', fixture: 'gladesProcLevel', codes: [['SeXCNGh9IRWPOteCiCAIQgAI', 10], ['SeHISGp8YRV2uu+AiCAIAAAI', 10]] },
].map(capture => ({ ...capture, table: require(path.join(root, 'test/fixtures', capture.fixture + '.json')) }));
const setRoot = path.dirname(fixtureDirectory), indexFile = path.join(setRoot, 'dungeons.json');
const fixtureIndex = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  : { sets: [...new Set(captures.map(capture => capture.key))].map(key => ({ key,
    set: captures.find(capture => capture.key === key).table.set,
    level_paths: captures.filter(capture => capture.key === key).map(capture => capture.table.level_path) })) };
const readSet = (set, name) => {
  const filename = path.join(setRoot, set, name + '.json');
  if (fs.existsSync(filename)) return JSON.parse(fs.readFileSync(filename, 'utf8'));
  const tables = captures.filter(capture => capture.key === set).map(capture => capture.table);
  return name === 'layouts' ? { layouts: tables } : { rooms: [...new Map(tables.flatMap(table => [...table.spawns, ...table.components])
    .map(entry => [entry.room, { room: entry.room, outline: [{ points: [[-8, -5], [8, -5], [8, 5], [-8, 5]], closed: true }] }])).values()] };
};
const fixtureData = new Map();
for (const key of new Set(captures.map(capture => capture.key))) for (const name of ['rooms', 'layouts']) {
  const value = readSet(key, name);
  if (name === 'layouts') value.layouts = value.layouts.map(withSerialization);
  fixtureData.set(`dungeons/${key}/${name}.json`, value);
}
const maps = new DungeonMap({ dataManager: {
  checkForUpdates: async () => {}, ensureAsset: async () => {}, getInfo: () => ({ version: 'fixture' }),
  readJSON: key => key === 'dungeons/index.json' ? fixtureIndex : fixtureData.get(key) || null,
} });
const snapshots = current => current.active && !current.unavailableReason ? { ...scene, state: current, version: 'fixture', reason: null }
  : { mode: 'unavailable', state: current, rooms: [], reason: current.unavailableReason || 'outside', bounds: null, version: 'fixture' };
const currentSnapshot = current => current.discoveryFixture && discoveryScene ? { ...discoveryScene, state: current }
  : current.active && current.realCapture ? maps.getSnapshot(current) : snapshots(current);
const discoveryOwner = { account: 'isolated-smoke-account', process: 'isolated-smoke-process' };
function discoveryContext() {
  if (!state.active || !state.instanceId || !state.layoutCode || state.unavailableReason) return null;
  return { ...discoveryOwner, instanceId: state.instanceId, levelPath: state.levelPath, layoutCode: state.layoutCode,
    revision: 'fixture', coordinateSpace: 'layout-local' };
}
const createDiscoveryStore = () => new DungeonDiscoveryStore({ directory: path.join(output, 'discovery'),
  getContext: discoveryContext, getOwner: () => discoveryOwner, getPose: () => privateLocation || playerLocation,
  getScene: () => currentSnapshot(state) });
let discovery = createDiscoveryStore();
const windows = [], errors = [], screenshots = [], actualCaptures = [], expansions = [];
const initializationGates = new Map();
let overlayWindow = null, overlayOpening = null;
let overlayInteractive = false;
let gameFocusWindow = null, gameReturns = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let attempt = 0; attempt < 200; attempt++) { const value = await fn(); if (value) return value; await pause(50); } throw new Error('Timed out: ' + label); }
function broadcast(channel, value) { for (const win of windows) if (!win.isDestroyed()) for (const frame of win.webContents.mainFrame.framesInSubtree) frame.send(channel, value); }
function setInteraction(active) { overlayInteractive = active; broadcast('overlay-interaction-changed', active); }
function transition(next) { state = next; broadcast('dungeon-state-changed', next); }
async function capture(win, name) { win.webContents.invalidate(); await pause(200); const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); screenshots.push(file); }
const stats = win => win.webContents.executeJavaScript(`(() => {const panel=document.querySelector('.dungeon-map');const canvas=panel.querySelector('canvas');const widget=panel.closest('.timer-widget');return {
  mode:panel.dataset.status, visible:!!panel.getClientRects().length, count:panel.querySelector('.dungeon-map-room-count').textContent,
  footer:panel.querySelector('.dungeon-map-footer').textContent, title:panel.querySelector('.dungeon-map-empty-title').textContent,
  retryHidden:panel.querySelector('[data-action=retry]').hidden, retryDisabled:panel.querySelector('[data-action=retry]').disabled, transparent:panel.dataset.seeThrough,
  mapBackground:getComputedStyle(panel.querySelector('.dungeon-map-viewport')).backgroundColor,
  widgetBackground:widget?getComputedStyle(widget).backgroundColor:null,
  width:innerWidth,height:innerHeight,scrollWidth:document.body.scrollWidth,scrollHeight:document.body.scrollHeight,
  canvasWidth:canvas.width,canvasHeight:canvas.height, locateDisabled:panel.querySelector('[data-action=locate]')?.disabled,
  aligning:panel.dataset.aligning,alignDisabled:panel.querySelector('[data-action=align]')?.disabled,
  followPlayer:panel.dataset.followPlayer,following:panel.dataset.following,
  manualControls:!!panel.querySelector('[data-action=align],[data-action=reset-alignment]'),guide:panel.querySelector('.dungeon-map-guide').textContent,
  roomNameControl:!!panel.querySelector('[data-action=labels]'),viewportTitle:panel.querySelector('.dungeon-map-viewport').title,
  miniActive:document.querySelector('.minimap-content')?.classList.contains('dungeon-active')||false}})()`);
const minimapView = win => win.webContents.executeJavaScript(`(() => {
  const context=document.querySelector('#minimap-canvas').getContext('2d');
  const scale=context.scale,translate=context.translate,view={};
  context.scale=function(x,y){view.zoom??=x;return scale.call(this,x,y)};
  context.translate=function(x,y){view.pan??=[x,y];return translate.call(this,x,y)};
  try {Minimap.render()} finally {context.scale=scale;context.translate=translate}
  return view;
})()`);
const dungeonDrawing = win => win.webContents.executeJavaScript("document.querySelector('.dungeon-map canvas').toDataURL()");
const traceCanvas = (win, selector = '.dungeon-map canvas') => win.webContents.executeJavaScript(`(() => {
  const context=document.querySelector(${JSON.stringify(selector)}).getContext('2d');
  window.__mapTrace={fill:[],stroke:[],rotate:[],arc:[],translate:[],paths:[]};
  if(context.__mapTraceInstalled)return;
  context.__mapTraceInstalled=true;
  for(const name of ['beginPath','moveTo','lineTo','closePath']){const original=context[name];context[name]=function(...args){
    if(name==='beginPath')this.__mapPath=[];
    else (this.__mapPath??=[]).push([name,...args]);
    return original.apply(this,args);
  }}
  for(const name of ['fill','stroke','rotate','arc','translate']){const original=context[name];context[name]=function(...args){
    const trace=window.__mapTrace;if(trace)trace[name].push(name==='fill'?this.fillStyle:name==='stroke'?this.strokeStyle:args);
    if(trace&&name==='fill')trace.paths.push((this.__mapPath||[]).map(command=>[...command]));
    return original.apply(this,args);
  }}
})()`);
const readTrace = win => win.webContents.executeJavaScript('window.__mapTrace');
const markerView = win => win.webContents.executeJavaScript(`(() => {
  const viewport=document.querySelector('.dungeon-map-viewport'),panel=document.querySelector('.dungeon-map');
  return {point:window.__mapTrace?.translate.at(-1),width:viewport.clientWidth,height:viewport.clientHeight,
    following:panel.dataset.following,followPlayer:panel.dataset.followPlayer};
})()`);
const coloredPixels = (win, color, selector = '.dungeon-map canvas') => win.webContents.executeJavaScript(`(() => {
  const canvas=document.querySelector(${JSON.stringify(selector)}),data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const rgb=${JSON.stringify(color.match(/\w\w/g).map(value => parseInt(value, 16)))};
  let count=0;for(let i=0;i<data.length;i+=4)if(data[i+3]>80&&rgb.every((value,index)=>Math.abs(value-data[i+index])<8))count++;
  return count;
})()`);
function assertCentered(view, label) {
  assert.ok(view.point?.length === 2, label + ' draws a current player marker');
  assert.ok(Math.abs(view.point[0] - view.width / 2) <= 1 && Math.abs(view.point[1] - view.height / 2) <= 1,
    label + ' centers the player in the viewport: ' + JSON.stringify(view));
}
const pixels = (win, remember = false) => win.webContents.executeJavaScript(`(() => {
  const canvas=document.querySelector('.dungeon-map canvas'),data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  let occupied=0,neutral=0,colored=0,retained=0,baseline=0;
  if(${remember})window.__mapBaseline=new Uint8Array(canvas.width*canvas.height);
  for(let i=0;i<data.length;i+=4){const index=i/4,visible=data[i+3]>0;
    const gray=visible&&Math.abs(data[i]-data[i+1])<2&&Math.abs(data[i]-data[i+2])<2&&data[i]>=200&&data[i]<=230;
    if(visible)occupied++;if(gray)neutral++;else if(visible&&Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>3)colored++;
    if(${remember})window.__mapBaseline[index]=gray?1:0;
    if(window.__mapBaseline?.[index]){baseline++;if(gray)retained++;}
  }return{occupied,neutral,colored,retained,baseline,width:canvas.width,height:canvas.height,ratio:canvas.width/canvas.clientWidth};
})()`);
async function preview(win) {
  await until(async () => (await stats(win)).mode === 'placed' && !(await stats(win)).alignDisabled, 'positioned layout can explicitly preview alignment');
  if ((await stats(win)).aligning !== 'true') await win.webContents.executeJavaScript("document.querySelector('.dungeon-map [data-action=align]').click()");
  await until(async () => (await stats(win)).aligning === 'true', 'explicit alignment preview');
}
async function focusForGesture(win) {
  win.show(); win.focus();
  await until(async () => win.isFocused() && await win.webContents.executeJavaScript('document.hasFocus()'), 'native map focus');
}
async function panStart(win) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const viewport=document.querySelector('.dungeon-map-viewport'),rect=viewport.getBoundingClientRect();
    window.__dungeonPointerId=null;
    viewport.addEventListener('pointerdown',event=>{window.__dungeonPointerId=event.pointerId},{once:true});
    return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  await until(() => win.webContents.executeJavaScript('window.__dungeonPointerId !== null'), 'trusted map pointer event');
  return point;
}
const panMove = (win, point) => win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: point.x + 35, y: point.y + 20 });
const panEnd = (win, point) => win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 35, y: point.y + 20 });
const panCaptured = win => win.webContents.executeJavaScript("document.querySelector('.dungeon-map-viewport').hasPointerCapture(window.__dungeonPointerId)");
async function panChangesDrawing(win) {
  const before = await dungeonDrawing(win), point = await panStart(win);
  await until(() => panCaptured(win), 'map captures active pan');
  panMove(win, point);
  await until(async () => await dungeonDrawing(win) !== before, 'focused pan changes dungeon drawing');
  panEnd(win, point);
  await until(async () => !(await panCaptured(win)), 'mouse release clears map capture');
}
async function panKeepsDrawing(win, label) {
  const before = await dungeonDrawing(win), point = await panStart(win);
  panMove(win, point); await pause(100); panEnd(win, point); await pause(100);
  assert.equal(await panCaptured(win), false, label + ' cannot acquire pointer capture');
  assert.equal(await dungeonDrawing(win), before, label + ' cannot pan the map');
}
async function loadFixtureWindow(win, filename, options, manualPreview, followPlayer) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  initializationGates.set(win.webContents.id, promise);
  try {
    await win.loadFile(filename, options);
    if (manualPreview || followPlayer !== undefined) await win.webContents.executeJavaScript(`(() => {
      // Fixture-only geometry preview. The production default remains automatic.
      const mount=window.DungeonMapWidget.mount;
      window.DungeonMapWidget.mount=function(element,options){return mount.call(this,element,{...options,
        ${manualPreview ? 'allowManualAlignment:true,' : ''}${followPlayer !== undefined ? `followPlayer:${JSON.stringify(followPlayer)},` : ''}})};
    })()`);
  } finally { initializationGates.delete(win.webContents.id); release(); }
}
async function open(embedded = false, { manualPreview = true, followPlayer = manualPreview ? false : undefined } = {}) {
  const win = new BrowserWindow({ show: false, transparent: true, frame: false, width: 420, height: 420,
    webPreferences: { preload: path.join(appRoot, 'src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  windows.push(win); win.webContents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  await loadFixtureWindow(win, path.join(appRoot, 'src/renderer/widget-host.html'), { query: { widget: 'minimap', ...(embedded ? { embed: '1' } : {}) } }, manualPreview, followPlayer);
  win.showInactive();
  await until(() => win.webContents.executeJavaScript("!!document.querySelector('.dungeon-map')"), 'minimap mounted');
  assert.equal(await win.webContents.executeJavaScript("window.ALL_WIDGET_IDS.includes('dungeon-map') || !!document.querySelector('[data-widget=\"dungeon-map\"]')"), false, 'Dungeon map cannot be opened as a separate widget');
  return win;
}
async function openOverlay({ manualPreview = true } = {}) {
  const win = new BrowserWindow({ show: false, transparent: true, frame: false, width: 1320, height: 850,
    webPreferences: { preload: path.join(appRoot, 'src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  windows.push(win); overlayWindow = win;
  win.webContents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  await loadFixtureWindow(win, path.join(appRoot, 'src/renderer/dungeon-overlay.html'), undefined, manualPreview);
  win.showInactive();
  await until(() => win.webContents.executeJavaScript("!!document.querySelector('.dungeon-map')"), 'large dungeon overlay mounted');
  return win;
}
async function openWorld() {
  const win = new BrowserWindow({ show: false, frame: false, width: 1000, height: 760,
    webPreferences: { preload: path.join(appRoot, 'src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  windows.push(win);
  win.webContents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  await win.loadFile(path.join(appRoot, 'src/renderer/map-window.html')); win.showInactive();
  await until(() => win.webContents.executeJavaScript("!!window.api && typeof zoom === 'number' && !!document.querySelector('#map-canvas')"), 'expanded overworld mounted');
  return win;
}
async function worldView(win, expanded = false) {
  if (expanded) return win.webContents.executeJavaScript(`({ zoom,pan:[panX,panY],width:container.clientWidth,height:container.clientHeight,
    point:playerMarker?[panX+playerMarker.px*zoom,panY+playerMarker.py*zoom]:null })`);
  const view = await minimapView(win);
  const data = await win.webContents.executeJavaScript(`(() => {const v=document.querySelector('#minimap-viewport'),p=Minimap.playerMarker;
    const m=p?Minimap.worldToMapPixel(p.x,p.z):null;return{width:v.clientWidth,height:v.clientHeight,marker:m};})()`);
  return { ...view, width: data.width, height: data.height, point: data.marker && view.pan ?
    [view.pan[0] + data.marker.px * view.zoom, view.pan[1] + data.marker.py * view.zoom] : null };
}
async function panWorld(win, expanded) {
  const selector = expanded ? '#map-container' : '#minimap-viewport';
  await focusForGesture(win);
  const point = await win.webContents.executeJavaScript(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: point.x + 35, y: point.y + 20 });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 35, y: point.y + 20 });
  await pause(75);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  session.defaultSession.webRequest.onHeadersReceived(require('../src/modules/guard').createHeadersHandler(path.join(appRoot, 'src/renderer')));
  protocol.handle('overkot-map-tiles', serveMapAsset);
  const translations = { en: JSON.parse(fs.readFileSync(path.join(root, 'langs/en.json'), 'utf8')) };
  const roomCountLabel = count => translations.en.mapRoomCount.replace('{count}', count);
  ipcMain.on('get-i18n', event => { event.returnValue = { translations, languages: [] }; });
  ipcMain.handle('get-state', async event => {
    const gate = initializationGates.get(event.sender.id); if (gate) await gate;
    return { config, overlayInteractive, timers: [], namesMap: {} };
  });
  ipcMain.handle('get-map-tiles', () => ({ source: 'bundled', version: 'fixture' }));
  ipcMain.handle('get-map-data', () => ({})); ipcMain.handle('resolve-location-names', () => ({}));
  ipcMain.handle('get-player-location', () => playerLocation); ipcMain.handle('get-player-tracking', () => ({ status: 'fixture' })); ipcMain.handle('get-ancestors', () => []);
  const discoveryChanged = value => broadcast('dungeon-discovery-changed', value);
  discovery.on('changed', discoveryChanged);
  ipcMain.handle('dungeon-discovery:get', (_event, input) => discovery.load(input));
  ipcMain.handle('dungeon-discovery:save', (_event, input) => { discoverySaves++; return discovery.save(input); });
  ipcMain.handle('dungeon-discovery:align', (_event, input) => discovery.addPoint(input));
  ipcMain.handle('dungeon-discovery:reset', (_event, input) => discovery.reset(input));
  ipcMain.handle('dungeon:state', () => state);
  ipcMain.handle('dungeon:map', async () => {
    const captured = { ...state };
    if (delayNext) { delayNext = false; await pause(700); }
    return currentSnapshot(captured);
  });
  ipcMain.handle('save-config', (_event, value) => { config = { ...config, ...value }; broadcast('config-changed', config); return true; });
  ipcMain.on('open-map-window', () => expansions.push('world'));
  ipcMain.on('open-dungeon-overlay', () => { expansions.push('dungeon'); overlayOpening = openOverlay(); });
  ipcMain.on('close-dungeon-overlay', event => BrowserWindow.fromWebContents(event.sender)?.destroy());
  ipcMain.on('exit-dungeon-overlay-interaction', event => {
    if (BrowserWindow.fromWebContents(event.sender) !== overlayWindow) return;
    gameReturns++;
    setInteraction(false);
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.blur();
    gameFocusWindow.show(); gameFocusWindow.focus();
  });

  let mini = await open();
  const painted = win => win.webContents.executeJavaScript(`(() => {const canvas=document.querySelector('.dungeon-map canvas');if(!canvas.width||!canvas.height)return 0;const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)count++;return count})()`);
  await until(async () => (await stats(mini)).mode === 'unavailable', 'outside state');
  assert.equal((await stats(mini)).miniActive, false);
  await mini.webContents.executeJavaScript("document.querySelector('#minimap-expand').click()");
  await until(() => expansions.length === 1, 'world expansion');
  assert.equal(expansions[0], 'world');
  await until(async () => Math.abs((await minimapView(mini)).zoom - .65) < 1e-9, 'closer initial overworld zoom');
  await mini.webContents.executeJavaScript('Minimap.zoomAt(1.5,200,180)');
  const before = await minimapView(mini);
  assert.ok(Number.isFinite(before.zoom) && before.pan?.length === 2);
  transition(activeState);
  await preview(mini);
  await until(async () => (await stats(mini)).miniActive && (await stats(mini)).mode === 'placed' && await painted(mini) > 100, 'automatic dungeon map switch');
  assert.equal((await stats(mini)).count, roomCountLabel(scene.rooms.length));
  const mapIcons = await mini.webContents.executeJavaScript(`(() => {
    return ['fit', 'expand'].map(action => {
      const svg = document.querySelector('.dungeon-map [data-action=' + action + '] svg');
      return { id: svg.dataset.uiIcon, width: getComputedStyle(svg).width,
        shapes: Array.from(svg.querySelectorAll('path, circle, rect, line, polyline, polygon'), shape => shape.outerHTML) };
    });
  })()`);
  assert.deepEqual(mapIcons.map(icon => icon.id), ['map-center', 'expand']);
  assert.notDeepEqual(mapIcons[0].shapes, mapIcons[1].shapes, 'Center and expand visibly use different vector icons');
  for (const icon of mapIcons) { assert.ok(icon.shapes.length > 0); assert.equal(icon.width, '16px'); }
  assert.equal((await stats(mini)).roomNameControl, false, 'Room name controls are removed');
  assert.equal((await stats(mini)).viewportTitle, '', 'Dungeon rooms have no hover labels');
  assert.equal((await stats(mini)).locateDisabled, undefined, 'Dungeon alignment replaces the F6-only locate control');
  await focusForGesture(mini);
  setInteraction(false);
  await panChangesDrawing(mini);
  await mini.webContents.executeJavaScript("document.querySelector('[data-action=fit]').click()");
  await capture(mini, 'minimap-dungeon');
  await mini.webContents.executeJavaScript("document.querySelector('[data-action=expand]').click()");
  await until(() => overlayOpening, 'dungeon expansion');
  const expanded = await overlayOpening;
  await preview(expanded);
  await until(async () => (await stats(expanded)).mode === 'placed' && await painted(expanded) > 100, 'expanded dungeon outlines');
  const overlayStats = await stats(expanded);
  assert.equal(expansions[1], 'dungeon');
  assert.equal(overlayStats.roomNameControl, false);
  assert.equal(overlayStats.transparent, 'true');
  assert.equal(overlayStats.mapBackground, 'rgba(0, 0, 0, 0)');
  assert.ok(overlayStats.canvasWidth >= 1200 && overlayStats.canvasHeight >= 800);
  assert.ok(overlayStats.scrollWidth <= overlayStats.width && overlayStats.scrollHeight <= overlayStats.height);
  const outlineCoverage = await expanded.webContents.executeJavaScript(`(() => {
    const canvas=document.querySelector('.dungeon-map canvas');const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let occupied=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])occupied++;
    return occupied/(canvas.width*canvas.height);
  })()`);
  assert.ok(outlineCoverage > 0 && outlineCoverage < .1, 'The expanded view draws outlines, leaving its interior transparent');
  await focusForGesture(expanded);
  await panKeepsDrawing(expanded, 'Focused fullscreen map outside interaction mode');
  setInteraction(true);
  await until(() => expanded.webContents.executeJavaScript("document.querySelector('#dungeon-overlay-hint').textContent.includes('Drag to pan')"), 'explicit expanded interaction');
  await panChangesDrawing(expanded);
  const outside = new BrowserWindow({ show: false, x: 0, y: 0, width: 240, height: 140,
    title: 'Outside focus fixture', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  gameFocusWindow = outside;
  windows.push(outside); await outside.loadURL('about:blank');
  const held = await panStart(expanded);
  await until(() => panCaptured(expanded), 'capture before native blur');
  outside.show(); outside.focus();
  await until(async () => outside.isFocused() && !(await expanded.webContents.executeJavaScript('document.hasFocus()'))
    && !(await panCaptured(expanded)), 'native focus loss releases dungeon capture');
  const afterBlur = await dungeonDrawing(expanded);
  panMove(expanded, held); panEnd(expanded, held); await pause(100);
  assert.equal(await dungeonDrawing(expanded), afterBlur, 'Moves forwarded after native blur cannot continue panning');
  await panKeepsDrawing(expanded, 'Unfocused fullscreen map with interaction previously active');
  await focusForGesture(expanded);
  const activePan = await panStart(expanded);
  await until(() => panCaptured(expanded), 'capture before interaction cancellation');
  setInteraction(false);
  await until(async () => !(await panCaptured(expanded)), 'interaction off releases dungeon capture');
  panEnd(expanded, activePan);
  await panKeepsDrawing(expanded, 'Interaction-off after an active fullscreen pan');
  setInteraction(true);
  await until(() => expanded.webContents.executeJavaScript("document.querySelector('#dungeon-overlay-hint').textContent.includes('Drag to pan')"), 'reactivated expanded interaction');
  await panChangesDrawing(expanded);
  await expanded.webContents.executeJavaScript("document.querySelector('[data-action=fit]').click()");
  const initialPixels = await painted(expanded);
  await expanded.webContents.executeJavaScript("document.querySelector('[data-action=zoom-in]').click()");
  await until(async () => await painted(expanded) !== initialPixels, 'expanded zoom control changes the drawing');
  await expanded.webContents.executeJavaScript("document.querySelector('[data-action=fit]').click()");
  await capture(expanded, 'expanded-dungeon-overlay');
  setInteraction(false);
  await until(() => expanded.webContents.executeJavaScript("document.querySelector('#dungeon-overlay-hint').textContent.includes('Shift + F1 to interact')"), 'expanded interaction hint');
  await expanded.webContents.executeJavaScript("window.api.saveConfig({interactionHotkey:'Alt+F1'})");
  await until(() => expanded.webContents.executeJavaScript("document.querySelector('#dungeon-overlay-hint').textContent.includes('Alt + F1 to interact')"), 'custom interaction chord hint');
  await capture(expanded, 'expanded-dungeon-pass-through');
  // Escape ends the current gesture and returns to gameplay while the map
  // remains drawn at its panned position; closing remains an explicit action.
  await focusForGesture(expanded); setInteraction(true);
  await until(() => expanded.webContents.executeJavaScript("document.querySelector('#dungeon-overlay-hint').textContent.includes('Escape to return to game')"), 'game return hint');
  const beforeEscape = await dungeonDrawing(expanded), escapePan = await panStart(expanded);
  await until(() => panCaptured(expanded), 'capture before Escape');
  panMove(expanded, escapePan);
  await until(async () => await dungeonDrawing(expanded) !== beforeEscape, 'pan before Escape');
  const afterPan = await dungeonDrawing(expanded);
  expanded.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  expanded.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(async () => gameReturns === 1 && outside.isFocused() && expanded.isVisible() && !expanded.isFocused()
    && !(await panCaptured(expanded)), 'Escape returns input to game without closing the map');
  assert.equal(expanded.isDestroyed(), false);
  assert.equal(overlayInteractive, false);
  assert.equal(await dungeonDrawing(expanded), afterPan, 'Escape preserves the map pan and zoom');
  assert.equal(await expanded.webContents.executeJavaScript("document.querySelector('#dungeon-overlay-hint').textContent"), 'Alt + F1 to interact');
  panEnd(expanded, escapePan);
  await capture(expanded, 'expanded-dungeon-after-escape');
  await focusForGesture(expanded);
  await expanded.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await pause(75);
  assert.equal(gameReturns, 1, 'Inactive Escape cannot request another focus transfer');
  assert.equal(expanded.isDestroyed(), false);
  await expanded.webContents.executeJavaScript("document.querySelector('[data-action=close]').click()");
  await until(() => expanded.isDestroyed(), 'close button closes map after Escape');
  outside.destroy();
  overlayOpening = null;
  await mini.webContents.executeJavaScript("document.querySelector('[data-action=expand]').click()");
  await until(() => overlayOpening, 'reopen expanded map');
  const reopened = await overlayOpening;
  await until(async () => (await stats(reopened)).mode === 'placed', 'reopened overlay');
  await reopened.webContents.executeJavaScript("document.querySelector('[data-action=close]').click()");
  await until(() => reopened.isDestroyed(), 'close button closes expanded map');
  for (const width of [250, 420, 650]) {
    mini.setSize(width, width); await pause(150);
    await mini.webContents.executeJavaScript("document.querySelector('[data-action=fit]').click()");
    const result = await stats(mini);
    assert.ok(result.scrollWidth <= result.width + 1 && result.scrollHeight <= result.height + 1, `${width}px minimap fits`);
    assert.ok(result.canvasWidth > 80 && result.canvasHeight > 80); await capture(mini, `minimap-${width}px`);
  }
  await mini.webContents.executeJavaScript("document.querySelector('[data-action=glass]').click()");
  await until(async () => (await stats(mini)).transparent === 'true', 'see-through config');
  assert.equal((await stats(mini)).mapBackground, 'rgba(0, 0, 0, 0)'); assert.equal((await stats(mini)).widgetBackground, 'rgba(0, 0, 0, 0)');
  await capture(mini, 'minimap-see-through');
  await mini.webContents.executeJavaScript('window.api.saveConfig({dungeonMapSeeThrough:false,dungeonMapBackgroundOpacity:20,dungeonMapAutoSwitch:false})');
  await until(async () => !(await stats(mini)).miniActive, 'automatic switching disabled');
  assert.match((await stats(mini)).mapBackground, /0\.2\)/);
  await mini.webContents.executeJavaScript('window.api.saveConfig({dungeonMapAutoSwitch:true})');
  await until(async () => (await stats(mini)).miniActive, 'automatic switching restored');
  for (const reason of ['waiting', 'unsupported', 'decode', 'data']) {
    transition({ ...activeState, layoutCode: reason === 'waiting' ? null : 'unresolved', unavailableReason: reason });
    await until(async () => (await stats(mini)).mode === 'unavailable' && (await stats(mini)).count === '' && await painted(mini) === 0, `${reason} never paints an atlas`);
    assert.equal((await stats(mini)).title, reason === 'waiting' ? 'Reading dungeon layout…' : 'Map unavailable');
    assert.equal((await stats(mini)).retryHidden, reason === 'waiting');
    await capture(mini, `minimap-${reason}`);
  }
  // Retry the current state after a transient map-data failure, without exit.
  state = { ...activeState };
  await mini.webContents.executeJavaScript("document.querySelector('[data-action=retry]').click()");
  await preview(mini);
  await until(async () => (await stats(mini)).mode === 'placed' && await painted(mini) > 100, 'retry restores the current layout');
  delayNext = true; transition(activeState); await pause(50); transition({ active: false, status: 'outside' });
  await until(async () => !(await stats(mini)).miniActive, 'exit restores overworld');
  await pause(800); assert.equal((await stats(mini)).mode, 'unavailable', 'Stale snapshot cannot resurrect the previous dungeon');
  mini.setSize(420, 420); await pause(150);
  assert.deepEqual(await minimapView(mini), before, 'Leaving a dungeon preserves the overworld pan and zoom');
  await capture(mini, 'minimap-overworld-restored');
  transition(activeState);
  const docked = await open(true);
  await preview(docked);
  await until(async () => (await stats(docked)).canvasHeight > 80 && await painted(docked) > 100, 'embedded minimap retains square height');
  await capture(docked, 'minimap-docked-cell');
  await mini.webContents.executeJavaScript("window.api.saveConfig({widgetCollapsed:{minimap:true},dungeonMapAutoSwitch:false})");
  const collapsed = await open();
  await until(async () => (await stats(collapsed)).mode === 'placed', 'collapsed minimap receives layout');
  assert.equal((await stats(collapsed)).visible, false);
  await mini.webContents.executeJavaScript("window.api.saveConfig({widgetCollapsed:{minimap:false},dungeonMapAutoSwitch:true})");
  await preview(collapsed);
  await until(async () => await painted(collapsed) > 100, 'initially hidden minimap fits on activation');
  await capture(collapsed, 'minimap-expanded-from-hidden');
  for (const captureData of captures) {
    const { table: captureTable, name, key, fixture, codes } = captureData;
    const watcher = new DungeonWatcher({ getIndex: () => fixtureIndex, onChange: next => transition({ ...next, realCapture: true }) });
    const level = captureTable.level_path;
    let previousRooms = null;
    for (const [index, [code, count]] of codes.entries()) {
      transition({ active: false, status: 'outside' });
      watcher._processLine(`100.000 Sys [Info]: ${level}/${code}.lp`);
      watcher._processLine(`100.010 Sys [Info]: ClientImpl::StreamRegion: ${level}/${code}.lp, prefetch=1`);
      assert.equal(watcher.getState().active, false, `${name} prefetch does not activate`);
      watcher._processLine(`101.000 Sys [Info]: StreamTrigger: Streaming started on level ${level} layer 256.`);
      watcher._processLine(`101.100 Sys [Info]: ${level}/${code}.lp`);
      watcher._processLine(`102.000 Script [Info]: ProcLevelSetup.lua: STATS ENTER_LEVEL ${level}`);
      assert.equal(watcher.getState().key, key); assert.equal(watcher.getState().layoutCode, code);
      const actual = await maps.getSnapshot(watcher.getState());
      assert.equal(actual.mode, 'placed', `${name} capture ${index + 1} resolves connected outlines`);
      assert.equal(actual.rooms.length, count); assert.deepEqual(actual.missingRooms, []);
      const route = JSON.stringify(actual.rooms.map(room => [room.room, room.parent, room.parentDoor, room.ownDoor]));
      if (previousRooms) assert.notEqual(route, previousRooms, `${name} re-entry resolves a different generated route`);
      previousRooms = route;
      await preview(mini);
      await until(async () => (await stats(mini)).miniActive && (await stats(mini)).count === roomCountLabel(count) && await painted(mini) > 100, `${name} captured entry paints`);
      await capture(mini, `${fixture}-capture-${index + 1}`);
      actualCaptures.push({ name, code, rooms: count, mode: actual.mode });
      watcher._processLine(`110.000 Script [Info]: LoadTriggers.lua: STATS EXIT_LEVEL ${level}`);
      watcher._processLine(`110.100 Game [Info]: ${level}/${code}.lp fully destroyed [layer=256]`);
      watcher._processLine(`110.100 Sys [Info]: StreamTrigger: Destreaming complete on level ${level}/${code}.lp layer 256.`);
      await until(async () => !(await stats(mini)).miniActive && (await stats(mini)).mode === 'unavailable', `${name} exit restores overworld`);
      watcher._processLine(`110.100 Game [Info]: ${level}/${code}.lp fully destroyed [layer=256]`);
      await pause(100); assert.equal((await stats(mini)).miniActive, false, 'Repeated destruction cannot reopen the dungeon view');
    }
  }
  // The final phase uses the production automatic default. Independently loaded
  // room frames must prove the complete decoded graph before it reveals a map.
  // Earlier preview wrappers apply only to test windows.
  for (const win of windows) if (win !== mini && !win.isDestroyed()) win.destroy();
  mini.destroy(); mini = await open(false, { manualPreview: false, followPlayer: false });
  mini.setSize(650, 650); await pause(150);
  const grid = [];
  for (let x = -180; x <= 180; x += 20) grid.push({ closed: false, points: [[x, -100], [x, 100]] });
  for (let z = -100; z <= 100; z += 20) grid.push({ closed: false, points: [[-180, z], [180, z]] });
  discoveryScene = { mode: 'placed', coordinateSpace: 'layout-local', version: 'fixture', reason: null, missingRooms: [],
    bounds: { x: [-180, 180], z: [-100, 100] }, rooms: [{ room: 'isolated-test-room', boss: true, deadEnd: true,
      transform: { x: 0, z: 0, rotation: 0, scale: 1 }, outline: [
        { closed: true, points: [[-180, -100], [180, -100], [180, 100], [-180, 100]] }, ...grid] }] };
  const fixtureState = { ...activeState, name: 'Exploration fixture', key: 'isolatedFixture', levelPath: '/SF/Levels/Procs/IsolatedFixture',
    layoutCode: 'isolated-fixture-code', instanceId: 'isolated-fixture-instance-1', discoveryFixture: true };
  const target = { instanceId: fixtureState.instanceId, revision: 'fixture' };
  const nativeFrames = scene.rooms.map(({ transform: t }) => {
    const rotation = t.rotation + Math.PI / 2, c = Math.cos(rotation), s = Math.sin(rotation);
    return { source: 'level-info', matrix: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0,
      1000 + t.z, t.y, -500 - t.x, 1] };
  }).reverse();
  nativeFrames.push({ source: 'level-info', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5000, 10, 900, 1] });
  const makeRoot = () => {
    const root = fitDungeonFrames(nativeFrames, { status: 'ready', state, coordinateSpace: 'layout-local', rooms: scene.rooms });
    assert.ok(root, 'The complete decoded graph fits the unordered native LevelInfo cloud');
    assert.equal(root.source, 'level-info-fit');
    assert.ok(Math.abs(root.matrix[12] - 1000) < 1e-5 && Math.abs(root.matrix[13]) < 1e-5
      && Math.abs(root.matrix[14] + 500) < 1e-5, 'Frame matching recovers final runtime placement');
    return root;
  };
  const makePose = (point, heading = 135, nativeProof = true) => ({ status: 'found', source: 'memory', sampledAt: Date.now(),
    position: { x: 1000 + point.z, y: 0, z: -500 - point.x }, heading, isOverworld: false,
    zone: state.levelPath, instanceId: state.instanceId, trackingSession: discoveryOwner.process,
    ...(nativeProof ? { dungeonRoot: makeRoot() } : {}) });
  const emitPose = async (point, heading, nativeProof = true) => {
    privateLocation = makePose(point, heading, nativeProof);
    if (nativeProof) assert.equal(await discovery.applyRoot(privateLocation.dungeonRoot, privateLocation), true, 'Fitted LevelInfo root admission');
    await discovery.observePose(privateLocation);
    const { dungeonRoot, ...publicPose } = privateLocation;
    playerLocation = { ...publicPose, dungeon: discovery.mappedPose(privateLocation) };
    broadcast('player-location', playerLocation);
    return playerLocation;
  };
  const alphaAtMap = (win, point) => win.webContents.executeJavaScript(`(() => {
    const canvas=document.querySelector('.dungeon-map canvas'),viewport=document.querySelector('.dungeon-map-viewport');
    const width=viewport.clientWidth,height=viewport.clientHeight,ratio=canvas.width/width;
    const zoom=Math.max(.001,Math.min(20,(width-44)/360,(height-44)/200));
    const x=Math.round((width/2+${point.x}*zoom)*ratio),y=Math.round((height/2-${point.z}*zoom)*ratio);
    let alpha=0;for(let offset=-2;offset<=2;offset++)alpha=Math.max(alpha,canvas.getContext('2d').getImageData(x,y+offset,1,1).data[3]);
    return alpha;
  })()`);
  transition(fixtureState);
  await until(async () => (await stats(mini)).mode === 'placed' && (await stats(mini)).guide.includes('Finding dungeon position') && await painted(mini) === 0,
    'automatic placement waits without disclosing the dungeon');
  assert.equal((await stats(mini)).manualControls, false, 'Normal dungeon maps contain no alignment or reset controls');
  await until(() => discovery.peek() !== null, 'real discovery store loads the fixture scope');
  await emitPose({ x: -120, z: 0 }, undefined, false); await pause(100);
  assert.equal(await painted(mini), 0, 'A world pose without a native root never reveals local dungeon geometry');
  await capture(mini, 'discovery-before-native-placement');
  await traceCanvas(mini);
  const firstSaveRequests = discoverySaves;
  await emitPose({ x: -120, z: 0 });
  await until(async () => (await stats(mini)).aligning === 'false' && (await stats(mini)).footer.includes('Live player position') && await painted(mini) > 100,
    'fitted native room placement enables local tracking without user clicks');
  assert.equal((await stats(mini)).manualControls, false);
  assert.deepEqual((await discovery.load(target)).alignment, { status: 'verified', source: 'level-info-fit', points: 0 });
  const firstReveal = await pixels(mini, true), firstTrace = await readTrace(mini);
  assert.ok(firstReveal.neutral > 100 && firstReveal.neutral < firstReveal.width * firstReveal.height * .04, 'First position reveals a bounded circle rather than the room');
  assert.equal(await alphaAtMap(mini, { x: 100, z: 0 }), 0, 'Unexplored grid geometry stays hidden');
  assert.equal(await alphaAtMap(mini, { x: -105, z: 7 }), 0, 'Explored floor between outlines has no tile fill');
  const innerAlpha = await alphaAtMap(mini, { x: -140, z: 0 }), featherAlpha = await alphaAtMap(mini, { x: -162, z: 0 });
  assert.ok(innerAlpha > 50 && featherAlpha > 0 && featherAlpha < innerAlpha * .8, 'Disclosure fades inward near its outer radius');
  assert.equal(await alphaAtMap(mini, { x: -168, z: 0 }), 0, 'Feathering cannot reveal outside the discovery circle');
  assert.ok(firstReveal.colored > 0 && firstReveal.colored < 400 * firstReveal.ratio ** 2, 'Only the small player marker adds color');
  assert.ok(firstTrace.rotate.some(args => Math.abs(args[0] - Math.PI / 4) < 1e-6), 'Verified 90-degree alignment rotates world heading 135 to map heading 45');
  assert.ok(firstTrace.fill.length && firstTrace.fill.every(style => style === '#f4b642'), 'Player marker is the only filled shape and uses the amber default colour');
  const markerVertices = firstTrace.paths.find(path => path.some(command => command[0] === 'lineTo'))
    ?.filter(command => ['moveTo', 'lineTo'].includes(command[0]));
  assert.equal(markerVertices?.length, 4, 'The reference-shaped player arrow has two shoulders and an inset tail');
  assert.equal(markerVertices[1][2], markerVertices[3][2], 'The arrow shoulders are symmetric');
  assert.ok(markerVertices[2][2] < markerVertices[1][2] && markerVertices[2][2] > markerVertices[0][2], 'The tail has a shallow inward notch');
  assert.ok(markerVertices[1][2] - markerVertices[0][2] > Math.abs(markerVertices[1][1] - markerVertices[3][1]), 'The arrow is longer than its shoulders are wide');
  assert.ok(firstTrace.stroke.every(style => style === '#241708'), 'The player arrow has a very dark brown outline');
  await capture(mini, 'discovery-first-circle');
  await emitPose({ x: 0, z: 0 });
  await until(async () => (await pixels(mini)).neutral > firstReveal.neutral * 1.4, 'walking progressively discloses overlapping circles');
  const walked = await pixels(mini);
  assert.ok(walked.retained >= walked.baseline * .96, 'Walking keeps outlines discovered around the first position');
  await traceCanvas(mini); await emitPose({ x: -120, z: 0 }, 225);
  await until(async () => (await readTrace(mini)).rotate.some(args => Math.abs(args[0] - 3 * Math.PI / 4) < 1e-6), 'new player heading updates the triangle');
  const returned = await pixels(mini);
  assert.ok(returned.neutral >= walked.neutral * .97 && returned.retained >= returned.baseline * .96, 'Returning keeps the complete explored trail');
  await until(() => discoverySaves > firstSaveRequests && discovery.peek()?.exploration.size > 2, 'exploration is saved through production preload IPC');
  await discovery.flush();
  const saved = await discovery.load(target);
  assert.ok(saved.exploration.cells.length > 2);
  await capture(mini, 'discovery-walk-and-return');
  await until(async () => (await stats(mini)).footer.includes('waiting for live player position'), 'stale live player triangle expires');
  await traceCanvas(mini); await mini.webContents.executeJavaScript("document.querySelector('.dungeon-map [data-action=fit]').click()"); await pause(75);
  assert.deepEqual((await readTrace(mini)).fill, [], 'Expired positions leave no triangle or position dot');
  assert.ok((await pixels(mini)).neutral >= walked.neutral * .97, 'Stale position clearing preserves discovered outlines');
  await capture(mini, 'discovery-stale-position');
  playerLocation = privateLocation = null; mini.destroy(); await discovery.flush(); discovery.removeListener('changed', discoveryChanged);
  discovery = createDiscoveryStore(); discovery.on('changed', discoveryChanged);
  const restored = await open(false, { manualPreview: false, followPlayer: false }); restored.setSize(650, 650); await pause(150);
  await until(async () => (await stats(restored)).footer.includes('Discovered areas saved') && await painted(restored) > 100, 'fresh store and window restore disk discovery');
  await restored.webContents.executeJavaScript("document.querySelector('.dungeon-map [data-action=fit]').click()"); await pause(75);
  const reloaded = await discovery.load(target);
  assert.equal(reloaded.scope, saved.scope);
  assert.equal(reloaded.exploration.cells.length, saved.exploration.cells.length);
  assert.deepEqual(reloaded.alignment, { status: 'detecting', source: 'level-info-fit', points: 0 });
  const unproved = makePose({ x: 0, z: 0 });
  assert.equal(discovery.mappedPose(unproved), null, 'Saved native transforms cannot produce poses until a current native proof is admitted');
  assert.equal(await discovery.observePose(unproved), false, 'Saved transforms cannot discover more geometry without current proof');
  await traceCanvas(restored); await restored.webContents.executeJavaScript("document.querySelector('.dungeon-map [data-action=fit]').click()"); await pause(75);
  assert.deepEqual((await readTrace(restored)).fill, [], 'Restoring remembered fog never creates a player marker');
  assert.ok((await pixels(restored)).neutral >= walked.neutral * .97, 'Saved fog restores without a live player or alignment preview');
  await capture(restored, 'discovery-restored-from-disk');
  let previousPose = await emitPose({ x: 0, z: 0 }), previousNative = privateLocation;
  assert.ok(previousPose.dungeon, 'Only reapplying the native root makes restored tracking available');
  // Exercise the actual compact mount defaults separately from the fixed-camera
  // discovery fixtures above. Player motion should move the camera, not the pin.
  const compact = await open(false, { manualPreview: false });
  await traceCanvas(compact); await emitPose({ x: 0, z: 0 });
  await until(async () => (await markerView(compact)).point && (await stats(compact)).following === 'true', 'compact player-follow starts automatically');
  assert.equal((await stats(compact)).followPlayer, 'true');
  assertCentered(await markerView(compact), 'Compact entry');
  await emitPose({ x: 50, z: 20 }); await pause(75);
  assertCentered(await markerView(compact), 'Moving compact player');
  await focusForGesture(compact);
  await panChangesDrawing(compact);
  assert.equal((await stats(compact)).following, 'false', 'Dragging pauses compact following');
  const panned = await markerView(compact);
  await emitPose({ x: 60, z: 20 }); await pause(75);
  const movedWhilePanned = await markerView(compact), initialZoom = (movedWhilePanned.point[0] - panned.point[0]) / 10;
  assert.ok(Math.abs(initialZoom - Math.min(panned.width, panned.height) / 90) < .02,
    'The 45-unit reveal radius reaches both edges of the compact viewport\'s shorter dimension');
  assert.ok(Math.abs(movedWhilePanned.point[1] - panned.point[1]) < 1, 'A paused camera stays put while the player moves');
  await compact.webContents.executeJavaScript("document.querySelector('.dungeon-map [data-action=fit]').click()"); await pause(75);
  assert.equal((await stats(compact)).following, 'true', 'Center control resumes compact following');
  assertCentered(await markerView(compact), 'Recentered compact player');
  await compact.webContents.executeJavaScript("document.querySelector('.dungeon-map [data-action=zoom-in]').click()"); await pause(75);
  assertCentered(await markerView(compact), 'Compact zoom button');
  await panChangesDrawing(compact);
  const zoomedPan = await markerView(compact);
  await emitPose({ x: 70, z: 20 }); await pause(75);
  const zoomedMovement = await markerView(compact), zoomed = (zoomedMovement.point[0] - zoomedPan.point[0]) / 10;
  assert.ok(Math.abs(zoomed - initialZoom * 1.4) < .02, 'Compact zoom remains adjustable around the player');
  await compact.webContents.executeJavaScript("document.querySelector('.dungeon-map [data-action=fit]').click()"); await pause(75);
  assertCentered(await markerView(compact), 'Compact center preserves chosen zoom');
  compact.webContents.sendInputEvent({ type: 'mouseWheel', x: 90, y: 120, deltaY: -80, deltaX: 0 }); await pause(75);
  assertCentered(await markerView(compact), 'Compact wheel zoom');
  compact.setSize(650, 650); await pause(150);
  await emitPose({ x: 80, z: -20 }); await pause(75);
  assertCentered(await markerView(compact), 'Resized compact map');
  const full = await openOverlay({ manualPreview: false });
  await traceCanvas(full); await emitPose({ x: 80, z: -20 }); await pause(75);
  assert.equal((await stats(full)).followPlayer, 'false', 'Expanded dungeon map keeps its overview camera');
  setInteraction(true); await focusForGesture(full); await panChangesDrawing(full);
  const fullPan = await markerView(full);
  await emitPose({ x: 85, z: -20 }); await pause(75);
  assert.equal((await stats(full)).following, 'false');
  assert.ok(Math.abs((await markerView(full)).point[0] - fullPan.point[0]) > 1, 'Expanded map retains free pan while the player moves');
  await capture(compact, 'compact-player-follow-default-marker');
  await traceCanvas(compact); await traceCanvas(full);
  await compact.webContents.executeJavaScript("window.api.saveConfig({playerMarkerColor:'#dc814a',playerMarkerOutlineColor:'#170a2b',dungeonMapOutlineColor:'#91acff'})");
  await until(async () => (await readTrace(compact)).fill.includes('#dc814a') && (await readTrace(full)).fill.includes('#dc814a'),
    'Custom player colour repaints both dungeon views immediately');
  assert.ok((await readTrace(compact)).stroke.includes('#170a2b') && (await readTrace(full)).stroke.includes('#170a2b'),
    'Custom player outline colour repaints both dungeon views immediately');
  assert.ok(await coloredPixels(compact, '#91acff') > 50, 'Custom outline colour replaces neutral strokes in the compact map');
  assert.ok(await coloredPixels(full, '#91acff') > 50, 'Custom outline colour repaints the expanded map');
  assertCentered(await markerView(compact), 'Colour updates preserve the compact player camera');
  await capture(compact, 'compact-player-follow-custom-colours');
  await capture(full, 'expanded-custom-colours');
  compact.destroy(); full.destroy(); setInteraction(false);
  previousPose = await emitPose({ x: 85, z: -20 }); previousNative = privateLocation;
  transition({ ...fixtureState, instanceId: 'isolated-fixture-instance-2' });
  assert.equal(await discovery.applyRoot(previousNative.dungeonRoot, previousNative), false, 'An old instance packet cannot provide native proof for a new entry');
  await until(async () => (await stats(restored)).mode === 'placed' && await painted(restored) === 0, 'a new instance starts fully undisclosed');
  broadcast('player-location', previousPose); broadcast('dungeon-discovery-changed', saved); await pause(100);
  assert.equal(await painted(restored), 0, 'Previous instance poses and saved discovery cannot reveal the new instance');
  const nextScope = await discovery.load({ ...target, instanceId: state.instanceId });
  assert.notEqual(nextScope.scope, saved.scope); assert.equal(nextScope.exploration.cells.length, 0);
  await capture(restored, 'discovery-new-instance');
  transition({ active: false, status: 'outside', levelPath: '/SF/Levels/MidrathRedux', instanceId: 'isolated-overworld' });
  await until(async () => !(await stats(restored)).miniActive, 'overworld returns after discovery fixture');
  privateLocation = null; playerLocation = { status: 'found', source: 'memory', sampledAt: Date.now(), position: { x: 0, y: 0, z: 0 }, heading: 90,
    isOverworld: true, zone: '/SF/Levels/MidrathRedux', instanceId: state.instanceId, trackingSession: discoveryOwner.process };
  broadcast('player-location', playerLocation); await pause(750);
  await traceCanvas(restored, '#minimap-canvas');
  await restored.webContents.executeJavaScript('Minimap.render()');
  assert.equal(await restored.webContents.executeJavaScript('Minimap.playerMarker?.heading'), 90);
  assert.ok((await readTrace(restored)).rotate.some(args => Math.abs(args[0] - Math.PI / 2) < 1e-6), 'Overworld triangle follows fresh memory heading');
  assert.ok((await readTrace(restored)).fill.includes('#dc814a'), 'The configured player colour carries into the overworld');
  assert.ok((await readTrace(restored)).stroke.includes('#170a2b'), 'The configured dark player outline carries into the overworld');
  await restored.webContents.executeJavaScript("window.api.saveConfig({playerMarkerColor:'#b49aff',playerMarkerOutlineColor:'#22330b'})");
  await until(async () => (await readTrace(restored)).fill.includes('#b49aff'), 'Changing player colour repaints the existing overworld marker');
  assert.ok((await readTrace(restored)).stroke.includes('#22330b'), 'Changing player outline colour repaints the existing overworld marker');
  await capture(restored, 'overworld-live-player-triangle');
  await until(() => restored.webContents.executeJavaScript('Minimap.playerMarker === null'), 'stale overworld player marker expires');
  const emitWorld = async (x, z, extra = {}) => {
    playerLocation = { status: 'found', source: 'memory', sampledAt: Date.now(), position: { x, y: 0, z }, heading: 90,
      isOverworld: true, zone: '/SF/Levels/MidrathRedux', instanceId: state.instanceId, trackingSession: discoveryOwner.process, ...extra };
    broadcast('player-location', playerLocation); await pause(75);
  };
  await emitWorld(25, -30);
  const worldMini = await open(false, { manualPreview: false }), world = await openWorld();
  for (const [win, expanded] of [[worldMini, false], [world, true]]) {
    const name = expanded ? 'Expanded overworld' : 'Overworld minimap';
    const center = expanded ? '#center-player-btn' : '#minimap-locate';
    await until(async () => { const view = await worldView(win, expanded); return view.point && Math.abs(view.point[0] - view.width / 2) < 1; }, name + ' initial snapshot centers');
    let view = await worldView(win, expanded); assertCentered(view, name + ' initial snapshot');
    assert.ok(Math.abs(view.zoom - .65) < 1e-9, name + ' starts at the closer default zoom');
    await emitWorld(40, -50); assertCentered(await worldView(win, expanded), name + ' follows movement');
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(expanded ? '#zoom-in-btn' : '#minimap-zoom-in')}).click()`); await pause(75);
    view = await worldView(win, expanded); assertCentered(view, name + ' button zoom');
    assert.ok(Math.abs(view.zoom - .65 * 1.5) < 1e-9, name + ' retains an adjustable zoom');
    await focusForGesture(win);
    const wheelPoint = await win.webContents.executeJavaScript(`(() => {const r=document.querySelector(${JSON.stringify(expanded ? '#map-container' : '#minimap-viewport')}).getBoundingClientRect();return{x:Math.round(r.left+30),y:Math.round(r.top+50)}})()`);
    const beforeWheelZoom = view.zoom;
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...wheelPoint, deltaY: -80, deltaX: 0 }); await pause(100);
    view = await worldView(win, expanded); assertCentered(view, name + ' off-center wheel zoom');
    const wheelFactor = view.zoom / beforeWheelZoom;
    assert.ok(Math.abs(wheelFactor - 1.2) < 1e-8 || Math.abs(wheelFactor - 1 / 1.2) < 1e-8,
      name + ' wheel changes the zoom by one step: ' + JSON.stringify({ beforeWheelZoom, after: view.zoom }));
    win.setSize(expanded ? 1120 : 650, expanded ? 800 : 650); await pause(125);
    await emitWorld(60, -20); assertCentered(await worldView(win, expanded), name + ' resize and movement');
    await panWorld(win, expanded);
    const panned = await worldView(win, expanded);
    assert.ok(Math.abs(panned.point[0] - panned.width / 2) > 10, name + ' trusted dragging pauses follow');
    await emitWorld(70, -20);
    const movingWhilePanned = await worldView(win, expanded);
    assert.deepEqual(movingWhilePanned.pan, panned.pan, name + ' manual camera stays put while the player moves');
    assert.ok(Math.abs(movingWhilePanned.point[0] - panned.point[0]) > 5);
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(center)}).click()`); await pause(75);
    view = await worldView(win, expanded); assertCentered(view, name + ' Center resumes follow');
    assert.equal(view.zoom, panned.zoom, name + ' Center preserves the selected zoom');
    await emitWorld(85, -25); assertCentered(await worldView(win, expanded), name + ' continues following after Center');
    await capture(win, expanded ? 'overworld-expanded-following-player' : 'overworld-minimap-following-player');
    if (expanded) {
      await win.webContents.executeJavaScript("document.querySelector('#zoom-fit-btn').click()"); await pause(75);
      const overview = await worldView(win, true); assert.ok(overview.zoom < .65);
      await emitWorld(100, -25); assert.deepEqual((await worldView(win, true)).pan, overview.pan, 'Full-map fit pauses following');
      await win.webContents.executeJavaScript("document.querySelector('#center-player-btn').click()"); await pause(75);
      assertCentered(await worldView(win, true), 'Expanded Center follows from the overview zoom');
      assert.equal((await worldView(win, true)).zoom, overview.zoom);
    }
    await emitWorld(100, -25, { sampledAt: Date.now() - 2001 });
    await until(async () => !(await worldView(win, expanded)).point, name + ' rejects stale player data');
    await emitWorld(100, -25, { zone: '/SF/Levels/Other', isOverworld: false });
    assert.equal((await worldView(win, expanded)).point, null, name + ' rejects another area');
    await emitWorld(110, -15);
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(center)}).click()`); await pause(75);
    assertCentered(await worldView(win, expanded), name + ' fresh tracking resumes safely');
    win.destroy();
  }
  await discovery.flush();
  assert.deepEqual(errors, []);
  const summary = { ok: true, packaged, fixtureSource, serviceSource: 'source production discovery and frame fitting; packaged renderer/preload when --packaged', exactRooms: scene.rooms.length, actualCaptures,
    checks: ['minimap only', 'automatic entry and exit', 'three sizes', 'see-through and opacity', 'no room names or hover labels',
      'expansion selects the current world/dungeon map', 'distinct center and expand vector icons', 'large transparent outline-only dungeon overlay',
      'Escape returns to game with the panned map visible', 'expanded zoom/fit/close controls', 'interaction hint follows the configured chord',
      'focused native Mini-Map pan with click-through disabled', 'fullscreen pan requires focus and explicit interaction', 'native blur and interaction-off release pan capture', 'forwarded input cannot restart a cancelled pan',
      'no atlas on unresolved layouts', 'retry current layout',
      'asynchronous stale-result guard', 'overworld view preserved', 'embedded sizing', 'initially hidden maps fit on activation',
      'six live captures across Cliff Cave, Cliff Town and Glades', 'different routes on re-entry', 'prefetch and repeated destruction do not activate',
      'explicit test-only geometry previews', 'complete decoded graph fitted to unordered native LevelInfo frames', 'automatic placement without calibration controls', 'blank before native placement',
      'inward-feathered circular disclosure and remembered return trail', 'mapped live triangle heading', 'stale marker clearing retains fog',
      'neutral outlines with no room fills', 'disk discovery restoration requires fresh native proof', 'new instance rejects old pose and fog', 'live overworld triangle and expiry',
      'reference-shaped amber player arrow with dark outline', 'live custom player fill, player outline and dungeon outline colours', 'compact reveal circle fits the viewport edges while following movement and resize',
      'compact dragging pauses follow and center resumes at chosen zoom', 'compact wheel and button zoom retain player center', 'expanded overview remains freely pannable',
      'both overworld maps start closer and follow their initial snapshot', 'overworld Center enables continuous following at the chosen zoom',
      'overworld wheel and button zoom and resize retain player center', 'overworld dragging and full-map fit pause following', 'overworld stale and area guards', 'app CSP'], screenshots, errors };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2)); app.exit(0);
}).catch(error => { console.error(error.stack); console.error({ output, errors }); app.exit(1); });
setTimeout(() => { console.error('Dungeon map smoke test timed out'); app.exit(1); }, 85000).unref();
