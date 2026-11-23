import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'

const b=await chromium.launch({args:['--no-sandbox']})
try{
 const p=await b.newPage({viewport:{width:1100,height:800}}),errors=[]
 p.on('pageerror',e=>errors.push(e.message))
 await p.route('http://localhost:19185/**',async route=>{
   const path=new URL(route.request().url()).pathname
   if(path==='/duet/avatar/renderer.mjs')return route.fulfill({contentType:'text/javascript',body:'export function mountAvatarRenderer(root,{onReady}){onReady();return {update(){},dispose(){}}}'})
   if(/^\/duet\/assets\/(client|shared)\/[a-z-]+\.mjs$/.test(path))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/'+path.slice('/duet/assets/'.length),import.meta.url))})
   if(path==='/duplex-control/api/voice/config')return route.fulfill({json:{avatar:{web_only:true}}})
   if(path.startsWith('/duplex-control/'))return route.fulfill({json:{ok:true}})
   return route.fulfill({contentType:'text/html',body:'<style>body{margin:0}aside{position:fixed;left:0;top:0;bottom:0;width:300px;display:flex;flex-direction:column;background:#eee}#workspaces{flex:1}#controls{height:40px;margin:8px}main{position:fixed;left:300px;right:0;top:0;bottom:0;background:white}</style><aside data-slot="sidebar"><div id="workspaces" data-slot="sidebar.workspaces"></div><footer><div id="controls">duet.</div></footer></aside><main><textarea aria-label="输入框"></textarea></main>'})
 })
 await p.goto('http://localhost:19185/')
 await p.evaluate(async()=>{
   const {mountAvatar}=await import('/duet/assets/client/avatar.mjs')
   const {agentTaskPanel}=await import('/duet/assets/client/agent-tasks.mjs')
   localStorage.setItem('dsh.duet.avatar.v1',JSON.stringify({enabled:true,webOnly:true}))
   const controls=()=>document.querySelector('#controls')
   window.avatar=mountAvatar({controls,audio:{},state:()=>({mode:'off'}),notice(){},requestMode(){}})
   window.nativeView=false
   window.panel=agentTaskPanel({sessions:{list:{getSnapshot:()=>({current:'user',byId:{}})}}},controls,()=>{},()=>nativeView?{native:true,mode:'desktop'}:avatar.presentation())
   window.frame={rows:[{session_id:'worker-'+'a'.repeat(32),name:'整理灵感笔记与项目进展',state:'running',progress:'已整理主要笔记，正在逐项检查项目计划。'.repeat(40)}]}
 })
 await p.waitForSelector('[data-duet-avatar-stage]')
 const baseline=await p.locator('[data-duet-avatar-stage]').boundingBox()
 await p.evaluate(()=>panel.update(frame,false))
 const root=p.locator('[data-duet-avatar]'),stage=p.locator('[data-duet-avatar-stage]'),list=p.locator('[data-task-list]')
 await p.waitForFunction(()=>document.querySelector('[data-duet-avatar]').hasAttribute('data-duet-task-layout'))
 const verify=async()=>assert.ok(await p.evaluate(()=>{
   const a=document.querySelector('aside').getBoundingClientRect(),s=document.querySelector('[data-duet-avatar-stage]').getBoundingClientRect(),c=document.querySelector('[data-task-list]').getBoundingClientRect()
   const hit=document.elementFromPoint(a.right+5,c.top+20)
   return s.left<=a.left+8&&c.left>=s.left+s.width*.82&&!!hit&&!hit.closest('[data-duet-agent-tasks]')
 }))
 await verify()
 assert.ok((await list.boundingBox()).width<=180)
 assert.ok(await stage.evaluate(e=>Math.abs(e.clientWidth/e.clientHeight-260/210)<.03),'original avatar camera aspect is preserved')
 const withTasks=await stage.boundingBox()
 assert.ok(Math.abs(withTasks.width-baseline.width)<.01);assert.ok(Math.abs(withTasks.height-baseline.height)<.01)
 assert.equal(await p.locator('[data-task-peek]').count(),0)
 const compact=list.locator('button').first(),beforeHover=await compact.boundingBox()
 await p.mouse.move(beforeHover.x+12,beforeHover.y+20)
 const expanded=p.locator('[data-duet-task-detail]')
 assert.equal(await expanded.count(),1)
 await p.waitForTimeout(220)
 assert.equal(await expanded.locator('[data-task-progress]').evaluate(e=>getComputedStyle(e).display),'block')
 assert.ok(await expanded.evaluate(e=>e.scrollHeight>e.clientHeight),'long progress remains scrollable, not truncated')
 const expandedRect=await expanded.boundingBox()
 assert.ok(expandedRect.x>=beforeHover.x,'detail replaces the anchor and extends rightward, never over the avatar')
 assert.ok(expandedRect.x+expandedRect.width>300,'detail may cross the sidebar')
 assert.deepEqual(await compact.boundingBox(),beforeHover,'compact geometry never animates or rewraps')
 assert.equal(await compact.evaluate(e=>getComputedStyle(e).opacity),'0','only the replacement card is painted')
 const spinner=await expanded.locator('button').evaluate(e=>{
   const s=getComputedStyle(e,'::before');return {width:s.width,height:s.height,shrink:s.flexShrink,image:s.backgroundImage}
 })
 assert.equal(spinner.width,'16px');assert.equal(spinner.height,'16px');assert.equal(spinner.shrink,'0')
 assert.match(spinner.image,/image\/svg\+xml/)
 await expanded.hover()
 await p.waitForTimeout(180)
 assert.equal(await expanded.count(),1,'pointer can cross from the compact card to its detail')
 await p.keyboard.press('Escape')
 assert.equal(await expanded.count(),0)
 assert.equal(await compact.evaluate(e=>getComputedStyle(e).opacity),'1','compact card returns after closing')
 await p.mouse.move(600,100)
 await p.locator('textarea').fill('输入区域正常')
 // The fan adapts to task count; every card can be brought to the front.
 for(const n of [1,3,5,10]){
   await p.evaluate(n=>panel.update({rows:Array.from({length:n},(_,i)=>({...frame.rows[0],session_id:'worker-'+i.toString(16).padStart(32,'0'),name:'测试任务 '+i}))},false),n)
   assert.equal(await list.locator('button').count(),n)
   assert.ok((await list.boundingBox()).height<=290)
   assert.ok((await list.boundingBox()).y+(await list.boundingBox()).height<=(await p.locator('#controls').boundingBox()).y-7,'cards never cover the mode controls')
   for(let i=0;i<n;i++){
     await p.mouse.move(900,100)
     await p.waitForTimeout(160)
     const card=list.locator('button').nth(i),r=await card.boundingBox()
     await p.mouse.move(r.x+25,r.y+5)
     await p.waitForTimeout(220)
     assert.equal(await card.getAttribute('data-expanded'),'')
     const d=await p.locator('[data-duet-task-detail]').boundingBox()
     assert.ok(d.x>=r.x)
     assert.equal(await card.evaluate(e=>getComputedStyle(e).opacity),'0')
     assert.equal(await p.locator('[data-duet-task-detail]').count(),1)
   }
 }
 await p.mouse.move(700,100)
 await p.waitForTimeout(160)
 await p.evaluate(()=>panel.update(frame,false))
 await p.evaluate(()=>{document.querySelector('aside').style.width='520px';document.querySelector('main').style.left='520px'})
 await p.waitForTimeout(100)
 await p.evaluate(()=>{document.querySelector('aside').style.width='240px';document.querySelector('main').style.left='240px'})
 await p.waitForTimeout(100)
 await verify()
 // Hidden avatar stays hidden; task cards still remain within the sidebar.
 await p.evaluate(()=>{localStorage.setItem('dsh.duet.avatar.v1',JSON.stringify({enabled:false,webOnly:true}));dispatchEvent(new StorageEvent('storage',{key:'dsh.duet.avatar.v1'}))})
 await p.waitForFunction(()=>!document.querySelector('[data-duet-avatar]'))
 await p.waitForFunction(()=>document.querySelector('[data-task-list]').getBoundingClientRect().left<20)
 // Native windows retain their independent projection, with no web mask or alignment.
 await p.evaluate(()=>{nativeView=true;dispatchEvent(new Event('duet:avatar-presentation'))})
 await p.waitForFunction(()=>getComputedStyle(document.querySelector('[data-duet-agent-tasks]')).visibility==='hidden')
 assert.equal(await list.evaluate(e=>getComputedStyle(e).maskImage),'none')
 await p.evaluate(()=>{nativeView=false;localStorage.setItem('dsh.duet.avatar.v1',JSON.stringify({enabled:true,webOnly:true}));dispatchEvent(new StorageEvent('storage',{key:'dsh.duet.avatar.v1'}));panel.update(frame,false)})
 await p.waitForFunction(()=>document.querySelector('[data-duet-avatar]')?.hasAttribute('data-duet-task-layout'))
 await p.evaluate(()=>panel.update({rows:[]},false))
 assert.equal(await root.getAttribute('data-duet-task-layout'),null)
 assert.equal(await root.evaluate(e=>getComputedStyle(e).alignItems),'center')
 await p.evaluate(()=>{panel.reset();avatar.dispose()})
 assert.deepEqual(errors,[])
 console.log('Web sidebar tasks: compact 1/3/5/10 fans, hover front/full progress, avatar aspect, resize, hidden avatar and native isolation passed')
}finally{await b.close()}
