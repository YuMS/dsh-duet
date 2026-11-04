import {mountAvatarRenderer} from './renderer.mjs'
import {avatarFrame,avatarInputEffect,avatarSize,AvatarHeartbeat} from '../shared/avatar.mjs'
import {sizeButton,nextAvatarSize,avatarCloseConfirmation} from '../shared/avatar-ui.mjs'
import {mountAvatarToolbar,maskContains} from './toolbar.mjs'
import {mountCompanionSurface} from './surface.mjs'
import {AVATAR_UI_PROTOCOL} from '../shared/avatar-surface.mjs'
import {mountAvatarMenu} from '../shared/avatar-menu-ui.mjs'
import {avatarGeometry} from '../shared/avatar-activity.mjs'
const config=window.__DUET_AVATAR__,invoke=(name,args)=>window.__TAURI__.core.invoke(name,args)
if(!config || !/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(config.url) || !/^[a-f0-9]{64}$/.test(config.token))throw Error('companion must be started by duet')
const $=id=>document.getElementById(id),socket=new WebSocket(config.url,[`duet-avatar-${config.token}`])
let ready=false,failed=false,closed=false,last=Date.now(),model,inputTimer,maskPending=null,maskAgain=false,sizePending=null,appliedSize=null
let desiredSize=avatarSize(config.size)
let desiredPanel=false, surfaceSide=null,menu,bubbleSize='medium',lastNotice
let frame={mode:'off',ready:false,rms:0,viseme:'A',text:'',utterance:''},input=null,alphaMask=[],pointerUnlisten,viewportUnlisten
let visibleViewport=null
let geometryBusy=false,lastGeometry=''
async function reportGeometry(){
  if(!ready||closed||geometryBusy)return
  geometryBusy=true
  try{const geometry=await invoke('avatar_geometry'),r=$('avatar').getBoundingClientRect(),s=geometry.scale
    const position=avatarGeometry({space:'desktop_physical',total_resolution:geometry.total_resolution,desktop_origin:geometry.desktop_origin,scale:s,avatar_position:{x:geometry.window_origin.x+r.x*s,y:geometry.window_origin.y+r.y*s,width:r.width*s,height:r.height*s}})
    const encoded=JSON.stringify(position);if(position&&encoded!==lastGeometry){lastGeometry=encoded;send({type:'avatar_geometry',position})}
  }catch{}finally{geometryBusy=false}
}
const viewport=()=>{
  if(!visibleViewport)return[0,0,innerWidth,innerHeight]
  const [x,y,w,h]=visibleViewport,left=Math.max(0,x),top=Math.max(0,y)
  return[left,top,Math.max(1,Math.min(innerWidth,x+w)-left),Math.max(1,Math.min(innerHeight,y+h)-top)]
}
const toolbar=mountAvatarToolbar({tools:$('tools'),avatar:$('avatar'),hitTest:(x,y)=>maskContains(alphaMask,rect($('avatar')),x,y),onChange:()=>{void refreshMask()}})
const characterAnchor={getBoundingClientRect(){const a=$('avatar').getBoundingClientRect(),t=$('tools').getBoundingClientRect();return{left:a.left,width:a.width,top:a.top,bottom:Math.max(a.bottom,t.bottom)}}}
const confirmation=avatarCloseConfirmation({floating:true,origin:'avatar',anchor:()=>characterAnchor,viewport,onChange:()=>toolbar.setConfirmation(desiredPanel||Boolean(confirmation.element)||menu?.active)})
const surface=mountCompanionSurface($('surface'),{send:value=>send(value),changed:(open,target)=>{
  desiredPanel=open;if(!open)surfaceSide=null;toolbar.setConfirmation(open||Boolean(confirmation.element)||menu?.active)
  for(const b of document.querySelectorAll('[data-mode]'))b.toggleAttribute('data-teaching',b.dataset.mode===target)
  positionSurface()
  void refreshMask()
}})
menu=mountAvatarMenu({anchor:()=>characterAnchor,viewport,send:async value=>{
  if(value.action==='hide')$('close').click()
  else {
    if(['open_dsh','view','settings'].includes(value.action)){
      try{await invoke('focus_dsh')}
      catch{menu.result({type:'menu_result',request_id:value.request_id,ok:false,message:'未能唤起 DSH，请确认所属窗口仍然打开；若刚更新插件，请更新桌面形象。'});return}
    }
    send(value)
  }
},changed:()=>{toolbar.setConfirmation(desiredPanel||Boolean(confirmation.element)||menu.active);void refreshMask()}})
const pointerReady=Promise.all([
  window.__TAURI__.event.listen('avatar-pointer',e=>toolbar.pointer(e.payload)).then(unlisten=>{if(closed)unlisten();else pointerUnlisten=unlisten}),
  window.__TAURI__.event.listen('avatar-viewport',e=>{
    if(!Array.isArray(e.payload)||e.payload.length!==4||!e.payload.every(Number.isFinite))return
    if(visibleViewport?.every((n,i)=>n===e.payload[i]))return
    visibleViewport=e.payload;positionSurface();window.dispatchEvent(new Event('resize'));void refreshMask()
  }).then(unlisten=>{if(closed)unlisten();else viewportUnlisten=unlisten})
]).catch(()=>{failed=true;send({type:'failed'});close()})
sizeButton($('size'),desiredSize)
const send=value=>{if(socket.readyState===1&&socket.bufferedAmount<16000)socket.send(JSON.stringify(value))}
function positionSurface(){
  const bubble=$('bubble'),panel=$('surface'),nodes=[bubble,panel].filter(n=>!n.hidden)
  if(!nodes.length)return
  const [x,y,w,h]=viewport(),avatar=$('avatar').getBoundingClientRect(),tools=$('tools').getBoundingClientRect()
  const fit=avatar.width/$('avatar').offsetWidth||1,gap=12*fit
  // Measure content only after setting its final width/height limits. Never use
  // yesterday's constrained height to calculate today's position.
  bubble.style.width='256px';bubble.style.right='auto'
  for(const n of nodes)n.style.maxHeight=(Math.max(1,h-24)/fit)+'px'
  const bubbleHeight=bubble.hidden?0:Math.min({small:90,medium:180,large:260}[bubbleSize]*fit,bubble.getBoundingClientRect().height)
  const panelHeight=panel.hidden?0:Math.min(256*fit,panel.getBoundingClientRect().height)
  const separation=nodes.length>1?gap:0,needed=bubbleHeight+panelHeight+separation
  const above=Math.max(0,avatar.top-gap-(y+12)),below=Math.max(0,y+h-12-(tools.bottom+gap))
  let side=desiredPanel?surfaceSide:null
  if(!side || (side==='above'?above:below)<Math.min(needed,80*fit))
    side=above>=needed?'above':below>=needed?'below':above>=below?'above':'below'
  if(desiredPanel)surfaceSide=side
  const space=side==='above'?above:below
  const bubbleBudget=panel.hidden?space:Math.min(bubbleHeight,Math.max(0,(space-separation)*.3))
  const bh=Math.min(bubbleHeight,bubbleBudget),ph=Math.min(panelHeight,Math.max(0,space-bh-separation))
  if(!bubble.hidden)bubble.style.maxHeight=Math.max(1,bh/fit)+'px'
  if(!panel.hidden)panel.style.maxHeight=Math.max(1,ph/fit)+'px'
  let edge=side==='above'?avatar.top-gap:tools.bottom+gap
  for(const n of nodes){
    const rect=n.getBoundingClientRect(),parent=n.offsetParent.getBoundingClientRect()
    const left=Math.max(x+12,Math.min(avatar.left+avatar.width/2-rect.width/2,x+w-12-rect.width))
    const top=side==='above'?edge-rect.height:edge
    n.style.left=((left-parent.left)/fit)+'px';n.style.top=((top-parent.top)/fit)+'px'
    n.style.bottom='auto';n.style.right='auto'
    edge=side==='above'?top-gap:top+rect.height+gap
  }
  // Measurement temporarily expands the bubble and can clamp scrollTop to zero.
  // Follow the newest line only after restoring the final visible height.
  if(!bubble.hidden)bubble.scrollTop=bubble.scrollHeight
}
const caption=()=>{
  const text=input?.text||frame.text
  const changed=$('bubble').hidden===Boolean(text)||$('text').textContent!==text
  $('bubble').hidden=!text;$('bubble').dataset.input=String(Boolean(input));$('keyboard').toggleAttribute('hidden',!input)
  if($('text').textContent!==text)$('text').textContent=text
  if(changed)positionSurface()
}
const clearInput=()=>{clearTimeout(inputTimer);input=null;caption()}
const controls=()=>{
  for(const b of document.querySelectorAll('[data-mode]')){
    const active=frame.mode===b.dataset.mode
    b.disabled=false;b.setAttribute('aria-pressed',String(active));b.setAttribute('aria-busy',String(active&&!frame.ready))
    b.querySelector('[data-connecting-ring]').hidden=!(active&&!frame.ready)
    b.setAttribute('aria-label',`${active?'关闭':'打开'}${b.dataset.mode==='online'?'交互模式':'播报模式'}`)
    b.title=active&&!frame.ready?`正在连接${b.dataset.mode==='online'?'交互模式':'播报模式'}`:b.getAttribute('aria-label')
  }
  $('dot').style.color=frame.ready?'#7fd6a6':'#ed9b35'
  const status=frame.mode==='off'?'语音未开启':!frame.ready?'正在连接…':frame.mode==='online'?'交互模式':'播报模式'
  if($('status').textContent!==status)$('status').textContent=status
}
const close=()=>{
  if(closed)return;closed=true;menu.dispose();confirmation.dispose();toolbar.dispose();pointerUnlisten?.();viewportUnlisten?.();clearInterval(timer);clearInterval(maskTimer);clearTimeout(inputTimer)
  model?.update({...frame,rms:0,text:''});model?.dispose();socket.close()
  void invoke('hide_avatar').catch(()=>{})
}
const notifyReady=()=>{if(failed)send({type:'failed'});else if(ready)send({type:'ready',protocol:AVATAR_UI_PROTOCOL})}
// Serialize native resize and hit-mask updates, including rapid preference changes.
// The owning page persists the preference; this window never opens a second store.
const requestSize=size=>{
  desiredSize=avatarSize(size)
  if(sizePending || desiredSize===appliedSize)return sizePending||Promise.resolve()
  sizePending=(async()=>{
    await maskPending
    while(!closed&&desiredSize!==appliedSize){
      // Reserve a stable transparent carrier before showing the window.
      // Popup open/close and countdown updates must never move the avatar.
      const target=desiredSize,panel=true,result=await invoke('set_avatar_size',{size:target,panel})
      if(!result||!Number.isFinite(result.scale)||result.scale<=0||result.scale>1)throw Error('invalid_avatar_layout')
      $('shell').style.transform=`scale(${result.fit??1})`;$('shell').dataset.panel=String(panel);$('stage').dataset.size=target
      $('stage').style.setProperty('--scale',result.scale)
      sizeButton($('size'),target);appliedSize=target
      toolbar.refresh();positionSurface()
    }
  })().catch(()=>{failed=true;send({type:'failed'});close()}).finally(()=>{sizePending=null})
  return sizePending
}
try{model=mountAvatarRenderer($('avatar'),{modelURL:'./character.glb',onReady(){
  void Promise.all([pointerReady,requestSize(desiredSize)]).then(async()=>{if(closed||failed)return;ready=true;await refreshMask();if(closed)return;notifyReady();return invoke('show_avatar')})
    .catch(()=>{failed=true;send({type:'failed'});close()})
},onError(){failed=true;notifyReady()}})}catch{failed=true}
socket.onopen=notifyReady
const liveness=new AvatarHeartbeat(1000)
socket.onmessage=e=>{
  liveness.touch()
  try{
    const message=JSON.parse(e.data)
    if(message.type==='frame'){
      frame=avatarFrame(message);last=Date.now();model?.update(frame);void requestSize(frame.size)
      if(frame.mode==='off')clearInput();caption();controls()
    }else if(message.type==='input_effect'){
      input=avatarInputEffect(message);last=Date.now();clearTimeout(inputTimer);caption();inputTimer=setTimeout(clearInput,1600)
    }else if(message.type==='clear_input_effect'){clearInput()}
    else if(message.type==='surface'){surface.update(message);last=Date.now()}
    else if(message.type==='local_state'){
      menu.update(message);bubbleSize=message.bubble;positionSurface();last=Date.now()
      if(message.toast&&message.toast!==lastNotice&&frame.mode==='off'&&message.items.find(i=>i.id===message.toast)?.status==='completed')
        model?.update({...frame,text:'完成了',utterance:'notice-'+message.toast})
      lastNotice=message.toast
    }
    else if(message.type==='menu_result'){menu.result(message);last=Date.now()}
    else if(message.type==='owner_focus'){void invoke('remember_dsh').catch(()=>{});last=Date.now()}
    else if(message.type==='alive'){} // Host liveness, independent of browser animation timers.
    else throw Error('invalid_avatar_message')
  }catch{socket.close(1008,'invalid_avatar_message')}
}
socket.onclose=close;socket.onerror=close
const timer=setInterval(()=>{
  if(liveness.expired()){close();return}
  if(Date.now()-last>1500){model?.update({...frame,rms:0,text:''});frame={...frame,text:''};clearInput()}
  send({type:'alive'})
  void reportGeometry()
},1000)
const rect=node=>{const r=node.getBoundingClientRect();return[r.x,r.y,r.width,r.height]}
function refreshMask(){
  if(!ready||sizePending||closed||document.hidden)return
  if(maskPending){maskAgain=true;return maskPending}
  maskPending=(async()=>{
    do{
      maskAgain=false
      if(closed||sizePending||document.hidden)break
      const regions=confirmation.element?[rect(confirmation.element)]:menu.active?[[0,0,innerWidth,innerHeight]]:[...toolbar.regions(),...($('bubble').hidden?[]:[rect($('bubble'))]),...($('surface').hidden?[]:[rect($('surface'))]),...menu.regions()]
      alphaMask=model.hitMask()
      await invoke('avatar_hit_mask',{mask:alphaMask,avatar:rect($('avatar')),regions})
    }while(maskAgain)
  })().catch(()=>{}).finally(()=>{maskPending=null})
  return maskPending
}
const maskTimer=setInterval(()=>{if(!maskPending)void refreshMask()},350)
for(const b of document.querySelectorAll('[data-mode]')){
  const ring=document.createElement('span');ring.dataset.connectingRing='';ring.hidden=true
  ring.innerHTML='<svg viewBox="0 0 30 30" preserveAspectRatio="none" aria-hidden="true"><rect x="1" y="1" width="28" height="28" rx="7" pathLength="100"/></svg>';b.append(ring)
  b.onclick=()=>send({type:'mode',mode:b.dataset.mode})
}
$('close').onclick=async()=>{if(await confirmation.ask()&&!closed){send({type:'hide'});close()}}
$('size').onclick=()=>send({type:'size',size:nextAvatarSize(appliedSize||desiredSize)})
let down=null
$('avatar').tabIndex=0
$('avatar').oncontextmenu=e=>{down=null;menu.open(e)}
$('avatar').onkeydown=e=>{if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey){down=null;menu.open(e)}}
$('avatar').onpointerdown=e=>{if(e.button===0&&!e.ctrlKey&&!menu.active)down={x:e.clientX,y:e.clientY}}
$('avatar').onpointermove=e=>{
  if(down&&!menu.active&&e.buttons===1&&Math.hypot(e.clientX-down.x,e.clientY-down.y)>4){down=null;void invoke('drag_avatar').catch(()=>{})}
}
window.addEventListener('pointerup',()=>{down=null});window.addEventListener('blur',()=>{down=null})
window.addEventListener('resize',()=>{positionSurface();void refreshMask()})
window.addEventListener('pagehide',close,{once:true})
