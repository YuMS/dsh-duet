import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile,mkdir} from 'node:fs/promises'
import {WebSocketServer} from 'ws'
import {chromium} from 'playwright'
const root=new URL('../../desktop/frontend/',import.meta.url),token='a'.repeat(64),messages=[]
const nativeConfig=JSON.parse(await readFile(new URL('../../desktop/src-tauri/tauri.conf.json',import.meta.url),'utf8'))
const capability=JSON.parse(await readFile(new URL('../../desktop/src-tauri/capabilities/avatar.json',import.meta.url),'utf8'))
assert.deepEqual(capability.windows,['avatar'])
assert.deepEqual(capability.permissions,['core:event:allow-listen','core:event:allow-unlisten'])
const server=createServer(async(req,res)=>{
 const name=new URL(req.url,'http://local').pathname.slice(1)||'index.html'
 if(!['index.html','renderer.mjs','companion.mjs','character.glb'].includes(name)){res.writeHead(404);res.end();return}
 res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.html')?'text/html':'model/gltf-binary')
 res.setHeader('Content-Security-Policy',nativeConfig.app.security.csp)
 res.end(await readFile(new URL(name,root)))
}).listen(0,'127.0.0.1');await once(server,'listening')
const wss=new WebSocketServer({server}),browser=await chromium.launch({args:['--no-sandbox','--enable-unsafe-swiftshader']})
let peer,heartbeat
wss.on('connection',(ws,req)=>{assert.equal(req.headers['sec-websocket-protocol'],`duet-avatar-${token}`);peer=ws;ws.on('message',raw=>messages.push(JSON.parse(raw)))})
try{
 const page=await browser.newPage({viewport:{width:280,height:490}}),errors=[]
 page.setDefaultTimeout(15000)
 page.on('pageerror',e=>errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Couldn't load texture/i.test(m.text()))errors.push(m.text())})
 await page.exposeFunction('resizeFixture',async ({size,panel})=>{
  const scale={large:1,medium:.75,small:.5}[size]
  await page.setViewportSize({width:panel?380:280,height:Math.round(210+280*scale+(panel?280:0))})
  return{size,scale,fit:1}
 })
 await page.addInitScript(({url,token})=>{
  window.__DUET_AVATAR__={url,token};window.calls=[]
  window.nativeListeners={}
  window.__TAURI__={event:{listen:async(name,fn)=>{nativeListeners[name]=fn;return()=>{delete nativeListeners[name];calls.push({name:'unlisten'})}}},core:{invoke:async(name,args)=>{calls.push({name,args});if(name==='set_avatar_size')return resizeFixture(args);if(name==='avatar_geometry')return{total_resolution:{width:6400,height:2160},desktop_origin:{x:-2560,y:0},window_origin:{x:-1500,y:100},scale:2}}}}
  window.AudioContext=class{constructor(){throw Error('companion must not play audio')}}
 },{url:`ws://127.0.0.1:${server.address().port}`,token})
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 console.log('Desktop: page loaded')
 await page.waitForFunction(()=>calls.some(c=>c.name==='show_avatar'),null,{timeout:60000})
 assert.ok(messages.some(m=>m.type==='ready'))
 await page.waitForFunction(()=>calls.some(c=>c.name==='avatar_geometry'))
 for(let i=0;i<100&&!messages.some(m=>m.type==='avatar_geometry');i++)await page.waitForTimeout(20)
 const geometry=messages.find(m=>m.type==='avatar_geometry').position
 assert.deepEqual(geometry.total_resolution,{width:6400,height:2160})
 assert.deepEqual(geometry.desktop_origin,{x:-2560,y:0})
 const character=await page.locator('#avatar').boundingBox()
 assert.deepEqual(geometry.avatar_position,{x:-1500+character.x*2,y:100+character.y*2,width:character.width*2,height:character.height*2})
 console.log('Desktop: GLB and initial native layout ready')
 const send=value=>peer.send(JSON.stringify(value))
 let frame={type:'frame',mode:'online',ready:false,rms:.2,viseme:'A',text:'好的，我来帮你。',utterance:'fixture'}
 heartbeat=setInterval(()=>{if(peer.readyState===1)send(frame)},200)
 send(frame);await page.waitForFunction(()=>document.querySelector('#text').textContent==='好的，我来帮你。')
 assert.equal(await page.locator('[data-mode=online]').getAttribute('aria-busy'),'true')
 frame={...frame,ready:true};send(frame);await page.waitForFunction(()=>document.querySelector('[data-mode=online]').getAttribute('aria-busy')==='false')
 await page.waitForFunction(()=>calls.some(c=>c.name==='avatar_hit_mask'&&c.args.regions.length===1&&c.args.mask.some(x=>x)))
 assert.equal(await page.locator('#tools').evaluate(el=>getComputedStyle(el).opacity),'0')
 assert.equal(await page.locator('#tools').evaluate(el=>getComputedStyle(el).pointerEvents),'none')
 const showToolbar=async()=>{
  const p=await page.evaluate(()=>{
   const h=calls.filter(c=>c.name==='avatar_hit_mask').at(-1).args
   let best=-1,d=Infinity;h.mask.forEach((v,i)=>{const dist=(i%48-24)**2+(Math.floor(i/48)-32)**2;if(v&&dist<d){best=i;d=dist}})
   return{x:h.avatar[0]+(best%48+.5)*h.avatar[2]/48,y:h.avatar[1]+(Math.floor(best/48)+.5)*h.avatar[3]/64}
  })
  await page.mouse.move(1,1)
  await page.mouse.move(p.x,p.y)
  // The OS poller continues to deliver positions while the webview passes through.
  await page.evaluate(p=>nativeListeners['avatar-pointer']({payload:{...p,overAvatar:true}}),p)
  await page.waitForFunction(()=>document.querySelector('#tools').dataset.revealed==='true')
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#tools')).opacity==='1')
  return p
 }
 await showToolbar()
 await page.waitForFunction(()=>calls.filter(c=>c.name==='avatar_hit_mask').at(-1)?.args.regions.length===3)
 const hit=await page.evaluate(()=>calls.filter(c=>c.name==='avatar_hit_mask').at(-1).args)
 assert.deepEqual(hit.avatar,[60,420,260,280]);assert.equal(hit.mask.length,48*64)
 const bubble=await page.locator('#bubble').boundingBox(),avatar=await page.locator('#avatar').boundingBox()
 assert.ok(bubble.y>=0&&bubble.y+bubble.height<avatar.y)
 const canvas=await page.locator('#avatar canvas').elementHandle()
 await mkdir(new URL('../../artifacts/avatar/',import.meta.url),{recursive:true})
 for(const [size,scale] of [['medium',.75],['small',.5],['large',1]]){
  await page.locator('#size').focus();await page.keyboard.press(size==='small'?'Space':'Enter')
  await page.waitForTimeout(60);assert.ok(messages.some(m=>m.type==='size'&&m.size===size))
  frame={...frame,size,text:'长字幕验证。'.repeat(35)};send(frame)
  await page.waitForFunction(size=>document.querySelector('#stage').dataset.size===size,size)
  console.log(`Desktop: ${size} layout applied`)
  const anchored=await page.locator('#avatar').boundingBox()
  const resizeCount=await page.evaluate(()=>calls.filter(c=>c.name==='set_avatar_size').length)
  for(const text of ['提示','很长的提示内容。'.repeat(45),'']){
   send({type:'surface',panel:text?{id:'s99',revision:1,nodes:[{kind:'text',text}]}:null})
   await page.waitForFunction(text=>text?document.querySelector('#surface').textContent===text:document.querySelector('#surface').hidden,text)
   assert.deepEqual(await page.locator('#avatar').boundingBox(),anchored,`${size}: popup must not move avatar`)
   assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='set_avatar_size').length),resizeCount,'popup must not resize native window')
  }
  const box=await page.locator('#avatar').boundingBox()
  assert.equal(box.width,260*scale);assert.equal(box.height,280*scale)
  assert.equal((await page.locator('#bubble').boundingBox()).width,256)
  assert.equal(await page.locator('#bubble').evaluate(el=>getComputedStyle(el).fontSize),'13px')
  assert.equal(await page.locator('#brand').isVisible(),true)
  assert.equal(await page.locator('#brand').evaluate(el=>getComputedStyle(el).fontSize),'21px')
  assert.equal(await page.locator(`#size [data-size-square=${size}]`).getAttribute('stroke-width'),'2.8')
  assert.equal(await page.locator('#size rect[stroke-width="1"]').count(),2)
  assert.equal(await page.locator('#size [stroke-dasharray]').count(),0)
  assert.equal(await page.locator('#status').evaluate(el=>getComputedStyle(el).clipPath),'inset(50%)')
  await page.waitForFunction(w=>calls.filter(c=>c.name==='avatar_hit_mask').at(-1)?.args.avatar[2]===w,260*scale)
  for(const selector of ['#tools','#bubble','#close','#size','[data-mode=online]','[data-mode=tts_only]']){
   const r=await page.locator(selector).boundingBox(),v=page.viewportSize()
   assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=v.width+.5&&r.y+r.height<=v.height+.5,`${size} ${selector}: ${JSON.stringify(r)}`)
  }
  assert.ok((await page.locator('#close').boundingBox()).height>=22)
  assert.ok(await canvas.evaluate(node=>node===document.querySelector('#avatar canvas')),'resize must not reload the GLB')
  await page.locator('#close').click()
  assert.equal(await page.locator('[data-avatar-close-confirm]').count(),1)
  const overlay=await page.locator('[data-avatar-close-overlay]').boundingBox()
  assert.ok(overlay.width<=300&&overlay.height<200,'native confirmation must be a compact card, not a carrier-size overlay')
  assert.equal(await page.locator('[data-avatar-close-confirm] button').first().evaluate(e=>getComputedStyle(e).fontSize),'13px')
  assert.deepEqual(await page.locator('#avatar').boundingBox(),anchored,'confirmation must not move avatar')
  await page.evaluate(()=>nativeListeners['avatar-viewport']({payload:[0,420,380,1000]}))
  const upper=await page.locator('[data-avatar-close-confirm]').boundingBox()
  assert.ok(upper.y>=432&&upper.y+upper.height<=page.viewportSize().height-11,'upper-screen popup must stay in the visible part of the carrier')
  assert.deepEqual(await page.locator('#avatar').boundingBox(),anchored,'screen clipping must not move avatar')
  await page.evaluate(()=>nativeListeners['avatar-viewport']({payload:[0,0,380,1000]}))
  assert.equal(await page.locator('[data-avatar-close-confirm]').getAttribute('aria-label'),'隐藏拟人角色？')
  assert.equal(await page.locator('#tools').getAttribute('data-confirming'),'true')
  const dialog=await page.locator('[data-avatar-close-confirm]').boundingBox(),v=page.viewportSize()
  assert.ok(dialog.x>=0&&dialog.y>=0&&dialog.x+dialog.width<=v.width&&dialog.y+dialog.height<=v.height)
  await page.waitForFunction(()=>calls.filter(c=>c.name==='avatar_hit_mask').at(-1)?.args.regions.length===1)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#tools').getAttribute('data-confirming'),'false')
  assert.equal(messages.filter(m=>m.type==='hide').length,0)
  assert.equal(await page.locator('#avatar canvas').count(),1)
  await page.locator('#close').evaluate(el=>el.blur());await page.mouse.move(1,1)
  await page.evaluate(()=>nativeListeners['avatar-pointer']({payload:{x:1,y:1,overAvatar:false}}))
  await page.waitForFunction(()=>document.querySelector('#tools').dataset.interactive==='false')
  assert.equal(await page.locator('#tools').evaluate(el=>getComputedStyle(el).opacity),'0')
  await page.waitForFunction(()=>calls.filter(c=>c.name==='avatar_hit_mask').at(-1)?.args.regions.length===1)
  await page.screenshot({path:new URL(`../../artifacts/avatar/desktop-r4-${size}.png`,import.meta.url).pathname})
  if(size==='small'){
    await showToolbar()
    await page.screenshot({path:new URL('../../artifacts/avatar/desktop-r4-small-hover.png',import.meta.url).pathname})
  }
 }
 // Queued resize replies must not revert the last preference.
 send({...frame,size:'small'});send({...frame,size:'medium'});frame={...frame,size:'large'};send(frame)
 await page.waitForFunction(()=>document.querySelector('#stage').dataset.size==='large')
 await showToolbar()
 await page.locator('[data-mode=tts_only]').click()
 await page.waitForTimeout(50);assert.ok(messages.some(m=>m.type==='mode'&&m.mode==='tts_only'))
 assert.equal(await page.locator('[data-mode=online]').getAttribute('aria-pressed'),'true','only an owning-page frame changes mode')
 frame={...frame,ready:true,mode:'tts_only'};send(frame);await page.waitForFunction(()=>document.querySelector('[data-mode=tts_only]').getAttribute('aria-pressed')==='true')
 send({type:'input_effect',text:'<b>输入一段内容</b>'});await page.waitForFunction(()=>document.querySelector('#bubble').dataset.input==='true')
 assert.equal(await page.locator('#keyboard').isVisible(),true);assert.equal(await page.locator('#text b').count(),0)
 await mkdir(new URL('../../artifacts/avatar/',import.meta.url),{recursive:true})
 await page.screenshot({path:new URL('../../artifacts/avatar/desktop.png',import.meta.url).pathname})
 send({type:'clear_input_effect'});await page.waitForFunction(()=>document.querySelector('#bubble').dataset.input==='false')
 const dragPoint=await showToolbar()
 await page.mouse.down();await page.mouse.move(dragPoint.x+6,dragPoint.y+5);await page.mouse.up()
 assert.ok(await page.evaluate(()=>calls.some(c=>c.name==='drag_avatar')))
 clearInterval(heartbeat)
 send({type:'surface',panel:{id:'s1',revision:1,target:'online',nodes:[{kind:'heading',text:'交互模式教学'},{kind:'text',text:'<img src=x onerror=alert(1)> 您可以说，输入，今天的计划。'},{kind:'button',text:'确认发送',action:'a1'},{kind:'button',text:'启用声音',action:'a2',gesture:true}]}})
 await page.waitForFunction(()=>!document.querySelector('#surface').hidden)
 assert.equal(await page.locator('#surface img').count(),0)
 assert.equal(await page.getByRole('button',{name:'启用声音',exact:true}).isDisabled(),true)
 await page.getByRole('button',{name:'确认发送',exact:true}).click()
 await page.waitForTimeout(50)
 assert.ok(messages.some(m=>m.type==='surface_action'&&m.id==='s1'&&m.revision===1&&m.action==='a1'))
 await page.waitForFunction(()=>calls.filter(c=>c.name==='avatar_hit_mask').at(-1)?.args.regions.some(r=>r[2]===356))
 assert.equal(await page.locator('[data-mode=online]').getAttribute('data-teaching'),'')
 await page.screenshot({path:new URL('../../artifacts/avatar/desktop-tutorial-surface.png',import.meta.url).pathname})
 send({type:'surface',panel:null});await page.waitForFunction(()=>document.querySelector('#surface').hidden)
 await page.waitForFunction(()=>document.querySelector('#bubble').hidden,null,{timeout:4000})
 await showToolbar();await page.locator('#close').click();await page.locator('[data-avatar-close-choice=cancel]').click()
 assert.equal(messages.filter(m=>m.type==='hide').length,0)
 await page.locator('#close').evaluate(el=>{el.click();el.click()})
 assert.equal(await page.locator('[data-avatar-close-confirm]').count(),1)
 await page.locator('[data-avatar-close-choice=confirm]').click();await page.waitForFunction(()=>calls.some(c=>c.name==='hide_avatar'))
 assert.equal(messages.filter(m=>m.type==='hide').length,1)
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='hide_avatar').length),1)
 assert.equal(await page.evaluate(()=>Object.keys(nativeListeners).length),0)
 assert.equal(await page.locator('#avatar canvas').count(),0);assert.deepEqual(errors,[])
 console.log('Desktop frontend: native CSP, real GLB textures, three sizes, scaled hit regions, IPC ownership and lifecycle passed (OS APIs mocked)')
}catch(error){console.error(error);throw error}
finally{clearInterval(heartbeat);await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));server.closeAllConnections()}
