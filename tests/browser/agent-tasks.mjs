import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'

const b=await chromium.launch({args:['--no-sandbox']})
try{
  const p=await b.newPage()
  await p.route('http://localhost:19184/**',async route=>{
    const path=new URL(route.request().url()).pathname
    if(/^\/(client|shared|avatar)\/[a-z-]+\.mjs$/.test(path))
      return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src'+path,import.meta.url))})
    return route.fulfill({contentType:'text/html',body:'<aside data-slot="sidebar" style="position:fixed;bottom:8px;width:220px"><div id="pet" style="height:170px"><div data-duet-avatar-stage style="height:100%"></div></div><div id="controls" style="height:36px"></div></aside>'})
  })
  await p.goto('http://localhost:19184/')
  const html=await readFile(new URL('../../src/avatar/companion.html',import.meta.url),'utf8')
  const css=html.match(/<style>([\s\S]*?)<\/style>/)[1]
  await p.addStyleTag({content:css.split('\n').filter(line=>line.includes('#surface[')||line.includes('@keyframes duet-task-spin')).join('\n').replaceAll('#surface','#native-mirror')})
  await p.evaluate(async()=>{
    const {agentTaskPanel}=await import('/client/agent-tasks.mjs')
    const id='worker-'+'e'.repeat(32)
    const snapshot=window.snapshot={current:'user-session',byId:{[id]:{}}};window.draft=''
    const ctx={sessions:{list:{getSnapshot:()=>snapshot},scope:()=>({}),refresh:async()=>{},open:id=>{snapshot.current=id}},
      conversation:{input:{for:()=>({state:{getSnapshot:()=>({draft:window.draft})}})}}}
    const presentation=()=>({anchor:document.querySelector('#pet'),mode:window.surface||'web',native:window.native===true})
    window.panel=agentTaskPanel(ctx,()=>document.querySelector('#controls'),()=>{},presentation)
    const {mountAvatarSurfaces}=await import('/client/avatar-surfaces.mjs')
    const {mountCompanionSurface}=await import('/avatar/surface.mjs')
    const mirror=document.createElement('section');mirror.id='native-mirror';mirror.hidden=true;document.body.append(mirror)
    window.projections=[]
    const view=mountCompanionSurface(mirror,{send:m=>surfaces.action(m),changed(){}})
    window.surfaces=mountAvatarSurfaces({avatar:()=>({presentation,surface:m=>{projections.push(m);view.update(m);return true}})})
    window.frame={rows:[{session_id:id,name:'修改已有图画',state:'running'}],focus:id}
    panel.update({...frame,focus:null},true)
  })
  assert.ok(await p.evaluate(()=>{
    const b=document.querySelector('[data-duet-agent-tasks]').getBoundingClientRect(),a=document.querySelector('#pet').getBoundingClientRect()
    return b.left>=a.right+7 && Math.abs((b.top+b.bottom-a.top-a.bottom)/2)<2 && document.querySelector('[data-duet-agent-tasks]').parentNode===document.body
  }))
  const summary=p.locator('[data-duet-agent-tasks] summary')
  assert.equal(await summary.isVisible(),false)
  assert.equal(await p.locator('[data-duet-agent-tasks] button').innerText(),'修改已有图画')
  assert.equal(await p.locator('[data-task-state=running]').count(),1)
  await p.evaluate(()=>{
    const q={session_id:'worker-'+'a'.repeat(32),name:'确认页面配色',state:'waiting_user'}
    panel.update({rows:[...frame.rows,q]},false)
  })
  assert.equal(await p.locator('[data-duet-agent-tasks] button').count(),2)
  assert.equal(await p.locator('[data-task-state=waiting]').count(),1)
  assert.equal(await summary.isVisible(),false)
  assert.equal(await p.locator('[data-duet-agent-tasks][data-stacked]').count(),1)
  await p.emulateMedia({forcedColors:'active'})
  assert.equal(await summary.evaluate(el=>getComputedStyle(el).backdropFilter),'none')
  await p.emulateMedia({forcedColors:'none'})
  if(process.env.DUET_TASK_CARD_PREVIEW){
    const r=await p.locator('[data-duet-agent-tasks]').boundingBox()
    await p.screenshot({path:process.env.DUET_TASK_CARD_PREVIEW,clip:{x:0,y:r.y-22,width:r.width+r.x+24,height:r.height+56}})
  }
  await p.evaluate(()=>panel.update({...frame,focus:null},false))
  assert.equal(await summary.isVisible(),false)
  assert.equal(await p.evaluate(()=>snapshot.current),'user-session')
  await p.evaluate(()=>{window.draft='正在编辑';panel.update(frame,true)})
  await p.waitForTimeout(40);assert.equal(await p.evaluate(()=>snapshot.current),'user-session')
  await p.evaluate(()=>{window.draft='';panel.update(frame,true)})
  await p.waitForFunction(()=>snapshot.current===frame.focus)
  assert.equal(await p.locator('[data-duet-agent-tasks]').isVisible(),true,'running task stays visible when visited')
  await p.evaluate(()=>{snapshot.current='user-session';panel.update({...frame,focus:null},false)})
  assert.equal(await p.locator('[data-duet-agent-tasks]').isVisible(),true,'running task stays visible after leaving')
  await p.evaluate(()=>{snapshot.current='user-session';frame.rows[0].state='completed';frame.rows[0].finished_at=Date.now();panel.update(frame,false)})
  assert.equal(await p.evaluate(()=>snapshot.current),'user-session')
  await p.getByRole('button',{name:/修改已有图画.*已完成/}).click()
  await p.waitForFunction(()=>snapshot.current===frame.focus)
  await p.waitForFunction(()=>!document.querySelector('[data-duet-agent-tasks] button'))
  assert.equal(await p.locator('[data-duet-agent-tasks]').isVisible(),false)
  await p.evaluate(()=>{snapshot.current='user-session';frame.rows[0].finished_at=null;frame.rows[0].state='running';panel.update(frame,false)})
  assert.equal(await p.getByRole('button',{name:/修改已有图画.*运行中/}).count(),1)
  await p.evaluate(()=>{frame.rows[0].finished_at=Date.now()-31*60_000;frame.rows[0].state='completed';panel.update(frame,false)})
  assert.equal(await p.locator('[data-duet-agent-tasks] button').count(),0)
  await p.evaluate(()=>{
    const old=Date.now()-90*86400_000
    frame.rows=Array.from({length:61},(_,i)=>({name:'归档任务 '+i,state:'completed',
      session_id:'worker-'+i.toString(16).padStart(32,'0'),finished_at:old}))
    Object.assign(snapshot.byId,Object.fromEntries(frame.rows.map(r=>[r.session_id,{}])))
    panel.update(frame,false)
  })
  await p.getByText('61 未读').click()
  await p.getByRole('button',{name:/查看更多任务/}).click()
  assert.equal(await p.getByRole('button',{name:/归档任务 60.*已完成/}).count(),1)
  await p.keyboard.press('Escape')
  await p.evaluate(()=>document.querySelector('#pet').remove())
  await p.waitForFunction(()=>Math.abs(document.querySelector('[data-duet-agent-tasks] summary').getBoundingClientRect().left-8-document.querySelector('#controls').getBoundingClientRect().right)<2)
  await p.setViewportSize({width:360,height:740})
  await p.waitForFunction(()=>document.querySelector('[data-duet-agent-tasks] summary').getBoundingClientRect().right<=innerWidth-7)
  // Switching presentation must route the already-existing card, without waiting
  // for another task frame. Native actions still execute in the owning DSH page.
  await p.evaluate(()=>{window.surface='desktop';window.native=true;window.dispatchEvent(new Event('duet:avatar-presentation'));surfaces.sync()})
  await p.waitForFunction(()=>!document.querySelector('#native-mirror').hidden)
  assert.equal(await p.locator('[data-duet-agent-tasks]').isVisible(),false)
  const mirror=p.locator('#native-mirror')
  assert.equal(await mirror.getByRole('button').count(),1,'closed details only projects its summary')
  await mirror.getByRole('button',{name:/61 未读/}).click()
  await mirror.getByRole('button',{name:/归档任务 60.*已完成/}).click()
  await p.waitForFunction(()=>snapshot.current==='worker-'+(60).toString(16).padStart(32,'0'))
  await p.waitForFunction(()=>!document.querySelector('#native-mirror').textContent.includes('归档任务 60'))
  await p.evaluate(()=>{
    const consent=document.createElement('section');consent.id='priority-panel';consent.dataset.duetAvatarSurface='100';consent.textContent='授权确认';document.body.append(consent);surfaces.sync()
  })
  assert.equal(await mirror.innerText(),'授权确认')
  await p.evaluate(()=>{document.querySelector('#priority-panel').remove();surfaces.sync()})
  await p.waitForFunction(()=>document.querySelector('#native-mirror').textContent.includes('60 未读'))
  // Three or fewer tasks are cards, not a duplicated summary plus list.
  await p.evaluate(()=>{
    snapshot.current='user-session'
    frame.rows=[['b','running'],['c','completed'],['d','waiting_user']].map(([id,state])=>({
      session_id:'worker-'+id.repeat(32),name:'任务 '+id,state,...(state==='completed'?{finished_at:Date.now()}:{})}))
    panel.update(frame,false);surfaces.sync()
  })
  await p.waitForFunction(()=>document.querySelector('#native-mirror').querySelectorAll('button').length===3)
  assert.equal(await mirror.getAttribute('data-layout'),'tasks')
  assert.equal(await mirror.locator('[data-task-state=running]').count(),1)
  assert.equal(await mirror.locator('[data-task-state=completed]').count(),1)
  assert.equal(await mirror.locator('[data-task-state=waiting]').count(),1)
  assert.deepEqual(await mirror.locator('button').allTextContents(),['任务 b','任务 c','任务 d'])
  assert.equal(await mirror.locator('[data-task-state=running]').evaluate(e=>getComputedStyle(e,'::before').animationName),'duet-task-spin')
  assert.equal(await mirror.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)')
  if(process.env.DUET_NATIVE_TASK_PREVIEW){
    if(process.env.DUET_PREVIEW_FONT){
      await p.route('http://localhost:19184/preview-font',route=>route.fulfill({contentType:'font/otf',path:process.env.DUET_PREVIEW_FONT}))
      await p.addStyleTag({content:"@font-face{font-family:Preview;src:url('/preview-font')}#native-mirror button{font-family:Preview,system-ui!important}"})
      await p.evaluate(()=>document.fonts.load('14px Preview'))
    }
    await mirror.evaluate(e=>{Object.assign(e.style,{position:'fixed',left:'20px',top:'20px',width:'340px'});document.body.style.background='#e9eef2'})
    await mirror.locator('button').evaluateAll(nodes=>nodes.forEach((e,i)=>e.textContent=['制作一个简单好看的 HTML 页面','整理今天的灵感笔记','确认一下页面的配色'][i]))
    await mirror.screenshot({path:process.env.DUET_NATIVE_TASK_PREVIEW})
  }
  // Only the yellow question card is read; running cards remain visible.
  await p.evaluate(()=>{snapshot.current='worker-'+'d'.repeat(32);panel.observe();surfaces.sync()})
  await p.waitForFunction(()=>document.querySelector('#native-mirror').querySelectorAll('button').length===2)
  assert.equal(await mirror.getByRole('button',{name:/任务 d/}).count(),0)
  assert.equal(await mirror.getByRole('button',{name:/任务 b/}).count(),1)
  await p.evaluate(()=>{snapshot.current='user-session';panel.update(frame,false);surfaces.sync()})
  assert.equal(await mirror.getByRole('button',{name:/任务 d/}).count(),0)
  await p.evaluate(()=>{snapshot.current='worker-'+'b'.repeat(32);panel.observe();surfaces.sync()})
  assert.equal(await mirror.getByRole('button',{name:/任务 b/}).count(),1,'viewing a running task never hides it')
  await p.evaluate(()=>{snapshot.current='user-session';frame.rows[2].attention_id='next-question';panel.update(frame,false);surfaces.sync()})
  await p.waitForFunction(()=>document.querySelector('#native-mirror').querySelectorAll('button').length===3)
  assert.equal(await mirror.getByRole('button',{name:/任务 d/}).count(),1,'a new question must not inherit the old read state')
  await p.evaluate(()=>{window.native=false;window.surface='recovering';window.dispatchEvent(new Event('duet:avatar-presentation'));surfaces.sync()})
  assert.equal(await mirror.isVisible(),false)
  assert.equal(await p.locator('[data-duet-agent-tasks]').isVisible(),false,'desktop recovery must not leak its card into DSH')
  await p.evaluate(()=>{window.surface='web';window.dispatchEvent(new Event('duet:avatar-presentation'));surfaces.sync()})
  await p.waitForFunction(()=>getComputedStyle(document.querySelector('[data-duet-agent-tasks]')).visibility==='visible')
  assert.equal(await p.locator('[data-duet-agent-tasks]').isVisible(),true)
  await p.evaluate(async()=>{
    const {noteTaskVisit,noteTaskNoticeVisit}=await import('/shared/work-mode.mjs')
    frame.rows=[]
    noteTaskNoticeVisit({session_id:'worker-'+'0'.repeat(32),state:'waiting_user'})
    for(let i=0;i<320;i++)noteTaskVisit('worker-'+i.toString(16).padStart(32,'0'),Date.now()-60*86400_000)
    panel.update(frame,false)
  })
  assert.equal(await p.locator('[data-duet-agent-tasks] button').count(),0)
  await p.evaluate(()=>panel.reset())
  await p.waitForFunction(()=>document.querySelector('#native-mirror').hidden)
  assert.equal(await p.locator('[data-duet-agent-tasks]').count(),0)
  await p.reload()
  assert.equal(await p.evaluate(async()=>{
    const {visibleTaskRows}=await import('/shared/work-mode.mjs')
    const session_id='worker-'+'0'.repeat(32)
    return visibleTaskRows([{session_id,state:'waiting_user'},{session_id,state:'running'},
      {session_id,finished_at:Date.now()-90*86400_000},{session_id,finished_at:Date.now()}]).length
  }),2)
  assert.equal(await p.locator('[data-duet-agent-tasks]').count(),0)
}finally{await b.close()}
