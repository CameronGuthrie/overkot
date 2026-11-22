'use strict';

// Native Chromium layout and pointer capture, isolated from the running app.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, stdio: 'inherit', windowsHide: true, timeout: 45000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
const out = fs.mkdtempSync(path.join(root, 'output', 'dock-icon-drag-'));
app.setPath('userData', path.join(out, 'profile'));
const renderer = process.argv.includes('--packaged-renderers')
  ? path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar', 'src', 'renderer') : path.join(root, 'src', 'renderer');
const preload = path.join(out, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');
contextBridge.exposeInMainWorld('i18n',{translations:{en:{}},titleTrackerEnabled:true});
const noop=()=>{};
contextBridge.exposeInMainWorld('api',{getState:async()=>({config:{},dockState:{edge:'bottom'},timers:[]}),
onConfigChanged:noop,onStateUpdate:noop,onOverlayInteraction:noop,onLayoutKeyMonitorStatus:noop,onDockState:noop,
setDockKeyboardActive:noop,saveConfig:async()=>true,toggleDockWidget:async()=>true});`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1240, height: 48, enableLargerThanScreen: true,
    webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const errors = [], report = [];
  win.webContents.on('console-message', ({ message }) => { if (/Uncaught|ReferenceError|TypeError/.test(message)) errors.push(message); });
  const run = code => win.webContents.executeJavaScript(code);
  const settle = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const until = async (predicate, label) => {
    for (let index = 0; index < 100; index++) { if (await predicate()) return; await pause(20); }
    throw new Error('Timed out: ' + label);
  };
  const measure = () => run(`(()=>{const bar=document.getElementById('dock-bar'),ghost=document.querySelector('.dock-icon-ghost');
    const rect=bar.getBoundingClientRect();return{width:rect.width,height:rect.height,viewport:[innerWidth,innerHeight],
    ghostPosition:ghost?getComputedStyle(ghost).position:null,dragging:document.body.classList.contains('dock-icons-dragging')};})()`);
  try {
    await win.loadFile(path.join(renderer, 'index.html'));
    await until(() => run('typeof renderWidgetButtons===\'function\''), 'dock renderer');
    for (const edge of ['bottom', 'top', 'left', 'right']) {
      const vertical = edge === 'left' || edge === 'right';
      win.setSize(vertical ? 48 : 1240, vertical ? 1000 : 48);
      await run(`config={dockEdge:${JSON.stringify(edge)},widgetVisibility:Object.fromEntries(Object.keys(WIDGET_CATALOG).map(id=>[id,true])),appearance:{version:1,base:'classic',global:{motionLevel:'off'},widgets:{}}};dockState={edge:${JSON.stringify(edge)}};applyConfig()`);
      await settle();
      const initial = await measure();
      const thickness = vertical ? initial.width : initial.height;
      assert.equal(thickness, 48, edge + ': initial bar thickness');
      for (const outcome of ['drop', 'cancel']) {
        await run("document.getElementById('widget-launchers').scrollLeft=0;document.getElementById('widget-launchers').scrollTop=0");
        await settle();
        const point = await run(`(()=>{const b=document.querySelector('.dock-widget-button').getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`);
        const move = { x: point.x + (vertical ? 0 : 100), y: point.y + (vertical ? 100 : 0) };
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: 'mouseMove', ...move, modifiers: ['leftButtonDown'] });
        await until(() => run("document.body.classList.contains('dock-icons-dragging')"), edge + ': drag starts');
        await settle();
        const during = await measure();
        fs.writeFileSync(path.join(out, edge + '-' + outcome + '.png'), (await win.webContents.capturePage()).toPNG());
        report.push({ edge, outcome, initial, during });
        if (!process.argv.includes('--baseline')) {
          assert.equal(during.ghostPosition, 'fixed', edge + ': the decorative drag clone stays outside flex layout');
          assert.deepEqual([during.width, during.height], [initial.width, initial.height], edge + ': dragging cannot change any rail dimension');
          assert.deepEqual(during.viewport, initial.viewport, edge + ': native window dimensions stay unchanged');
        }
        const end = await run(`(()=>{const r=document.getElementById('widget-launchers').getBoundingClientRect();return{x:${vertical ? 'Math.round(r.x+r.width/2)' : 'Math.round(r.right-4)'},y:${vertical ? 'Math.round(r.bottom-4)' : 'Math.round(r.y+r.height/2)'}}})()`);
        win.webContents.sendInputEvent({ type: 'mouseMove', ...end, modifiers: ['leftButtonDown'] });
        await until(() => run(`document.getElementById('widget-launchers').${vertical ? 'scrollTop' : 'scrollLeft'}>0`), edge + ': held icon autoscroll reaches overflow');
        const scrolled = await measure();
        if (!process.argv.includes('--baseline')) assert.deepEqual([scrolled.width, scrolled.height], [initial.width, initial.height], edge + ': overflow autoscroll preserves the rail');
        if (outcome === 'cancel') await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...end });
        await until(() => run("!document.body.classList.contains('dock-icons-dragging')"), edge + ': drag finishes');
        await settle();
        const finished = await measure();
        assert.deepEqual([finished.width, finished.height], [initial.width, initial.height], edge + ': finishing preserves the full rail');
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, renderer, report }, null, 2));
    console.log(JSON.stringify({ ok: true, out, cases: report.map(({ edge, outcome, initial, during }) => ({ edge, outcome, before: [initial.width, initial.height], during: [during.width, during.height], ghostPosition: during.ghostPosition })) }));
  } finally { win.destroy(); }
}).then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
