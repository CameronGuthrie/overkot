// Build the portable app first, then: node scripts/check-edge-dock-package.js
// Verify the actual ASAR renderers/preload in the packaged native runtime.
// Windows stay hidden; no game services, global shortcuts or input hooks run.
if (!process.versions.electron) {
  const result = require('./run-packaged-check').runPackagedCheck(__filename, process.argv.slice(2), 50000);
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const packagedDirectory = path.resolve(process.env.OVERKOT_PACKAGED_DIRECTORY || path.join(root, 'dist', process.platform === 'linux' ? 'linux-unpacked' : 'win-unpacked'));
const archive = path.join(packagedDirectory, 'resources', 'app.asar');
const out = path.join(root, 'output', `edge-dock-package-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.on('window-all-closed', () => {});
const errors = [], requests = [], windows = [], checks = [], screenshots = [];
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await pause(40);
  }
  throw new Error('Timed out: ' + label);
}
const evaluate = (win, code) => win.webContents.executeJavaScript(code);
async function capture(win, name) {
  let screenshot;
  await until(async () => {
    win.webContents.invalidate();
    await pause(80);
    screenshot = await win.webContents.capturePage();
    return !screenshot.isEmpty();
  }, name + ' painted screenshot');
  const filename = path.join(out, name + '.png');
  fs.writeFileSync(filename, screenshot.toPNG());
  screenshots.push(filename);
}
function makeWindow(width, height, preload = true, nativeOptions = {}) {
  const win = new BrowserWindow({ show: false, frame: false, focusable: false,
    width, height, minWidth: 1, minHeight: 1, enableLargerThanScreen: true,
    ...nativeOptions,
    webPreferences: { ...(preload ? { preload: path.join(archive, typeof preload === 'string' ? preload : 'src/preload.js') } : {}),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  windows.push(win);
  win.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error' || level >= 3) errors.push(message);
  });
  win.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  win.webContents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) errors.push(`${description}: ${url}`);
  });
  return win;
}

app.whenReady().then(async () => {
  assert.ok(fs.existsSync(archive), 'Build or install the packaged app before this check');
  const packageInfo = JSON.parse(fs.readFileSync(path.join(archive, 'package.json'), 'utf8'));
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(packageInfo.version, expectedVersion, 'The packaged version matches the release source');
  assert.match(packageInfo.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);
  const required = ['src/main.js', 'src/preload.js', 'src/renderer/index.html', 'src/renderer/renderer.js',
    'src/renderer/styles.css', 'src/renderer/icons.css', 'src/renderer/theme.css', 'src/renderer/theme.js',
    'src/renderer/widget-host.html', 'src/renderer/widget-host.js', 'src/renderer/widget-host.css',
    'src/renderer/layout-grid.html', 'src/renderer/layout-grid.css',
    'src/modules/tutorials.js', 'src/renderer/tutorial.html', 'src/renderer/tutorial.js', 'src/renderer/tutorial.css',
    'src/renderer/focus-reminder.html', 'src/renderer/focus-reminder.js', 'src/renderer/focus-reminder.css', 'src/renderer/focus-reminder-preload.js',
    'src/renderer/dungeon-overlay.html', 'src/renderer/dungeon-overlay.js', 'src/renderer/dungeon-overlay.css', 'langs/en.json', 'assets/overkot.png'];
  for (const relative of required) assert.ok(fs.statSync(path.join(archive, relative)).isFile(), relative);
  // Widget host imports shared renderers even when only boss/wiki are active.
  for (const file of ['index.html', 'widget-host.html', 'layout-grid.html', 'dungeon-overlay.html', 'tutorial.html', 'focus-reminder.html']) {
    const document = fs.readFileSync(path.join(archive, 'src/renderer', file), 'utf8');
    for (const reference of document.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css))"/g)) {
      assert.ok(fs.existsSync(path.join(archive, 'src/renderer', reference[1])), `${file}: ${reference[1]}`);
    }
  }
  const bundledMain = fs.readFileSync(path.join(archive, 'src/main.js'), 'utf8');
  for (const marker of ['dock-toggle-widget', 'layout-key-monitor-status', 'EncodedCommand', 'dockWidgetOrder', 'widgetOutlineOpacity', 'open-dungeon-overlay', 'close-dungeon-overlay',
    'tutorial:open', 'tutorial:complete', 'focus-reminder:state']) {
    assert.ok(bundledMain.includes(marker), `Bundled main contains ${marker}`);
  }
  checks.push('release version, required ASAR assets and bundled dock runtime markers');

  const { createHeadersHandler } = require('../src/modules/guard');
  session.defaultSession.webRequest.onHeadersReceived(createHeadersHandler(path.join(archive, 'src/renderer')));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const translations = { en: JSON.parse(fs.readFileSync(path.join(archive, 'langs/en.json'), 'utf8')) };
  const state = { status: 'connected', nativeLayoutTracking: true, layoutEditing: false,
    platformSupport: { platform: 'win32' }, config: { language: 'en', theme: 'classic', backgroundOpacity: 88,
      clickThrough: false, widgetVisibility: { boss: true, wiki: true }, widgetOpen: {}, widgetDocked: {},
      dockEdge: 'bottom', dockAutoHide: false, dockWidgetOrder: [], widgetOutlineOpacity: 100,
      interactionHotkey: 'Ctrl+F3', overlayVisibilityHotkey: 'Shift+F2' }, namesMap: {},
    timers: [{ tag: 'CurlailSiege', expiryTime: Math.floor(Date.now() / 1000) + 900 },
      { tag: 'KearnholdSiege', expiryTime: Math.floor(Date.now() / 1000) + 1200 }] };
  const broadcastConfig = () => {
    for (const win of windows) if (!win.isDestroyed()) win.webContents.send('config-changed', state.config);
  };
  ipcMain.on('get-i18n', event => { event.returnValue = { translations, languages: [] }; });
  ipcMain.handle('get-state', () => state);
  ipcMain.handle('save-config', (_event, patch) => { Object.assign(state.config, patch); broadcastConfig(); return true; });
  const completedTutorials = [];
  ipcMain.handle('tutorial:complete', (_event, id) => { completedTutorials.push(id); return true; });
  ipcMain.on('window-close', (event) => requests.push({ channel: 'window-close', sender: event.sender.id, args: [] }));
  ipcMain.handle('dock-toggle-widget', (_event, id) => {
    assert.equal(state.config.widgetVisibility[id], true);
    state.config.widgetOpen = { ...state.config.widgetOpen, [id]: !state.config.widgetOpen[id] };
    broadcastConfig();
    return { config: state.config };
  });
  for (const channel of ['fit-window-size', 'window-resize-to', 'window-drag-start', 'window-move-by', 'window-drag-end',
    'open-wiki-search', 'dock-keyboard-active']) {
    ipcMain.on(channel, (event, ...args) => requests.push({ channel, sender: event.sender.id, args }));
  }
  ipcMain.on('layout-editing-request', (event, active) => {
    requests.push({ channel: 'layout-editing-request', sender: event.sender.id, args: [active] });
    event.sender.send('layout-editing', active);
  });

  const display = screen.getPrimaryDisplay().bounds;
  const edges = [];
  for (const edge of ['bottom', 'top', 'left', 'right']) {
    state.config.dockEdge = edge;
    state.config.dockWidgetOrder = [];
    const vertical = edge === 'left' || edge === 'right';
    const size = vertical ? [48, display.height] : [display.width, 48];
    const bar = makeWindow(...size);
    await bar.loadFile(path.join(archive, 'src/renderer/index.html'));
    // Windows can constrain initial creation to its work area. Reapply the
    // app's full-edge bounds after the packaged document has loaded.
    bar.setBounds({ x: display.x, y: display.y, width: size[0], height: size[1] });
    await until(() => evaluate(bar, "document.querySelectorAll('.dock-widget-button').length === 2"), edge + ' launch icons');
    const layout = await evaluate(bar, `(() => {
      const rect = document.getElementById('dock-bar').getBoundingClientRect();
      return { edge: document.body.dataset.dockEdge, viewport: [innerWidth, innerHeight],
        bar: [rect.width, rect.height], overflow: [document.body.scrollWidth > innerWidth, document.body.scrollHeight > innerHeight],
        icons: [...document.querySelectorAll('.dock-widget-button')].map(button => ({ id: button.dataset.widget,
          pressed: button.getAttribute('aria-pressed'), label: button.getAttribute('aria-label'), icon: !!button.querySelector('.dock-widget-icon') })) };
    })()`);
    assert.equal(layout.edge, edge);
    assert.deepEqual(layout.viewport, size);
    assert.deepEqual(layout.bar, size);
    assert.deepEqual(layout.overflow, [false, false]);
    assert.deepEqual(layout.icons.map(icon => [icon.id, icon.pressed, icon.icon]), [['boss', 'false', true], ['wiki', 'false', true]]);
    assert.ok(layout.icons.every(icon => /Show|docked widget/.test(icon.label)));
    await evaluate(bar, "document.querySelector('[data-widget=wiki]').click()");
    await until(() => evaluate(bar, "document.querySelector('[data-widget=wiki]').getAttribute('aria-pressed') === 'true'"), edge + ' open toggle');
    await evaluate(bar, "document.querySelector('[data-widget=wiki]').click()");
    await until(() => evaluate(bar, "document.querySelector('[data-widget=wiki]').getAttribute('aria-pressed') === 'false'"), edge + ' hide toggle');
    await evaluate(bar, "window.api.saveConfig({dockWidgetOrder:['wiki','boss']})");
    await until(() => evaluate(bar, "[...document.querySelectorAll('.dock-widget-button')].map(button=>button.dataset.widget).join(',') === 'wiki,boss'"), edge + ' saved icon order');
    await capture(bar, 'bar-' + edge);
    edges.push(layout);
    bar.destroy();
  }
  checks.push('packaged preload, four full-length 48 DIP bars, inactive icons, open/hide toggles, saved icon order and no viewport overflow');

  const widgets = [];
  for (const id of ['boss', 'wiki']) {
    const win = makeWindow(350, 300);
    await win.loadFile(path.join(archive, 'src/renderer/widget-host.html'), { query: { widget: id } });
    await until(() => evaluate(win, `document.body.dataset.widget === '${id}'`), id + ' renderer initialization');
    const content = await evaluate(win, `(() => {
      const card = document.querySelector('.timer-widget[data-widget="${id}"]');
      return { label: card.getAttribute('aria-label'),
        chrome: card.querySelectorAll('.widget-caption,.widget-title,.widget-count,.widget-header,.widget-drag-region,.widget-collapse-btn').length,
        topInset: card.querySelector('.widget-body').getBoundingClientRect().top-card.getBoundingClientRect().top };
    })()`);
    assert.ok(content.label.length, 'A card remains identified to assistive technology');
    assert.equal(content.chrome, 0, 'Widget content has no visible title/header controls');
    assert.ok(content.topInset <= 10, 'Widget content reclaims the caption space');
    if (id === 'boss') assert.equal(await evaluate(win, "document.querySelectorAll('.timer-entry').length"), 2);
    else {
      await evaluate(win, `(() => {
        const input = document.getElementById('wiki-search-input'); input.value = 'Orlick';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
      await until(() => requests.some(request => request.channel === 'open-wiki-search' && request.args[0] === 'Orlick'), 'packaged wiki search bridge');
      const point = await evaluate(win, `(() => { const r = document.getElementById('wiki-search-input').getBoundingClientRect(); return {x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}; })()`);
      const dragBefore = requests.filter(request => request.channel === 'window-drag-start').length;
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      await pause(80);
      assert.equal(requests.filter(request => request.channel === 'window-drag-start').length, dragBefore, 'Normal widget clicks do not drag');
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1, modifiers: ['shift'] });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1, modifiers: ['shift'] });
      await pause(80);
      assert.equal(requests.filter(request => request.channel === 'window-drag-start').length, dragBefore, 'Shift in an unfocused hidden renderer must not initiate layout');
      // This fixture deliberately has no native focus. Start the following
      // gesture through the main-process approval bridge, as real focused
      // sessions do (focus/loss is exercised by the source native check).
      await evaluate(win, 'window.api.setLayoutEditing(true)');
      await until(() => evaluate(win, "document.body.classList.contains('layout-editing')"), 'approved packaged layout session');
      await evaluate(win, `window.addEventListener('pointerdown', event => { window.__packagePointer = {
        id: event.pointerId, x: event.screenX, y: event.screenY }; }, {capture:true,once:true});`);
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1, modifiers: ['shift'] });
      await until(() => requests.some(request => request.channel === 'window-drag-start' && request.sender === win.webContents.id), 'Shift drag start');
      // Offscreen native mouse events can report stationary desktop screen
      // coordinates. Keep the trusted, captured pointer and explicitly deliver
      // its screen delta through the packaged renderer's real move handler.
      await evaluate(win, `(() => { const pointer = window.__packagePointer;
        document.querySelector('.timer-widget[data-widget="wiki"]').dispatchEvent(new PointerEvent('pointermove', {
          pointerId:pointer.id, screenX:pointer.x+31, screenY:pointer.y+43, buttons:1,
          button:0, isPrimary:true, shiftKey:true, bubbles:true }));
      })()`);
      await pause(80);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 31, y: point.y + 43, button: 'left', modifiers: ['shift'] });
      await until(() => requests.some(request => request.channel === 'window-drag-end' && request.sender === win.webContents.id), 'Shift drag end');
      const drag = requests.filter(request => request.sender === win.webContents.id && ['window-drag-start', 'window-move-by', 'window-drag-end'].includes(request.channel));
      assert.deepEqual(drag.map(request => [request.channel, ...request.args]), [
        ['window-drag-start', 3, false], ['window-move-by', 31, 43, false], ['window-drag-end', false],
      ]);
      assert.ok(requests.some(request => request.channel === 'layout-editing-request' && request.args[0] === true));
      win.webContents.send('layout-editing', false);
    }
    const outlines = [];
    for (const theme of ['classic', 'high-contrast']) {
      for (const opacity of [100, 0]) {
        state.config.theme = theme;
        state.config.widgetOutlineOpacity = opacity;
        broadcastConfig();
        await until(() => evaluate(win, `document.documentElement.dataset.theme === '${theme}' && config.widgetOutlineOpacity === ${opacity}`), `${id} ${theme} outline ${opacity}`);
        await until(() => evaluate(win, `(() => {
          const color=getComputedStyle(document.querySelector('.timer-widget[data-widget="${id}"]')).borderTopColor;
          const alpha=color.startsWith('rgba')?Number(color.match(/,\\s*([\\d.]+)\\)$/)[1]):1;
          return Math.abs(alpha-${opacity === 0 ? 0 : theme === 'high-contrast' ? 1 : .24})<0.001;
        })()`), `${id} ${theme} painted outline ${opacity}`);
        await until(() => evaluate(win, `(() => {
          const elements = [document.querySelector('.timer-widget[data-widget="${id}"]'), document.querySelector('.wiki-search-bar')].filter(Boolean);
          return elements.every(element => {
            // Flush pending styles before checking this element's transitions.
            getComputedStyle(element).borderTopColor;
            return element.getAnimations().every(animation => !(animation instanceof CSSTransition)
              || (!animation.pending && animation.playState !== 'running'));
          });
        })()`), `${id} ${theme} settled border transitions ${opacity}`);
        const appearance = await evaluate(win, `(() => {
          const card = document.querySelector('.timer-widget[data-widget="${id}"]');
          const color = getComputedStyle(card).borderTopColor;
          const alpha = color.startsWith('rgba') ? Number(color.match(/,\\s*([\\d.]+)\\)$/)[1]) : 1;
          return {theme:'${theme}',opacity:${opacity},color,alpha,
            control: document.querySelector('#wiki-search-input')?.closest('.wiki-search-bar') && getComputedStyle(document.querySelector('.wiki-search-bar')).borderTopColor};
        })()`);
        assert.equal(appearance.alpha > 0, opacity === 100, `${id} ${theme} outline opacity`);
        // Chromium can serialize an opaque transition endpoint as either rgb
        // or rgba with alpha 1. Both represent the same painted control border.
        const opaqueColor = color => color?.replace(/^rgba\((.*),\s*1\)$/, 'rgb($1)');
        if (opacity === 0) assert.equal(opaqueColor(appearance.control), opaqueColor(outlines.at(-1)?.control), 'Control borders retain their theme contrast');
        outlines.push(appearance);
      }
    }
    win.webContents.send('layout-editing', true);
    await until(() => evaluate(win, "document.body.classList.contains('layout-editing')"), id + ' editing guide');
    assert.equal(await evaluate(win, `getComputedStyle(document.querySelector('.timer-widget[data-widget="${id}"]')).outlineStyle`), 'solid', 'Shift editing still outlines invisible cards');
    win.webContents.send('layout-editing', false);
    state.config.theme = 'classic';
    state.config.widgetOutlineOpacity = 100;
    broadcastConfig();
    await capture(win, id + '-widget');
    widgets.push({ id, content, outlines });
    win.destroy();
  }
  checks.push('title-free widget content, outline 100/0 in classic/high contrast, retained boss timers/wiki search, normal clicks and Shift drag preload requests');

  const grid = makeWindow(960, 720, false);
  await grid.loadFile(path.join(archive, 'src/renderer/layout-grid.html'));
  const scrim = await evaluate(grid, `(() => { const style = getComputedStyle(document.body); return {
    color: style.backgroundColor, image: style.backgroundImage, size: style.backgroundSize, pointerEvents: style.pointerEvents,
    guidance: document.querySelector('.layout-guide').textContent }; })()`);
  assert.ok(scrim.size.split(',').every(size => size.trim() === '24px 24px'), 'Each grid gradient repeats at 24 DIP');
  assert.match(scrim.image, /linear-gradient/);
  assert.match(scrim.color, /0\.48\)/);
  assert.equal(scrim.pointerEvents, 'none');
  assert.match(scrim.guidance, /Release Shift to align/);
  await capture(grid, 'layout-grid');
  grid.destroy();
  checks.push('24 DIP alignment grid with dark scrim and release-to-align/redock guidance');

  const tutorial = makeWindow(480, 520);
  await tutorial.loadFile(path.join(archive, 'src/renderer/tutorial.html'), { query: { tour: 'app' } });
  await until(() => evaluate(tutorial, "typeof OverkotTutorials === 'object' && document.getElementById('tutorial-progress').textContent === '1 / 6' && !document.getElementById('tutorial-next').disabled"), 'packaged tutorial catalogue and first step');
  await capture(tutorial, 'app-tutorial');
  await evaluate(tutorial, "document.getElementById('tutorial-next').click()");
  assert.equal(await evaluate(tutorial, "document.getElementById('tutorial-progress').textContent"), '2 / 6');
  assert.match(await evaluate(tutorial, "document.getElementById('tutorial-body').textContent"), /Ctrl\s*\+\s*F3/, 'The packaged tour uses the configured focus shortcut');
  const tutorialFit = await evaluate(tutorial, `({ horizontal: document.documentElement.scrollWidth <= innerWidth,
    navigation: [...document.querySelectorAll('.tutorial-navigation button')].every(button => {
      const rect = button.getBoundingClientRect(); return rect.right <= innerWidth && rect.bottom <= innerHeight;
    }), widgetSteps: OverkotTutorials.getTutorial('clock', config).steps.length })`);
  assert.deepEqual(tutorialFit, { horizontal: true, navigation: true, widgetSteps: 3 });
  await evaluate(tutorial, "document.getElementById('tutorial-back').click(); document.getElementById('tutorial-skip').click()");
  await until(() => completedTutorials.includes('app') && requests.some(request => request.channel === 'window-close' && request.sender === tutorial.webContents.id), 'packaged tutorial completion and close bridge');
  tutorial.destroy();
  checks.push('packaged shared tutorial catalogue, configured chord, Next/Back, reachable navigation and completion/close preload bridge');

  const reminder = makeWindow(330, 110, 'src/renderer/focus-reminder-preload.js', { transparent: true, backgroundColor: '#00000000' });
  reminder.setIgnoreMouseEvents(true);
  await reminder.loadFile(path.join(archive, 'src/renderer/focus-reminder.html'));
  reminder.webContents.send('focus-reminder:state', { edge: 'bottom', arrowOffset: 28, hotkey: 'Alt+F1', warning: '' });
  await until(() => evaluate(reminder, "document.getElementById('focus-hotkey').textContent === 'Alt + F1'"), 'packaged reminder isolated preload');
  const reminderState = await evaluate(reminder, `({ apiKeys: Object.keys(window.focusReminder), appApi: typeof window.api,
    mouse: getComputedStyle(document.body).pointerEvents, message: document.getElementById('focus-message').textContent,
    overflow: [document.body.scrollWidth > innerWidth, document.body.scrollHeight > innerHeight] })`);
  assert.deepEqual(reminderState.apiKeys, ['onState']);
  assert.equal(reminderState.appApi, 'undefined', 'The reminder does not expose application mutation IPC');
  assert.equal(reminderState.mouse, 'none');
  assert.equal(reminder.isFocusable(), false);
  assert.match(reminderState.message, /Alt \+ F1 to focus/);
  assert.deepEqual(reminderState.overflow, [false, false]);
  await capture(reminder, 'focus-reminder');
  reminder.destroy();
  checks.push('packaged focus reminder receives its configured chord through a minimal preload, fits and remains passive');
  assert.deepEqual(errors, [], 'Packaged renderers finish without console, preload or document-load errors');
  const summary = { ok: true, version: packageInfo.version, archive, checks, edges, widgets, scrim, tutorialFit, reminderState, screenshots, output: out };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  app.exit(0);
}).catch(error => {
  console.error(error.stack);
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  app.exit(1);
});
setTimeout(() => { console.error('Packaged edge dock smoke timed out'); app.exit(2); }, 45000).unref();
