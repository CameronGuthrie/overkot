'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function fixture() {
  const sender = {}, stranger = {}, state = { closes: 0, opens: 0, broadcasts: 0, visible: true, minimized: false, destroyed: false, enabled: true };
  const win = { webContents: sender, isDestroyed: () => state.destroyed,
    isVisible: () => state.visible, isMinimized: () => state.minimized };
  let dismiss;
  const context = vm.createContext({ dailyBriefWindow: win,
    dailyBriefPopout: { close() { state.closes++; context.dailyBriefWindow = null; } },
    ipcMain: { handle(channel, callback) { assert.equal(channel, 'daily-brief:dismiss'); dismiss = callback; } },
    config: { get(key) { assert.equal(key, 'widgetVisibility'); return { daily: state.enabled }; },
      set() { throw new Error('Opening or closing a pop-out must not alter docked widget preferences'); } },
    openDailyBriefWindow() { state.opens++; context.dailyBriefWindow = win; state.minimized = false; state.visible = true; },
    pushDockState() { state.broadcasts++; },
  });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('daily-brief:dismiss'"), source.indexOf("ipcMain.handle('inventory-widget:get'")), context);
  vm.runInContext(source.slice(source.indexOf('function toggleDockWidget('), source.indexOf("ipcMain.handle('dock-toggle-widget'")), context);
  return { state, context, dismiss: () => dismiss({ sender }), other: () => dismiss({ sender: stranger }),
    toggle: () => context.toggleDockWidget('daily'), missing() { context.dailyBriefWindow = null; } };
}

test('Done closes only its own Daily pop-out; stale repeated delivery cannot reopen it', () => {
  const f = fixture(); assert.equal(f.dismiss(), true); assert.equal(f.state.closes, 1);
  assert.equal(f.dismiss(), false); assert.equal(f.state.closes, 1); assert.equal(f.state.opens, 0);
});

test('another renderer, missing window or destroyed Daily pop-out cannot dismiss a current one', () => {
  const f = fixture(); assert.equal(f.other(), false); assert.equal(f.state.closes, 0);
  f.state.destroyed = true; assert.equal(f.dismiss(), false);
  f.missing(); assert.equal(f.dismiss(), false); assert.equal(f.state.closes, 0);
});

test('Daily dock action toggles a pop-out without changing widgetOpen or participating in widget layout', () => {
  const f = fixture();
  assert.equal(f.toggle(), true); assert.equal(f.state.closes, 1);
  assert.equal(f.toggle(), true); assert.equal(f.state.opens, 1);
  assert.equal(f.state.broadcasts, 2);
  f.state.enabled = false; assert.equal(f.toggle(), false); assert.equal(f.state.closes, 1); assert.equal(f.state.opens, 1);
});

test('clicking the Daily launcher restores a minimized or hidden pop-out instead of closing it', () => {
  const minimized = fixture(); minimized.state.minimized = true;
  assert.equal(minimized.toggle(), true); assert.equal(minimized.state.opens, 1); assert.equal(minimized.state.closes, 0);
  const hidden = fixture(); hidden.state.visible = false;
  assert.equal(hidden.toggle(), true); assert.equal(hidden.state.opens, 1); assert.equal(hidden.state.closes, 0);
});

test('automatic login and reset open the separate Daily pop-out without stealing focus', () => {
  let callback, request;
  const context = vm.createContext({ dailyBrief: { on(event, fn) { assert.equal(event, 'open'); callback = fn; } },
    openDailyBriefWindow: options => { request = options; } });
  vm.runInContext(source.slice(source.indexOf("dailyBrief.on('open'"), source.indexOf('async function refreshDailyBrief')), context);
  callback(); assert.equal(request.focus, false);
});

test('the dock reports Daily visibility independently from docked widget-open preferences', () => {
  const state = { visible: true, minimized: false, destroyed: false };
  const context = vm.createContext({ config: { get: (_key, fallback) => fallback }, validEdge: value => value,
    dockAutoHidden: false, layoutEditing: false, redockTarget: false, visibilityShortcutWarning: '', marketWindow: null,
    dailyBriefWindow: { isDestroyed: () => state.destroyed, isVisible: () => state.visible, isMinimized: () => state.minimized } });
  vm.runInContext(source.slice(source.indexOf('function dockState()'), source.indexOf('function pushDockState()')), context);
  assert.equal(context.dockState().dailyOpen, true);
  state.minimized = true; assert.equal(context.dockState().dailyOpen, false);
  state.minimized = false; state.visible = false; assert.equal(context.dockState().dailyOpen, false);
  state.visible = true; state.destroyed = true; assert.equal(context.dockState().dailyOpen, false);
});

test('Daily minimizes independently while the existing overlay minimize action remains available', () => {
  let callback, minimized = 0, hidden = 0;
  const daily = { minimize: () => minimized++ }, other = {};
  const context = vm.createContext({ dailyBriefWindow: daily,
    BrowserWindow: { fromWebContents: sender => sender === 'daily' ? daily : sender === 'other' ? other : null },
    ipcMain: { on(channel, fn) { assert.equal(channel, 'window-minimize'); callback = fn; } },
    setOverlayHidden: value => { assert.equal(value, true); hidden++; } });
  vm.runInContext(source.slice(source.indexOf("ipcMain.on('window-minimize'"), source.indexOf("ipcMain.on('window-close'")), context);
  callback({ sender: 'daily' }); assert.equal(minimized, 1); assert.equal(hidden, 0);
  callback({ sender: 'other' }); assert.equal(hidden, 1);
  callback({ sender: 'missing' }); assert.equal(hidden, 1);
});
