// Run with node scripts/check-window-renderers.js. Uses hidden, isolated Electron
// windows and mocked data IPC; it does not connect to or modify the running game.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 20000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'output', `window-smoke-profile-${process.pid}`));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const windows = [];
app.whenReady().then(async () => {
  ipcMain.on('get-i18n', event => { event.returnValue = { translations: {}, languages: [] }; });
  ipcMain.handle('get-state', () => ({ config: { language: 'en', widgetVisibility: { boss: true, crafting: true } }, timers: [], namesMap: {} }));
  ipcMain.handle('dock-get-max-height', () => 600);
  ipcMain.handle('save-config', () => true);
  ipcMain.on('dock-resize-request', (event, width, height) => {
    BrowserWindow.fromWebContents(event.sender)?.setSize(width, height);
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
    ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com"]
  } }));
  const makeWindow = () => {
    const win = new BrowserWindow({ show: false, frame: false, width: 800, height: 600, webPreferences: {
      preload: path.join(root, 'src/preload.js'), contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false,
    } });
    windows.push(win);
    return win;
  };
  const dock = makeWindow();
  await dock.loadFile(path.join(root, 'src/renderer/dock-window.html'));
  for (let i = 0; i < 100; i++) {
    const ready = await dock.webContents.executeJavaScript(`document.querySelectorAll('.dock-cell').length === 2 && [...document.querySelectorAll('.dock-cell')].every(cell => cell.contentDocument?.readyState === 'complete' && cell.contentWindow.api)`);
    if (ready) break;
    await pause(50);
  }
  await pause(300);
  const fits = await dock.webContents.executeJavaScript(`({
    horizontal: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight <= document.documentElement.clientHeight,
  })`);
  assert.deepEqual(fits, { horizontal: true, vertical: true }, 'A dock sized to its content must not add scrollbars');
  const initial = await dock.webContents.executeJavaScript(`(() => {
    const cells = [...document.querySelectorAll('.dock-cell')];
    for (const cell of cells) cell.contentWindow.__retainedMarker = cell.dataset.widget;
    return cells.map(cell => cell.dataset.widget);
  })()`);
  assert.deepEqual(initial, ['boss', 'crafting']);
  await dock.webContents.executeJavaScript(`render(); render(); render();`);
  await pause(300);
  const retained = await dock.webContents.executeJavaScript(`[...document.querySelectorAll('.dock-cell')].every(cell => cell.contentWindow.__retainedMarker === cell.dataset.widget)`);
  assert.equal(retained, true, 'Stable dock layout must preserve iframe browsing contexts');
  await dock.webContents.executeJavaScript(`state.columns = [{ widgets: ['crafting'] }, { widgets: ['boss'] }]; render();`);
  await pause(300);
  const reordered = await dock.webContents.executeJavaScript(`[...document.querySelectorAll('.dock-cell')].map(cell => ({ id: cell.dataset.widget, marker: cell.contentWindow.__retainedMarker }))`);
  assert.deepEqual(reordered, [{ id: 'crafting', marker: 'crafting' }, { id: 'boss', marker: 'boss' }]);
  const bossFrame = dock.webContents.mainFrame.frames.find(frame => frame.url.includes('widget=boss'));
  const timerRetention = await bossFrame.executeJavaScript(`(() => {
    const expiryTime = Math.floor(Date.now()/1000)+120;
    currentTimers=[{tag:'KearnholdSiege',expiryTime}];renderTimers();
    const entry=document.querySelector('.timer-entry'),fill=entry.querySelector('.timer-bar-fill');
    const decoration=document.createElement('span');decoration.className='appearance-event';entry.append(decoration);
    renderTimers();renderTimers();
    return document.querySelector('.timer-entry')===entry && entry.querySelector('.timer-bar-fill')===fill && decoration.isConnected;
  })()`);
  assert.equal(timerRetention, true, 'Timer ticks preserve progress nodes and slow event decoration');
  const thinLabel = await bossFrame.executeJavaScript(`(() => {
    OverkotTheme.apply({appearance:{version:1,base:'classic',global:{fontSize:20,barHeight:4,barLabels:'inside'}}});
    const entry=document.querySelector('.timer-entry'),bar=entry.querySelector('.timer-bar').getBoundingClientRect(),label=entry.querySelector('.timer-bar-text').getBoundingClientRect();
    return {trackHeight:bar.height,below:label.top>=bar.bottom,labelHeight:label.height,fits:label.bottom<=entry.closest('.timer-widget').getBoundingClientRect().bottom};
  })()`);
  assert.equal(thinLabel.trackHeight, 4); assert.equal(thinLabel.below, true);
  assert.ok(thinLabel.labelHeight >= 17 && thinLabel.fits, `Large labels fit below thin tracks without clipping: ${JSON.stringify(thinLabel)}`);
  const rail = makeWindow();
  await rail.loadFile(path.join(root, 'src/renderer/index.html')); await pause(100);
  const railSize = require('../src/modules/edgeDockGeometry').DOCK_SIZE;
  const railMetrics = [];
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const vertical = edge === 'left' || edge === 'right';
    rail.setSize(vertical ? railSize : 800, vertical ? 800 : railSize); await pause(50);
    railMetrics.push(await rail.webContents.executeJavaScript(`(() => {
      OverkotTheme.apply({appearance:{version:1,base:'classic',global:{borderWidth:4}}});
      document.body.dataset.dockEdge='${edge}';document.body.classList.toggle('dock-vertical',${vertical});
      const bounds=document.getElementById('dock-bar').getBoundingClientRect();
      return {edge:'${edge}',thickness:${vertical ? 'bounds.width' : 'bounds.height'},buttons:[...document.querySelectorAll('.dock-button')].map(button=>{const r=button.getBoundingClientRect();return {width:r.width,height:r.height,fits:r.left>=bounds.left&&r.top>=bounds.top&&r.right<=bounds.right&&r.bottom<=bounds.bottom};})};
    })()`));
  }
  for (const metric of railMetrics) {
    assert.equal(metric.thickness, railSize, `${metric.edge} native rail thickness stays fixed`);
    assert.ok(metric.buttons.every(button => button.width === 36 && button.height === 36 && button.fits), `${metric.edge} 4px border preserves complete 36px hit areas`);
  }
  const alert = makeWindow();
  await alert.loadFile(path.join(root, 'src/renderer/alert-window.html'));
  alert.webContents.send('alert-data', { name: 'Window smoke test', readyLabel: 'Ready now' });
  await pause(100);
  const alertText = await alert.webContents.executeJavaScript(`({ name: document.getElementById('alert-name').textContent, label: document.getElementById('alert-label').textContent })`);
  assert.deepEqual(alertText, { name: 'Window smoke test', label: 'Ready now' });
  const dismissed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Alert dismiss did not send IPC')), 2000);
    ipcMain.once('alert-dismiss', () => { clearTimeout(timer); resolve(); });
  });
  await alert.webContents.executeJavaScript(`document.getElementById('alert-close').click()`);
  await dismissed;
  console.log(JSON.stringify({ ok: true, checks: ['content-sized dock has no scrollbars', 'dock stable render preserves iframe state', 'dock reorder preserves iframe state', 'timer ticks retain nodes and event decoration', 'large labels fit below thin tracks', '4px borders preserve 36px hit areas on all 48px rail edges', 'alert renders under script-src self CSP', 'alert dismissal sends IPC'], railMetrics }));
  for (const win of windows) win.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  app.exit(1);
});
setTimeout(() => { console.error('Window smoke timed out'); app.exit(1); }, 15000).unref();
