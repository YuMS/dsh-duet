import {sidebarElement,clipToSidebar} from './sidebar-layout.mjs'
import {focusedSession,openLocalSession} from './composer.mjs'
import {taskBubbleCardStyle} from '../shared/avatar-ui.mjs'
import {TASK_STATES as states, noteTaskNoticeVisit, taskCardState, visibleTaskRows, taskCompletionSeconds} from '../shared/work-mode.mjs'
const active=new Set(['queued','pending','running','progress','waiting','waiting_user','blocked'])
const bubbleCSS=`
[data-duet-agent-tasks][data-sidebar-tasks]{pointer-events:none}
[data-duet-agent-tasks][data-sidebar-tasks]::before{display:none}
[data-duet-agent-tasks][data-sidebar-tasks]>summary,[data-duet-agent-tasks][data-sidebar-tasks]>[data-task-list]{pointer-events:auto}
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
[data-duet-agent-tasks] [data-task-list] button{${taskBubbleCardStyle};margin-bottom:8px}
[data-duet-agent-tasks] [data-task-list] button span{font-size:13px;font-weight:550;line-height:1.5;overflow-wrap:anywhere}
[data-duet-agent-tasks][data-sidebar-tasks] summary{display:none}
[data-duet-agent-tasks][data-sidebar-tasks] [data-task-list]{position:relative;overflow:visible;max-height:none}
[data-duet-agent-tasks][data-sidebar-tasks] [data-task-list] button{position:absolute;left:0;top:var(--task-y);width:100%;height:72px;min-height:0;margin:0;padding:9px 10px;gap:7px;align-items:flex-start;border-radius:13px;background:#f4f8fc!important;backdrop-filter:none;box-shadow:0 3px 10px #243c5620;text-align:left;transition:box-shadow .18s}
[data-duet-agent-tasks][data-sidebar-tasks] [data-task-copy]{min-width:0;flex:1}
[data-duet-agent-tasks][data-sidebar-tasks] [data-task-name]{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:18px}
[data-duet-agent-tasks][data-sidebar-tasks] [data-task-progress]{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;line-height:16px;color:#617287;font-weight:400;margin-top:3px;white-space:pre-wrap}
[data-duet-agent-tasks][data-sidebar-tasks] [data-task-state]::before{margin-top:2px}
/* Keep the invisible anchor's geometry/hit area, so replacing it with the
   detail does not move its neighbours or flicker between hover targets. */
[data-duet-agent-tasks][data-sidebar-tasks] button[data-expanded]{opacity:0;z-index:100!important}
[data-duet-task-detail]{position:fixed;z-index:2147483600;box-sizing:border-box;border-radius:16px;overflow:auto;box-shadow:0 10px 32px #243c5640;background:#fff;animation:duet-task-detail-in .16s ease-out}
[data-duet-task-detail]>button{${taskBubbleCardStyle};align-items:flex-start;border-radius:16px;background:#fff;backdrop-filter:none;box-shadow:none}
[data-duet-task-detail] [data-task-copy]{min-width:0;flex:1}
[data-duet-task-detail] [data-task-name]{display:block;font-size:13px;font-weight:600;white-space:normal;overflow-wrap:anywhere}
[data-duet-task-detail] [data-task-progress]{display:block;font-size:12px;line-height:1.6;color:#617287;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}
@keyframes duet-task-detail-in{from{opacity:0}to{opacity:1}}
@media(prefers-reduced-motion:reduce){[data-duet-task-detail]{animation:none}}
[data-task-state]::before{content:'';display:block;flex:0 0 18px;width:18px;height:18px;box-sizing:border-box;border:2px solid #62a0cd45;border-top-color:#468abf;border-radius:50%;animation:duet-task-spin 1s linear infinite}
[data-task-state=running]::before{flex:0 0 16px;width:16px;min-width:16px;max-width:16px;height:16px;min-height:16px;max-height:16px;padding:0;border:0;border-radius:0;box-sizing:content-box;background:center/16px 16px no-repeat url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='%23d8e8f5' stroke-width='2.4'/%3E%3Cpath d='M12 3a9 9 0 0 1 9 9' fill='none' stroke='%234c91c7' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E");transform-origin:50% 50%;animation:duet-task-spin 1.1s linear infinite}
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
  let box,summary,title,statusLine,count,list,attempt,currentFrame,limit=50,lifecycle,resize,mutations,raf=0,tracked,timer,releaseTaskLayout
  let countdowns=[]
  let detail,detailSource,detailTimer,suppressedDetail
  function closeDetail(){
    clearTimeout(detailTimer);detail?.remove();detail=null
    detailSource?.removeAttribute('data-expanded');detailSource?.removeAttribute('aria-expanded');detailSource=null
  }
  const laterClose=()=>{clearTimeout(detailTimer);detailTimer=setTimeout(closeDetail,140)}
  function showDetail(button){
    if(!box?.hasAttribute('data-sidebar-tasks'))return
    if(suppressedDetail===button)return
    clearTimeout(detailTimer)
    if(detailSource===button&&detail)return
    closeDetail();detailSource=button;button.dataset.expanded='';button.setAttribute('aria-expanded','true')
    const a=button.getBoundingClientRect()
    detail=document.createElement('div');detail.dataset.duetTaskDetail=''
    detail.setAttribute('role','region');detail.setAttribute('aria-label','任务最新进度')
    // Lay out one separate card at its final width. Fade opacity only: no
    // animated width or per-frame text wrapping, and never move over the pet.
    const x=Math.min(innerWidth-48,a.left),width=Math.max(40,Math.min(320,innerWidth-x-8))
    Object.assign(detail.style,{left:x+'px',width:width+'px',maxHeight:Math.min(360,innerHeight-16)+'px'})
    const copy=button.cloneNode(true);copy.removeAttribute('data-expanded');copy.removeAttribute('aria-expanded');copy.removeAttribute('style');copy.title=''
    copy.onclick=()=>button.click();detail.append(copy);document.body.append(detail)
    detail.style.top=Math.max(8,Math.min(a.top,innerHeight-detail.offsetHeight-8))+'px'
    detail.onpointerenter=()=>clearTimeout(detailTimer);detail.onpointerleave=laterClose
    detail.onfocusin=()=>clearTimeout(detailTimer);detail.onfocusout=laterClose
  }
  function reset(){
    closeDetail();suppressedDetail=null
    releaseTaskLayout?.(false);releaseTaskLayout=null
    clearInterval(timer);timer=null;countdowns=[]
    attempt?.abort();lifecycle?.abort();resize?.disconnect();mutations?.disconnect();cancelAnimationFrame(raf)
    box?.remove();box=null;currentFrame=null;tracked=null;raf=0;limit=50
  }
  function place(){
    if(!box)return
    const view=presentation(),web=location.protocol!=='dsh-app:'&&!view?.native&&!['desktop','connecting','recovering','other'].includes(view?.mode)
    releaseTaskLayout=view?.taskLayout??releaseTaskLayout
    releaseTaskLayout?.(web&&!box.hidden)
    if(box.hidden)return
    const pet=view?.anchor,stage=pet?.querySelector('[data-duet-avatar-stage]')||pet
    const sidebar=web?sidebarElement(anchor()):null,bounds=sidebar?.getBoundingClientRect()
    box.toggleAttribute('data-sidebar-tasks',Boolean(bounds))
    clipToSidebar(summary,null);clipToSidebar(list,null)
    // Native presentation is projected through avatar-surfaces, not positioned
    // against the DSH toolbar. Keep it off-page during desktop reconnects too.
    if(view?.native || ['desktop','connecting','recovering','other'].includes(view?.mode)){
      closeDetail()
      if(box.hasAttribute('data-inline')&&list.querySelectorAll('button[data-task-state]').length>3){box.removeAttribute('data-inline');summary.hidden=false;box.open=false}
      box.style.visibility='hidden';return
    }
    const target=stage?.isConnected && stage.getBoundingClientRect().height?stage:anchor()
    if(!target?.isConnected){box.style.visibility='hidden';return}
    if(target!==tracked){resize.disconnect();resize.observe(target);if(sidebar&&sidebar!==target)resize.observe(sidebar);tracked=target}
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
    const hasPet=target===stage
    const left=clamp(bounds&&!hasPet?bounds.left+gap:a.right+gap,innerWidth-card.offsetWidth)
    const top=clamp(bounds&&!hasPet?a.top-card.offsetHeight-gap:a.top+(a.height-card.offsetHeight)/2,innerHeight-card.offsetHeight)
    Object.assign(box.style,{left:left+'px',top:top+'px'})
    if(bounds){
      if(!box.hasAttribute('data-inline')){box.setAttribute('data-inline','');summary.hidden=true;box.open=true}
      // Keep every task reachable in a bounded fan. Hover changes only its layer,
      // not its neighbours' positions, so moving between tasks stays predictable.
      const buttons=[...list.children].filter(e=>e.matches('button[data-task-state]'))
      const step=Math.min(52,(Math.min(270,innerHeight*.36)-72)/Math.max(1,buttons.length-1))
      const height=72+Math.max(0,buttons.length-1)*step
      // The portrait viewport contains transparent side gutters. Cards may
      // overlap that gutter, while the central body remains unobstructed.
      const x=hasPet?Math.max(bounds.left+gap,a.left+a.width*.82+gap):bounds.left+gap
      const w=Math.min(180,Math.max(40,bounds.right-x-gap))
      const toolbar=anchor()?.getBoundingClientRect()
      const bottom=Math.min(innerHeight-gap,toolbar?.top>height+gap?toolbar.top-gap:innerHeight-gap)
      const y=Math.max(gap,Math.min(hasPet?a.top+(a.height-height)/2:a.top-height-gap,bottom-height))
      Object.assign(box.style,{left:x+'px',top:y+'px',width:w+'px'})
      Object.assign(list.style,{width:'100%',height:height+'px',left:'',top:'',bottom:'',maxHeight:'none'})
      buttons.forEach((button,i)=>{
        button.style.setProperty('--task-y',i*step+'px');button.style.zIndex=String(i+1)
      })
      return
    }
    list.style.height=''
    if(inline){Object.assign(list.style,{width:'100%',left:'',top:'',bottom:'',maxHeight:'65vh'});clipToSidebar(list,bounds);return}
    clipToSidebar(summary,bounds)
    if(!box.open)return
    list.style.width=Math.min(264,innerWidth-left-gap)+'px'
    const below=innerHeight-top-summary.offsetHeight-2*gap,above=top-2*gap
    const up=above>below
    Object.assign(list.style,{left:clamp(left,innerWidth-list.offsetWidth)+'px',
      top:up?'auto':top+summary.offsetHeight+gap+'px',bottom:up?innerHeight-top+gap+'px':'auto',
      maxHeight:Math.max(32,Math.min(innerHeight*.46,up?above:below))+'px'})
    clipToSidebar(list,bounds)
  }
  function schedule(){if(!raf)raf=requestAnimationFrame(()=>{raf=0;place()})}
  function tick(){
    for(const {row,button,label} of countdowns){
      const seconds=taskCompletionSeconds(row)
      if(seconds===0){update({...currentFrame,focus:null},false);return}
      if(button.dataset.taskCountdown!==String(seconds)){
        button.dataset.taskCountdown=String(seconds);label.textContent=`${seconds}s 后消失`
      }
    }
  }
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
      resize=new ResizeObserver(schedule);mutations=new MutationObserver(records=>{if(records.some(r=>!box?.contains(r.target)))schedule()})
      mutations.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden']})
      window.addEventListener('resize',()=>{closeDetail();schedule()},{signal});document.addEventListener('scroll',e=>{if(!detail?.contains(e.target)){closeDetail();schedule()}},{signal,capture:true,passive:true})
      window.addEventListener('duet:avatar-presentation',schedule,{signal})
      box.addEventListener('toggle',place,{signal})
      document.addEventListener('pointerdown',e=>{if(!presentation()?.native&&box.open&&!box.hasAttribute('data-inline')&&!box.contains(e.target))box.open=false},{signal,capture:true})
      document.addEventListener('keydown',e=>{if(box.open&&!box.hasAttribute('data-inline')&&e.key==='Escape'){box.open=false;summary.focus()}},{signal})
      document.addEventListener('keydown',e=>{if(e.key==='Escape'){suppressedDetail=detailSource;closeDetail()}},{signal})
      document.addEventListener('pointermove',e=>{
        if(!suppressedDetail)return
        const r=suppressedDetail.getBoundingClientRect()
        if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)suppressedDetail=null
      },{signal,passive:true})
      document.addEventListener('pointerdown',e=>{if(!box.contains(e.target)&&!detail?.contains(e.target))closeDetail()},{signal,capture:true})
    }
    closeDetail()
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
    const view=presentation(),web=location.protocol!=='dsh-app:'&&!view?.native&&!['desktop','connecting','recovering','other'].includes(view?.mode)
    const inline=web||rows.length<=3,wasInline=box.hasAttribute('data-inline')
    box.toggleAttribute('data-inline',inline);summary.hidden=inline
    if(inline)box.open=true;else if(wasInline)box.open=false
    if(box.hidden)box.open=false
    list.replaceChildren()
    countdowns=[]
    if(!rows.length)list.textContent='还没有任务'
    for(const r of rows.slice(0,limit)){
      const button=document.createElement('button');button.type='button'
      const label=document.createElement('span');label.dataset.taskCopy=''
      const name=document.createElement('span');name.dataset.taskName='';name.textContent=r.name||'未命名任务'
      const progress=document.createElement('small');progress.dataset.taskProgress=''
      progress.textContent=typeof r.progress==='string'&&r.progress.trim()?r.progress:(states[r.state]||'状态待确认')+' · 暂无进度更新'
      progress.style.cssText='font-size:11px;font-weight:400;overflow-wrap:anywhere'
      button.dataset.taskState=taskCardState(r)
      button.title=name.textContent+' · '+(states[r.state]||'状态待确认')+' · '+progress.textContent
      button.setAttribute('aria-label',button.title)
      label.append(name,document.createTextNode('\n'),progress)
      button.append(label)
      const expand=()=>showDetail(button)
      button.onpointerenter=expand;button.onfocus=expand
      button.onpointerleave=laterClose
      button.onblur=laterClose
      const seconds=taskCompletionSeconds(r)
      if(seconds!==null){
        const countdown=document.createElement('small');countdown.dataset.taskCountdownLabel=''
        countdown.style.cssText='margin-left:auto;flex-shrink:0;color:#737b85;font:400 10px/1.4 system-ui;white-space:nowrap'
        countdown.textContent=`${seconds}s 后消失`;button.dataset.taskCountdown=String(seconds)
        button.append(countdown);countdowns.push({row:r,button,label:countdown})
      }
      button.onclick=()=>void open(r.session_id,false);list.append(button)
    }
    if(rows.length>limit){
      const more=document.createElement('button');more.type='button';more.textContent='查看更多任务（剩余 '+(rows.length-limit)+'）'
      more.onclick=()=>{limit+=50;update({...currentFrame,focus:null},false)};list.append(more)
    }
    if(follow&&rows.some(r=>r.session_id===frame.focus))void open(frame.focus,true)
    // Expire every completed row, including those behind the collapsed summary.
    clearInterval(timer);timer=rows.some(r=>taskCompletionSeconds(r)!==null)?setInterval(()=>{
      if(rows.some(r=>taskCompletionSeconds(r)===0))update({...currentFrame,focus:null},false)
      else tick()
    },1000):null
    place()
  }
  return {update,reset,observe}
}
