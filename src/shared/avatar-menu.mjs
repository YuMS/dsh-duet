/** Local-only presentation protocol. No remote URLs, credentials or executable payloads. */
export const AVATAR_LOCAL_PROTOCOL='avatar_local_v1'
export const NOTICE_KEY='dsh.duet.avatar.notices.v1'
export const MENU_ACTIONS=['open_dsh','pending','settings','tutorial','hide','notifications','size','bubble','view','dismiss']
const sizes=['small','medium','large'], statuses=['completed','failed','stopped','approval','question','plan_review']
export function noticePreferences(storage=globalThis.localStorage){
  try {const p=JSON.parse(storage.getItem(NOTICE_KEY));return {enabled:p?.enabled!==false,snoozeUntil:0,bubble:sizes.includes(p?.bubble)?p.bubble:'medium'}}
  catch{return {enabled:true,snoozeUntil:0,bubble:'medium'}}
}
export function saveNoticePreferences(p,storage=globalThis.localStorage){
  const clean={enabled:p.enabled!==false,snoozeUntil:Number.isFinite(p.snoozeUntil)?Math.max(0,p.snoozeUntil):0,bubble:sizes.includes(p.bubble)?p.bubble:'medium'}
  storage.setItem(NOTICE_KEY,JSON.stringify(clean));return clean
}
const text=(v,n)=>typeof v==='string'?v.slice(0,n):''
export function avatarMenuAction(v){
  if(v?.type!=='menu_action'||!MENU_ACTIONS.includes(v.action)||!/^[a-zA-Z0-9-]{1,64}$/.test(v.request_id||''))throw Error('invalid_avatar_menu_action')
  const out={type:'menu_action',request_id:v.request_id,action:v.action}
  if(['size','bubble'].includes(v.action)){if(!sizes.includes(v.value))throw Error('invalid_avatar_size');out.value=v.value}
  if(['view','dismiss'].includes(v.action)){if(typeof v.id!=='string'||!v.id||v.id.length>512)throw Error('invalid_avatar_notice');out.id=v.id}
  if(v.action==='notifications'){if(typeof v.value!=='boolean')throw Error('invalid_avatar_preference');out.value=v.value}
  if(v.action==='snooze'){if(![0,30].includes(v.value))throw Error('invalid_avatar_snooze');out.value=v.value}
  return out
}
export function avatarLocalState(v){
  if(v?.type!=='local_state'||v.protocol!==AVATAR_LOCAL_PROTOCOL||!Number.isSafeInteger(v.revision)||v.revision<0||!Array.isArray(v.items)||v.items.length>32)throw Error('invalid_avatar_local_state')
  const items=v.items.map(i=>{
    if(!statuses.includes(i.status)||!i.id||typeof i.id!=='string'||i.id.length>512)throw Error('invalid_avatar_notice')
    return {id:i.id,session_id:text(i.session_id,256),name:text(i.name,100),status:i.status,summary:text(i.summary,240),pending:i.pending===true,unread:i.unread===true}
  })
  while(JSON.stringify(items).length>12000)items.pop()
  return {type:'local_state',protocol:AVATAR_LOCAL_PROTOCOL,revision:v.revision,items,
    size:sizes.includes(v.size)?v.size:'large',bubble:sizes.includes(v.bubble)?v.bubble:'medium',enabled:v.enabled!==false,
    snoozed:v.snoozed===true,running:Math.max(0,Math.min(10000,Number(v.running)||0)),available:v.available===true,
    toast:items.some(i=>i.id===v.toast)?v.toast:null}
}
export function avatarMenuResult(v){
  if(v?.type!=='menu_result'||!/^[a-zA-Z0-9-]{1,64}$/.test(v.request_id||''))throw Error('invalid_avatar_menu_result')
  return {type:'menu_result',request_id:v.request_id,ok:v.ok===true,message:text(v.message,180)}
}
/** Incremental snapshots, scope fencing and stable IDs; never infer success from text. */
export class AvatarNotices {
  constructor(){this.items=new Map();this.seen=new Set();this.dismissed=new Set();this.scope=null;this.epoch=null;this.revision=0;this.order=0;this.toast=null;this.toastAt=0;this.running=0}
  update({scope,epoch,sessions=[],results=[],interactions=[]}){
    if(scope!==this.scope||epoch!==this.epoch){this.items.clear();this.seen.clear();this.dismissed.clear();this.toast=null;this.scope=scope;this.epoch=epoch}
    const allowed=new Map(sessions.filter(s=>!s.archived&&s.origin!=='subagent').map(s=>[s.session_id,s]))
    this.running=[...allowed.values()].filter(s=>s.running===true).length
    for(const [id,item]of this.items)if(!allowed.has(item.session_id))this.items.delete(id)
    const pending=new Set()
    for(const p of interactions){
      if(!allowed.has(p.session_id)||!['approval','question','plan_review'].includes(p.kind)||!p.id)continue
      const id='pending:'+p.id;pending.add(id)
      const row=allowed.get(p.session_id),old=this.items.get(id)
      const summary=p.kind==='approval'?p.reason:(p.questions?.[0]?.question||p.questions?.[0]?.text||'请到 DSH 查看并回答')
      this.items.set(id,{id,order:old?.order??++this.order,session_id:p.session_id,name:row.label,status:p.kind,summary:typeof summary==='string'?summary.slice(0,240):'',pending:true,unread:old?.unread??true})
      if(!old){this.toast=id;this.toastAt=Date.now()}
    }
    for(const[id,item]of this.items)if(item.pending&&!pending.has(id))this.items.delete(id)
    for(const job of results){
      if(!allowed.has(job.session_id)||!Number.isSafeInteger(job.completion_seq)||typeof job.id!=='string')continue
      const id=`job:${epoch}:${job.id}:${job.completion_seq}`;if(this.seen.has(id))continue
      this.seen.add(id)
      const status=job.turn_end_reason==='aborted'?'stopped':job.status==='failed'?'failed':job.status==='succeeded'&&job.turn_end_reason==='completed'?'completed':null
      if(!status)continue
      const row=allowed.get(job.session_id)
      this.items.set(id,{id,order:++this.order,session_id:job.session_id,name:row.label,status,summary:status==='failed'?text(job.error,240):'',pending:false,unread:true})
      this.toast=id;this.toastAt=Date.now()
    }
    while(this.seen.size>1024)this.seen.delete(this.seen.values().next().value)
    const rows=[...this.items.values()].sort((a,b)=>Number(b.pending)-Number(a.pending)||Number(b.unread)-Number(a.unread)||b.order-a.order)
    this.items=new Map(rows.slice(0,32).map(i=>[i.id,i]))
    if(!this.items.has(this.toast))this.toast=null
    for(const id of this.dismissed)if(!this.items.has(id))this.dismissed.delete(id)
    this.revision++
  }
  read(id){const item=this.items.get(id);if(item)item.unread=false;if(this.toast===id)this.toast=null;this.revision++}
  dismiss(id){if(this.items.has(id))this.dismissed.add(id);if(this.toast===id)this.toast=null;this.revision++}
  state(prefs,size,available=true){
    const pending=[...this.items.values()].find(i=>i.pending&&i.unread&&!this.dismissed.has(i.id))
    const toast=pending?.id??(Date.now()-this.toastAt<=8000?this.toast:null)
    return avatarLocalState({type:'local_state',protocol:AVATAR_LOCAL_PROTOCOL,revision:this.revision,items:[...this.items.values()],
      ...prefs,size,available,running:this.running,snoozed:prefs.snoozeUntil>Date.now(),toast:available&&prefs.enabled&&prefs.snoozeUntil<=Date.now()?toast:null})
  }
}
