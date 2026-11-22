// Isolated fixture QA: actual Chromium maps and production preload/CSP.
// These synthetic weapon observations verify rendering, never live detection.
// node scripts/check-world-drops.js --source | --packaged
if (!process.versions.electron) {
  const args = process.argv.slice(2), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = args.includes('--packaged') ? require('./run-packaged-check').runPackagedCheck(__filename, args, 60000)
    : require('node:child_process').spawnSync(require('electron'), [__filename, ...args], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { serveMapAsset } = require('../test/fixtures/map-assets');
const root = path.resolve(__dirname, '..'), packaged = process.argv.includes('--packaged');
const packagedRoot = process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist', process.platform === 'linux' ? 'linux-unpacked' : 'win-unpacked');
const appRoot = packaged ? path.join(packagedRoot, 'resources/app.asar') : root;
const output = path.join(root, 'output', `world-drops-check-${packaged ? 'packaged' : 'source'}-${Date.now()}`);
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged([{ scheme: 'overkot-map-tiles', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const outside = { active: false, status: 'outside', instanceId: 'fixture-world', levelPath: '/SF/Levels/MidrathRedux' };
const inside = { active: true, status: 'ready', instanceId: 'fixture-dungeon', levelPath: '/SF/Levels/Procs/Fixture', name: 'Rendering fixture', layoutCode: 'isolated' };
const scope = 'isolated-drop-rendering-scope';
let state = outside, location = null;
let config = { language: 'en', clickThrough: false, showWorldDrops: true, dungeonMapAutoSwitch: true,
  appearance: { version: 1, base: 'classic', global: { backgroundOpacity: 100, elementOpacity: 100, surfaceOpacity: 100, motionLevel: 'off', iconMotion: 'off' }, widgets: {} } };
const windows = [], errors = [], screenshots = [], results = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) { for (let i = 0; i < 100; i++) { if (await test()) return; await pause(40); } throw new Error('Timed out: ' + label); }
function broadcast(channel, value) { for (const win of windows) if (!win.isDestroyed()) win.webContents.send(channel, value); }
function configure(patch) { config = { ...config, ...patch }; broadcast('config-changed', config); broadcast('theme-changed', config); }
function emit(items, dungeon, overrides = {}) {
  const sampledAt = Date.now();
  const mapped = position => ({ instanceId: inside.instanceId, revision: 'fixture-v1', coordinateSpace: 'layout-local', scope, alignmentVerified: true, position });
  location = { status: 'found', source: 'memory', sampledAt, trackingSession: 'isolated-rendering-fixture', instanceId: state.instanceId,
    isOverworld: !dungeon, zone: state.levelPath, position: dungeon ? { x: 1000, y: 0, z: 2000 } : { x: 0, y: 0, z: 0 }, heading: 0,
    ...(dungeon ? { dungeon: { ...mapped({ x: 0, z: 0 }), heading: 0 } } : {}),
    worldDrops: { status: 'available', sampledAt, items: items.map(item => ({ ...item, ...(dungeon ? { dungeon: { ...mapped(item.map), ...item.mappedOverrides } }
      : { position: { x: item.position.x - 1000, y: item.position.y, z: item.position.z - 2000 } }) })) }, ...overrides };
  broadcast('player-location', location);
}
const fixtureItems = () => [
  { id: 'normal', name: 'Stultin', kind: 'weapon', shiny: null, position: { x: 985, y: 0, z: 2007 }, map: { x: -15, z: 7 } },
  { id: 'moonsteel', name: 'Stultin', kind: 'weapon', shiny: true, position: { x: 1020, y: 0, z: 1992 }, map: { x: 20, z: -8 } },
];
const scene = () => ({ mode: 'placed', version: 'fixture-v1', coordinateSpace: 'layout-local', state,
  bounds: { x: [-60, 60], z: [-60, 60] }, rooms: [{ slot: 0, transform: { x: 0, z: 0, rotation: 0 },
    outline: [{ closed: true, points: [[-50, -25], [50, -25], [50, 25], [-50, 25]] }] }] });

async function open(mode) {
  const dungeon = mode.includes('dungeon'), large = mode.includes('large');
  state = dungeon ? inside : outside; location = null;
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, width: large ? 960 : 420, height: large ? 680 : 440,
    webPreferences: { preload: path.join(appRoot, 'src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  windows.push(win);
  win.webContents.on('console-message', ({ level, message }) => { if ((level === 'error' || level >= 3) && /Uncaught|Error invoking|ReferenceError|TypeError/.test(message)) errors.push(message); });
  const html = large ? dungeon ? 'dungeon-overlay.html' : 'map-window.html' : 'widget-host.html';
  await win.loadFile(path.join(appRoot, 'src/renderer', html), large ? undefined : { query: { widget: 'minimap' } });
  win.showInactive();
  const selector = dungeon ? '.dungeon-map canvas' : large ? '#map-canvas' : '#minimap-canvas';
  await until(() => win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)}) && ${large ? 'true' : 'Minimap.inited'} && document.querySelector(${JSON.stringify(selector)}).getClientRects().length>0`), mode + ' renderer ready');
  await win.webContents.executeJavaScript(`(() => {
    const badge=document.createElement('div');badge.textContent='ISOLATED RENDERING FIXTURE · normal + Moonsteel';
    badge.style.cssText='position:fixed;top:3px;left:8px;z-index:99999;font:10px Segoe UI;color:#fff;background:#101010;padding:3px 6px;pointer-events:none';document.body.appendChild(badge);
    const canvas=document.querySelector(${JSON.stringify(selector)}),context=canvas.getContext('2d');
    window.__dropTrace={text:[],arcs:[],shapes:[]};window.__shinyFrames=0;window.__shinyMotion=[];
    for(const method of ['clearRect','beginPath','moveTo','lineTo','closePath','fill','arc','fillText']) {
      const original=context[method];context[method]=function(...args){
        if(method==='clearRect')window.__dropTrace={text:[],arcs:[],shapes:[]};
        if(method==='beginPath')this.__dropPath=[];
        if(['moveTo','lineTo','closePath'].includes(method))(this.__dropPath??=[]).push([method,...args]);
        if(method==='fill'){
          window.__dropTrace.shapes.push({color:this.fillStyle,path:(this.__dropPath||[]).map(value=>[...value]),outline:this.strokeStyle,lineWidth:this.lineWidth,glow:this.shadowBlur,glowColor:this.shadowColor});
          if(this.fillStyle==='#da75ff'){window.__shinyFrames++;const matrix=this.getTransform();window.__shinyMotion.push([matrix.a,matrix.d,matrix.e,matrix.f]);if(window.__shinyMotion.length>20)window.__shinyMotion.shift();}
        }
        if(method==='arc')window.__dropTrace.arcs.push(args);
        if(method==='fillText')window.__dropTrace.text.push({text:args[0],x:args[1],y:args[2],color:this.fillStyle,font:this.font,outline:this.strokeStyle,lineWidth:this.lineWidth});
        return original.apply(this,args);
      };
    }
  })()`);
  return { win, dungeon, large, selector, mode };
}
const trace = view => view.win.webContents.executeJavaScript('window.__dropTrace');
const names = async view => (await trace(view)).text.filter(label => label.text === 'Stultin');
async function capture(view) {
  const file = path.join(output, view.mode + '-fixture.png');
  // Native capture can wait for the compositor longer than the live TTL.
  // Refresh only this explicitly labelled fixture while taking its picture;
  // the later expiry assertion runs without this fixture interval.
  const refresh = setInterval(() => emit(fixtureItems(), view.dungeon), 200);
  try {
    emit(fixtureItems(), view.dungeon); await pause(100);
    fs.writeFileSync(file, (await view.win.webContents.capturePage()).toPNG()); screenshots.push(file);
  } finally { clearInterval(refresh); }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  session.defaultSession.webRequest.onHeadersReceived(require('../src/modules/guard').createHeadersHandler(path.join(appRoot, 'src/renderer')));
  protocol.handle('overkot-map-tiles', serveMapAsset);
  const translations = { en: JSON.parse(fs.readFileSync(path.join(root, 'langs/en.json'), 'utf8')) };
  ipcMain.on('get-i18n', event => { event.returnValue = { translations, languages: [] }; });
  ipcMain.handle('get-state', () => ({ config, overlayInteractive: false, timers: [], namesMap: {} }));
  ipcMain.handle('get-map-tiles', () => ({ source: 'bundled', version: 'fixture' }));
  ipcMain.handle('get-map-data', () => ({})); ipcMain.handle('resolve-location-names', () => ({})); ipcMain.handle('get-ancestors', () => []);
  ipcMain.handle('get-player-location', () => location); ipcMain.handle('get-player-tracking', () => ({ status: 'fixture' }));
  ipcMain.handle('dungeon:state', () => state);
  ipcMain.handle('dungeon:map', () => state.active ? scene() : { mode: 'unavailable', state, rooms: [], reason: 'outside' });
  ipcMain.handle('dungeon-discovery:get', () => ({ ok: true, scope, alignment: { status: 'verified', points: 3 },
    exploration: { schema: 1, radius: 45, cellSize: 8, cells: [[0, 0]] } }));
  ipcMain.handle('dungeon-discovery:save', () => ({ ok: true }));
  ipcMain.handle('save-config', (_event, patch) => { configure(patch); return true; });
  for (const mode of ['overworld-compact', 'overworld-large', 'dungeon-compact', 'dungeon-large']) {
    const view = await open(mode), items = fixtureItems();
    if (!view.dungeon) await until(() => view.win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(view.large ? '#map-loading' : '#minimap-loading')}).classList.contains('loaded')`), mode + ' tiles settle before visual capture');
    emit(items, view.dungeon);
    await until(async () => (await names(view)).length === 2, mode + ' draws both observed fixture weapons');
    const initial = await trace(view);
    assert.ok(initial.arcs.some(arc => arc[2] === 3), mode + ' normal dot is small');
    assert.ok(initial.shapes.some(shape => shape.color === '#da75ff' && shape.path.length === 11
      && shape.outline === '#ffffff' && shape.lineWidth === 2.5 && shape.glow === 9 && shape.glowColor === '#da75ff'), mode + ' shiny star uses the selected colour, white outline and glow');
    const labels = await names(view);
    assert.ok(labels.some(label => label.color === '#ffffff'), mode + ' ordinary weapon labels stay white');
    assert.ok(labels.some(label => label.color === '#e098fb' && /^(?:700|bold) 12px /.test(label.font)
      && label.outline === '#000000' && label.lineWidth === 2), mode + ' shiny weapon labels use the selected text style');
    await pause(180);
    assert.ok(await view.win.webContents.executeJavaScript('new Set(window.__shinyMotion.map(value=>value.join(","))).size>1'), mode + ' shiny markers breathe between telemetry samples');
    await capture(view);
    if (view.dungeon) {
      emit([...items, { id: 'hidden', name: 'Hidden weapon fixture', kind: 'weapon', shiny: false, position: { x: 1035, y: 0, z: 2035 }, map: { x: 35, z: 35 } },
        { ...items[0], id: 'wrong-scope', name: 'Wrong scope fixture', mappedOverrides: { scope: 'previous-alignment' } }], true);
      await pause(80);
      assert.equal((await trace(view)).text.some(label => /Hidden weapon|Wrong scope/.test(label.text)), false, mode + ' refuses undiscovered or mismatched projections');
    }
    configure({ showWorldDrops: false }); await until(async () => (await names(view)).length === 0, mode + ' hides drops from Settings');
    const hiddenFrames = await view.win.webContents.executeJavaScript('window.__shinyFrames');
    await pause(100);
    assert.equal(await view.win.webContents.executeJavaScript('window.__shinyFrames'), hiddenFrames, mode + ' hidden drops stop animating');
    configure({ showWorldDrops: true }); emit(items, view.dungeon); await until(async () => (await names(view)).length === 2, mode + ' restores drops');
    emit([], view.dungeon); await until(async () => (await names(view)).length === 0, mode + ' removes picked-up items');
    emit(items, view.dungeon); await until(async () => (await names(view)).length === 2, mode + ' fresh fixture for expiry');
    await until(async () => (await names(view)).length === 0, mode + ' expires stale dropped-item and player samples');
    emit(items, view.dungeon); await until(async () => (await names(view)).length === 2, mode + ' fresh fixture for opacity');
    configure({ appearance: { ...config.appearance, global: { ...config.appearance.global, elementOpacity: 0 } } });
    await until(() => view.win.webContents.executeJavaScript(`getComputedStyle(document.querySelector(${JSON.stringify(view.selector)})).opacity==='0'`), mode + ' uses the shared Elements channel');
    configure({ appearance: { ...config.appearance, global: { ...config.appearance.global, elementOpacity: 100 } } });
    emit([], view.dungeon, { trackingSession: 'new-isolated-session' }); await until(async () => (await names(view)).length === 0, mode + ' clears a new session');
    results.push({ mode, whiteNames: 1, purpleNames: 1, normalDotRadius: 3, shinyStar: true, breathing: true, hiddenAnimationStopped: true, pickup: true, expiry: true, settings: true, opacity: true, verifiedDiscovery: view.dungeon });
    view.win.destroy();
  }
  assert.deepEqual(errors, []);
  const summary = { ok: true, packaged, evidence: 'Synthetic isolated renderer/preload fixtures only; no live dropped-item detections claimed.', results, screenshots, errors };
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify({ ...summary, output }, null, 2)); app.exit(0);
}).catch(async error => {
  const diagnostics = await Promise.all(windows.filter(win => !win.isDestroyed()).map(win => win.webContents.executeJavaScript(`({hidden:document.hidden,helper:typeof WorldDropMarkers,mini:typeof Minimap==='undefined'?null:{inited:Minimap.inited,player:Minimap.playerMarker},trace:window.__dropTrace,canvases:[...document.querySelectorAll('canvas')].map(canvas=>({width:canvas.clientWidth,height:canvas.clientHeight}))})`).catch(value => ({ error: value.message }))));
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, diagnostics, errors }, null, 2));
  console.error(error.stack); console.error(JSON.stringify({ output, diagnostics, errors }, null, 2)); app.exit(1);
});
setTimeout(() => { console.error('World-drop renderer QA timed out', { output, errors }); app.exit(1); }, 55000).unref();
