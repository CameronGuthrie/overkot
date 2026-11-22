'use strict';

// Native, offline optical/motion review at the sizes used by real controls.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)],
    { env, stdio: 'inherit', windowsHide: true, timeout: 90000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const speed = Number(process.argv.find(value => value.startsWith('--speed='))?.slice(8) || 100);
assert.ok(Number.isFinite(speed) && speed >= 50 && speed <= 200, 'Icon speed must be between 50 and 200 percent');
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
const out = fs.mkdtempSync(path.join(root, 'output', 'icon-review-'));
app.setPath('userData', path.join(out, 'profile'));
const file = relative => pathToFileURL(path.join(root, relative)).href;
const html = `<!doctype html><html data-icon-motion="loop" data-motion-level="standard" data-respect-reduced-motion="false"><head><meta charset="utf-8">
<link rel="stylesheet" href="${file('src/renderer/icons.css')}"><style>
:root{--icon-primary:#d7e0dd;--icon-secondary:#8cbaa8;--icon-detail:#d3bd88;--icon-duration:${900 * 100 / speed}ms;--motion-base:220ms;--motion-fast:120ms}
*{box-sizing:border-box}body{margin:0;background:#111714;color:#d7e0dd;font:12px/1.5 'Segoe UI',sans-serif;padding:22px}
h1{margin:0 0 4px;font-size:22px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}header p{margin:0;color:#9aaca3}
button,select{font:inherit;padding:7px 10px;color:inherit;background:#25332b;border:1px solid #435a4c;border-radius:6px}.controls{display:flex;gap:8px;align-items:center}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.card{padding:13px 15px;background:#1c2620;border:1px solid #314438;border-radius:9px;min-height:126px}
.name{font-size:13px;font-weight:600}.note{color:#9aaca3;font-size:10px;overflow-wrap:anywhere;min-height:28px}.sizes{display:flex;align-items:center;gap:22px;height:49px}.sample{display:flex;align-items:center;gap:5px}.sample small{color:#708e7a;font-size:9px}.sample svg{display:block;flex:none;outline:1px dashed #405b481f}
</style><script src="${file('src/renderer/widget-icons.js')}"></script><script src="${file('src/renderer/ui-icons.js')}"></script></head><body>
<header><div><h1 id="title">Overkot icon review</h1><p>Actual glyphs at 16, 20 and 32 px · Toggle animation and colour modes to review each treatment</p></div><div class="controls">
<select id="family"><option value="widgets">Widgets</option><option value="actions">Actions</option></select><select id="motion"><option value="loop">Loop</option><option value="off">Static</option></select><select id="palette"><option value="theme">Theme</option><option value="custom">Custom colours</option><option value="mono">Monochrome</option></select>
</div></header><main class="grid"></main><script>
const families={widgets:WidgetIcons,actions:UIIcons};
function render(){const group=document.getElementById('family').value,api=families[group],grid=document.querySelector('.grid');grid.replaceChildren();
 for(const id of api.ids){const item=document.createElement('article');item.className='card';item.dataset.reviewId=id;item.dataset.reviewKind=group;
 const title=document.createElement('div');title.className='name';title.textContent=id;const sizes=document.createElement('div');sizes.className='sizes';
 for(const size of [16,20,32]){const cell=document.createElement('div');cell.className='sample';const svg=api.create(id);svg.style.width=size+'px';svg.style.height=size+'px';svg.dataset.reviewSize=size;const label=document.createElement('small');label.textContent=size;cell.append(svg,label);sizes.append(cell)}
 const note=document.createElement('div');note.className='note';const metadata=api.catalogue?.[id];note.textContent=metadata?.description||sizes.querySelector('svg').dataset.iconMotionKind;item.append(title,sizes,note);grid.append(item)}
 document.getElementById('title').textContent='Overkot '+group+' · optical and animation review';}
document.getElementById('family').addEventListener('change',render);document.getElementById('motion').addEventListener('change',event=>document.documentElement.dataset.iconMotion=event.target.value);
document.getElementById('palette').addEventListener('change',event=>{const values=event.target.value==='custom'?['#e59775','#87b7d1','#c2b875']:event.target.value==='mono'?['#d7e0dd','#d7e0dd','#d7e0dd']:['#d7e0dd','#8cbaa8','#d3bd88'];for(const [i,key] of ['primary','secondary','detail'].entries())document.documentElement.style.setProperty('--icon-'+key,values[i])});render();
</script></body></html>`;
const reviewFile = path.join(out, 'index.html'); fs.writeFileSync(reviewFile, html);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1240, height: 1320, enableLargerThanScreen: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  try {
    await win.loadFile(reviewFile);
    const reports = [];
    for (const family of ['widgets', 'actions']) {
      await win.webContents.executeJavaScript(`document.getElementById('family').value='${family}';render();document.documentElement.dataset.iconMotion='off'`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const bounds = await win.webContents.executeJavaScript(`([...document.querySelectorAll('svg[data-review-size="20"]')].map(svg=>{
        const b=svg.getBBox();return{id:svg.dataset.widgetIcon||svg.dataset.uiIcon,x:b.x,y:b.y,width:b.width,height:b.height,
          parts:svg.querySelectorAll('[data-icon-part]').length,channels:new Set([...svg.querySelectorAll('[data-icon-layer]')].map(node=>node.dataset.iconLayer)).size};}))`);
      const dimensions = await win.webContents.executeJavaScript('({height:innerHeight,page:document.documentElement.scrollHeight})');
      let page = 0;
      for (let y = 0; y < dimensions.page; y += dimensions.height - 80) {
        await win.webContents.executeJavaScript(`scrollTo(0,${y});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        fs.writeFileSync(path.join(out, family + '-static' + (page++ ? '-page-' + page : '') + '.png'), (await win.webContents.capturePage()).toPNG());
      }
      await win.webContents.executeJavaScript('scrollTo(0,0)');
      await win.webContents.executeJavaScript("document.documentElement.dataset.iconMotion='loop'");
      const animation = await win.webContents.executeJavaScript(`([...document.querySelectorAll('svg[data-review-size="20"]')].map(svg=>({id:svg.dataset.widgetIcon||svg.dataset.uiIcon,
        animations:svg.getAnimations({subtree:true}).filter(a=>a.playState==='running').map(a=>a.animationName)})))`);
      const missing = animation.filter(row => !row.animations.length);
      const overflow = bounds.filter(row => row.x < -.1 || row.y < -.1 || row.x + row.width > 24.1 || row.y + row.height > 24.1);
      const motion = await win.webContents.executeJavaScript(`(async()=>{
        const svgs=[...document.querySelectorAll('svg[data-review-size="20"]')];
        const rows=svgs.map(svg=>({svg,id:svg.dataset.widgetIcon||svg.dataset.uiIcon,states:new Set(),spill:0,strokeSpill:0}));
        const animations=rows.flatMap(row=>row.svg.getAnimations({subtree:true}));
        for(const animation of animations)animation.pause();
        await Promise.all(animations.map(animation=>animation.ready));
        for(const phase of [0,.06,.12,.2,.3,.45,.6,.75,.88,.97]){
          for(const animation of animations){const timing=animation.effect.getTiming();animation.currentTime=(Number(timing.delay)||0)+(Number(timing.duration)||1800)*phase;}
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          for(const row of rows){
            const parts=[...row.svg.querySelectorAll('[data-icon-part]')],frame=row.svg.getBoundingClientRect();
            row.states.add(JSON.stringify(parts.map(part=>{const style=getComputedStyle(part);return[style.transform,style.opacity,style.strokeDashoffset]})));
            for(const shape of row.svg.querySelectorAll('path,circle,rect,line,ellipse,polyline,polygon')){
              const style=getComputedStyle(shape),matrix=shape.getScreenCTM();
              const stroke=style.stroke==='none'?0:parseFloat(style.strokeWidth)||0;
              const padX=stroke/2*Math.hypot(matrix.a,matrix.c),padY=stroke/2*Math.hypot(matrix.b,matrix.d);
              // Rotating a path's rectangular DOM bounds overestimates its
              // actual ink. Sample native curve geometry at <=.125 SVG units
              // and include the transformed round stroke/caps instead.
              const length=shape.getTotalLength(),count=Math.max(1,Math.ceil(length*8));
              for(let i=0;i<=count;i++){
                const point=shape.getPointAtLength(length*i/count),x=matrix.a*point.x+matrix.c*point.y+matrix.e,y=matrix.b*point.x+matrix.d*point.y+matrix.f;
                row.spill=Math.max(row.spill,frame.x-x,frame.y-y,x-frame.right,y-frame.bottom);
                row.strokeSpill=Math.max(row.strokeSpill,frame.x-x+padX,frame.y-y+padY,x-frame.right+padX,y-frame.bottom+padY);
              }
            }
          }
        }
        for(const animation of animations)animation.play();
        return rows.map(row=>({id:row.id,distinctStates:row.states.size,spillPixels:Math.round(Math.max(0,row.spill)*100)/100,
          strokeSpillPixels:Math.round(Math.max(0,row.strokeSpill)*100)/100}));
      })()`);
      reports.push({ family, icons: bounds.length, overflow, missingAnimation: missing,
        unchangedMotion: motion.filter(row => row.distinctStates < 2), motionOverflow: motion.filter(row => row.strokeSpillPixels > .25), bounds, motion });
      // Seek every rendered size to the same authored phase, so the contact
      // sheet shows the moving state rather than a random resting frame.
      for (const phase of [.2, .35, .7]) {
        await win.webContents.executeJavaScript(`(async()=>{
          const animations=[...document.querySelectorAll('svg')].flatMap(svg=>svg.getAnimations({subtree:true}));
          for(const animation of animations)animation.pause();
          await Promise.all(animations.map(animation=>animation.ready));
          for(const animation of animations){
            const timing=animation.effect.getTiming();
            animation.currentTime=(Number(timing.delay)||0)+Number(timing.duration)*${phase};
          }
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        })()`);
        fs.writeFileSync(path.join(out, family + '-motion-phase-' + phase + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify({ out, speed, reports: reports.map(({ bounds, motion, ...value }) => value) }));
    if (!process.argv.includes('--baseline')) {
      for (const report of reports) {
        assert.deepEqual(report.overflow, [], 'Every independent SVG shape must remain in its authored viewBox');
        assert.deepEqual(report.missingAnimation, [], 'Every icon needs a working animation in Loop mode');
        assert.deepEqual(report.unchangedMotion, [], 'Every animation must change its authored component, not just create an empty timeline');
        assert.deepEqual(report.motionOverflow, [], 'Animation must remain inside the control padding throughout the cycle');
      }
    }
  } finally { win.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
