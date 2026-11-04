import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({args:['--no-sandbox']})
try {
 const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('http://127.0.0.1:19355/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(/^\/src\/(client|shared|avatar)\/[a-z-]+\.mjs$/.test(path))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../..'+path,import.meta.url),'utf8')})
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><body><div id="dsh-duet-entry" data-duet-surface="control-entry">duet</div><div id="invalid-panel" data-duet-avatar-surface="control-entry">not a panel</div><div id="avatar" style="position:fixed;left:40px;top:300px;width:180px;height:230px"></div><script type="module">
  import {mountAvatarSurfaces} from '/src/client/avatar-surfaces.mjs'
  import {createAudioUploadConsent} from '/src/client/consent.mjs'
  window.native=false;window.audioReady=false;window.messages=[];window.clicked=0;window.accepted=0;
  window.surfaces=mountAvatarSurfaces({avatar:()=>({presentation:()=>({native,anchor:document.getElementById('avatar')}),surface:m=>messages.push(m)}),canActivate:()=>audioReady})
  window.consent=createAudioUploadConsent(null)
  window.make=()=>{const p=document.createElement('section');p.dataset.duetAvatarSurface='80';p.style.cssText='position:fixed;left:0;top:0;width:300px';p.innerHTML='<h3>教学</h3><label><input type="checkbox">声音已打开</label><button>继续</button><button data-duet-user-gesture>开始教学</button>';p.querySelector('button').onclick=()=>clicked++;p.querySelectorAll('button')[1].onclick=()=>clicked++;document.body.append(p);window.panel=p;surfaces.sync()}
  make()
  </script></body>`})
 })
 await page.goto('http://127.0.0.1:19355/')
 await page.waitForFunction(()=>window.surfaces)
 const box=await page.locator('[data-duet-avatar-surface="80"]').boundingBox()
 assert.equal(box.x,232);assert.equal(box.y,300)
 await page.evaluate(()=>{native=true;surfaces.sync()})
 assert.equal(await page.locator('#dsh-duet-entry').isVisible(),true,'sidebar branding must never become a native panel')
 assert.equal(await page.locator('#invalid-panel').isVisible(),true,'invalid panel priority must be ignored')
 assert.equal(await page.locator('#dsh-duet-entry').getAttribute('data-duet-surface-positioned'),null)
 assert.ok((await page.evaluate(()=>messages.at(-1).panel.nodes)).some(n=>n.text==='教学'),'mirror the actual panel, not sidebar branding')
 assert.equal(await page.locator('[data-duet-avatar-surface="80"]').isVisible(),true,'real-click steps must retain a visible DSH counterpart')
 await page.evaluate(()=>{
   const p=messages.at(-1).panel,b=p.nodes.find(n=>n.text==='开始教学');surfaces.action({type:'surface_action',id:p.id,revision:p.revision,action:b.action})
 })
 assert.equal(await page.evaluate(()=>clicked),0,'native IPC cannot unlock page audio')
 await page.evaluate(async()=>{
  const {mountCompanionSurface}=await import('/src/avatar/surface.mjs')
  const mirror=document.createElement('section');document.body.append(mirror)
  const view=mountCompanionSurface(mirror,{send(){},changed(){}})
  view.update(messages.at(-1))
  if(mirror.querySelector('.gesture-note')?.textContent!=='请回到 DSH，点击“开始教学”。')throw Error('tutorial must name its actual start button')
  if(!mirror.querySelector('button:last-child')?.disabled)throw Error('native tutorial must not bypass the page gesture')
  mirror.remove()
 })
 await page.evaluate(()=>{audioReady=true;surfaces.sync()})
 assert.equal(await page.locator('[data-duet-avatar-surface="80"]').isVisible(),false)
 await page.evaluate(()=>{
  const p=messages.at(-1).panel,b=p.nodes.find(n=>n.text==='继续'),event={type:'surface_action',id:p.id,revision:p.revision,action:b.action}
  surfaces.action(event);surfaces.action(event)
 })
 assert.equal(await page.evaluate(()=>clicked),1,'duplicate/stale actions are ignored')
 await page.evaluate(()=>{
  const p=messages.at(-1).panel,b=p.nodes.find(n=>n.kind==='checkbox');surfaces.action({type:'surface_action',id:p.id,revision:p.revision,action:b.action,checked:true})
 })
 assert.equal(await page.locator('input').isChecked(),true)
 await page.evaluate(()=>{native=false;surfaces.sync()})
 assert.equal(await page.locator('[data-duet-avatar-surface="80"]').isVisible(),true,'helper exit restores the same panel')
 assert.equal(await page.locator('input').isChecked(),true)
 await page.evaluate(()=>{native=true;audioReady=false;consent.request(()=>accepted++,undefined,{origin:'avatar'});surfaces.sync()})
 assert.equal(await page.locator('#duet-audio-consent').isVisible(),true)
 assert.ok((await page.evaluate(()=>messages.at(-1).panel.nodes)).some(n=>n.gesture&&n.text==='同意并开启'))
 await page.getByRole('button',{name:'同意并开启',exact:true}).click()
 assert.equal(await page.evaluate(()=>accepted),1)
 await page.evaluate(()=>{panel.remove();surfaces.sync()})
 assert.equal(await page.evaluate(()=>messages.at(-1).panel),null)
 await page.evaluate(()=>{native=false;make();surfaces.dispose()})
 assert.equal(await page.locator('[data-duet-surface-positioned]').count(),0)
 await page.evaluate(async()=>{
  const {mountCompanionSurface}=await import('/src/avatar/surface.mjs')
  const root=document.createElement('section');document.body.append(root)
  const view=mountCompanionSurface(root,{send:m=>messages.push(m),changed:()=>{}})
  const update=revision=>view.update({type:'surface',panel:{id:'s20',revision,nodes:[{kind:'button',action:'a20',text:'确认发送'}]}})
  update(1);root.querySelector('button').focus();update(2)
  if(document.activeElement!==root.querySelector('button'))throw Error('focus was lost on update')
  root.querySelector('button').click()
  if(messages.at(-1).revision!==2)throw Error('stale callback after update')
  view.update({type:'surface',panel:null});if(!root.hidden)throw Error('surface did not dismiss')
 })

 // Real rating lifecycle: a countdown repaint must not invalidate skip in transit.
 await page.evaluate(async()=>{
  const {mountRating}=await import('/src/client/feedback.mjs')
  document.querySelectorAll('[data-duet-avatar-surface]').forEach(n=>n.remove())
  const {mountCompanionSurface}=await import('/src/avatar/surface.mjs')
  const {mountAvatarSurfaces}=await import('/src/client/avatar-surfaces.mjs')
  window.mirror=document.createElement('section');mirror.id='rating-mirror';mirror.style.cssText='position:fixed;left:600px;top:20px';document.body.append(mirror)
  window.sent=[]
  const view=mountCompanionSurface(mirror,{send:m=>sent.push(m),changed:()=>{}})
  window.manager=mountAvatarSurfaces({avatar:()=>({presentation:()=>({native:true}),surface:m=>{messages.push(m);view.update(m)}})})
  window.startRating=()=>{window.rating=mountRating(document.getElementById('avatar'),'fake-ticket',{origin:'avatar'});manager.sync()}
  startRating()
  const p=messages.at(-1).panel,b=p.nodes.find(n=>n.label==='暂不评价')
  const event={type:'surface_action',id:p.id,revision:p.revision,action:b.action}
  document.querySelector('[data-duet-avatar-surface="60"] [data-duet-live-text]').textContent='暂不评价（9s）';manager.sync()
  if(messages.at(-1).panel.revision!==p.revision)throw Error('countdown invalidated skip')
  manager.action(event)
  if(document.querySelector('[data-duet-avatar-surface="60"]')||!mirror.hidden)throw Error('skip did not dismiss both surfaces')
  startRating()
  window.originalSkip=mirror.querySelector('[aria-label="暂不评价"]')
 })
 const skip=page.locator('#rating-mirror [aria-label="暂不评价"]'),skipBox=await skip.boundingBox()
 await page.mouse.move(skipBox.x+skipBox.width/2,skipBox.y+skipBox.height/2);await page.mouse.down()
 await page.evaluate(()=>{
  document.querySelector('[data-duet-avatar-surface="60"] [data-duet-live-text]').textContent='暂不评价（8s）';manager.sync()
  if(originalSkip!==mirror.querySelector('[aria-label="暂不评价"]'))throw Error('countdown replaced the pressed button')
 })
 await page.mouse.up()
 assert.equal(await page.evaluate(()=>sent.length),1,'pointerup must still deliver skip across repaint')
 await page.evaluate(()=>{manager.action(sent.pop());if(!mirror.hidden)throw Error('skip stuck');startRating()})
 // Actual question changes, unlike cosmetic countdowns, must fence old actions.
 await page.evaluate(()=>{
  const p=messages.at(-1).panel,b=p.nodes.find(n=>n.label==='暂不评价')
  document.querySelector('[data-duet-avatar-surface="60"] h3').textContent='另一份确认';manager.sync()
  manager.action({type:'surface_action',id:p.id,revision:p.revision,action:b.action})
  if(!document.querySelector('[data-duet-avatar-surface="60"]'))throw Error('stale action accepted after semantic change')
  rating.dispose();manager.sync();manager.dispose();mirror.remove()
 })


 // Playback activation card remains styled under a host button reset.
 await page.evaluate(async()=>{
  const {audioUnlockPanel}=await import('/src/shared/avatar-ui.mjs')
  const {mountAvatarSurfaces}=await import('/src/client/avatar-surfaces.mjs')
  const reset=document.createElement('style');reset.textContent='button {background:none;border:0;padding:0;font:inherit;color:inherit}';document.head.append(reset)
  window.enabledSound=0;window.cancelledSound=0;window.activeClick=false
  window.openSound=()=>{window.soundPanel=audioUnlockPanel({onEnable:()=>{enabledSound++;activeClick=navigator.userActivation.isActive;soundPanel.remove()},onCancel:()=>{cancelledSound++;soundPanel.remove()}});document.body.append(soundPanel)}
  openSound()
  window.projections=[]
  window.soundReady=false
  window.routing=mountAvatarSurfaces({avatar:()=>({presentation:()=>({native:true,anchor:document.getElementById('avatar')}),surface:m=>projections.push(m)}),canActivate:()=>soundReady})
  routing.sync()
  if(projections.at(-1).panel.nodes.length!==1||projections.at(-1).panel.nodes[0].kind!=='text')throw Error('audio hint must be text only')
  if(projections.at(-1).panel.nodes[0].text!=='请回到 DSH，点击“启动音频播放”。')throw Error('wrong hint')
  if(soundPanel.hasAttribute('data-duet-surface-native'))throw Error('real activation button was hidden')
  for(const ready of [true,false,true]){
   soundReady=ready;routing.sync()
   const nodes=projections.at(-1).panel.nodes
   if(nodes.length!==1||nodes[0].text!=='请回到 DSH，点击“启动音频播放”。')throw Error('audio readiness restored full activation card on avatar')
   if(soundPanel.hasAttribute('data-duet-surface-native')||soundPanel.hasAttribute('data-duet-surface-positioned'))throw Error('activation card must stay in DSH')
  }
 })
 for(const colorScheme of ['light','dark']){
  await page.emulateMedia({colorScheme});await page.setViewportSize({width:320,height:640})
  const card=await page.locator('[data-duet-audio-unlock]').boundingBox()
  assert.ok(card.x>=0&&card.x+card.width<=320&&card.y>=0&&card.y+card.height<=640)
  const primary=page.locator('[data-duet-audio-unlock] button').last()
  assert.equal(await primary.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(220, 239, 255)')
  assert.equal(await primary.getAttribute('data-duet-user-gesture'),'')
  assert.ok((await primary.boundingBox()).height>=40)
 }
 await page.locator('[data-duet-audio-unlock]').screenshot({path:'/tmp/duet-sound-card.png'})
 await page.getByRole('button',{name:'暂不开启',exact:true}).click()
 assert.equal(await page.evaluate(()=>cancelledSound),1);assert.equal(await page.evaluate(()=>enabledSound),0)
 await page.evaluate(()=>openSound())
 await page.getByRole('button',{name:'启动音频播放',exact:true}).click()
 assert.equal(await page.evaluate(()=>enabledSound),1);assert.equal(await page.evaluate(()=>activeClick),true)
 assert.equal(await page.locator('[data-duet-audio-unlock]').count(),0)
 await page.evaluate(async()=>{
  routing.dispose()
  const {mountRating}=await import('/src/client/feedback.mjs')
  const {avatarCloseConfirmation}=await import('/src/shared/avatar-ui.mjs')
  const {createAudioUploadConsent}=await import('/src/client/consent.mjs')
  const {mountAvatarSurfaces}=await import('/src/client/avatar-surfaces.mjs')
  const rows=[],manager=mountAvatarSurfaces({avatar:()=>({presentation:()=>({native:true}),surface:m=>rows.push(m)})})
  const rating=mountRating(document.getElementById('avatar'),'page-ticket')
  const confirm=avatarCloseConfirmation({floating:true});void confirm.ask()
  const consent=createAudioUploadConsent(null);consent.request(()=>{})
  manager.sync()
  if(rows.at(-1)?.panel)throw Error('page-origin panels leaked to avatar')
  for(const p of document.querySelectorAll('[data-duet-surface-origin="page"]'))
    if(p.hasAttribute('data-duet-surface-native')||p.hasAttribute('data-duet-surface-positioned'))throw Error('page panel relocated')
  consent.cancel();confirm.cancel();rating.dispose();manager.sync();manager.dispose()
 })

 assert.deepEqual(errors,[])
 console.log('Avatar surfaces: web anchoring, native mirroring, gesture guard, consent, stale-action fencing and fallback passed')
} finally {await browser.close()}
