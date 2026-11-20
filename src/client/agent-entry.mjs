import {focusedSession,openLocalSession} from './composer.mjs'

/** A connection owns one initial navigation; later task focus stays independent. */
export function agentEntryNavigation(ctx,signal,enabled=()=>true){
  let id=null,ready=false,used=false
  async function go(){
    if(!ready||!id||used||signal.aborted)return
    used=true
    if(!enabled())return
    const target=id,before=focusedSession(ctx)
    try{
      for(let n=0;n<10;n++){
        await ctx.sessions.refresh();signal.throwIfAborted()
        if(!enabled())return
        if(focusedSession(ctx)!==before)return
        if(ctx.sessions.list.getSnapshot().byId?.[target]){
          await openLocalSession(ctx,target,signal);return
        }
        await new Promise(resolve=>setTimeout(resolve,300))
      }
    }catch{/* Navigation is optional and must not close a voice connection. */}
  }
  return {
    frame(frame){if(typeof frame?.main_session_id==='string'&&/^orchestrator-[a-f0-9]{32}$/.test(frame.main_session_id)){id=frame.main_session_id;void go()}},
    connected(){ready=true;void go()},
  }
}
