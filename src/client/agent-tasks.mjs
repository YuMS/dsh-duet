import {focusedSession,openLocalSession} from './composer.mjs'
import {TASK_STATES as states, noteTaskNoticeVisit, taskCardState, visibleTaskRows} from '../shared/work-mode.mjs'
const active=new Set(['queued','pending','running','progress','waiting','waiting_user','blocked'])
const bubbleCSS=`
[data-duet-agent-tasks]{position:fixed;isolation:isolate;z-index:2147483599;margin:0;color:CanvasText;font:13px/1.35 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
[data-duet-agent-tasks] summary,[data-duet-agent-tasks] [data-task-list]{box-sizing:border-box;background:Canvas;border:1px solid color-mix(in srgb,CanvasText 12%,Canvas);box-shadow:0 8px 22px -7px #0003,0 1px 4px #0001}
[data-duet-agent-tasks] summary{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px;padding:7px 15px;border-radius:24px;text-align:start;list-style:none;cursor:pointer;user-select:none}
[data-duet-agent-tasks] summary::-webkit-details-marker{display:none}
[data-duet-agent-tasks] summary:focus-visible{outline:2px solid Highlight;outline-offset:2px}
[data-duet-agent-tasks] summary strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-duet-agent-tasks] summary small{grid-column:1;color:color-mix(in srgb,CanvasText 70%,Canvas);font-size:11px}
[data-duet-agent-tasks] summary span{grid-area:1 / 2 / span 2;font-size:10px;color:color-mix(in srgb,CanvasText 62%,Canvas);white-space:nowrap}
[data-duet-agent-tasks][data-stacked]:not([open])::before{content:'';pointer-events:none;position:absolute;inset:6px 8px -4px;border-radius:24px;background:Canvas;box-shadow:0 3px 7px #0002;z-index:-1}
[data-duet-agent-tasks] [data-task-list]{position:fixed;width:min(264px,calc(100vw - 16px));overflow:auto;padding:6px;border-radius:18px}
[data-duet-agent-tasks] [data-task-list] button{border-radius:10px}
[data-duet-agent-tasks] [data-task-list] button:hover{background:color-mix(in srgb,CanvasText 8%,transparent)!important}
[data-duet-agent-tasks][data-inline] summary{display:none}
[data-duet-agent-tasks][data-inline] [data-task-list]{position:static;width:100%;max-height:65vh;overflow:auto}
[data-duet-agent-tasks] [data-task-list]{background:transparent!important;border:0;box-shadow:none;padding:0;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
[data-duet-agent-tasks] [data-task-list] button{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:14px 16px;margin:0 0 8px;border:1px solid #ffffff90;border-radius:20px;background:#f7f9fbe8;color:#253344;text-align:left;cursor:pointer;box-shadow:0 6px 18px -8px #172c4938;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
[data-duet-agent-tasks] [data-task-list] button span{font-size:13px;font-weight:550;line-height:1.5;overflow-wrap:anywhere}
[data-task-state]::before{content:'';display:block;flex:0 0 18px;width:18px;height:18px;box-sizing:border-box;border:2px solid #62a0cd45;border-top-color:#468abf;border-radius:50%;animation:duet-task-spin 1s linear infinite}
[data-task-state=completed]::before{content:'✓';border:0;background:#dcefe8;color:#23845e;text-align:center;font:600 14px/18px system-ui;animation:none}
[data-task-state=waiting]::before{content:'?';border:0;background:#fff0d9;color:#ad7523;text-align:center;font:600 13px/18px system-ui;animation:none}
[data-task-state=failed]::before,[data-task-state=stopped]::before{content:'!';border:0;background:#f8e3e3;color:#b45353;text-align:center;font:600 13px/18px system-ui;animation:none}
@keyframes duet-task-spin{to{transform:rotate(360deg)}}
@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  [data-duet-agent-tasks] summary,[data-duet-agent-tasks] [data-task-list]{background:color-mix(in srgb,Canvas 82%,transparent);-webkit-backdrop-filter:blur(18px) saturate(1.25);backdrop-filter:blur(18px) saturate(1.25)}
}
@media (prefers-reduced-transparency:reduce),(forced-colors:active){
  [data-duet-agent-tasks] summary,[data-duet-agent-tasks] [data-task-list]{background:Canvas;-webkit-backdrop-filter:none;backdrop-filter:none}
}`

/** A local, connection-owned projection; never turn the model's short handles into UI routes. */
export function agentTaskPanel(ctx,anchor,notice,presentation=()=>null){
  let box,summary,title,statusLine,count,list,attempt,currentFrame,limit=50,lifecycle,resize,mutations,raf=0,tracked
  function reset(){
    attempt?.abort();lifecycle?.abort();resize?.disconnect();mutations?.disconnect();cancelAnimationFrame(raf)
    box?.remove();box=null;currentFrame=null;tracked=null;raf=0;limit=50
  }
  function place(){
    if(!box||box.hidden)return
    const view=presentation(),pet=view?.anchor,stage=pet?.querySelector('[data-duet-avatar-stage]')||pet
    // Native presentation is projected through avatar-surfaces, not positioned
    // against the DSH toolbar. Keep it off-page during desktop reconnects too.
    if(view?.native || ['desktop','connecting','recovering','other'].includes(view?.mode)){
      box.style.visibility='hidden';return
    }
    const target=stage?.isConnected && stage.getBoundingClientRect().height?stage:anchor()
    if(!target?.isConnected){box.style.visibility='hidden';return}
    if(target!==tracked){resize.disconnect();resize.observe(target);tracked=target}
    const a=target.getBoundingClientRect(), gap=8
    if(!a.width||!a.height){box.style.visibility='hidden';return}
    box.style.visibility='visible'
    const clamp=(v,hi)=>Math.max(gap,Math.min(v,hi-gap))
    const room=innerWidth-a.right-2*gap
    // On tiny viewports keep the card at the right edge rather than moving it above the pet.
    const width=Math.min(224,Math.max(112,room))
    summary.style.width=Math.min(innerWidth-2*gap,width)+'px'
    const inline=box.hasAttribute('data-inline')
    if(inline)box.style.width=Math.min(innerWidth-2*gap,width)+'px';else box.style.width=''
    const card=inline?box:summary
    const left=clamp(a.right+gap,innerWidth-card.offsetWidth)
    const top=clamp(a.top+(a.height-card.offsetHeight)/2,innerHeight-card.offsetHeight)
    Object.assign(box.style,{left:left+'px',top:top+'px'})
    if(inline){Object.assign(list.style,{width:'100%',left:'',top:'',bottom:'',maxHeight:'65vh'});return}
    if(!box.open)return
    list.style.width=Math.min(264,innerWidth-left-gap)+'px'
    const below=innerHeight-top-summary.offsetHeight-2*gap,above=top-2*gap
    const up=above>below
    Object.assign(list.style,{left:clamp(left,innerWidth-list.offsetWidth)+'px',
      top:up?'auto':top+summary.offsetHeight+gap+'px',bottom:up?innerHeight-top+gap+'px':'auto',
      maxHeight:Math.max(32,Math.min(innerHeight*.46,up?above:below))+'px'})
  }
  function schedule(){if(!raf)raf=requestAnimationFrame(()=>{raf=0;place()})}
  function observe(){
    if(!currentFrame || document.hidden || !document.hasFocus())return
    const id=focusedSession(ctx)
    const row=visibleTaskRows(currentFrame.rows).find(r=>r.session_id===id&&(r.finished_at||taskCardState(r)==='waiting'))
    if(row){
      noteTaskNoticeVisit(row); update({...currentFrame,focus:null},false)
    }
  }
  async function open(id,automatic){
    attempt?.abort()
    const controller=attempt=new AbortController(),{signal}=controller
    const before=focusedSession(ctx)
    try {
      if(automatic && (before===id || document.hidden || !document.hasFocus()))return
      // The acceptance can precede registration of the worker in DSH.
      for(let n=0;n<6;n++){
        await ctx.sessions.refresh();signal.throwIfAborted()
        if(ctx.sessions.list.getSnapshot().byId?.[id])break
        if(n===5)throw Error('session_not_ready')
        await new Promise(resolve=>setTimeout(resolve,300))
      }
      if(ctx.workspaces?.list?.getSnapshot()?.archivedSessionIds?.includes(id))return
      if(automatic){
        if(document.hidden || !document.hasFocus() || focusedSession(ctx)!==before)return
        if(before && ctx.conversation.input.for(ctx.sessions.scope(before)).state.getSnapshot().draft?.trim())return
        if(document.activeElement?.matches('input:not([type=button])'))return
      }
      await openLocalSession(ctx,id,signal)
      observe()
    }catch{if(!signal.aborted&&!automatic)notice('暂时打不开这个任务会话，请稍后再试。')}
  }
  function update(frame,follow){
    const controls=anchor()
    if(!controls?.parentElement||!Array.isArray(frame.rows))return
    if(!box){
      box=document.createElement('details');box.dataset.duetAgentTasks=''
      box.dataset.duetAvatarSurface='10';box.dataset.duetAvatarNativeOnly=''
      const style=document.createElement('style');style.textContent=bubbleCSS
      summary=document.createElement('summary');title=document.createElement('strong')
      statusLine=document.createElement('small');count=document.createElement('span')
      summary.append(title,statusLine,count)
      list=document.createElement('div');list.dataset.taskList=''
      box.append(summary,list,style);document.body.append(box)
      lifecycle=new AbortController();const {signal}=lifecycle
      resize=new ResizeObserver(schedule);mutations=new MutationObserver(schedule)
      mutations.observe(controls.closest('[data-slot="sidebar"]')||controls.parentElement,{childList:true,subtree:true})
      window.addEventListener('resize',schedule,{signal});document.addEventListener('scroll',schedule,{signal,capture:true,passive:true})
      window.addEventListener('duet:avatar-presentation',schedule,{signal})
      box.addEventListener('toggle',place,{signal})
      document.addEventListener('pointerdown',e=>{if(box.open&&!box.hasAttribute('data-inline')&&!box.contains(e.target))box.open=false},{signal,capture:true})
      document.addEventListener('keydown',e=>{if(box.open&&!box.hasAttribute('data-inline')&&e.key==='Escape'){box.open=false;summary.focus()}},{signal})
    }
    currentFrame=frame
    const candidates=frame.rows.filter(r=>r && /^worker-[a-f0-9]{32}$/.test(r.session_id))
    const id=focusedSession(ctx)
    if(!document.hidden && document.hasFocus()){
      const selected=candidates.find(r=>r.session_id===id)
      if(selected)noteTaskNoticeVisit(selected)
    }
    const rows=visibleTaskRows(candidates)
    const running=rows.filter(r=>active.has(r.state)).length,unread=rows.filter(r=>r.finished_at).length
    const lead=rows.find(r=>r.state==='waiting_user')||rows.find(r=>active.has(r.state))||rows[0]
    title.textContent='代理任务'
    statusLine.textContent=states[lead?.state]||'状态待确认'
    statusLine.hidden=true
    count.textContent=[running&&running+' 进行中',unread&&unread+' 未读'].filter(Boolean).join(' · ')||rows.length+' 个任务'
    summary.title=title.textContent
    summary.setAttribute('aria-label',['代理任务',title.textContent,statusLine.textContent,count.textContent].join('，'))
    box.toggleAttribute('data-stacked',rows.length>1)
    box.hidden=!rows.length
    const inline=rows.length<=3,wasInline=box.hasAttribute('data-inline')
    box.toggleAttribute('data-inline',inline);summary.hidden=inline
    if(inline)box.open=true;else if(wasInline)box.open=false
    if(box.hidden)box.open=false
    list.replaceChildren()
    if(!rows.length)list.textContent='还没有任务'
    for(const r of rows.slice(0,limit)){
      const button=document.createElement('button');button.type='button'
      const label=document.createElement('span');label.textContent=r.name||'未命名任务'
      button.dataset.taskState=taskCardState(r)
      button.title=label.textContent+' · '+(states[r.state]||'状态待确认')
      button.setAttribute('aria-label',button.title)
      button.append(label);button.onclick=()=>void open(r.session_id,false);list.append(button)
    }
    if(rows.length>limit){
      const more=document.createElement('button');more.type='button';more.textContent='查看更多任务（剩余 '+(rows.length-limit)+'）'
      more.onclick=()=>{limit+=50;update({...currentFrame,focus:null},false)};list.append(more)
    }
    if(follow&&rows.some(r=>r.session_id===frame.focus))void open(frame.focus,true)
    place()
  }
  return {update,reset,observe}
}
