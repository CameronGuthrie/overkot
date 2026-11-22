// Real Chromium pixel assertions for inward dungeon discovery feathering.
// Run: node scripts/check-dungeon-feather.js [--packaged]
if (!process.versions.electron) {
  const args = process.argv.slice(2), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = args.includes('--packaged') ? require('./run-packaged-check').runPackagedCheck(__filename, args, 90000, { windowsHide: true })
    : require('node:child_process').spawnSync(require('electron'), [__filename, ...args], { env, stdio: 'inherit', windowsHide: true, timeout: 90000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), packaged = process.argv.includes('--packaged');
const appRoot = packaged ? path.join(root, 'dist/win-unpacked/resources/app.asar') : root;
const output = path.join(root, 'output', `dungeon-feather-${packaged ? 'packaged' : 'source'}-${Date.now()}`);
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 520, height: 540, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  try {
    const css = fs.readFileSync(path.join(appRoot, 'src/renderer/dungeon-map.css'), 'utf8');
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<style>body{margin:0;background:#111}#host{width:440px;height:490px;padding:12px}.dungeon-map{height:100%}${css}</style><div id="host"></div>`)}`);
    for (const file of ['src/modules/dungeonExploration.js', 'src/modules/playerMarkerMotion.js', 'src/modules/mapAppearance.js', 'src/renderer/dungeon-map.js']) {
      await window.webContents.executeJavaScript(`${fs.readFileSync(path.join(appRoot, file), 'utf8')}\n;void 0;`);
    }
    await window.webContents.executeJavaScript(`(${function installFixture() {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      let widget, version = 0, sampleFeather, changeFeatherConfig, keepFeatherAlive = () => {};
      window.setFeatherProgressive = async enabled => {
        keepFeatherAlive();
        changeFeatherConfig(enabled);
        for (let count = 0; count < 3; count++) { keepFeatherAlive(); await frame(); }
        return sampleFeather();
      };
      window.setupFeather = async (cells, extent = 100, player = false, options = {}) => {
        widget?.destroy(); version++;
        const id = `pixel-entry-${version}`, revision = `pixel-${version}`, scope = `pixel-scope-${version}`;
        const state = { active: true, instanceId: id, name: 'Exploration pixel fixture' };
        const map = { state, version: revision, coordinateSpace: 'world', mode: 'placed', bounds: { x: [-extent, extent], z: [-extent, extent] },
          rooms: [{ room: 'Fixture', transform: { x: 0, z: 0, rotation: 0 }, outline: [{ closed: false, points: [[-extent, 0], [extent, 0]] }] }] };
        const pose = player ? { status: 'found', source: 'memory', sampledAt: Date.now(), isOverworld: false, instanceId: id, trackingSession: 'pixel-session',
          dungeon: { instanceId: id, revision, scope, alignmentVerified: true, coordinateSpace: 'world', position: { x: 0, z: 0 }, heading: 0 } } : null;
        let saves = 0, configListener, playerListener;
        const config = { ...options.config };
        changeFeatherConfig = enabled => { config.dungeonMapProgressiveReveal = enabled; configListener?.({ ...config }); };
        keepFeatherAlive = () => { if (pose) playerListener?.({ ...pose, sampledAt: Date.now() }); };
        const api = { getDungeonMap: async () => map,
          getDungeonDiscovery: async () => ({ ok: true, scope, exploration: { schema: 1, radius: 45, cellSize: 8, cells }, alignment: { status: 'verified', points: 3 } }),
          saveDungeonDiscovery: async () => { saves++; return { ok: true }; }, getPlayerLocation: async () => pose,
          onDungeonDiscoveryChanged: () => () => {}, onConfigChanged: callback => { configListener = callback; return () => {}; },
          onPlayerLocation: callback => { playerListener = callback; return () => {}; } };
        widget = window.DungeonMapWidget.mount(document.getElementById('host'), { api, config, followPlayer: options.compact === true });
        let startupMaximum = 0;
        for (let count = 0; count < 3; count++) {
          keepFeatherAlive();
          await frame();
          if (!cells.length && !player) {
            const canvas = document.querySelector('canvas'), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            for (let index = 3; index < pixels.length; index += 4) startupMaximum = Math.max(startupMaximum, pixels[index]);
          }
        }
        const canvas = document.querySelector('canvas'), viewport = document.querySelector('.dungeon-map-viewport');
        const width = viewport.clientWidth, height = viewport.clientHeight, ratio = canvas.width / width;
        const zoom = Math.max(.001, Math.min(20, (width - 44) / (extent * 2), (height - 44) / (extent * 2)));
        const context = canvas.getContext('2d');
        const alphaAt = (x, y) => {
          const px = Math.round(x * ratio), py = Math.round(y * ratio);
          let alpha = 0;
          for (let dy = -2; dy <= 2; dy++) alpha = Math.max(alpha, context.getImageData(px, py + dy, 1, 1).data[3]);
          return alpha;
        };
        const atWorld = x => alphaAt(width / 2 + x * zoom, height / 2);
        sampleFeather = () => {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let maximum = 0; for (let index = 3; index < pixels.length; index += 4) maximum = Math.max(maximum, pixels[index]);
          return { inner: atWorld(20), feather: atWorld(42), outside: atWorld(48), far: atWorld(80), maximum, startupMaximum,
            overlap: [atWorld(-20), atWorld(0), atWorld(20)], outerUnion: atWorld(68), radius: 45 * zoom,
            marker: alphaAt(width / 2, height / 2 - 5), beyondMarker: alphaAt(width / 2, height / 2 - 20), saves,
            guideHidden: document.querySelector('.dungeon-map-guide').hidden,
            fitDisabled: document.querySelector('[data-action="fit"]').disabled,
            following: document.querySelector('.dungeon-map').dataset.following,
            footer: document.querySelector('.dungeon-map-footer').textContent };
        };
        return sampleFeather();
      };
      window.setupCompactCircle = async (width, height) => {
        widget?.destroy(); version++;
        const host = document.getElementById('host'); host.style.width = `${width}px`; host.style.height = `${height}px`;
        const id = `compact-circle-${version}`, state = { active: true, instanceId: id, name: 'Compact reveal circle' };
        const revision = id, scope = id;
        const pose = { status: 'found', source: 'memory', sampledAt: Date.now(), isOverworld: false, instanceId: id, trackingSession: id,
          dungeon: { instanceId: id, revision, scope, alignmentVerified: true, coordinateSpace: 'world', position: { x: 0, z: 0 }, heading: 0 } };
        const map = { state, version: revision, coordinateSpace: 'world', mode: 'placed', bounds: { x: [-10000, 10000], z: [-10000, 10000] },
          rooms: [{ room: 'Cross', transform: { x: 0, z: 0, rotation: 0 }, outline: [
            { closed: false, points: [[-10000, 0], [10000, 0]] }, { closed: false, points: [[0, -10000], [0, 10000]] }] }] };
        const api = { getDungeonMap: async () => map, getPlayerLocation: async () => pose,
          getDungeonDiscovery: async () => ({ ok: true, scope, exploration: { schema: 1, radius: 45, cellSize: 8, cells: [] }, alignment: { status: 'verified', points: 3 } }),
          saveDungeonDiscovery: async () => ({ ok: true }), onDungeonDiscoveryChanged: () => () => {} };
        const arcs = [], originalArc = CanvasRenderingContext2D.prototype.arc;
        CanvasRenderingContext2D.prototype.arc = function(...args) { arcs.push(args); return originalArc.apply(this, args); };
        try {
          widget = window.DungeonMapWidget.mount(host, { api, followPlayer: true });
          for (let count = 0; count < 4; count++) await frame();
        } finally { CanvasRenderingContext2D.prototype.arc = originalArc; }
        const canvas = host.querySelector('canvas'), viewport = host.querySelector('.dungeon-map-viewport'), context = canvas.getContext('2d');
        const w = viewport.clientWidth, h = viewport.clientHeight, ratio = canvas.width / w, radius = Math.min(w, h) / 2;
        const outer = arcs.find(([x, y, r]) => Math.abs(x - w / 2) < .01 && Math.abs(y - h / 2) < .01 && Math.abs(r - radius) < .01);
        const horizontal = w <= h;
        const alphaAtDistance = distance => {
          const x = Math.round((w / 2 + (horizontal ? distance : 0)) * ratio), y = Math.round((h / 2 + (horizontal ? 0 : distance)) * ratio);
          let alpha = 0;
          for (let offset = -2; offset <= 2; offset++) {
            const px = Math.max(0, Math.min(canvas.width - 1, x + (horizontal ? 0 : offset)));
            const py = Math.max(0, Math.min(canvas.height - 1, y + (horizontal ? offset : 0)));
            alpha = Math.max(alpha, context.getImageData(px, py, 1, 1).data[3]);
          }
          return alpha;
        };
        return { width: w, height: h, radius, outer, inner: alphaAtDistance(radius - 18), feather: alphaAtDistance(radius - 3), edge: alphaAtDistance(radius - 1) };
      };
    }.toString()})()`);
    const checks = {};
    checks.circle = await window.webContents.executeJavaScript('window.setupFeather([[0,0]])');
    assert.ok(checks.circle.inner >= 120, JSON.stringify(checks.circle));
    assert.ok(checks.circle.feather > 0 && checks.circle.feather < checks.circle.inner * .8, JSON.stringify(checks.circle));
    assert.equal(checks.circle.outside, 0); assert.equal(checks.circle.far, 0);
    fs.writeFileSync(path.join(output, 'circle.png'), (await window.webContents.capturePage()).toPNG());
    checks.overlap = await window.webContents.executeJavaScript('window.setupFeather([[-20,0],[20,0]])');
    assert.ok(Math.max(...checks.overlap.overlap) - Math.min(...checks.overlap.overlap) <= 1, JSON.stringify(checks.overlap));
    assert.equal(checks.overlap.outerUnion, 0);
    fs.writeFileSync(path.join(output, 'overlap.png'), (await window.webContents.capturePage()).toPNG());
    checks.empty = await window.webContents.executeJavaScript('window.setupFeather([])');
    assert.equal(checks.empty.maximum, 0, 'An undiscovered layout never flashes its full room outlines');
    assert.equal(checks.empty.startupMaximum, 0, 'Every initial frame keeps an undiscovered layout hidden');
    checks.full = [];
    for (const compact of [false, true]) {
      const full = await window.webContents.executeJavaScript(`window.setupFeather([],100,false,{compact:${compact},config:{dungeonMapProgressiveReveal:false}})`);
      assert.ok(full.far >= 120, 'Disabling progressive reveal fits and shows the full dungeon without a player: ' + JSON.stringify(full));
      assert.equal(full.guideHidden, true, 'A full map must not be covered by a waiting-for-position guide');
      assert.equal(full.fitDisabled, false, 'Full-map fit works without a tracked player');
      assert.equal(full.following, 'false');
      assert.equal(full.saves, 0, 'Showing full outlines must not record exploration');
      const hidden = await window.webContents.executeJavaScript('window.setFeatherProgressive(true)');
      assert.equal(hidden.maximum, 0, 'Reenabling progressive reveal hides the still-undiscovered map');
      const restored = await window.webContents.executeJavaScript('window.setFeatherProgressive(false)');
      assert.ok(restored.far >= 120, 'The live setting restores full-map visibility');
      assert.equal(restored.saves, 0, 'Toggling visibility must not create discovery writes');
      checks.full.push({ compact, full, hidden, restored });
    }
    fs.writeFileSync(path.join(output, 'full-map-without-player.png'), (await window.webContents.capturePage()).toPNG());
    checks.discoveryToggle = { full: await window.webContents.executeJavaScript('window.setupFeather([[0,0]],100,false,{config:{dungeonMapProgressiveReveal:false}})') };
    assert.ok(checks.discoveryToggle.full.far >= 120);
    checks.discoveryToggle.revealed = await window.webContents.executeJavaScript('window.setFeatherProgressive(true)');
    assert.ok(checks.discoveryToggle.revealed.inner >= 120, 'The actual explored circle survives showing the full map');
    assert.equal(checks.discoveryToggle.revealed.far, 0, 'Showing the full map never turns unvisited areas into discovery');
    assert.equal(checks.discoveryToggle.revealed.saves, 0);
    checks.trackedToggle = { initial: await window.webContents.executeJavaScript('window.setupFeather([[0,0]],100,true)') };
    assert.ok(checks.trackedToggle.initial.marker >= 220, JSON.stringify(checks.trackedToggle.initial));
    checks.trackedToggle.full = await window.webContents.executeJavaScript('window.setFeatherProgressive(false)');
    assert.ok(checks.trackedToggle.full.marker >= 220, 'The verified live marker remains visible on the full map');
    assert.ok(checks.trackedToggle.full.far >= 120);
    checks.trackedToggle.revealed = await window.webContents.executeJavaScript('window.setFeatherProgressive(true)');
    assert.ok(checks.trackedToggle.revealed.marker >= 220, 'Toggling progressive reveal does not interrupt tracking');
    assert.equal(checks.trackedToggle.revealed.far, 0);
    checks.marker = await window.webContents.executeJavaScript('window.setupFeather([[0,0]],10000,true)');
    assert.ok(checks.marker.radius < 1); assert.ok(checks.marker.marker >= 220, JSON.stringify(checks.marker));
    assert.equal(checks.marker.beyondMarker, 0);
    fs.writeFileSync(path.join(output, 'marker.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(800, 700);
    checks.compact = [];
    for (const size of [[320, 500], [600, 360]]) {
      const check = await window.webContents.executeJavaScript(`window.setupCompactCircle(${size.join(',')})`);
      assert.ok(check.outer, 'The actual reveal clip circle is tangent to both short viewport edges: ' + JSON.stringify(check));
      assert.ok(check.inner >= 100 && check.feather > 0 && check.feather < check.inner * .75, JSON.stringify(check));
      assert.ok(check.edge <= check.feather, 'Feather fades inward as the circle reaches the viewport edge: ' + JSON.stringify(check));
      checks.compact.push(check);
    }
    fs.writeFileSync(path.join(output, 'compact-circle-fit.png'), (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
    console.log(`Dungeon feather Chromium checks passed: ${output}`);
  } finally { window.destroy(); }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
