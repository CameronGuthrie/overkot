'use strict';

// Called by check-settings.js with the real application, preload and Settings
// window. Only file chooser paths and game/account services are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Appearance = require('../src/modules/appearance');
const { readEncryptedJSON } = require('../src/modules/fileEncryption');
const { CONFIG_PATH } = require('../src/modules/appPaths');

async function checkAppearance({ settings, main, evaluate, until, click, state, capturePaint, checks, out, dialogs, BrowserWindow, appRoot }) {
  console.log('[appearance-check] Starting real editor IPC checks');
  const current = async () => (await state(main)).config;
  const saved = () => readEncryptedJSON(CONFIG_PATH) || {};
  const savedAppearance = () => Appearance.extract(saved());
  const initial = Appearance.copy(savedAppearance());
  const set = async (id, value) => evaluate(settings, `(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    if (!element) throw new Error('Missing control: '+${JSON.stringify(id)});
    const details = element.closest('details'); if (details) details.open = true;
    if (element.type === 'checkbox') element.checked = ${JSON.stringify(value)};
    else element.value = ${JSON.stringify(String(value))};
    element.dispatchEvent(new Event(['range','color','number','text'].includes(element.type) ? 'input' : 'change', {bubbles:true}));
    return element.value;
  })()`);
  const press = async id => {
    // Exercise the renderer's actual click handler. Native titlebar/focus/tab
    // routing is already checked separately by check-settings.js.
    await until(()=>evaluate(settings,"document.getElementById('appearance-editor').getAttribute('aria-busy') !== 'true'"),'editor ready before '+id);
    await evaluate(settings, `document.getElementById(${JSON.stringify(id)}).click()`);
    await until(()=>evaluate(settings,"document.getElementById('appearance-editor').getAttribute('aria-busy') !== 'true'"),'editor completes '+id);
  };
  const scope = async value => set('appearance-scope', value);
  const globalValue = async (key, value) => until(async () => (await current()).appearance?.global?.[key] === value, 'live global '+key+' = '+value);
  await until(() => evaluate(settings, "!!document.getElementById('appearance-apply') && document.getElementById('appearance-base').options.length > 1"), 'appearance editor initialized');

  await set('appearance-cornerShape','sharp');
  await set('appearance-cornerRadius',0);
  await set('appearance-borderWidth',0);
  await set('appearance-barShape','inherit');
  await globalValue('cornerShape','sharp'); await globalValue('borderWidth',0);
  assert.deepEqual(savedAppearance(), initial, 'preview never writes persisted appearance');

  await evaluate(main, "document.querySelector('.dock-widget-button[data-widget=clock]').click()");
  const clock = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('widget-host.html?widget=clock')), 'native clock window');
  await until(() => evaluate(clock, "!!document.querySelector('.clock-orbit')"), 'actual clock renderer mounted');
  await until(async () => await evaluate(clock, "getComputedStyle(document.querySelector('.timer-widget[data-widget=clock]')).borderTopLeftRadius") === '0px', 'sharp preview reaches native floating widget');
  assert.equal(await evaluate(clock,"getComputedStyle(document.querySelector('.timer-widget[data-widget=clock]')).borderTopWidth"),'0px','zero decorative border reaches actual widget');
  await capturePaint(settings,'appearance-sharp-editor');

  const embedded = new BrowserWindow({show:false,width:520,height:520,frame:false,webPreferences:{
    preload:path.join(appRoot,'src/preload.js'),contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:true,backgroundThrottling:false,
  }});
  // This retained legacy renderer is deliberately not created by current main.
  // Supply only its removed native max-height query; theme IPC stays real.
  const { ipcMain } = require('electron');
  ipcMain.handle('dock-get-max-height', () => 480);
  try {
    await embedded.loadFile(path.join(appRoot,'src/renderer/dock-window.html'));
    embedded.showInactive(); settings.focus();
    await until(() => evaluate(embedded,"!!document.querySelector('iframe[data-widget=clock]')?.contentDocument?.querySelector('.clock-orbit')"),'actual embedded clock mounted');
    await scope('clock');
    await set('appearance-cornerShape','rounded'); await set('appearance-cornerRadius',17); await set('appearance-borderWidth',2);
    await until(async () => (await current()).appearance?.widgets?.clock?.cornerRadius === 17,'explicit widget override previews');
    await until(async () => await evaluate(clock,"getComputedStyle(document.querySelector('.timer-widget[data-widget=clock]')).borderTopLeftRadius") === '17px','native widget override geometry');
    await until(async () => await evaluate(embedded,"getComputedStyle(document.querySelector('iframe[data-widget=clock]').contentDocument.querySelector('.timer-widget[data-widget=clock]')).borderTopLeftRadius") === '17px','override reaches embedded frame');
    assert.deepEqual(savedAppearance(),initial,'widget override preview does not persist');
    await press('appearance-reset-scope');
    await until(async () => !(await current()).appearance?.widgets?.clock,'reset widget returns to inherited values');
    await until(async () => await evaluate(clock,"getComputedStyle(document.querySelector('.timer-widget[data-widget=clock]')).borderTopLeftRadius") === '0px','widget reset restores global sharp geometry');
    await scope('');
    await press('appearance-cancel');
    await until(async () => JSON.stringify(Appearance.extract(await current())) === JSON.stringify(initial),'cancel restores current appearance across windows');
    await until(async () => await evaluate(clock,"getComputedStyle(document.querySelector('.timer-widget[data-widget=clock]')).borderTopLeftRadius") !== '0px','cancel rolls native widget back');
    assert.deepEqual(savedAppearance(),initial);
    checks.push('appearance preview/cancel and zero corner/border values synchronize actual floating and embedded widgets without persistence');
    console.log('[appearance-check] Preview, scope inheritance and cancel passed');

    await set('appearance-cornerRadius',14); await globalValue('cornerRadius',14);
    await press('appearance-undo'); await until(async () => (await current()).appearance?.global?.cornerRadius !== 14,'undo restores preceding draft');
    await press('appearance-redo'); await globalValue('cornerRadius',14);
    await evaluate(settings,"document.querySelector('[data-reset-field=cornerRadius]').click()");
    await until(async () => !Object.hasOwn((await current()).appearance.global,'cornerRadius'),'individual reset removes override');

    // Preserve an independently updated setting while committing appearance.
    const beforeResetPreference = (await current()).dailyAutoReset;
    await evaluate(main,`window.api.saveConfig({dailyAutoReset:${JSON.stringify(!beforeResetPreference)}})`);
    await set('appearance-base','dark-mint');
    await set('appearance-cornerShape','pill'); await set('appearance-cornerRadius',0); await set('appearance-borderWidth',0);
    await set('appearance-motionLevel','off');
    await scope('clock'); await set('appearance-cornerShape','rounded'); await set('appearance-cornerRadius',9); await scope('');
    await set('appearance-name','Native QA preset'); await press('appearance-save-preset');
    await press('appearance-apply');
    await until(()=>savedAppearance().base==='dark-mint' && savedAppearance().global.motionLevel==='off','Apply persists appearance');
    assert.equal(savedAppearance().global.cornerRadius,0); assert.equal(savedAppearance().global.borderWidth,0);
    assert.equal(saved().dailyAutoReset,!beforeResetPreference,'Apply merges with latest unrelated settings');
    await until(()=>saved().appearancePresets?.some(p=>p.name==='Native QA preset'),'named preset library persists');
    await until(async () => await evaluate(clock,"document.documentElement.dataset.motionLevel") === 'off','motion off reaches actual widget');
    assert.equal(await evaluate(settings,"getComputedStyle(document.getElementById('appearance-base')).borderTopLeftRadius"),'0px','explicit radius zero stays sharp for Pill controls');
    assert.equal(await evaluate(settings,"getComputedStyle(document.querySelector('#appearance-preview-card .timer-bar')).borderTopLeftRadius"),'0px','explicit radius zero stays sharp for inherited Pill progress tracks');
    const applied = Appearance.copy(savedAppearance());
    await capturePaint(settings,'appearance-applied-editor');
    checks.push('undo/redo, individual reset, named preset save, motion Off and Apply preserve unrelated concurrent configuration');
    console.log('[appearance-check] Apply, persistence and concurrent config passed');

    await set('appearance-name','Native QA duplicate'); await press('appearance-duplicate-preset');
    await set('appearance-name','Native QA renamed'); await press('appearance-rename-preset'); await press('appearance-apply');
    await until(()=>saved().appearancePresets.some(p=>p.name==='Native QA renamed'),'duplicate and rename persist');
    await press('appearance-delete-preset'); await press('appearance-apply');
    await until(()=>!saved().appearancePresets.some(p=>p.name==='Native QA renamed'),'delete preset persists');

    const exportedPath = path.join(out,'appearance-roundtrip.json'); dialogs.save = exportedPath;
    await set('appearance-name','Shareable QA style'); await press('appearance-export');
    await until(()=>fs.existsSync(exportedPath),'export saves appearance-only JSON');
    const exportedText=fs.readFileSync(exportedPath,'utf8'), exported=JSON.parse(exportedText);
    assert.equal(exported.format,'overkot-appearance'); assert.equal(exported.version,1);
    assert.deepEqual(exported.appearance,applied,'export preserves raw corners, borders, motion and widget overrides');
    assert.deepEqual(Object.keys(exported).sort(),['appearance','format','metadata','name','version']);
    for(const secret of ['nonce','accountId','eeLogPath','screenshotDir','windowBounds','dockAutoHide']) assert.equal(exportedText.includes(`"${secret}"`),false,'export excludes '+secret);

    // Invalid imports must leave both the current preview and disk untouched.
    const invalidPath=path.join(out,'appearance-invalid.json');
    fs.writeFileSync(invalidPath,JSON.stringify({...exported,appearance:{...exported.appearance,global:{cornerRadius:-1}}}));
    dialogs.open=invalidPath; await press('appearance-import');
    await until(()=>evaluate(settings,"document.getElementById('appearance-status').textContent.toLowerCase().includes('corner radius')"),'invalid import explains numeric bounds');
    assert.deepEqual(Appearance.extract(await current()),applied);assert.deepEqual(savedAppearance(),applied);

    // A valid import is summarized before being staged, and staging still
    // requires Apply. A different draft proves it is not an automatic commit.
    await set('appearance-cornerShape','sharp'); await globalValue('cornerShape','sharp');
    dialogs.open=exportedPath; await press('appearance-import');
    await until(()=>evaluate(settings,"!document.getElementById('appearance-import-review').hidden"),'valid import offers summary and preview');
    assert.equal((await current()).appearance.global.cornerShape,'sharp','choosing import does not change draft');
    await press('appearance-import-preview');
    await until(async()=>JSON.stringify(Appearance.extract(await current()))===JSON.stringify(applied),'valid import restores equivalent visual data');
    assert.deepEqual(savedAppearance(),applied,'import preview still leaves persisted data unchanged');
    await press('appearance-apply');
    await until(()=>JSON.stringify(savedAppearance())===JSON.stringify(applied),'roundtrip import applies equivalent appearance');
    await until(()=>saved().appearancePresets.some(p=>p.name===exported.name && JSON.stringify(p.appearance)===JSON.stringify(applied)),'import Apply persists the imported preset name and appearance in the library');
    await capturePaint(settings,'appearance-import-roundtrip');
    checks.push('custom preset duplicate/rename/delete and appearance-only native JSON export/import validation, summary, preview and roundtrip');
    console.log('[appearance-check] Preset CRUD and native file roundtrip passed');

    // Full animation disablement keeps geometry and labels truthful while
    // reducing all running CSS animations to immediate presentation.
    const motion = await evaluate(clock,"({level:document.documentElement.dataset.motionLevel,animations:document.getAnimations().filter(a=>a.playState==='running').length})");
    assert.equal(motion.level,'off');
    assert.equal(motion.animations,0,'Off leaves no running decorative CSS animation');
    await set('appearance-motionLevel','expressive'); await set('appearance-respectReducedMotion',true);
    clock.webContents.debugger.attach('1.3');
    try {
      await clock.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await until(async()=>await evaluate(clock,"matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motionLevel === 'off'"),'system reduced motion suppresses decorative motion');
      await set('appearance-respectReducedMotion',false);
      await until(async()=>await evaluate(clock,"document.documentElement.dataset.motionLevel") === 'expressive','explicit reduced-motion override honors app level');
      await set('appearance-motionLevel','off');
      await until(async()=>await evaluate(clock,"document.documentElement.dataset.motionLevel") === 'off','Off remains disabled with explicit system override');
    } finally {
      await clock.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]}); clock.webContents.debugger.detach();
    }
    await press('appearance-cancel');
    await until(async()=>JSON.stringify(Appearance.extract(await current()))===JSON.stringify(applied),'motion check discards temporary preferences');
    checks.push('motion Off leaves no running CSS animation; emulated system reduced motion and explicit app override follow documented precedence');

    await set('appearance-motionLevel','off');await scope('clock');await set('appearance-motionLevel','standard');
    await until(()=>evaluate(settings,"document.documentElement.dataset.motionLevel==='off' && document.getElementById('appearance-preview-card').dataset.motionLevel==='standard' && getComputedStyle(document.getElementById('appearance-preview-card')).transitionDuration.split(',').some(value=>parseFloat(value)>0)"),'widget motion override escapes global Off scope');
    await scope('');await set('appearance-motionLevel','standard');await scope('clock');await set('appearance-motionLevel','off');
    await until(()=>evaluate(settings,"document.documentElement.dataset.motionLevel==='standard' && document.getElementById('appearance-preview-card').dataset.motionLevel==='off' && getComputedStyle(document.getElementById('appearance-preview-card')).transitionDuration.split(',').every(value=>parseFloat(value)===0)"),'widget Off overrides global standard motion');
    await scope('');await press('appearance-cancel');
    await until(async()=>JSON.stringify(Appearance.extract(await current()))===JSON.stringify(applied),'widget motion scope check discards temporary overrides');
    checks.push('per-widget motion settings override global settings in both directions through scoped CSS');
    console.log('[appearance-check] Reduced motion and per-widget CSS scopes passed');

    await evaluate(settings,"document.querySelector('[data-builtin=obsidian]').click()");
    await globalValue('cornerShape','sharp');
    await until(async()=>await evaluate(clock,"getComputedStyle(document.querySelector('.timer-widget[data-widget=clock]')).borderTopLeftRadius")==='0px','Obsidian builtin previews actual square panel');
    await evaluate(settings,"document.querySelector('[data-builtin=ember]').click()");
    await globalValue('cornerShape','pill');
    await set('appearance-borderWidth',4);await set('appearance-borderColor','#00bbcc');await set('appearance-borderOpacity',50);
    await until(async()=>await evaluate(clock,"getComputedStyle(document.querySelector('.timer-widget[data-widget=clock]')).borderTopWidth")==='4px','thick decorative border previews');
    await evaluate(settings,"document.querySelector('[data-reset-section=corners]').click()");
    await until(async()=>!Object.hasOwn((await current()).appearance.global,'borderWidth'),'section reset removes explicit corner and border values');
    await press('appearance-reset-all');
    await until(async()=>(await current()).appearance.base==='classic' && !Object.keys((await current()).appearance.global).length && !Object.keys((await current()).appearance.widgets).length,'whole appearance reset stages shared defaults');
    await press('appearance-cancel');
    await until(async()=>JSON.stringify(Appearance.extract(await current()))===JSON.stringify(applied),'builtin and reset preview can be canceled');
    await set('appearance-textOpacity',0);await globalValue('textOpacity',0);
    const opacityReadability=await evaluate(settings,"({sample:getComputedStyle(document.querySelector('#appearance-preview-card .timer-name')).color,sidebar:getComputedStyle(document.getElementById('tab-appearance')).color,close:getComputedStyle(document.getElementById('close-btn')).color,apply:getComputedStyle(document.getElementById('appearance-apply')).color})");
    assert.match(opacityReadability.sample,/,\s*0\)$/,'sample uses actual fully transparent text');
    for(const key of ['sidebar','close','apply'])assert.doesNotMatch(opacityReadability[key],/,\s*0\)$/,'editor '+key+' remains legible');
    await capturePaint(settings,'appearance-zero-text-opacity-editor');
    await evaluate(settings,"document.querySelector('[data-builtin=\"high-contrast\"]').click()");
    await until(()=>evaluate(settings,"document.getElementById('appearance-textOpacity').disabled && document.getElementById('appearance-accentColor').disabled && !document.getElementById('appearance-contrast-note').hidden"),'High Contrast explains and locks forced fields');
    assert.equal(await evaluate(settings,"document.getElementById('appearance-textOpacity').value"),'100','High Contrast shows effective opaque value');
    const contrastSemantic=await evaluate(settings,"({success:document.getElementById('appearance-successColor').value,warning:document.getElementById('appearance-warningColor').value,danger:document.getElementById('appearance-dangerColor').value,tokens:['--state-success','--state-warning','--state-danger'].map(key=>getComputedStyle(document.getElementById('appearance-preview-card')).getPropertyValue(key).replaceAll(' ',''))})");
    assert.deepEqual(contrastSemantic,{success:'#adffbd',warning:'#ffff00',danger:'#ffb5a9',tokens:['rgba(173,255,189,1)','rgba(255,255,0,1)','rgba(255,181,169,1)']},'disabled High Contrast semantic pickers show actual renderer colors');
    await press('appearance-cancel');
    await until(async()=>JSON.stringify(Appearance.extract(await current()))===JSON.stringify(applied),'opacity and contrast preview can be canceled');
    await set('appearance-name','Draft only preset');await press('appearance-save-preset');
    await press('appearance-cancel');
    assert.equal(await evaluate(settings,"document.getElementById('appearance-preset').value"),'','Cancel clears selection of unsaved library entry');
    assert.equal(await evaluate(settings,"document.getElementById('appearance-rename-preset').disabled && document.getElementById('appearance-delete-preset').disabled"),true,'Cancel disables actions for nonexistent library entry');
    checks.push('zero text opacity preserves editor controls; High Contrast locks effective colors and opacity; canceled draft-only presets clear their selection');
    const previousSize=settings.getSize();settings.setSize(560,650);
    await until(()=>evaluate(settings,"document.documentElement.clientWidth===560"),'narrow Settings size settles');
    const narrow=await evaluate(settings,"({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth})");
    assert.ok(narrow.scrollWidth<=narrow.width,'narrow appearance editor has no horizontal document overflow');
    await capturePaint(settings,'appearance-narrow-editor');settings.setSize(...previousSize);
    await until(()=>evaluate(settings,`document.documentElement.clientWidth===${previousSize[0]}`),'restored Settings size settles');
    checks.push('built-in square/pill styles, thick borders, section/all resets and a 560px Settings viewport render through the shared appearance system');
    console.log('[appearance-check] Built-ins, resets and narrow viewport passed');
  } finally { embedded.destroy(); }
  await evaluate(main,"window.api.toggleDockWidget('clock')");
  await until(()=>!clock.isVisible(),'appearance fixture returns clock to closed state');
  settings.show();settings.focus();
  console.log('[appearance-check] All appearance assertions passed');
  return { base:'dark-mint', persisted:Appearance.copy(savedAppearance()) };
}

module.exports={checkAppearance};
