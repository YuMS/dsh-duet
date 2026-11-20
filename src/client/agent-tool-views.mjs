import {focusedSession,openLocalSession} from './composer.mjs'
import {TASK_STATES,taskCardState} from '../shared/work-mode.mjs'

const ticketId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value)?value:null
const object=value=>{
  if(typeof value!=='string')return value&&typeof value==='object'&&!Array.isArray(value)?value:null
  if(value.length>512000)return null
  try{return object(JSON.parse(value))}catch{return null}
}
const output=block=>(Array.isArray(block?.content)?block.content:[]).filter(p=>p?.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n')

// Ticket stages (working, working/queued, person/answer) differ from UI states.
// The successful routing receipt,
// not that lifecycle or the proposed arguments, identifies this historical event.
const routeEventState=item=>{
  const kind=item.decision??item.kind
  if(kind==='accept')return 'running'
  if(kind==='attach')return 'progress'
  if(kind==='stop')return 'stopped'
  const stages={'working':'running','working/queued':'queued','person/answer':'waiting_user','person/review':'waiting_user','person/delivery':'ready','person/blocked':'blocked','person/failed':'failed','idle':'waiting'}
  const state=item.ticket?.state
  return typeof state==='string'?(Object.hasOwn(stages,state)?stages[state]:state):null
}

/** Only successful, explicit ticket references become links; never route by title. */
export function agentToolCard(toolName,block){
  const settled=block?.kind==='tool-result',args=object(block?.call?.argsRaw??block?.argsRaw)||{}
  const raw=output(block),result=object(raw),failed=!!block?.isError
  const links=[],messages=[]
  if(toolName==='orchestrator_route'&&settled&&!failed){
    for(const item of (Array.isArray(result?.results)?result.results:[]).slice(0,100)){
      if(item?.refused){messages.push(String(item.refused));continue}
      const id=ticketId(item?.ticket?.ticket_id)
      if(id&&!links.some(link=>link.ticket===id))links.push({ticket:id,name:typeof item.ticket.title==='string'?item.ticket.title:'',state:routeEventState(item),label:'打开会话',result:false})
    }
  }
  if(toolName==='orchestrator_reply'&&settled&&!failed&&ticketId(args.ticket_id)&&['sent','pending'].includes(result?.status)){
    links.push({ticket:args.ticket_id,name:'',state:args.purpose==='result'?'ready':args.purpose==='attention'?'waiting_user':null,label:args.purpose==='result'?'跳转到结果':'打开会话',result:args.purpose==='result',at:block.callTime??block.time})
  }
  const title=toolName==='orchestrator_route'?'任务安排':toolName==='orchestrator_report'?'任务报告':args.purpose==='attention'?'需要你确认':args.purpose==='result'?'任务结果':'任务回复'
  return {title,links,messages,settled,failed,args,raw,text:typeof args.text==='string'?args.text:toolName==='orchestrator_report'&&typeof args.summary==='string'?args.summary:'',
    reportTime:toolName==='orchestrator_report'&&settled&&!failed&&args.state==='ready'?block.time:null}
}

export function taskLinkPresentation(link,session){
  const name=[link.name,session?.title].find(value=>typeof value==='string'&&value.trim())?.trim().slice(0,512)||'任务会话'
  const state=typeof link.state==='string'&&Object.hasOwn(TASK_STATES,link.state)?link.state:null
  const labels={running:'开始执行',progress:'继续执行',waiting_user:'向你提问'}
  return {name,label:state?(labels[state]||TASK_STATES[state]):'已关联任务',tone:state?taskCardState({state}):'neutral'}
}

/** Turn-local links remain available when DSH folds the tool execution process. */
export function agentTurnLinks(snapshot,turn){
  const links=new Map()
  const visit=block=>{
    if(!block)return
    const name=block.call?.name??block.name
    if(['orchestrator_route','orchestrator_reply'].includes(name)){
      for(const link of agentToolCard(name,block).links){
        const previous=links.get(link.ticket)
        if(!previous||link.result)links.set(link.ticket,{...link,name:link.name||previous?.name||''})
      }
    }
    for(const child of block.subCalls||[])visit(child)
  }
  for(const key of snapshot.locations.getTurn(turn)){
    const node=snapshot.nodes.get(key)
    if(node?.kind==='tool-call')visit(node.data.root)
  }
  return [...links.values()]
}

/** Land on the matching report's final chat node, not a newer run of the same ticket. */
export async function navigateAgentTool(ctx,link,signal){
  const id=ticketId(link.ticket)
  if(!id)throw Error('无法确定这个任务的会话。')
  const target='worker-'+id
  await ctx.sessions.refresh();signal.throwIfAborted()
  if(!ctx.sessions.list.getSnapshot().byId?.[target])throw Error('这个任务会话暂时不可用，可能已被移除。')
  await openLocalSession(ctx,target,signal)
  if(!link.result)return ''
  if(!Number.isFinite(link.at))return '已打开任务会话，暂时无法定位这次结果。'
  for(let n=0;n<12;n++){
    signal.throwIfAborted()
    if(focusedSession(ctx)!==target)return ''
    const reports=[...document.querySelectorAll('[data-duet-report-time]')].filter(node=>Number(node.dataset.duetReportTime)<=link.at)
      .sort((a,b)=>Number(b.dataset.duetReportTime)-Number(a.dataset.duetReportTime))
    const report=reports[0]
    if(report){
      const row=report.closest('[data-chat-turn]')
      // DSH gives every node in a turn the same durable turn identity.
      const peers=row?[...row.parentElement.querySelectorAll('[data-chat-turn]')].filter(node=>node.dataset.chatTurn===row.dataset.chatTurn&&node.getClientRects().length):[]
      const end=peers.filter(node=>(node.dataset.chatFlowKind==='assistant'||node.dataset.turnProcessAnswer==='true')
        && (report.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)).at(-1)
      if(end){end.scrollIntoView({block:'center',behavior:'auto'});return ''}
    }
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  return '已打开任务会话；这次结果所在的历史内容尚未加载。'
}

/** Official keyed tool views: only duet's three tools are customized. */
export function mountAgentToolViews(ctx,React){
  if(!ctx.slots?.inject||!React?.createElement)return ()=>{}
  const {createElement:h,useState,useEffect,useRef}=React,cleanup=[]
  let navigation=null,disposed=false
  let noticeTimer
  const notice=document.createElement('div')
  notice.setAttribute('role','status');notice.hidden=true
  notice.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100021;max-width:calc(100vw - 48px);padding:12px 18px;border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 4px 24px #0003;font:14px/1.6 system-ui;white-space:pre-wrap'
  document.body.append(notice)
  const showNotice=text=>{if(!text||disposed)return;clearTimeout(noticeTimer);notice.textContent=text;notice.hidden=false;noticeTimer=setTimeout(()=>{notice.hidden=true},6000)}
  const css=document.createElement('style')
  css.textContent='.duet-tool-card{font:inherit;color:inherit;margin:6px 0;padding:8px 0}.duet-tool-card header{display:flex;align-items:center;gap:8px;font-weight:600}.duet-tool-card p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}.duet-tool-card .links{display:grid;gap:8px;margin:8px 0}.duet-tool-card .link-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.duet-tool-card button{font:inherit;color:inherit;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;padding:4px 10px;background:transparent;cursor:pointer}.duet-tool-card button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.duet-tool-card button:focus-visible{outline:2px solid Highlight;outline-offset:2px}.duet-tool-card button:disabled{opacity:.5;cursor:default}.duet-tool-card summary{cursor:pointer;opacity:.65;font-size:12px}.duet-tool-card pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font-size:12px}.duet-tool-card [role=status]{font-size:12px;opacity:.8}'
  document.head.append(css)
  css.textContent+=`
    .duet-tool-card .links{gap:10px;margin:4px 0}
    .duet-tool-card button.duet-task-link{display:flex;align-items:center;gap:12px;width:100%;max-width:660px;min-width:0;box-sizing:border-box;padding:14px 16px;text-align:start;border:1px solid color-mix(in srgb,CanvasText 10%,Canvas);border-radius:16px;background:color-mix(in srgb,Canvas 94%,transparent);box-shadow:0 2px 8px -4px #0002;transition:background .16s,border-color .16s,box-shadow .16s,transform .16s}
    .duet-tool-card button.duet-task-link:hover:not(:disabled){background:color-mix(in srgb,Highlight 5%,Canvas);border-color:color-mix(in srgb,Highlight 30%,Canvas);box-shadow:0 6px 18px -8px #0003;transform:translateY(-1px)}
    .duet-task-link .task-icon{display:grid;place-items:center;width:36px;height:36px;flex-shrink:0;border-radius:12px;background:light-dark(#edf3f9,#273848);color:light-dark(#527fa3,#9bc2e3)}
    .duet-task-link[data-duet-task-tone=completed] .task-icon{background:light-dark(#e5f3ec,#203c30);color:light-dark(#328363,#8ecbaa)}
    .duet-task-link[data-duet-task-tone=waiting] .task-icon{background:light-dark(#fcf1de,#423722);color:light-dark(#a67932,#e4bd78)}
    .duet-task-link[data-duet-task-tone=failed] .task-icon{background:light-dark(#fae9e7,#442b2c);color:light-dark(#b65e57,#e7a49b)}
    .duet-task-link svg{display:block;width:18px;height:18px;flex-shrink:0}
    .duet-task-link .task-icon svg{width:22px;height:22px}
    .duet-task-link .task-copy{display:grid;gap:4px;flex:1;min-width:0}
    .duet-task-link .task-name{font-size:14px;font-weight:600;line-height:1.5;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .duet-task-link .task-status{font-size:11px;font-weight:400;line-height:1.5;color:color-mix(in srgb,CanvasText 60%,Canvas)}
    .duet-task-link .task-destination{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-shrink:0;font-size:12px;font-weight:450;color:color-mix(in srgb,CanvasText 65%,Canvas)}
    .duet-task-link .task-destination svg{width:14px;height:14px}
    @media(max-width:420px){.duet-tool-card button.duet-task-link{padding:12px;gap:9px}.duet-task-link .task-icon{width:28px;height:28px;border-radius:9px}.duet-task-link .task-destination{font-size:11px;gap:1px}.duet-task-link .task-name{font-size:13px}}
    @media(prefers-reduced-motion:reduce){.duet-tool-card button.duet-task-link{transition:none;transform:none!important}}
  `
  // Heroicons v2.2.0, 24/outline (MIT), matching the sidebar controls.
  const taskIcons={
    running:['rocket-launch','M15.59 14.37a6 6 0 0 1-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41m5.96 5.96a14.926 14.926 0 0 1-5.841 2.58m-.119-8.54a6 6 0 0 0-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 0 0-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 0 1-2.448-2.448 14.9 14.9 0 0 1 .06-.312m-2.24 2.39a4.493 4.493 0 0 0-1.757 4.306 4.493 4.493 0 0 0 4.306-1.758M16.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z'],
    completed:['check-circle','M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],
    waiting:['question-mark-circle','M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z'],
    failed:['exclamation-circle','M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z'],
    stopped:['stop-circle','M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z','M9 9.563C9 9.252 9.252 9 9.563 9h4.874c.311 0 .563.252.563.563v4.874c0 .311-.252.563-.563.563H9.564A.562.562 0 0 1 9 14.437V9.564Z'],
    neutral:['clipboard-document-list','M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z'],
  }
  const icon=tone=>{
    const [name,...paths]=taskIcons[tone]||taskIcons.neutral
    return h('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true,'data-heroicon':name},
      ...paths.map((d,key)=>h('path',{key,d,strokeLinecap:'round',strokeLinejoin:'round'})))
  }
  function Links({links}){
    const [busy,setBusy]=useState(false),alive=useRef(true)
    const descriptionPrefix=useRef(crypto.randomUUID()).current
    const [,refresh]=useState(0)
    useEffect(()=>ctx.sessions.list.subscribe?.(()=>refresh(n=>n+1)),[])
    useEffect(()=>{alive.current=true;return ()=>{alive.current=false}},[])
    const open=async link=>{
      navigation?.abort();const controller=navigation=new AbortController()
      setBusy(true);notice.hidden=true
      try{const text=await navigateAgentTool(ctx,link,controller.signal);if(!controller.signal.aborted)showNotice(text)}
      catch(error){if(!controller.signal.aborted)showNotice(error.message||'暂时无法打开任务会话。')}
      finally{if(!disposed&&alive.current)setBusy(false)}
    }
    return h('div',{className:'links'},...links.map(link=>{
      const item=taskLinkPresentation(link,ctx.sessions.list.getSnapshot().byId?.['worker-'+link.ticket])
      return h('button',{className:'duet-task-link',key:link.ticket,type:'button',disabled:busy,'data-duet-task-tone':item.tone,'aria-label':link.label,'aria-describedby':descriptionPrefix+link.ticket,title:item.name+' · '+item.label,onClick:()=>void open(link)},
        h('span',{className:'task-icon','aria-hidden':true},icon(item.tone)),
        h('span',{className:'task-copy',id:descriptionPrefix+link.ticket},h('span',{className:'task-name'},item.name),h('span',{className:'task-status',title:'此轮任务回执'},item.label)),
        h('span',{className:'task-destination','aria-hidden':true},link.label,h('svg',{viewBox:'0 0 20 20',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'},h('path',{d:'m8 5 5 5-5 5'}))))
    }))
  }
  function Card({toolName,block,inspect}){
    const card=agentToolCard(toolName,block)
    return h('section',{className:'duet-tool-card','data-duet-report-time':card.reportTime??undefined},
      h('header',null,card.title,h('small',null,card.failed?'执行失败':card.settled?'':'处理中…')),
      card.text&&h('p',null,card.text),
      h(Links,{links:card.links}),
      ...card.messages.map((text,i)=>h('p',{key:i,role:'status'},text)),
      h('details',null,h('summary',null,'调用详情'),h('pre',null,JSON.stringify(card.args,null,2).slice(0,30000)),h('pre',null,card.raw.slice(0,30000)),inspect&&h('button',{type:'button',onClick:inspect},'查看调用记录')))
  }
  function TurnLinks({turn,useChat}){
    const serialized=useChat(snapshot=>JSON.stringify(agentTurnLinks(snapshot,turn.turn)))
    const links=JSON.parse(serialized)
    return links.length?h('nav',{className:'duet-tool-card','aria-label':'任务快捷操作','data-duet-turn-links':''},h(Links,{links})):null
  }
  const tail=ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:'dsh-duet-task-links'},TurnLinks))
  if(typeof tail==='function')cleanup.push(tail)
  for(const key of ['orchestrator_route','orchestrator_reply','orchestrator_report']){
    const off=ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key},Card))
    if(typeof off==='function')cleanup.push(off)
  }
  return ()=>{disposed=true;navigation?.abort();clearTimeout(noticeTimer);notice.remove();for(const off of cleanup)off();css.remove()}
}
