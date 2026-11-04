import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:900,height:750}}),errors=[],network=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('http://127.0.0.1:19388/**',async route=>{
  const path=new URL(route.request().url()).pathname;network.push(path)
  if(path.startsWith('/src/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../'+path.slice(1),import.meta.url),'utf8')})
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<meta charset="utf-8"><button id="pet" style="position:fixed;left:650px;top:500px;width:180px;height:180px">形象</button><script type="module">
   import {mountAvatarMenu} from '/src/shared/avatar-menu-ui.mjs';
   import {mountAvatarTasks} from '/src/client/avatar-tasks.mjs';
   window.AudioContext=class{constructor(){throw Error('unexpected audio')}};
   window.events=[];window.current='s1';window.pending=new Map();window.listeners={};
   window.sessions=[{session_id:'s1',label:'灵感笔记',workspace_id:'w1',running:true},{session_id:'s2',label:'另一个工作区',workspace_id:'w2'}];
   window.sync={active:true,epoch:'e',snapshot:{sessions,results:[]},subscribe(fn){listeners.sync=fn;return()=>{} }};
   const ctx={sessions:{list:{getSnapshot:()=>({current,byId:{}}),subscribe(fn){listeners.sessions=fn;return()=>{}}},refresh:async()=>{},open:id=>{current=id;events.push('open:'+id)}},
    workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'w1',sessionIds:['s1']},{workspaceId:'w2',sessionIds:['s2']}]}),subscribe:()=>()=>{}}},
    uiSession:{pendingInteractions:{getSnapshot:()=>pending,subscribe(fn){listeners.pending=fn;return()=>{}}}}};
   window.menu=mountAvatarMenu({anchor:()=>document.getElementById('pet'),send:e=>tasks.action(e)});
   window.tasks=mountAvatarTasks({ctx,sync,avatar:()=>({localState:s=>{window.lastState=s;menu.update(s)},menuResult:r=>{events.push(r);menu.result(r)},setSize:s=>events.push('size:'+s),toggle:()=>events.push('hide')}),
     tutorial:()=>({open:o=>events.push('tutorial:'+o.origin)}),settings:()=>events.push('settings'),focus:()=>events.push('focus')});
   document.getElementById('pet').oncontextmenu=e=>menu.open(e);
   window.makeResult=()=>{sync.snapshot.results=[{id:'j1',session_id:'s1',status:'succeeded',turn_end_reason:'completed',completion_seq:1}];listeners.sync()};
   window.ready=true;
  </script>`})
 })
 await page.goto('http://127.0.0.1:19388/');await page.waitForFunction(()=>window.ready)
 await page.locator('#pet').click({button:'right'})
 const menu=page.getByRole('menu',{name:'duet 形象菜单'})
 assert.equal(await menu.isVisible(),true)
 const text=await menu.innerText();assert.doesNotMatch(text,/交互模式|播报模式|关闭语音/)
 assert.doesNotMatch(text,/（0）|免打扰/);assert.equal(await menu.locator('[data-wordmark]').innerText(),'duet.')
 const box=await menu.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=900&&box.y+box.height<=750)
 await menu.screenshot({path:'/tmp/duet-menu-v2.png'})
 await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'隐藏形象')
 await page.keyboard.press('Escape');assert.equal(await menu.count(),0)
 await page.evaluate(()=>makeResult())
 await page.locator('[data-duet-local-notice]').waitFor()
 assert.match(await page.locator('[data-duet-local-notice]').innerText(),/灵感笔记.*本轮已完成/)
 await page.locator('[data-duet-local-notice]').getByRole('menuitem',{name:'收起',exact:true}).click()
 await page.waitForFunction(()=>!document.querySelector('[data-duet-local-notice]'))
 await page.evaluate(()=>{pending=new Map([['p',{key:'question:q1',sessionId:'s1',kind:'question',questions:[{question:'选哪个？'}]}],['foreign',{key:'question:q2',sessionId:'s2',kind:'question'}]]);listeners.pending()})
 assert.equal(await page.evaluate(()=>lastState.items.filter(x=>x.pending).length),1)
 await page.locator('[data-duet-local-notice]').getByRole('menuitem',{name:'去处理'}).click()
 await page.waitForFunction(()=>events.includes('open:s1'))
 assert.equal(await page.evaluate(()=>pending.size),2,'menu must not answer or dismiss DSH requests')
 await page.evaluate(()=>{pending.clear();listeners.pending()})
 assert.equal(await page.evaluate(()=>lastState.items.some(x=>x.pending)),false)
 await page.locator('#pet').click({button:'right'})
 const toggle=menu.getByRole('menuitemcheckbox',{name:'任务通知',exact:true})
 await toggle.click();assert.equal(await page.evaluate(()=>lastState.enabled),false);assert.equal(await menu.isVisible(),true)
 await toggle.click();assert.equal(await page.evaluate(()=>lastState.enabled),true)
 await menu.locator('[data-menu-action=size]').click()
 assert.equal(await page.evaluate(()=>events.includes('size:medium')),true);assert.equal(await menu.isVisible(),true)
 await menu.locator('[data-menu-action=bubble_panel]').click()
 await menu.locator('[data-menu-action=bubble]').click()
 assert.equal(await page.evaluate(()=>lastState.bubble),'large')
 assert.equal(await menu.isVisible(),true);assert.equal(await menu.locator('[data-bubble-preview]').getAttribute('data-size'),'large')
 await menu.screenshot({path:'/tmp/duet-menu-bubble-v2.png'})
 await menu.getByRole('menuitem',{name:'返回',exact:true}).click()
 await menu.getByRole('menuitem',{name:'使用教学'}).click()
 assert.equal(await page.evaluate(()=>events.includes('tutorial:avatar')),true)
 await page.locator('#pet').click({button:'right'});await page.mouse.click(20,20);assert.equal(await menu.count(),0)
 await page.evaluate(()=>{tasks.dispose();menu.dispose()});assert.deepEqual(errors,[])
 assert.ok(network.every(path=>path==='/'||path.startsWith('/src/')),'local menus must not contact voice/TTS or submit tasks')
 console.log('Avatar menu: local-only, scope, pending lifecycle, keyboard, dismissal, inline toggle, persistent size controls, bubble preview and tutorial routing passed')
}finally{await browser.close()}
