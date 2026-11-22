'use strict';

// Exercise the real Settings preview IPC and the actual floating renderers.
// No account data or personal profile is used by the parent smoke fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function checkOpacity({ settings, main, evaluate, until, state, checks, BrowserWindow, out }) {
  console.log('[opacity-check] Checking independent background and elements controls');
  const current = async () => (await state(main)).config;
  const original = await current();
  const ids = ['clock', 'weather', 'minimap'];
  const windows = {};
  const set = async (key, value) => evaluate(settings, `(() => {
    const control=document.getElementById('appearance-'+${JSON.stringify(key)});
    if(!control) throw new Error('Missing opacity control: '+${JSON.stringify(key)});
    const section=control.closest('details');if(section)section.open=true;
    control.value=${JSON.stringify(String(value))};
    control.dispatchEvent(new Event(control.type==='range'?'input':'change',{bubbles:true}));
  })()`);
  const press = async id => {
    await until(()=>evaluate(settings,"document.getElementById('appearance-editor').getAttribute('aria-busy')!=='true'"),'opacity editor ready');
    await evaluate(settings,`document.getElementById(${JSON.stringify(id)}).click()`);
    await until(()=>evaluate(settings,"document.getElementById('appearance-editor').getAttribute('aria-busy')!=='true'"),'opacity editor operation completes');
  };
  const sample = win => evaluate(win, `(() => {
    const card=document.querySelector('.timer-widget[data-widget="'+new URLSearchParams(location.search).get('widget')+'"]');
    const css=node=>getComputedStyle(node);
    const channel=(selector,property)=>{const node=card.querySelector(selector);return node?css(node)[property]:null;};
    const ancestry=[];for(let node=card;node;node=node.parentElement)ancestry.push(css(node).opacity);
    return {background:css(card).backgroundColor,cardOpacity:css(card).opacity,ancestry,
      elements:css(card).getPropertyValue('--elements-opacity').trim(),
      text:channel('.clock-countdown','fill'),sun:channel('.clock-sun','color'),
      weatherSun:channel('.weather-sun','fill'),weatherCloud:channel('.weather-cloud','fill'),
      canvas:channel('canvas','opacity'),inner:channel('.minimap-viewport','backgroundColor')};
  })()`);
  function alpha(color) {
    assert.equal(typeof color,'string');
    const canvasMatch=color.match(/\/\s*([.\d]+)\s*\)$/);
    if(canvasMatch)return Number(canvasMatch[1]);
    if(color.startsWith('rgba('))return Number(color.split(',').at(-1).replace(')',''));
    if(color.startsWith('color('))return 1;
    assert.match(color,/^rgb\(/,'a computed RGB colour is available');return 1;
  }
  const captures=[];
  const snapshots=[];
  async function checkpoint(name, background, elements) {
    await set('backgroundOpacity',background);await set('elementOpacity',elements);
    await until(async()=>{
      const config=await current();
      return config.appearance.global.backgroundOpacity===background && config.appearance.global.elementOpacity===elements;
    },name+': live Settings preview reaches main');
    const samples={};
    for(const id of ids){
      await until(async()=>{
        const value=await sample(windows[id]);return Number(value.elements)===elements/100 && alpha(value.background)===background/100;
      },name+': '+id+' receives both channels');
      const value=samples[id]=await sample(windows[id]);
      assert.ok(value.ancestry.every(opacity=>Number(opacity)===1),name+': '+id+' never fades a panel or ancestor');
      if(id==='clock'){
        assert.equal(alpha(value.text),elements/100,name+': SVG text receives Elements once');
        assert.equal(alpha(value.sun),elements/100,name+': clock artwork receives Elements once');
      }
      if(id==='weather'){
        assert.equal(alpha(value.weatherSun),elements/100,name+': weather sun receives Elements once');
        assert.equal(alpha(value.weatherCloud),elements/100,name+': weather cloud receives Elements once');
      }
      if(id==='minimap'){
        assert.equal(Number(value.canvas),elements/100,name+': actual map canvas follows Elements');
        assert.equal(alpha(value.inner),1,name+': map background remains independently opaque');
      }
      if(id!=='minimap'){
        const filename=path.join(out,`opacity-${name}-${id}.png`);
        fs.writeFileSync(filename,(await windows[id].webContents.capturePage()).toPNG());captures.push(filename);
      }
    }
    snapshots.push({name,background,elements,samples});
  }
  try {
    const visible={...original.widgetVisibility};for(const id of ids)visible[id]=true;
    await evaluate(main,`window.api.saveConfig({widgetVisibility:${JSON.stringify(visible)}})`);
    for(const id of ids){
      if(!(await current()).widgetOpen?.[id])await evaluate(main,`window.api.toggleDockWidget(${JSON.stringify(id)})`);
      windows[id]=await until(()=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes('widget-host.html?widget='+id)),id+' opacity window');
      await until(()=>evaluate(windows[id],`!!document.querySelector(${JSON.stringify(id==='clock'?'.clock-countdown':id==='weather'?'.weather-sun':'#minimap-canvas')})`),id+' artwork mounted');
    }
    await set('scope','');
    await evaluate(settings,"document.querySelector('[data-builtin=classic]').click()");
    await until(()=>evaluate(settings,"document.getElementById('appearance-backgroundOpacity').value==='100'"),'Classic preset is fully opaque');
    for(const id of ids){await set('scope',id);await press('appearance-reset-scope');}
    await set('scope','');
    await set('motionLevel','off');await set('surfaceOpacity',100);await set('textOpacity',100);await set('barOpacity',100);
    await checkpoint('opaque',100,100);
    await checkpoint('clear-background',0,100);
    await checkpoint('hidden-elements',100,0);
    const recovery=await evaluate(settings,`(() => {
      const nodes=['#appearance-scope','#appearance-elementOpacity','#appearance-cancel','#tab-appearance',
        'label[for="appearance-elementOpacity"]','.appearance-group[data-section="transparency"] summary strong',
        '#settings-title','.settings-panel-header h1'].map(selector=>document.querySelector(selector));
      return nodes.map(node=>({color:getComputedStyle(node).color,opacity:getComputedStyle(node).opacity,disabled:node.disabled}));
    })()`);
    for(const value of recovery){assert.equal(alpha(value.color),1,'Settings recovery labels, headings and controls keep opaque text at Elements0');assert.notEqual(value.disabled,true);}
    const chrome=await evaluate(settings,`(() => {
      const stroke=selector=>getComputedStyle(document.querySelector(selector)).stroke;
      return {close:stroke('#close-btn [data-icon-layer="primary"] path'),
        sidebar:stroke('#tab-appearance [data-icon-layer="primary"] path'),
        preview:getComputedStyle(document.querySelector('#appearance-preview-card .timer-name')).color};
    })()`);
    assert.equal(alpha(chrome.close),1,'Settings close icon remains visible at Elements0');
    assert.equal(alpha(chrome.sidebar),1,'Settings sidebar icon remains visible at Elements0');
    assert.equal(alpha(chrome.preview),0,'Settings sample retains actual zero Elements while editor chrome recovers');
    await evaluate(settings,"(async()=>{document.getElementById('appearance-elementOpacity').scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()");
    fs.writeFileSync(path.join(out,'opacity-zero-elements-settings.png'),(await settings.webContents.capturePage()).toPNG());
    await checkpoint('half-elements',100,50);

    await set('scope','clock');await set('elementOpacity',25);
    await until(async()=>Number((await sample(windows.clock)).elements)===.25,'per-widget element opacity reaches clock');
    assert.equal(alpha((await sample(windows.clock)).text),.25,'per-widget Elements receives one multiplier');
    assert.equal(Number((await sample(windows.weather)).elements),.5,'neighbouring widget retains global Elements');
    assert.equal(alpha((await sample(windows.clock)).background),1,'per-widget Elements leaves background opaque');
    await press('appearance-reset-scope');
    await until(async()=>Number((await sample(windows.clock)).elements)===.5,'per-widget reset inherits global Elements');
    await set('scope','');await set('surfaceOpacity',0);
    await until(async()=>alpha((await sample(windows.minimap)).inner)===0,'inner surface opacity clears map viewport independently');
    assert.equal(alpha((await sample(windows.minimap)).background),1,'inner surface opacity leaves outer panel opaque');
    fs.writeFileSync(path.join(out,'opacity-summary.json'),JSON.stringify({snapshots,recovery,chrome,captures},null,2));
    checks.push('Classic starts at 100%; real Clock, Weather and Minimap keep backgrounds and elements independent at 0/50/100% without double fading');
    checks.push('per-widget Elements override/reset inherits correctly, inner surfaces remain separate, and Settings recovery controls stay readable at Elements0');
  } finally {
    await set('scope','');await press('appearance-cancel');
    await until(async()=>JSON.stringify((await current()).appearance)===JSON.stringify(original.appearance),'opacity preview cancels to applied style');
    for(const id of ids){
      if(Boolean((await current()).widgetOpen?.[id])!==Boolean(original.widgetOpen?.[id]))await evaluate(main,`window.api.toggleDockWidget(${JSON.stringify(id)})`);
    }
    await evaluate(main,`window.api.saveConfig({widgetVisibility:${JSON.stringify(original.widgetVisibility)}})`);
    settings.show();settings.focus();
  }
  console.log('[opacity-check] All independent opacity assertions passed');
}

module.exports={checkOpacity};
