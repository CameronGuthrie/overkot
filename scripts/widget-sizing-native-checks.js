'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Real Settings controls, native geometry, fitting and pointer capture. */
async function checkWidgetSizing({ settings, main, evaluate, until, click, state, capturePaint, checks, BrowserWindow, foreground, out }) {
  const original = (await state(main)).config;
  const current = async () => (await state(main)).config;
  const panel = id => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('widget-host.html?widget=' + id));
  const control = (id, value) => evaluate(settings, `(()=>{
    const input=document.getElementById(${JSON.stringify(id)});
    if(input.type==='checkbox')input.checked=${JSON.stringify(value)};else input.value=${JSON.stringify(String(value))};
    input.dispatchEvent(new Event(input.type==='number'?'input':'change',{bubbles:true}));
  })()`);
  const choose = id => control('widget-size-select', id);
  const size = async (id, width, height) => {
    await choose(id);
    await control('widget-size-auto-width', width === null);
    await control('widget-size-auto-height', height === null);
    if(width !== null)await control('widget-size-width', width);
    if(height !== null)await control('widget-size-height', height);
    await evaluate(settings, "document.getElementById('widget-size-form').requestSubmit()");
    await until(async()=>{
      const saved=(await current()).widgetSizes?.[id];
      return width===null&&height===null?!saved:saved?.width===width&&saved?.height===height;
    }, 'exact size for ' + id);
    await until(()=>evaluate(settings,"document.getElementById('widget-sizing').getAttribute('aria-busy')==='false'"),'size Apply finishes');
  };
  await click(settings, 'tab-widgets');
  await until(()=>evaluate(settings,"document.getElementById('widget-size-select').options.length>10"),'sizing controls ready');
  const ids=await evaluate(settings,"[...document.getElementById('widget-size-select').options].map(option=>option.value)");
  assert.ok(ids.includes('resources')&&ids.includes('boss'));
  assert.ok(!ids.includes('daily')&&!ids.includes('market'),'pop-outs keep their own sizing');
  await control('widget-resize-mode','grid');
  await until(async()=>(await current()).widgetResizeMode==='grid','grid preference');

  // Editing a closed widget saves intent without creating a window.
  assert.equal(panel('resources'),undefined);
  await size('resources',437,317);
  assert.equal(panel('resources'),undefined);
  await size('boss',341,145);
  const visibility={...(await current()).widgetVisibility,resources:true};
  await evaluate(main,`window.api.saveConfig({widgetVisibility:${JSON.stringify(visibility)}})`);
  await evaluate(main,"window.api.toggleDockWidget('resources')");
  const resources=await until(()=>panel('resources'),'resized resources opens');
  await until(()=>resources.getBounds().width===437&&resources.getBounds().height===317,'saved exact native geometry');
  await until(()=>evaluate(resources,"document.body.classList.contains('widget-manual-height')"),'fixed-height viewport');
  assert.equal(await evaluate(resources,"getComputedStyle(document.querySelector('.timer-widget[data-widget=resources] .inventory-widget-body')).maxHeight"),'none','fixed-height views can use the full chosen height');
  await evaluate(resources,`(()=>{const box=document.createElement('div');box.id='qa-long-widget';box.style.height='1800px';box.textContent='Long widget content';document.querySelector('.timer-widget[data-widget=resources] .widget-body').append(box);window.api.fitWindowSize(900,1800)})()`);
  await evaluate(resources,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(resources.getBounds().width,437);
  assert.equal(resources.getBounds().height,317,'content fitting cannot replace explicit height');
  const scrolling=await evaluate(resources,"(()=>{const body=document.querySelector('.timer-widget[data-widget=resources] .widget-body');return{overflow:getComputedStyle(body).overflowY,scroll:body.scrollHeight,client:body.clientHeight,viewport:innerHeight,body:document.body.scrollHeight,injected:document.getElementById('qa-long-widget')?.offsetHeight,card:body.parentElement.getBoundingClientRect().height}})()");
  fs.writeFileSync(path.join(out,'widget-fixed-height-content.png'),(await resources.webContents.capturePage()).toPNG());
  assert.equal(scrolling.overflow,'auto');assert.ok(scrolling.scroll>scrolling.client,JSON.stringify(scrolling));assert.ok(scrolling.body<=scrolling.viewport+1,JSON.stringify(scrolling));
  await evaluate(resources,"document.getElementById('qa-long-widget').remove()");

  // Use Chromium mouse input and real pointer capture for both resize modes.
  settings.hide();main.show();main.focus();foreground(process.pid);
  const gesture=async(dx,dy,precise,endByShift=false)=>{
    main.focus();foreground(process.pid);
    await evaluate(main,'window.api.setLayoutEditing(true)');
    await until(()=>evaluate(resources,"document.body.classList.contains('layout-editing')"),'native Shift layout mode');
    const before={...resources.getBounds()};
    const savedBefore=(await current()).widgetSizes.resources;
    const point=await evaluate(resources,"(()=>{const r=document.getElementById('resize-handle').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    const modifiers=precise?['shift','alt']:['shift'];
    resources.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point,globalX:before.x+point.x,globalY:before.y+point.y,modifiers});
    await until(()=>evaluate(resources,"!document.getElementById('widget-size-readout').hidden"),'corner captures pointer');
    resources.webContents.sendInputEvent({type:'mouseMove',x:point.x+dx,y:point.y+dy,globalX:before.x+point.x+dx,globalY:before.y+point.y+dy,modifiers:[...modifiers,'leftButtonDown']});
    await until(()=>resources.getBounds().width!==before.width||resources.getBounds().height!==before.height,'resize preview changes native bounds');
    const preview=resources.getBounds();
    assert.deepEqual((await current()).widgetSizes.resources,savedBefore,'pointer previews do not persist size choices before release');
    if(endByShift)await evaluate(main,'window.api.setLayoutEditing(false)');
    resources.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x+dx,y:point.y+dy,globalX:before.x+point.x+dx,globalY:before.y+point.y+dy,modifiers:endByShift?[]:modifiers});
    await until(async()=>{const saved=(await current()).widgetSizes.resources;return saved.width===preview.width&&saved.height===preview.height},'gesture commits size intent');
    await evaluate(main,'window.api.setLayoutEditing(false)');
    return{before,after:resources.getBounds()};
  };
  const fine=await gesture(9,5,true,true);
  assert.equal(fine.after.width,fine.before.width+9);assert.equal(fine.after.height,fine.before.height+5);
  const grid=await gesture(34,38,false);
  assert.equal(grid.after.width%24,0);assert.equal(grid.after.height%24,0);

  settings.show();settings.focus();foreground(process.pid);
  await choose('resources');
  await click(settings,'widget-size-reset');
  await until(async()=>!(await current()).widgetSizes.resources,'per-widget reset clears size intent');
  assert.deepEqual((await current()).widgetSizes.boss,{width:341,height:145},'another closed widget retains its size');
  await until(()=>evaluate(resources,"!document.body.classList.contains('widget-manual-height')"),'reset restores natural content height');
  assert.notEqual(await evaluate(resources,"getComputedStyle(document.querySelector('.timer-widget[data-widget=resources] .inventory-widget-body')).maxHeight"),'none','Auto mode restores the compact-list limit');
  await until(()=>resources.getBounds().height<317,'Auto height fits the short card again');
  await until(()=>evaluate(settings,`document.getElementById('widget-size-current').textContent.includes('410 × ${resources.getBounds().height}')`),'Settings readout follows the final Auto height');
  const widthBefore=settings.getBounds();
  settings.setBounds({...widthBefore,width:560});
  await evaluate(settings,"document.getElementById('widget-sizing').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const narrow=await evaluate(settings,"(()=>{const host=document.getElementById('widget-sizing');return{width:host.clientWidth,scroll:host.scrollWidth}})()");
  assert.ok(narrow.scroll<=narrow.width+1,'exact size controls fit narrow Settings');
  await capturePaint(settings,'widget-sizes-settings-narrow');
  settings.setBounds(widthBefore);
  await evaluate(settings,'window.api.widgetSizesResetAll()');
  for(const [id,value]of Object.entries(original.widgetSizes||{}))await evaluate(settings,`window.api.widgetSizesSet(${JSON.stringify({id,...value})})`);
  await evaluate(settings,`window.api.widgetSizesMode(${JSON.stringify(original.widgetResizeMode||'grid')})`);
  await evaluate(main,`window.api.saveConfig({widgetVisibility:${JSON.stringify(original.widgetVisibility)}})`);
  await evaluate(main,`window.api.saveConfig(${JSON.stringify({widgetOpen:original.widgetOpen,widgetDocked:original.widgetDocked})})`);
  checks.push('closed-widget exact width/height settings restore native geometry; fixed-height content scrolls and cannot be overwritten by autofit');
  checks.push('real corner gestures use Alt 1 px precision or the 24 px grid, persist on release and survive Shift ending first');
  checks.push('per-widget reset preserves other saved sizes, restores content fitting and fits a 560 px Settings window');
}

module.exports={checkWidgetSizing};
