/** Workspace-bound duet_agent_v1 bridge, independent of microphone/speaker mode. */
import { validAgentWorkspaceId } from '../shared/work-mode.mjs'
import { AgentTraceSender } from './agent-trace.mjs'
export const AGENT_PROTOCOL = 'duet_agent_v1'
const leases = new WeakMap()

// Task selection belongs to the local Router; the voice model can only name a pending question.
function validMessage(message) {
  return message !== null && typeof message === 'object' && !Array.isArray(message) &&
    Object.keys(message).every(key => key === 'text' || key === 'reply_to') &&
    typeof message.text === 'string' && message.text.trim().length > 0 && message.text.trim().length <= 16000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message.text) &&
    (!Object.hasOwn(message, 'reply_to') || typeof message.reply_to === 'string' && /^[A-Za-z0-9_.:-]{1,6}$/.test(message.reply_to))
}

/** JSON Pointer removals and recursive object sets follow duet_agent_v1. */
export function overviewDelta(before, after, path = '') {
  const set = {}, unset = []
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  for (const key of Object.keys(before)) if (!Object.hasOwn(after,key)) unset.push(`${path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`)
  for (const [key,value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) === JSON.stringify(value)) continue
    if (object(before[key]) && object(value)) {
      const change=overviewDelta(before[key],value,`${path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`)
      if(Object.keys(change.set).length)set[key]=change.set
      unset.push(...change.unset)
    } else set[key]=value
  }
  return {set,unset:unset.sort()}
}

export class AgentConnection {
  constructor(service, send, present, traceOptions={}) {
    this.traceOptions=traceOptions
    this.present=present;this.liveRequests=new Set();this.liveRunKeys=new Set();this.focusedResults=new Set()
    this.service = service; this.send = send; this.closed = false; this.ready = false
    this.inflight = null; this.stop = null; this.source = null
  }
  async prepare(workspaceId, options) {
    if (!this.service?.open) throw Error('duet_agent_unavailable')
    if (!validAgentWorkspaceId(workspaceId)) throw Error('workspace_selection_required')
    let active = leases.get(this.service)
    if (!active) leases.set(this.service, active = new Map())
    if (active.has(workspaceId)) throw Error('duet_agent_workspace_in_use')
    active.set(workspaceId, this); this.workspaceId = workspaceId
    try {
      this.source = await this.service.open(workspaceId, options)
      if (this.closed) throw Error('duet_agent_connection_closed')
      if(this.source.trace)this.traceSender=new AgentTraceSender(this.source.trace,this.send,this.traceOptions)
      this.overview = this.source.overview()
      this.publishedRows = structuredClone(this.overview.sessions || {})
      return {protocol:AGENT_PROTOCOL, overview:this.overview}
    } catch (error) { this.close(); throw error }
  }
  offer(event) {
    if (event.session?.config?.agent_protocol !== AGENT_PROTOCOL) throw Error('duet_agent_backend_upgrade_required')
    if (!this.source || this.closed) throw Error('duet_agent_not_ready')
    this.ready = true
    this.traceSender?.offer(event.session?.config?.agent_trace_protocol)
    this.traceLab('voice.open',{voice_session_id:event.session?.id})
    this.traceLab('voice.context',{overview:this.overview})
    this.replayThrough=this.source.latestSequence?.() ?? Infinity
    this.stop = this.source.subscribe(() => this.flush())
    this.showTasks()
    if(this.present && this.source.taskRows){
      this.uiTimer=setInterval(()=>this.showTasks(),5000);this.uiTimer.unref?.()
    }
    this.flush()
  }
  showTasks(events=[]) {
    if(!this.present||this.closed||!this.source?.taskRows)return
    // Presentation failure must never affect voice delivery.
    try{
      const rows=this.source.taskRows().map(row=>{
        // Local notification identity; never send native ticket metadata upstream.
        const ticket=this.source.runtime?.store?.tickets?.get?.(row.session_id?.replace(/^worker-/,''))
        const run=ticket?.assignments?.at(-1)
        // Actual executor progress, not model selection metadata. Only project
        // the latest assignment: an older run must not look like current work.
        const progress=ticket?.attention?.question || run?.report?.summary || ticket?.ended?.reason
        return {...row,...(ticket?.attention?.id?{attention_id:ticket.attention.id}:{}),
          ...(typeof progress==='string'&&progress.trim()?{progress:progress.slice(0,4000)}:{})}
      })
      const key=r=>r.task_id+':'+r.run_id
      for(const r of rows)if(r.run_id && !r.finished_at && this.previousFinished?.has(key(r)))
        this.focusedResults.delete(key(r))
      this.previousFinished=new Set(rows.filter(r=>r.run_id && r.finished_at).map(key))
      const own=e=>e.request_id && this.liveRequests.has(this.source.ids.raw('request',e.request_id))
      const matches=e=>rows.find(r=>r.run_id && r.task_id===e.task_id && r.run_id===e.run_id)
      const result=events.slice().reverse().find(e=>e.purpose==='result' && matches(e) &&
        (own(e)||e.sequence>this.replayThrough) && !this.focusedResults.has(key(e)))
      const completed=(result && matches(result)) || rows.find(r=>r.finished_at &&
        this.liveRunKeys.has(key(r)) && !this.focusedResults.has(key(r)))
      const ack=events.slice().reverse().find(e=>e.purpose==='acknowledgement' && own(e) && matches(e) && !this.focusedResults.has(key(e)))
      const focus=completed?.session_id || (ack && matches(ack).session_id)
      if(completed)this.focusedResults.add(key(completed))
      this.liveRunKeys=new Set(rows.filter(r=>r.run_id && (!r.finished_at || this.liveRunKeys.has(key(r)))).map(key))
      while(this.focusedResults.size>256)this.focusedResults.delete(this.focusedResults.values().next().value)
      const serialized=JSON.stringify(rows)
      if(serialized!==this.lastRows||focus){
        if(focus)this.traceLab('view.focus_requested',{session_id:focus,reason:completed?'result':'acknowledgement'})
        this.present({type:'duet.local.tasks',rows,focus:focus||null,
          main_session_id:this.source.runtime?.masterId||null,
          ...(completed?{focus_reason:'result'}:{})});this.lastRows=serialized
      }
    }catch{/* Optional local view. */}
  }
  flush() {
    this.showTasks()
    if (this.closed || !this.ready || this.inflight) return
    const batch = this.source.events(this.source.cursor(), 20)
    if (!batch.events.length) {this.refresh();return}
    this.inflight = batch
    this.send({type:'duet.agent.events', protocol:AGENT_PROTOCOL, ...batch})
    this.showTasks(batch.events)
  }
  refresh() {
    // An overview can reference a delivered report. Its event batch goes first.
    if(this.inflight)return
    const current=structuredClone(this.source.overview())
    // The UI sees live engine state. The voice context only sees task lifecycle
    // changes after their corresponding notification has been delivered. In
    // particular, ended/queued can precede the orchestrator's result/acceptance.
    if(current.sessions && !Array.isArray(current.sessions)){
      for(const [sid,row] of Object.entries(current.sessions)){
        if(!row.latest_task_id)continue
        if(this.publishedRows[sid])current.sessions[sid]=structuredClone(this.publishedRows[sid])
        else delete current.sessions[sid]
      }
      if(current.session_order)current.session_order=current.session_order.filter(id=>
        current.sessions[id] || current.other_sessions?.[id])
    }
    const delta=overviewDelta(this.overview,current)
    if(Object.keys(delta.set).length||delta.unset.length)this.send({type:'duet.agent.state',protocol:AGENT_PROTOCOL,delta})
    this.overview=current
  }
  publishTaskNotifications(events) {
    const current=this.source.overview(), rows=this.source.taskRows?.() || []
    for(const event of events){
      if(!event.task_id || !event.run_id)continue
      const live=rows.find(row=>row.task_id===event.task_id)
      // A delayed result for an older run must not finish the newer run.
      if(live && live.run_id!==event.run_id)continue
      const entry=Object.entries(current.sessions || {}).find(([,row])=>row.latest_task_id===event.task_id)
      if(!entry)continue
      const [sid,value]=entry, row=structuredClone(value)
      if(event.purpose==='result')row.state=event.status
      else if(event.purpose==='acknowledgement')row.state=value.state==='running'?'running':'queued'
      else if(event.type==='attention')row.state='waiting_user'
      else continue
      if(typeof event.text==='string'){
        const chars=Array.from(event.text)
        row.latest_report={task_id:event.task_id,status:event.status??null,
          body_excerpt:{text:chars.slice(0,360).join(''),truncated:chars.length>360}}
      }
      this.publishedRows[sid]=row
    }
  }
  handle(event) {
    if(this.traceSender?.handle(event))return true
    if (!event.type?.startsWith('duet.agent.')) return false
    if (!this.ready || this.closed || event.protocol !== AGENT_PROTOCOL) throw Error('invalid_duet_agent_event')
    if (event.type === 'duet.agent.ack') {
      if (Number.isSafeInteger(event.cursor) && event.cursor >= 0 && event.cursor <= this.source.cursor()) return true
      if (!this.inflight || event.cursor !== this.inflight.cursor) throw Error('invalid_agent_cursor')
      this.publishTaskNotifications(this.inflight.events)
      this.source.acknowledge(event.cursor); this.inflight = null; this.flush(); return true
    }
    if (event.type === 'duet.agent.request') {
      // The request ID belongs to the originating action, never this delivery attempt.
      const {request_id, message} = event
      if (typeof request_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(request_id)) throw Error('invalid_agent_request_id')
      let response
      if(validMessage(message))this.traceLab('voice.action',{request_id,message})
      if (!validMessage(message)) response={status:400,body:{error_code:'invalid_agent_message'}}
      else try {
        this.liveRequests.add(request_id)
        if(this.liveRequests.size>256)this.liveRequests.delete(this.liveRequests.values().next().value)
        const body=this.source.receive({protocol:AGENT_PROTOCOL,request_id,message})
        if (body?.received !== true) throw Error('agent_delivery_unconfirmed')
        response={status:200,body}
      } catch (error) {
        const rejected=['request_id_conflict','question_not_pending','question_task_missing','agent_message_filtered'].includes(error?.message)
        response={status:rejected?400:503,body:{error_code:rejected?error.message:'agent_delivery_unconfirmed'}}
      }
      this.send({type:'duet.agent.response',protocol:AGENT_PROTOCOL,request_id,...response})
      this.traceLab('voice.receipt',{request_id,...response})
      if (response.status === 200) this.refresh()
      return true
    }
    if (event.type === 'duet.agent.refresh') {
      this.refresh(); return true
    }
    throw Error('unsupported_duet_agent_event')
  }
  traceLab(kind,value){
    try{this.source?.trace?.add(kind,value)}catch{/* Diagnostics cannot interrupt voice. */}
    try{this.source?.labTrace?.add(kind,value)}catch{/* optional local fixture */}
  }
  close() {
    if(this.ready&&!this.closed)this.traceLab('voice.close',{})
    clearInterval(this.uiTimer);this.liveRequests.clear()
    this.traceSender?.close()
    this.closed = true; this.stop?.(); this.stop = null
    const active = this.service && leases.get(this.service)
    if (active?.get(this.workspaceId) === this) active.delete(this.workspaceId)
    // Detach delivery, not execution. The native Engine owns running tasks.
  }
}
