import { AVATAR_KEY, AVATAR_SIZES, avatarScale, avatarPreferences, saveAvatarPreferences } from '../shared/avatar.mjs'
import { voiceSocketUrl } from './transport.mjs'
import { identityFetch } from './identity.mjs'
import { PLUGIN_VERSION } from '../shared/state.mjs'
import { mountInputEffect } from './input-effect.mjs'
import { avatarCloseConfirmation } from '../shared/avatar-ui.mjs'
import {mountAvatarMenu} from '../shared/avatar-menu-ui.mjs'
import {avatarLocalState,avatarMenuResult,noticePreferences} from '../shared/avatar-menu.mjs'
import {AvatarActivityClock,avatarGeometry} from '../shared/avatar-activity.mjs'

/** Page-bound presentation. The native helper cannot acquire its own voice session. */
export function mountAvatar({controls, audio, state, notice, requestMode, onSurfaceAction=()=>{}, onMenuAction=()=>{}, focusedSession=()=>null}) {
  let dead=false,renderer,root,stage,caption,ws,native=false,epoch=0,loading=false,lastState='',timer
  let prefs=avatarPreferences()
  const closeConfirmation=avatarCloseConfirmation({floating:true,origin:'page',anchor:()=>controls()})
  let forceWebOnly=false,configLoaded=false
  let menu,localState,lastNotice,retryTimer,connectTimer,reconnect,retryCount=0,presentationMode='off'
  let desktopPosition=null,activityStartTimer
  const activity=new AvatarActivityClock({snapshot:()=>{
    const p=noticePreferences(),r=root?.getBoundingClientRect(),screen=window.screen
    const position=native?desktopPosition:r?avatarGeometry({space:'viewport_css',total_resolution:{width:screen.width,height:screen.height},viewport_resolution:{width:innerWidth,height:innerHeight},avatar_position:{x:r.x,y:r.y,width:r.width,height:r.height}}):null
    return{size:prefs.size,bubble_size:p.bubble,notifications_enabled:p.enabled,pending_count:localState?.available?localState.items.filter(i=>i.pending).length:null,notification_count:localState?.available?localState.items.filter(i=>!i.pending).length:null,position}
  },send:value=>{void identityFetch('/duplex-control/api/avatar/activity',{method:'POST',headers:{'Content-Type':'application/json','X-Duplex-Settings':'1'},body:JSON.stringify(value),keepalive:true}).catch(()=>{})}})
  const activityTimer=setInterval(()=>activity.tick(),30000)
  const pagehide=()=>{clearTimeout(activityStartTimer);activityStartTimer=null;activity.stop('pagehide')}
  window.addEventListener('pagehide',pagehide)
  const publishPresentation=mode=>{presentationMode=mode;channel?.postMessage({type:'presentation',mode})}
  const ownerKind=location.protocol==='dsh-app:'?'desktop':/Edg\//.test(navigator.userAgent)?'edge':/Firefox\//.test(navigator.userAgent)?'firefox':/Chrome\//.test(navigator.userAgent)?'chrome':/Safari\//.test(navigator.userAgent)?'safari':'browser'
  const rememberOwner=()=>{if(native&&document.visibilityState==='visible'&&document.hasFocus())send({type:'owner_focus'})}
  window.addEventListener('focus',rememberOwner)
  const inputEffect=mountInputEffect({anchor:()=>{
    if(root&&!root.hidden)return caption&&!caption.hidden?caption:root
    return controls()?.querySelector('#dsh-duet-entry')||controls()
  },isCurrent:id=>focusedSession()===id})
  const syncToggle=()=>{
    const button=controls()?.querySelector('[data-duet-avatar-toggle]');if(!button)return
    const enabled=avatarPreferences().enabled
    button.setAttribute('aria-pressed',String(enabled))
    button.title=enabled?'隐藏拟人角色':'打开拟人角色';button.setAttribute('aria-label',button.title)
    button.style.background=enabled?'#dcefff':'transparent';button.style.color=enabled?'#185a89':'currentColor'
  }
  const channel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel(AVATAR_KEY)
  const send=frame=>{if(ws?.readyState===1&&ws.bufferedAmount<16000){ws.send(JSON.stringify(frame));return true}return false}
  const frame=()=>{
    const s=state(),sample=audio.avatarSample?.() || {rms:0,viseme:'A',utterance:''}
    return {type:'frame',mode:s.mode,ready:s.ready===true,size:prefs.size,rms:sample.rms,viseme:sample.viseme,utterance:sample.utterance,text:sample.text||''}
  }
  const place=()=>{
    if(!root)return
    const c=controls(),r=c?.getBoundingClientRect()
    root.hidden=!r||c.dataset.compact==='true'
    if(r){
      const base=Math.min(260,Math.max(180,r.width)),scale=Math.min(avatarScale(prefs.size),Math.max(1,innerWidth-16)/base)
      const width=base*scale,height=210*scale,top=Math.max(0,r.top-height-4)
      root.dataset.size=prefs.size;root.style.width=`${width}px`;root.style.height=`${height}px`
      root.style.left=`${Math.max(8,Math.min(innerWidth-width-8,r.left))}px`;root.style.top=`${top}px`
      stage.style.width=`${base}px`;stage.style.transform=`scale(${scale})`
      const bubbleWidth=Math.min(base-8,innerWidth-16),left=parseFloat(root.style.left)
      caption.style.width=`${bubbleWidth}px`;caption.style.left=`${Math.max(8,Math.min(innerWidth-bubbleWidth-8,left+width/2-bubbleWidth/2))-left}px`
      caption.style.maxHeight=`${Math.max(30,Math.min({small:90,medium:180,large:260}[noticePreferences().bubble],top-18))}px`
      // Reveal and constrain the caption before scrolling, including size changes.
      if(!caption.hidden)caption.scrollTop=caption.scrollHeight
    }
  }
  const clear=(reason='restart')=>{clearTimeout(activityStartTimer);activityStartTimer=null;activity.stop(reason);clearTimeout(retryTimer);clearTimeout(connectTimer);reconnect=null;retryCount=0;closeConfirmation.cancel();menu?.dispose();menu=null;epoch++;loading=false;native=false;desktopPosition=null;const old=ws;ws=null;old?.close();renderer?.dispose();renderer=null;root?.remove();root=null;clearInterval(timer);inputEffect.clear()}
  const web=async ticket=>{
    if(dead||ticket!==epoch||renderer||loading)return
    loading=true
    try{
      const {mountAvatarRenderer}=await import(`/duet/avatar/renderer.mjs?v=${PLUGIN_VERSION}`)
      if(dead||ticket!==epoch)return
      root=document.createElement('div');root.dataset.duetAvatar='';root.setAttribute('aria-label','duet 3D 形象')
      root.style.cssText='position:fixed;height:210px;z-index:20;pointer-events:none'
      stage=document.createElement('div');stage.style.cssText='position:absolute;left:0;top:0;height:210px;transform-origin:top left';stage.dataset.duetAvatarStage=''
      const viewport=document.createElement('div');viewport.style.cssText='width:100%;height:100%'
      caption=document.createElement('div');caption.dataset.duetCaption='';caption.style.cssText='position:absolute;bottom:calc(100% + 10px);left:4px;right:4px;box-sizing:border-box;text-align:left;font:13px system-ui;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:CanvasText;background:Canvas;border:1px solid color-mix(in srgb, CanvasText 12%, transparent);border-radius:16px;padding:12px 14px;max-height:180px;overflow-y:auto;box-shadow:0 6px 24px #0002;pointer-events:auto';caption.hidden=true
      const tail=document.createElement('div');tail.dataset.duetCaptionTail='';tail.style.cssText='position:absolute;bottom:calc(100% + 3px);left:48%;width:14px;height:14px;background:Canvas;transform:rotate(45deg);border-right:1px solid color-mix(in srgb, CanvasText 12%, transparent);border-bottom:1px solid color-mix(in srgb, CanvasText 12%, transparent)';tail.hidden=true
      stage.append(viewport);root.append(stage,caption,tail);document.body.append(root);place()
      viewport.style.pointerEvents='auto';viewport.tabIndex=0;viewport.setAttribute('aria-label','duet 形象，右键打开菜单')
      menu=mountAvatarMenu({anchor:()=>root,send:onMenuAction})
      viewport.oncontextmenu=e=>menu.open(e)
      viewport.onkeydown=e=>{if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey)menu.open(e)}
      if(localState)menu.update(localState)
      renderer=mountAvatarRenderer(viewport,{modelURL:'/duet/avatar/character.glb',onReady:()=>{if(!dead&&ticket===epoch&&root){root.dataset.ready='true';activity.start('web')}},onError:()=>{activity.stop('unavailable');publishPresentation('unavailable');notice('3D 形象暂不可用，可在设置中关闭。')}})
    }catch{root?.remove();root=null;publishPresentation('unavailable');notice('3D 形象暂不可用，语音功能不受影响。')}
    finally{if(ticket===epoch)loading=false}
  }
  const start=()=>{
    syncToggle()
    if(!configLoaded)return
    clear(avatarPreferences().enabled?'restart':'disabled');prefs=avatarPreferences();const ticket=epoch
    if(dead||!prefs.enabled){publishPresentation('off');return}
    let lastReceive=Date.now(),lastTick=Date.now()
    const permanent=new Set(['desktop_platform_unsupported','desktop_display_unavailable','desktop_helper_missing','desktop_helper_upgrade_required','desktop_webview2_missing','desktop_assets_invalid','desktop_assets_damaged','desktop_assets_incompatible'])
    const fallback=reason=>{
      if(dead||ticket!==epoch)return
      activity.stop('unavailable')
      clearTimeout(connectTimer);native=false
      const old=ws;ws=null;old?.close()
      if(permanent.has(reason)){
        reconnect=null;publishPresentation('fallback')
        notice(reason==='desktop_webview2_missing'?'桌面形象需要 WebView2 Runtime，当前临时在网页中显示。':'桌面组件不可用，当前临时在网页中显示；可在设置中重试桌面显示。')
        void web(ticket);return
      }
      // Temporary loss (including sleep/wake) must not move the character into
      // the page or rewrite the user's desktop preference. Explicit hide is
      // handled by the separate hide command, never inferred from a crash.
      publishPresentation(reason==='desktop_in_use'?'other':'recovering')
      clearTimeout(retryTimer)
      retryTimer=setTimeout(()=>connect(),[1000,2000,5000,10000,30000][Math.min(retryCount++,4)])
    }
    const connect=()=>{
      if(dead||ticket!==epoch||ws)return
      clearTimeout(retryTimer)
      try{
        lastReceive=Date.now()
        const socket=ws=new WebSocket(voiceSocketUrl({},globalThis,'duet/avatar/ws'))
        const current=()=>!dead&&ticket===epoch&&ws===socket
        connectTimer=setTimeout(()=>{if(current())fallback('desktop_start_timeout')},25000)
        socket.onopen=()=>{if(current())send({type:'start',size:prefs.size,owner_kind:ownerKind})}
        socket.onmessage=e=>{
          if(!current())return
          lastReceive=Date.now()
          try{
            const value=JSON.parse(e.data)
            if(value.type==='desktop_ready'){
              clearTimeout(connectTimer);retryCount=0;native=true;publishPresentation('desktop')
              clearTimeout(activityStartTimer);activityStartTimer=setTimeout(()=>{activityStartTimer=null;if(current()&&native)activity.start('desktop')},1500)
              send(frame());if(localState)send(localState);rememberOwner()
            }
            else if(value.type==='alive')return
            else if(value.type==='avatar_geometry'){desktopPosition=avatarGeometry(value.position);if(activityStartTimer&&native&&desktopPosition){clearTimeout(activityStartTimer);activityStartTimer=null;activity.start('desktop')}}
            else if(value.type==='fallback')fallback(value.reason)
            else if(value.type==='mode')requestMode(value.mode)
            else if(value.type==='surface_action'&&native)onSurfaceAction(value)
            else if(value.type==='menu_action'&&native)onMenuAction(value)
            else if(value.type==='size' && Object.hasOwn(AVATAR_SIZES,value.size))setSize(value.size)
            else if(value.type==='hide')hide()
          }catch{fallback('desktop_failed')}
        }
        socket.onerror=()=>{}
        socket.onclose=()=>{if(current())fallback('desktop_disconnected')}
      }catch{fallback('desktop_unavailable')}
    }
    reconnect=()=>{if(!ws)connect();else send({type:'alive'})}
    if(forceWebOnly||prefs.webOnly){reconnect=null;publishPresentation('web');void web(ticket)}
    else{publishPresentation('connecting');connect()}
    let lastPing=0,lastFrame=0
    timer=setInterval(()=>{
      if(dead||ticket!==epoch)return
      const now=Date.now()
      if(now-lastTick>5000||now<lastTick){lastReceive=now;reconnect?.()}
      lastTick=now
      if(ws&&now-lastPing>=5000){send({type:'alive'});lastPing=now}
      if(native&&now-lastReceive>20000)fallback('desktop_disconnected')
      const value=frame(),summary=JSON.stringify(value)
      if(renderer){
        renderer.update(value)
        if(caption.textContent!==value.text)caption.textContent=value.text
        caption.hidden=!value.text;root.querySelector('[data-duet-caption-tail]').hidden=!value.text;place()
      }
      // Active speech at 20 Hz; idle state at 1 Hz. No PCM or microphone data.
      if(native&&(summary!==lastState||now-lastFrame>=1000)){send(value);lastState=summary;lastFrame=now}
    },50)
  }
  const setEnabled=enabled=>{
    try{saveAvatarPreferences({...avatarPreferences(),enabled});channel?.postMessage('changed');changed()}
    catch{notice('头像设置未保存，请检查浏览器存储权限。')}
  }
  const hide=()=>setEnabled(false)
  const changed=e=>{
    if(e&&e.key!==AVATAR_KEY)return
    const next=avatarPreferences()
    if(next.enabled!==prefs.enabled||next.webOnly!==prefs.webOnly){start();return}
    prefs=next;syncToggle();place();if(native)send(frame())
  }
  const setSize=size=>{
    if(!Object.hasOwn(AVATAR_SIZES,size))return
    try{saveAvatarPreferences({...avatarPreferences(),size});channel?.postMessage('changed');changed()}
    catch{notice('形象大小未保存，请检查浏览器存储权限。')}
  }
  window.addEventListener('storage',changed)
  const resume=()=>{if(document.visibilityState==='visible'){reconnect?.();if(native)activity.start('desktop');else if(root?.dataset.ready==='true')activity.start('web')}}
  window.addEventListener('online',resume);window.addEventListener('pageshow',resume);window.addEventListener('focus',resume)
  document.addEventListener('visibilitychange',resume)
  if(channel)channel.onmessage=e=>{
    if(e.data?.type==='presentation_request')publishPresentation(presentationMode)
    else if(e.data?.type==='retry_desktop'&&!forceWebOnly&&!avatarPreferences().webOnly)start()
    else if(e.data==='changed')changed()
  }
  syncToggle()
  const configAbort=new AbortController()
  const configTimeout=setTimeout(()=>configAbort.abort(),3000)
  void identityFetch('/duplex-control/api/voice/config',{cache:'no-store',signal:configAbort.signal})
    .then(r=>r.ok?r.json():{}).then(config=>{forceWebOnly=config.avatar?.web_only===true})
    .catch(()=>{}).finally(()=>{clearTimeout(configTimeout);configLoaded=true;if(!dead)start()})
  return {
    presentation(){return {native,mode:presentationMode,anchor:root&&!root.hidden?root:null}},
    surface(value){return native&&send(value)},
    syncToggle,
    setSize,
    localState(value){
      localState=avatarLocalState(value);menu?.update(localState);place();if(native)send(localState)
      if(localState.toast&&localState.toast!==lastNotice&&state().mode==='off'&&localState.items.find(i=>i.id===localState.toast)?.status==='completed')
        renderer?.update({...frame(),text:'完成了',utterance:'notice-'+localState.toast})
      lastNotice=localState.toast
    },
    menuResult(value){const result=avatarMenuResult(value);if(native)send(result);else menu?.result(result)},
    async toggle(){if(!avatarPreferences().enabled)setEnabled(true);else if(await closeConfirmation.ask()&&avatarPreferences().enabled)hide()},
    inputWritten(text,id){try{
      inputEffect.show(text,id)
      if(native&&text&&focusedSession()===id)send({type:'input_effect',text:text.slice(0,600)})
    }catch{inputEffect.clear()}},
    cancelInput(){inputEffect.clear();if(native)send({type:'clear_input_effect'})},
    event(){}, // Captions and mouth animation are driven solely by actual PCM playback.
    dispose(){dead=true;clearInterval(activityTimer);window.removeEventListener('pagehide',pagehide);closeConfirmation.dispose();inputEffect.dispose();configAbort.abort();clearTimeout(configTimeout);clear('unmount');window.removeEventListener('storage',changed);window.removeEventListener('focus',rememberOwner);window.removeEventListener('online',resume);window.removeEventListener('pageshow',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);publishPresentation('off');channel?.close()},
  }
}
