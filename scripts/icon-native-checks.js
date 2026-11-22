'use strict';

const assert = require('node:assert/strict');

/** Verify actual SVG strokes and CSS animation timelines, not just preferences. */
async function checkAnimatedIcons({ settings, main, evaluate, until, capturePaint, checks, BrowserWindow }) {
  const current = async () => (await evaluate(main, 'window.api.getState()')).config.appearance;
  const original = await current();
  const set = async (id, value) => evaluate(settings, `(() => {
    const input = document.getElementById(${JSON.stringify('appearance-' + id)});
    const group = input.closest('details'); if (group) group.open = true;
    if (input.type === 'checkbox') input.checked = ${JSON.stringify(value)};
    else input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event(['color', 'range', 'number'].includes(input.type) ? 'input' : 'change', { bubbles: true }));
  })()`);
  const sample = target => evaluate(target, `(() => {
    const svg = document.querySelector('${target === main ? '#settings-btn' : '#appearance-icon-preview'} svg.overkot-icon');
    if (!svg) return null;
    return { strokes: Object.fromEntries([...svg.querySelectorAll('[data-icon-layer]')].map(path => [path.dataset.iconLayer, getComputedStyle(path).stroke])),
      animations: svg.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').map(animation => ({time: animation.currentTime, name: animation.animationName})) };
  })()`);
  await until(() => evaluate(settings, "!!document.getElementById('appearance-iconMotion')"), 'icon appearance controls');
  const names = await evaluate(settings, "[...document.querySelectorAll('.appearance-preset-card strong')].map(node => node.textContent)");
  assert.deepEqual(names, ['Classic', 'Spirit', 'Grace', 'Courage', 'High Contrast']);
  assert.equal(await evaluate(settings, "document.querySelectorAll('[style*=\"--preset-accent\"]').length"), 0, 'style cards have no individual coloured border');

  await set('scope', '');
  await set('motionLevel', 'standard');
  await set('motionSpeed', 100);
  await set('textOpacity', 100);
  await set('respectReducedMotion', false);
  await set('iconPalette', 'custom');
  await set('iconPrimaryColor', '#f2766b');
  await set('iconSecondaryColor', '#67d2c8');
  await set('iconDetailColor', '#ffe098');
  await set('iconSpeed', 125);
  await set('iconMotion', 'loop');
  await until(async () => (await current()).global.iconMotion === 'loop' && (await sample(main))?.animations.length > 0, 'live control icon loops');
  const expectedColours = { primary: 'rgb(242, 118, 107)', secondary: 'rgb(103, 210, 200)', detail: 'rgb(255, 224, 152)' };
  for (const [channel, colour] of Object.entries((await sample(main)).strokes)) assert.equal(colour, expectedColours[channel], channel);
  const previewColours = await evaluate(settings, `Object.fromEntries([...document.querySelectorAll('#appearance-icon-preview [data-icon-layer]')].map(part => [part.dataset.iconLayer, getComputedStyle(part).stroke]))`);
  assert.deepEqual(previewColours, expectedColours, 'Each available colour belongs to an authored component across the preview, without forcing every icon to use all three');
  const first = await sample(main);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.notDeepEqual((await sample(main)).animations.map(row => row.time), first.animations.map(row => row.time), 'native icon animation timelines advance');
  await evaluate(settings, "document.getElementById('appearance-icon-preview').scrollIntoView({block:'center'})");
  await evaluate(settings, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await capturePaint(settings, 'appearance-animated-icons');

  // Picker labels have a larger target than the glyph. Both the label text
  // and keyboard focus must activate the icon's own scoped hover treatment.
  await set('iconMotion', 'hover');
  settings.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  settings.webContents.debugger.attach('1.3');
  try {
    await settings.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const focus = await evaluate(settings, `(async()=>{
      const blank=document.createElement('div');blank.tabIndex=-1;document.body.append(blank);
      const first=document.querySelector('#tab-appearance'),second=document.querySelector('#tab-updates');
      const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const sample=()=>[first,second].map(button=>button.querySelector('svg').getAnimations({subtree:true}).length);
      try {blank.focus();await settle();const content=sample();first.focus();await settle();return{content,control:sample()};}
      finally{blank.remove();}
    })()`);
    assert.deepEqual(focus.content, [0, 0], 'focus on ordinary content must not animate unrelated action icons');
    assert.equal(focus.control[0] > 0, true, 'focused action animates');
    assert.equal(focus.control[1], 0, 'neighbouring action stays still');
  } finally {
    await settings.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    settings.webContents.debugger.detach();
  }
  await evaluate(settings, 'window.api.openWidgets()');
  const picker = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('widgets-window.html')), 'picker for hover review');
  await until(() => evaluate(picker, "document.querySelector('.widget-card[data-widget=resources]')?.dataset.iconMotion === 'hover'"), 'scoped picker icon preferences');
  const position = await evaluate(picker, `(()=>{
    const card=document.querySelector('.widget-card[data-widget=resources]');card.scrollIntoView({block:'center'});
    const rect=card.getBoundingClientRect();return{x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
  })()`);
  picker.webContents.sendInputEvent({ type: 'mouseMove', ...position });
  const pickerAnimating = () => evaluate(picker, "document.querySelector('.widget-card[data-widget=resources] svg').getAnimations({subtree:true}).some(animation=>animation.playState==='running')");
  await until(pickerAnimating, 'hovering picker text animates the icon');
  const hoverTiming = await evaluate(picker, `(()=>{
    const svg=document.querySelector('.widget-card[data-widget=resources] svg');
    return{duration:svg.getAnimations({subtree:true})[0].effect.getTiming().duration,
      configured:parseFloat(getComputedStyle(svg).getPropertyValue('--icon-duration'))};
  })()`);
  assert.equal(hoverTiming.duration, hoverTiming.configured, 'hover uses the responsive configured duration without the long Loop rest');
  picker.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  await evaluate(picker, "document.querySelector('.widget-card[data-widget=resources] input').focus()");
  await until(pickerAnimating, 'keyboard focus animates the picker icon');
  await set('iconMotion', 'loop');
  await until(() => evaluate(picker, "document.querySelector('.widget-card[data-widget=resources]')?.dataset.iconMotion === 'loop'"), 'picker changes to Loop');
  const loopDuration = await evaluate(picker, "document.querySelector('.widget-card[data-widget=resources] svg').getAnimations({subtree:true})[0].effect.getTiming().duration");
  assert.ok(loopDuration > hoverTiming.duration * 2, 'Loop keeps a longer cycle and resting phase');
  picker.close(); settings.show(); settings.focus();

  await set('iconMotion', 'off');
  await until(async () => (await sample(main))?.animations.length === 0 && (await sample(settings))?.animations.length === 0, 'icon Off stops actual paths');
  await set('iconMotion', 'loop');
  await set('motionLevel', 'off');
  await until(async () => (await sample(main))?.animations.length === 0, 'global Motion Off stops icon loops');
  await set('motionLevel', 'standard');
  await set('respectReducedMotion', true);
  settings.webContents.debugger.attach('1.3');
  try {
    await settings.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await until(async () => (await sample(settings))?.animations.length === 0, 'system reduced motion stops preview paths');
    await set('respectReducedMotion', false);
    await until(async () => (await sample(settings))?.animations.length > 0, 'explicit reduced-motion opt-out resumes paths');
  } finally {
    await settings.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    settings.webContents.debugger.detach();
  }
  await set('motionLevel', original.global.motionLevel || 'standard');
  await set('motionSpeed', original.global.motionSpeed || 100);
  await set('textOpacity', original.global.textOpacity ?? 100);
  await set('respectReducedMotion', original.global.respectReducedMotion !== false);
  await evaluate(settings, "document.getElementById('appearance-apply').click()");
  await until(() => evaluate(settings, "document.getElementById('appearance-editor').getAttribute('aria-busy') !== 'true'"), 'icon settings Apply completes');
  const persisted = await current();
  assert.equal(persisted.global.iconPalette, 'custom');
  assert.equal(persisted.global.iconMotion, 'loop');
  assert.equal(persisted.global.iconPrimaryColor, '#f2766b');
  checks.push('editable icon colours reach their semantic SVG components without forced extra layers; native motion advances and icon/global Off and reduced motion stop it');
  checks.push('picker icon animation responds to the whole label hit area and keyboard focus');
  checks.push('Hover animates only the focused action; ordinary content and neighbouring controls remain still');
  checks.push('Classic/Spirit/Grace/Courage/High Contrast retain stable choices and icon preferences persist through Appearance Apply');
  return persisted;
}

module.exports = { checkAnimatedIcons };
