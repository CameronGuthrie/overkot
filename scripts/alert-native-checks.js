'use strict';

// Run inside check-settings.js: actual main, preload and alert renderers, with
// isolated configuration. Real Windows mouse input tests native hit regions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkAlerts({ main, evaluate, until, state, foreground, BrowserWindow, out, checks }) {
  const { screen } = require('electron');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const area = screen.getPrimaryDisplay().workArea;
  const mouse = await require('./windows-native-mouse').createNativeMouse();
  const game = new BrowserWindow({ show: false, frame: false,
    x: area.x + area.width - 720, y: area.y + area.height - 450, width: 700, height: 420,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const alerts = () => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().split('?')[0].endsWith('/alert-window.html'));
  const progress = win => evaluate(win, `(() => {
    const fill=document.getElementById('progress-fill');
    return {at:performance.now(),scale:new DOMMatrixReadOnly(getComputedStyle(fill).transform).a,
      region:getComputedStyle(document.body).webkitAppRegion};
  })()`);
  const snapshots = [];
  async function open(name) {
    const existing = new Set(alerts());
    await evaluate(main, `window.api.showAlert({name:${JSON.stringify(name)},readyLabel:'Ready'})`);
    const alert = await until(() => alerts().find(win => !existing.has(win)), 'native '+name+' alert created');
    await until(async () => alert.isVisible() && !alert.webContents.isLoading()
      && await evaluate(alert, `document.getElementById('alert-name').textContent===${JSON.stringify(name)}`), name+' alert visible and initialized');
    assert.equal(alert.isFocusable(), false, 'Alerts stay nonactivating');
    assert.equal(game.isFocused(), true, 'Showing an alert preserves game focus');
    return alert;
  }
  try {
    await game.loadURL('about:blank');
    await evaluate(game, `document.body.style.cssText='background:#18221c;color:#d5e1da;font:18px Segoe UI;padding:30px';document.body.textContent='Isolated alert input fixture — this window retains keyboard focus.'`);
    game.show(); game.focus();
    await until(() => game.isFocused(), 'isolated game fixture acquires native focus');
    foreground(process.pid + 100000);
    await evaluate(main, 'window.api.saveConfig({enableAlertPopup:true,showAlertsWhenHidden:false,clickThrough:true})');
    await until(async () => !(await state(main)).overlayInteractive && !main.isFocusable(), 'overlay remains passive during alert clicks');

    const first = await open('First alert'), second = await open('Second alert');
    const firstBounds = first.getBounds(), secondBounds = second.getBounds();
    assert.ok(secondBounds.y < firstBounds.y, 'Two alerts stack above one another');
    assert.equal((await progress(first)).region, 'no-drag', 'The animated alert is not a native caption drag region');
    await pause(450); // Finish the entrance before exercising the native X.
    fs.writeFileSync(path.join(out,'alerts-stacked.png'),(await second.webContents.capturePage()).toPNG());
    const clickedAt = Date.now();
    await mouse.click(first, 'alert-close');
    await until(() => first.isDestroyed(), 'physical close click destroys first alert', 1500);
    assert.ok(Date.now() - clickedAt < 500, 'X closes immediately without waiting for an exit animation');
    await until(() => second.getBounds().y === firstBounds.y, 'Remaining alert closes the stack gap');
    assert.equal(game.isFocused(), true, 'Physical X does not activate Overkot or steal game focus');
    await mouse.click(second, 'alert-close');
    await until(() => second.isDestroyed(), 'physical close click destroys second alert', 1500);
    checks.push('real Windows X clicks dismiss passive alerts immediately, preserve game focus and re-stack the remaining popup');

    const startedAt = Date.now(), timed = await open('Eight second alert');
    const samples=[];
    for(let i=0;i<25;i++){samples.push(await progress(timed));await pause(25);}
    const changed=samples.slice(1).filter((sample,index)=>sample.scale<samples[index].scale-0.00001);
    assert.ok(changed.length>=18,'Countdown advances every frame rather than jumping once per second');
    assert.ok(samples.every(sample=>sample.scale>0 && sample.scale<=1),'Progress remains bounded');
    assert.ok(samples[0].scale-samples.at(-1).scale<.16,'Countdown follows elapsed time without a fast jump');
    await evaluate(timed, `OverkotTheme.apply({appearance:{version:1,base:'classic',global:{motionLevel:'off',motionSpeed:200},widgets:{}}})`);
    const offBefore=await progress(timed);await pause(150);const offAfter=await progress(timed);
    assert.ok(offAfter.scale<offBefore.scale,'Functional countdown remains truthful with decorative motion disabled');
    fs.writeFileSync(path.join(out,'alert-countdown.png'),(await timed.webContents.capturePage()).toPNG());
    await until(()=>timed.isDestroyed(),'Alert expires automatically after eight seconds',10000);
    const elapsed=Date.now()-startedAt;
    assert.ok(elapsed>=7800&&elapsed<9500,'Motion settings do not alter the eight-second lifetime: '+elapsed);
    assert.equal(game.isFocused(),true,'Automatic expiry preserves game focus');
    snapshots.push({samples,changedFrames:changed.length,offBefore,offAfter,lifetimeMs:elapsed});
    checks.push('native countdown paints smooth transform steps and expires after eight seconds regardless of decorative motion/speed settings');
    fs.writeFileSync(path.join(out,'alerts-summary.json'),JSON.stringify({ok:true,snapshots},null,2));
  } finally {
    for(const alert of alerts())if(!alert.isDestroyed())alert.destroy();
    if(!game.isDestroyed())game.destroy();
    await mouse.close();
  }
}

module.exports={checkAlerts};
