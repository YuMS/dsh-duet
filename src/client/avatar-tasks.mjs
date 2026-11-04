import {AvatarNotices,noticePreferences,saveNoticePreferences,NOTICE_KEY,avatarMenuAction,avatarMenuResult} from '../shared/avatar-menu.mjs'
import {avatarPreferences} from '../shared/avatar.mjs'
import {nativeInteractions} from './interactions.mjs'
import {focusedSession,openLocalSession} from './composer.mjs'
/** Local DSH feed only: does not own/open a voice connection or call TTS. */
export function mountAvatarTasks({ctx,sync,avatar,tutorial,settings,focus=()=>window.focus()}){
  const model=new AvatarNotices(),seenCommands=new Set(),controller=new AbortController()
  let dead=false,interactions,unwatch=()=>{},last='',prefs=noticePreferences()
  try{interactions=nativeInteractions(ctx)}catch{}
  const scope=()=>{
    const work=ctx.workspaces?.list?.getSnapshot(),current=focusedSession(ctx)
    const workspace=work?.items?.find(w=>w.sessionIds?.includes(current))??(work?.items?.length===1?work.items[0]:null)
    const id=workspace?.workspaceId||workspace?.id
    if(!id)return {id:null,rows:[]}
    const member=new Set(workspace.sessionIds||[]),archived=new Set(work.archivedSessionIds||[])
    return {id,rows:(sync.snapshot?.sessions||[]).filter(s=>!archived.has(s.session_id)&&s.origin!=='subagent'&&(s.workspace_id===id||member.has(s.session_id)))}
  }
  const publish=()=>{
    if(dead)return
    const state=model.state(prefs,avatarPreferences().size,sync.active)
    const fingerprint=JSON.stringify({...state,revision:0})
    if(last!==fingerprint){last=fingerprint;avatar()?.localState?.(state)}
  }
  const refresh=()=>{
    if(dead)return
    const s=scope()
    let pending=[];try{pending=interactions?.snapshot()||[]}catch{}
    model.update({scope:s.id,epoch:sync.epoch,sessions:s.rows,results:sync.active?(sync.snapshot?.results||[]):[],interactions:pending})
    publish()
  }
  const unsubscribe=sync.subscribe(refresh),workspaceStop=ctx.workspaces?.list?.subscribe?.(refresh),sessionStop=ctx.sessions?.list?.subscribe?.(refresh)
  if(interactions)unwatch=interactions.subscribe(refresh)
  const preferenceChange=()=>{prefs=noticePreferences();publish()}
  window.addEventListener('storage',preferenceChange)
  const channel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel(NOTICE_KEY)
  if(channel)channel.onmessage=preferenceChange
  const change=patch=>{prefs=saveNoticePreferences({...prefs,...patch});channel?.postMessage('changed');publish()}
  const result=(request,ok,message='')=>avatar()?.menuResult?.(avatarMenuResult({type:'menu_result',request_id:request.request_id,ok,message}))
  const action=async raw=>{
    let request;try{request=avatarMenuAction(raw)}catch{return}
    if(dead||seenCommands.has(request.request_id))return
    seenCommands.add(request.request_id);while(seenCommands.size>256)seenCommands.delete(seenCommands.values().next().value)
    try{
      switch(request.action){
        case 'open_dsh':focus();return result(request,true)
        case 'view':{
          refresh()
          const item=model.items.get(request.id)
          if(!sync.active||!item||!scope().rows.some(s=>s.session_id===item.session_id))throw Error('这条通知已失效，请回到 DSH 查看')
          await openLocalSession(ctx,item.session_id,controller.signal);focus();model.read(item.id);publish()
          return result(request,true)
        }
        case 'dismiss':model.dismiss(request.id);publish();break
        case 'size':avatar()?.setSize?.(request.value);publish();break
        case 'bubble':change({bubble:request.value});break
        case 'notifications':change({enabled:request.value,snoozeUntil:0});break
        case 'settings':settings();focus();return result(request,true)
        case 'tutorial':tutorial()?.open({origin:'avatar'});return result(request,true)
        case 'hide':await avatar()?.toggle?.();break
        default:return
      }
      result(request,true)
    }catch(error){if(!dead)result(request,false,/通知已失效/.test(error.message)?error.message:'操作未完成，请回到 DSH 重试')}
  }
  // Only expires local DND; never polls a server.
  const timer=setInterval(publish,1000);refresh()
  return{action,refresh,dispose(){dead=true;controller.abort();clearInterval(timer);unsubscribe();unwatch();workspaceStop?.();sessionStop?.();channel?.close();window.removeEventListener('storage',preferenceChange)}}
}
