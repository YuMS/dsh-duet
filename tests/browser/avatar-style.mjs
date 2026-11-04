import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const html=(await readFile(new URL('../../src/avatar/companion.html',import.meta.url),'utf8'))
 .replace('src="./companion.mjs"','src="./fixture.mjs"')
const fixture=`import{sizeButton,nextAvatarSize,avatarCloseConfirmation}from'/shared/avatar-ui.mjs';
import{mountAvatarToolbar,maskContains}from'/toolbar.mjs';
const tools=document.querySelector('#tools'),avatar=document.querySelector('#avatar'),size=document.querySelector('#size');
const mask=Array.from({length:48*64},(_,i)=>+(i%48>=12&&i%48<36&&Math.floor(i/48)>=12&&Math.floor(i/48)<60));
window.toolbar=mountAvatarToolbar({tools,avatar,hitTest:(x,y)=>{const r=avatar.getBoundingClientRect();return maskContains(mask,[r.x,r.y,r.width,r.height],x,y)}});
window.confirmation=avatarCloseConfirmation({onChange:()=>toolbar.setConfirmation(Boolean(confirmation.element))});
sizeButton(size,'large');size.onclick=()=>{sizeButton(size,nextAvatarSize(size.dataset.size));document.querySelector('#stage').style.setProperty('--scale',{large:1,medium:.75,small:.5}[size.dataset.size]);toolbar.refresh()};
document.querySelector('#close').onclick=()=>confirmation.ask();
for(const b of document.querySelectorAll('[data-mode]'))b.disabled=false;
document.querySelector('#bubble').hidden=false;document.querySelector('#text').textContent='字幕独立显示，不随整条工具栏淡出。'.repeat(12);
window.fixtureReady=true;`
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://local').pathname
 res.setHeader('content-type',path.endsWith('.mjs')?'text/javascript':'text/html; charset=utf-8')
 if(path==='/')return res.end(html)
 if(path==='/fixture.mjs')return res.end(fixture)
 if(path==='/toolbar.mjs')return res.end(await readFile(new URL('../../src/avatar/toolbar.mjs',import.meta.url)))
 if(['/shared/avatar.mjs','/shared/avatar-ui.mjs'].includes(path))return res.end(await readFile(new URL('../../src'+path,import.meta.url)))
 res.writeHead(404);res.end()
}).listen(0,'127.0.0.1');await once(server,'listening')
const browser=await chromium.launch({args:['--no-sandbox']}),evidence={}
try{
 const page=await browser.newPage({viewport:{width:280,height:490}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.fixtureReady)
 const opacity=()=>page.locator('#tools').evaluate(el=>Number(getComputedStyle(el).opacity))
 const finish=()=>page.locator('#tools').evaluate(el=>el.getAnimations().forEach(a=>a.finish()))
 const revealed=()=>page.waitForFunction(()=>document.querySelector('#tools').dataset.revealed==='true')
 const hidden=()=>page.waitForFunction(()=>document.querySelector('#tools').dataset.interactive==='false')
 const leave=async()=>{await page.mouse.move(1,1);await page.waitForFunction(()=>document.querySelector('#tools').dataset.revealed==='false')}
 const show=async()=>{const r=await page.locator('#avatar').boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await revealed()}
 const samples=()=>page.locator('#tools').evaluate(el=>{
  getComputedStyle(el).opacity
  const a=el.getAnimations().find(a=>a.transitionProperty==='opacity')
  if(!a)throw Error('expected whole-toolbar opacity transition')
  const duration=a.effect.getTiming().duration
  a.pause();const samples=[]
  for(const ms of [0,250,500]){a.currentTime=ms;samples.push({ms,opacity:Number(getComputedStyle(el).opacity)})}
  a.finish();return{duration,samples}
 })
 assert.equal(await opacity(),0);assert.deepEqual(await page.evaluate(()=>toolbar.regions()),[])
 assert.equal(await page.locator('#tools').evaluate(el=>getComputedStyle(el).pointerEvents),'none')
 // WebViews may focus the first button on launch without keyboard interaction.
 await page.locator('#size').focus();await page.waitForTimeout(50)
 assert.equal(await page.locator('#size').evaluate(el=>getComputedStyle(el).outlineStyle),'none')
 assert.equal(await opacity(),0,'automatic startup focus must not expose the toolbar')
 await page.locator('#size').evaluate(el=>el.blur())
 // Invisible toolbar and transparent carrier must not reveal/capture the pointer.
 const t=await page.locator('#tools').boundingBox()
 await page.mouse.move(t.x+20,t.y+20);await page.waitForTimeout(220);assert.equal(await opacity(),0)
 assert.equal(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('#tools')),{x:t.x+20,y:t.y+20}),false)
 await page.mouse.move(12,142);await page.waitForTimeout(220);assert.equal(await opacity(),0)
 evidence.default={opacity:0,regions:[],transparentCornerReveals:false,hiddenButtonsCapture:false}
 await show();evidence.enter=await samples();assert.equal(evidence.enter.duration,500)
 assert.equal(evidence.enter.samples[0].opacity,0);assert.ok(evidence.enter.samples[1].opacity>0&&evidence.enter.samples[1].opacity<1);assert.equal(evidence.enter.samples[2].opacity,1)
 // Cross the short geometric bridge, then rest over each child control.
 const a=await page.locator('#avatar').boundingBox()
 await page.mouse.move(140,a.y+a.height+1);await page.waitForTimeout(250);assert.equal(await opacity(),1)
 for(const selector of ['#brand','#size','[data-mode=online]','[data-mode=tts_only]','#close']){
  await page.locator(selector).hover();await page.waitForTimeout(200);assert.equal(await opacity(),1)
 }
 await page.mouse.move(1,1);await page.waitForTimeout(60);await show();await page.waitForTimeout(220)
 assert.equal(await opacity(),1);evidence.traversal={bridge:true,children:true,reentryDuringGrace:true}
 await leave();evidence.leave=await samples();assert.equal(evidence.leave.duration,500)
 assert.equal(evidence.leave.samples[0].opacity,1);assert.ok(evidence.leave.samples[1].opacity>0&&evidence.leave.samples[1].opacity<1);assert.equal(evidence.leave.samples[2].opacity,0)
 await hidden();assert.deepEqual(await page.evaluate(()=>toolbar.regions()),[])
 assert.equal(await page.locator('#bubble').isVisible(),true)
 // Preserve r3 regression: resizing moves the button; re-enter its new geometry.
 await show();await finish();await page.locator('#size').click()
 await show();await page.locator('#size').hover();await finish()
 assert.equal(await opacity(),1,'pointer leave must start from a visible toolbar')
 assert.equal(await page.locator('#size').evaluate(el=>el===document.activeElement&&!el.matches(':focus-visible')),true)
 await leave();evidence.afterPointerClick=await samples();assert.equal(evidence.afterPointerClick.samples[2].opacity,0);await hidden()
 // Native pointer messages recover hover while OS passthrough suppresses DOM moves.
 await page.evaluate(()=>toolbar.pointer({x:140,y:210,overAvatar:true}));await revealed();await finish();assert.equal(await opacity(),1)
 await page.evaluate(()=>toolbar.pointer({x:-1,y:-1,overAvatar:false}));await page.waitForFunction(()=>document.querySelector('#tools').dataset.revealed==='false')
 await samples();await hidden()
 // Tab is allowed to reveal the whole toolbar; ordinary mouse focus is not.
 await page.locator('#size').evaluate(el=>el.blur());await page.keyboard.press('Tab');await revealed();await finish()
 assert.equal(await page.locator('#tools').evaluate(el=>Boolean(el.querySelector(':focus-visible'))),true)
 assert.equal(await page.locator('#tools :focus-visible').evaluate(el=>getComputedStyle(el).outlineStyle),'solid')
 assert.equal(await opacity(),1);await page.mouse.move(1,1);assert.equal(await opacity(),1)
 for(let i=0;i<5&&await page.locator('#tools').evaluate(el=>el.contains(document.activeElement));i++)await page.keyboard.press('Tab')
 assert.equal(await page.locator('#tools').evaluate(el=>el.contains(document.activeElement)),false)
 await page.waitForFunction(()=>document.querySelector('#tools').dataset.revealed==='false');await samples();await hidden()
 evidence.keyboard={reveals:true,leavingHides:true,mouseFocusDoesNotStick:true}
 evidence.sizes=[]
 for(const size of ['small','large','medium']){
  await show();await finish();await page.locator('#size').click();await show();await page.locator('#size').hover();await finish()
  assert.equal(await page.locator('#size').getAttribute('data-size'),size)
  assert.equal(await page.locator(`#size [data-size-square=${size}]`).getAttribute('stroke-width'),'2.8')
  assert.equal(await page.locator('#size rect[stroke-width="1"]').count(),2)
  assert.equal(await page.locator('#size [stroke-dasharray]').count(),0)
  const rects=await page.locator('#size rect').evaluateAll(nodes=>nodes.map(n=>({x:+n.getAttribute('x'),y:+n.getAttribute('y'),w:+n.getAttribute('width'),h:+n.getAttribute('height')})))
  for(const r of rects){assert.equal(r.x,3);assert.equal(r.y+r.h,21);assert.equal(r.w,r.h)}
  assert.equal((await page.locator('#bubble').boundingBox()).width,256);assert.equal(await opacity(),1)
  evidence.sizes.push({size,rects,captionWidth:256})
 }
 await page.locator('#close').click();await page.mouse.move(1,1);await page.waitForTimeout(750)
 assert.equal(await opacity(),1);assert.equal(await page.locator('#tools').getAttribute('data-confirming'),'true')
 assert.equal(await page.locator('[data-avatar-close-confirm]').getAttribute('aria-label'),'隐藏拟人角色？')
 assert.equal(await page.locator('[data-avatar-close-choice=confirm]').textContent(),'隐藏拟人角色')
 assert.equal(await page.locator('#bubble').isVisible(),true)
 await page.locator('[data-avatar-close-choice=cancel]').click();await leave()
 evidence.afterPointerCancel=await samples();assert.equal(evidence.afterPointerCancel.samples[2].opacity,0);await hidden()
 await show();await finish();await page.locator('#close').click();await page.mouse.move(1,1);await page.keyboard.press('Escape')
 assert.equal(await page.locator('[data-avatar-close-confirm]').count(),0)
 assert.equal(await page.locator('#close').evaluate(el=>el.matches(':focus-visible')),true)
 assert.equal(await opacity(),1)
 await page.keyboard.press('Tab');await page.waitForFunction(()=>document.querySelector('#tools').dataset.revealed==='false');await samples();await hidden()
 evidence.confirmation={persistsOnLeave:true,cancelRestores:true,escapeKeepsKeyboardFocus:true,captionIndependent:true}
 assert.deepEqual(errors,[])
 await mkdir(new URL('../../artifacts/avatar/',import.meta.url),{recursive:true})
 await writeFile(new URL('../../artifacts/avatar/avatar-style-r4.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n')
 console.log('Avatar r4: whole-toolbar 500ms fade, alpha hover, no invisible hits, bridge/grace, focus/confirmation, fixed captions and solid size icons passed')
}finally{await browser.close();await new Promise(r=>server.close(r))}
