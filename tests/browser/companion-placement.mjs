import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile} from 'node:fs/promises'
import {WebSocketServer} from 'ws'
import {chromium} from 'playwright'
const root=process.env.DUET_TEST_FRONTEND?new URL(process.env.DUET_TEST_FRONTEND):new URL('../../desktop/frontend/',import.meta.url),token='a'.repeat(64)
const server=createServer(async(req,res)=>{
 const name=new URL(req.url,'http://local').pathname.slice(1)||'index.html'
 if(!['index.html','companion.mjs','renderer.mjs'].includes(name)){res.writeHead(404).end();return}
 res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':'text/html')
 res.end(name==='renderer.mjs'?`export function mountAvatarRenderer(node,{onReady}){queueMicrotask(onReady);return{hitMask:()=>Array(48*64).fill(1),update(){},dispose(){}}}`:await readFile(new URL(name,root)))
}).listen(0,'127.0.0.1');await once(server,'listening')
const wss=new WebSocketServer({server}),browser=await chromium.launch({args:['--no-sandbox']})
let peer
const commands=[]
wss.on('connection',ws=>{peer=ws;ws.on('message',raw=>commands.push(JSON.parse(raw)))})
try{
 const page=await browser.newPage({viewport:{width:380,height:1050}})
 page.setDefaultTimeout(8000)
 await page.addInitScript(({url,token})=>{
  window.__DUET_AVATAR__={url,token,size:'small'};window.calls=[];window.listeners={}
  window.__TAURI__={event:{listen:async(name,fn)=>{listeners[name]=fn;return()=>{delete listeners[name]}}},core:{invoke:async(name,args)=>{calls.push({name,args});if(name==='set_avatar_size')return{size:args.size,scale:.5,fit:1}}}}
 },{url:`ws://127.0.0.1:${server.address().port}`,token})
 await page.clock.install()
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 await page.waitForFunction(()=>calls.some(x=>x.name==='show_avatar'))
 const emitViewport=async v=>{await page.evaluate(v=>listeners['avatar-viewport']({payload:v}),v)}
 const send=v=>peer.send(JSON.stringify(v))
 const panel=(text='请选择一个操作')=>({type:'surface',panel:{id:'s1',revision:1,target:'online',nodes:[{kind:'heading',text:'提示面板'},{kind:'text',text},{kind:'break',text:''},{kind:'button',text:'确认',action:'a1'}]}})
 const rect=id=>page.locator(id).boundingBox()
 const assertBounds=async(minY,maxY)=>{
  const avatar=await rect('#avatar'),tools=await rect('#tools')
  for(const selector of ['#surface','#bubble']){
   const box=await rect(selector);if(!box)continue
   assert.ok(box.x>=11.5&&box.x+box.width<=368.5,`${selector} horizontal bounds`)
   assert.ok(box.y>=minY+11.5&&box.y+box.height<=maxY-11.5,`${selector} visible bounds ${JSON.stringify(box)}`)
   assert.ok(box.y+box.height<=avatar.y-10||box.y>=tools.y+tools.height+10,`${selector} overlaps character/tools`)
  }
  const a=await rect('#surface'),b=await rect('#bubble')
  if(a&&b)assert.ok(a.y+a.height<=b.y-10||b.y+b.height<=a.y-10,'panels overlap')
 }
 // At the top edge, the transparent header is outside the work area.
 await emitViewport([0,410,380,900]);send(panel())
 await page.locator('#surface').waitFor({state:'visible'})
 await assertBounds(410,1050)
 const before=await rect('#surface'),avatarBefore=await rect('#avatar')
 for(let i=0;i<12;i++){
  send(panel(`剩余 ${12-i} 秒`))
  await page.waitForFunction(text=>document.querySelector('#surface').textContent.includes(text),`剩余 ${12-i} 秒`)
  const after=await rect('#surface');assert.equal(after.y,before.y,'countdown moves panel')
 }
 send({type:'frame',mode:'online',ready:true,size:'small',rms:0,text:'测试字幕',utterance:'fixture'})
 await page.locator('#bubble').waitFor({state:'visible'})
 await assertBounds(410,1050)
 const both=await rect('#surface')
 for(let i=0;i<10;i++){
  send({type:'frame',mode:'online',ready:true,size:'small',rms:.1,text:'测试字幕',utterance:'fixture'})
  await emitViewport([0,410,380,900])
  assert.deepEqual(await rect('#surface'),both,'unchanged frames cause drift')
 }
 // When near the lower edge, both cards move above without resizing the window.
 await emitViewport([0,-420,380,1050]);await assertBounds(0,630)
 assert.deepEqual(await rect('#avatar'),avatarBefore,'panel updates moved the character')
 assert.equal(await page.evaluate(()=>calls.filter(x=>x.name==='set_avatar_size').length),1)
 send({type:'surface',panel:null});await page.locator('#surface').waitFor({state:'hidden'})
 await emitViewport([0,410,380,900])
 await page.evaluate(()=>document.querySelector('#close').click())
 const confirmation=page.locator('[data-avatar-close-confirm]');await confirmation.waitFor({state:'visible'})
 const c=await confirmation.boundingBox(),tools=await rect('#tools')
 assert.ok(c.y>=tools.y+tools.height+10,'close confirmation covers toolbar')
 assert.ok(c.y+c.height<=1038,'close confirmation outside viewport')
 await page.keyboard.press('Escape')
 // Streaming captions must follow the newest line after positioning has measured
 // and constrained the bubble, including hidden-to-visible and viewport changes.
 const assertTail=async()=>{
  const state=await page.locator('#bubble').evaluate(el=>({top:el.scrollTop,height:el.clientHeight,total:el.scrollHeight}))
  assert.ok(state.total>state.height,'fixture must overflow the subtitle box')
  assert.ok(state.total-state.height-state.top<=1.5,`latest subtitle line is clipped: ${JSON.stringify(state)}`)
 }
 await emitViewport([0,0,380,1050])
 send({type:'frame',mode:'online',ready:true,size:'small',rms:0,text:'',utterance:'long'})
 await page.locator('#bubble').waitFor({state:'hidden'})
 for(let i=0;i<8;i++){
  const text=('长句字幕应该始终跟随最新内容，不要跳回开头。'.repeat(14)+`结尾${i}`).slice(-240)
  send({type:'frame',mode:'online',ready:true,size:'small',rms:0,text,utterance:'long'})
  await page.waitForFunction(text=>document.querySelector('#text').textContent===text,text)
  await assertTail()
 }
 assert.ok((await rect('#bubble')).height>108,'long captions should have more reading room')
 await emitViewport([0,410,380,900]);await assertTail();await assertBounds(410,1050)
 send(panel('字幕与提示同时出现'))
 await page.locator('#surface').waitFor({state:'visible'});await assertTail();await assertBounds(410,1050)
 send({type:'surface',panel:null});await page.locator('#surface').waitFor({state:'hidden'})
 await assertTail()
 await page.clock.setSystemTime(new Date(Date.now()+8*60*60*1000))
 await page.clock.runFor(1100)
 assert.equal(await page.evaluate(()=>calls.some(c=>c.name==='hide_avatar')),false,'sleep must not close a healthy companion')
 await page.clock.resume()
 // Native WebView menu uses the same hit-mask carrier without opening voice.
 send({type:'local_state',protocol:'avatar_local_v1',revision:1,items:[{id:'p',session_id:'s',status:'question',pending:true,unread:true}],size:'small',bubble:'medium',enabled:true,available:true})
 await page.locator('[data-duet-notice-badge]').waitFor()
 assert.match(await page.locator('[data-duet-notice-badge]').evaluate(e=>e.style.left),/^[0-9.]+px$/)
 await page.locator('#avatar').evaluate(e=>e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:500})))
 const menu=page.getByRole('menu',{name:'duet 形象菜单'})
 await menu.waitFor()
 const labels=await menu.locator('button>span:not([data-value]):not([data-switch]):not([data-size-icon])').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().left))
 assert.ok(labels.length>=8)
 assert.ok(Math.max(...labels)-Math.min(...labels)<1,'native menu labels must share one left edge: '+JSON.stringify(labels))
 await menu.screenshot({path:new URL('../../artifacts/menu-native-aligned.png',import.meta.url).pathname})
 assert.doesNotMatch(await menu.innerText(),/交互模式|播报模式|关闭语音/)
 const dragCount=await page.evaluate(()=>calls.filter(c=>c.name==='drag_avatar').length)
 await page.locator('#avatar').dispatchEvent('pointerdown',{button:0,buttons:1,clientX:140,clientY:500})
 await page.locator('#avatar').dispatchEvent('pointermove',{buttons:1,clientX:170,clientY:520})
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='drag_avatar').length),dragCount)
 await menu.waitFor({state:'hidden'})
 await page.locator('#avatar').evaluate(e=>e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:500})))
 await menu.locator('[data-menu-action=bubble_panel]').click()
 await menu.locator('[data-menu-action=bubble]').click()
 await new Promise(r=>setTimeout(r,50))
 assert.ok(commands.some(c=>c.type==='menu_action'&&c.action==='bubble'&&c.value==='large'))
 assert.ok(!commands.some(c=>c.type==='mode'))
 await menu.getByRole('menuitem',{name:'返回',exact:true}).click()
 await menu.getByRole('menuitem',{name:'打开 DSH',exact:true}).click()
 await page.waitForFunction(()=>calls.some(c=>c.name==='focus_dsh'))
 await new Promise(r=>setTimeout(r,50))
 assert.ok(commands.some(c=>c.type==='menu_action'&&c.action==='open_dsh'))
 const sentBefore=commands.filter(c=>c.type==='menu_action'&&c.action==='open_dsh').length
 await page.evaluate(()=>{const original=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(name,args)=>name==='focus_dsh'?Promise.reject(Error('fixture denied')):original(name,args)})
 await page.locator('#avatar').evaluate(e=>e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:500})))
 await menu.getByRole('menuitem',{name:'打开 DSH',exact:true}).click()
 await page.getByLabel('操作提示').waitFor()
 assert.match(await page.getByLabel('操作提示').innerText(),/未能唤起 DSH/)
 assert.equal(commands.filter(c=>c.type==='menu_action'&&c.action==='open_dsh').length,sentBefore,'native failure must not report a successful open')
 console.log('Placement: top/bottom bounds, no overlapping cards, stable countdown/audio frames, stable character, one native resize, close confirmation below toolbar passed')
}finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r))}
