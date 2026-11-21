/** Work mode is independent of microphone/speaker mode. */
export const WORK_MODE_VERSION = 1
export function effectiveWorkPolicy(config,policy='recommend_agent'){
  const force=policy==='direct_only'
  const implicit=policy==='default_direct' && config.work_mode_choice_version!==WORK_MODE_VERSION
  return {...config,work_mode_policy:policy,...(force||implicit?{work_mode:'direct',
    work_mode_choice_version:WORK_MODE_VERSION,agent_permission_version:0}:{})}
}
const READ_KEY='duet.agent.visited.v1', visitKey=id=>READ_KEY+'.'+id
export const nativeWorkerId=id=>typeof id==='string' && /^worker-[a-f0-9]{32}$/.test(id)
const cachedVisits=new Map()
const completionTimers=new Map(),completionKey=id=>'duet.agent.completion-expiry.v1.'+id
/** Start once on receipt, not on the possibly skewed DSH completion clock. */
export function taskCompletionSeconds(row,now=Date.now()){
  if(!nativeWorkerId(row?.session_id)||!Number.isFinite(row.finished_at)||taskCardState(row)!=='completed')return null
  const stamp=JSON.stringify([row.run_id??null,row.finished_at]),key=completionKey(row.session_id)
  let saved=completionTimers.get(key)
  try{const stored=JSON.parse(localStorage.getItem(key));if(stored?.stamp===stamp&&Number.isFinite(stored.end))saved=stored}catch{}
  if(saved?.stamp!==stamp||!Number.isFinite(saved.end)){
    saved={stamp,end:now+10000};completionTimers.set(key,saved)
    try{localStorage.setItem(key,JSON.stringify(saved))}catch{}
  }
  completionTimers.set(key,saved)
  return Math.max(0,Math.min(10,Math.ceil((saved.end-now)/1000)))
}
const waitingReads=new Map(),waitingKey=id=>'duet.agent.waiting-read.v1.'+id
export function taskCardState(row){
  return ['completed','merged','ready','ended'].includes(row.state)?'completed':['failed'].includes(row.state)?'failed':
    ['stopped','dropped','closed','cancelled'].includes(row.state)?'stopped':
    ['queued','pending','running','progress'].includes(row.state)?'running':'waiting'
}
const waitingNotice=row=>JSON.stringify([row.attention_id||null,row.run_id||null,row.state])
function waitingWasRead(row){
  let saved=waitingReads.get(row.session_id)
  try{saved=localStorage.getItem(waitingKey(row.session_id))||saved}catch{}
  return saved===waitingNotice(row)
}
export function noteTaskNoticeVisit(row,now=Date.now()){
  if(!row||!nativeWorkerId(row.session_id))return
  if(row.finished_at)noteTaskVisit(row.session_id,now)
  else if(taskCardState(row)==='waiting'){
    const value=waitingNotice(row);waitingReads.set(row.session_id,value)
    try{localStorage.setItem(waitingKey(row.session_id),value)}catch{}
  }
}
function storedVisit(id){
  try{return Number(localStorage.getItem(visitKey(id)))||0}catch{return 0}
}
function legacyVisits(){
  try{return JSON.parse(localStorage.getItem(READ_KEY)||'{}')||{}}catch{return {}}
}
export function noteTaskVisit(id,now=Date.now()){
  if(!nativeWorkerId(id))return
  const at=Math.max(now,storedVisit(id),cachedVisits.get(id)||0)
  cachedVisits.set(id,at)
  try{localStorage.setItem(visitKey(id),String(at))}catch{}
}
export function visibleTaskRows(rows){
  const old=legacyVisits()
  return rows.filter(r=>{
    if(!r)return false
    if(taskCompletionSeconds(r)===0)return false
    const visited=Math.max(Number(old[r.session_id])||0,cachedVisits.get(r.session_id)||0,storedVisit(r.session_id))
    return r.finished_at ? visited<r.finished_at : taskCardState(r)!=='waiting'||!waitingWasRead(r)
  })
}
export const TASK_STATES={queued:'排队中',pending:'准备中',running:'运行中',progress:'运行中',waiting:'等待中',
  waiting_user:'待你回答',ready:'结果就绪',ended:'执行已结束',completed:'已完成',merged:'已完成',
  failed:'失败',blocked:'受阻',dropped:'已终止',stopped:'已停止',closed:'已关闭'}
export const WORK_MODES = {
  direct: {name:'输入模式（传统）',description:'帮你把需求输入文本框'},
  agent: {name:'代理模式',description:'直接帮你执行任务'},
}
export const AGENT_WORKSPACE_NOTICE = '代理模式只能在全新工作区和会话中使用；如果需要在历史会话中使用，请使用输入模式。'
const reminderKey='dsh.duet.agent-entry-reminders.v1'
const reminderConnections=new Map()
let reminderCount=0
export function agentEntryReminder(connectionId,storage){
  if(!connectionId)return false
  if(reminderConnections.has(connectionId))return reminderConnections.get(connectionId)
  try{storage??=globalThis.localStorage}catch{}
  try{const n=Number(storage?.getItem(reminderKey));if(Number.isSafeInteger(n)&&n>=0)reminderCount=Math.max(reminderCount,n)}catch{}
  const show=reminderCount<10
  reminderCount=Math.min(10,reminderCount+1)
  try{storage?.setItem(reminderKey,String(reminderCount))}catch{}
  reminderConnections.set(connectionId,show)
  if(reminderConnections.size>100)reminderConnections.delete(reminderConnections.keys().next().value)
  return show
}
export const AGENT_PERMISSION_TEXT = '启用代理模式后，dsh-duet 会以完整权限（danger-full-access）执行命令、读写文件和访问网络，无需逐项确认。任务从所选工作区开始，但访问不限于该目录；其他 DSH 会话的权限不变。'
export const validAgentWorkspaceId = id => typeof id === 'string' && id.length > 0 && id.length <= 512
export function roleModel(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k=>!['provider','model','reasoningEffort'].includes(k)) ||
      ['provider','model'].some(k=>typeof value[k]!=='string'||!value[k].trim()||value[k].length>256) ||
      value.reasoningEffort !== undefined && (typeof value.reasoningEffort!=='string'||!value.reasoningEffort||value.reasoningEffort.length>64)) throw Error('invalid_agent_model')
  return {provider:value.provider,model:value.model,...(value.reasoningEffort?{reasoningEffort:value.reasoningEffort}:{})}
}
export function agentOptions(value = {}) {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('invalid_agent_options')
  const workspace_id=value.workspace_id??null
  if(workspace_id!==null&&!validAgentWorkspaceId(workspace_id))throw Error('invalid_agent_workspace')
  if(value.auto_switch_session!==undefined&&typeof value.auto_switch_session!=='boolean')throw Error('invalid_agent_auto_switch')
  return {workspace_id,executor_model:roleModel(value.executor_model),manager_model:roleModel(value.manager_model),auto_switch_session:value.auto_switch_session!==false}
}
export function workModeIssue(config) {
  if(config.work_mode_choice_version!==WORK_MODE_VERSION)return 'work_mode_choice_required'
  if(config.work_mode==='agent') {
    if(config.agent_permission_version!==WORK_MODE_VERSION)return 'agent_permission_required'
    if(!config.agent_options?.workspace_id)return 'workspace_selection_required'
  }
  return null
}
export function taskModelLabel(info) {
  if(!info || typeof info.provider!=='string' || typeof info.model!=='string')return '模型尚未记录'
  const prefix={response:'最近使用',request:'最近请求',selection:'已选择',configured:'待使用'}[info.source]||'模型'
  return `${prefix}：${info.provider} / ${info.model}`
}
