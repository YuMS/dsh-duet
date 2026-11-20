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
  return rows.filter(r=>r && (!r.finished_at || Math.max(Number(old[r.session_id])||0,
    cachedVisits.get(r.session_id)||0,storedVisit(r.session_id))<r.finished_at))
}
export const TASK_STATES={queued:'排队中',pending:'准备中',running:'运行中',progress:'运行中',waiting:'等待中',
  waiting_user:'待你回答',ready:'结果就绪',ended:'执行已结束',completed:'已完成',merged:'已完成',
  failed:'失败',blocked:'受阻',dropped:'已终止',stopped:'已停止',closed:'已关闭'}
export const WORK_MODES = {
  direct: {name:'输入模式',description:'帮你把需求输入文本框'},
  agent: {name:'代理模式',description:'直接帮你执行任务'},
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
  return {workspace_id,executor_model:roleModel(value.executor_model),manager_model:roleModel(value.manager_model)}
}
export function workModeIssue(config) {
  if(config.work_mode_choice_version!==WORK_MODE_VERSION)return 'work_mode_choice_required'
  if(config.work_mode==='agent') {
    if(config.agent_permission_version!==WORK_MODE_VERSION)return 'agent_permission_required'
    if(!config.agent_options?.workspace_id)return 'workspace_selection_required'
  }
  return null
}
