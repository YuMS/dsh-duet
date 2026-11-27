import { WORK_MODES, AGENT_PERMISSION_TEXT, AGENT_WORKSPACE_NOTICE, workModeIssue, TASK_STATES, taskModelLabel } from '../shared/work-mode.mjs'
import { identityFetch } from './identity.mjs?v=0.3.4'

const styles = `
.dt-work{--ink:light-dark(#20392d,#e3eee7);--muted:light-dark(#53695c,#a7b9ae);--edge:light-dark(#cbd7cf,#3b4a40);--surface:light-dark(#fff,#191f1d);--tint:light-dark(#eef7f0,#203329);--accent:light-dark(#236548,#b3e9cb);color:var(--ink);font:normal 14px/1.5 system-ui,sans-serif;text-align:start;display:grid;gap:16px;container-type:inline-size}
.dt-work *{box-sizing:border-box}.dt-work [hidden]{display:none!important}
.dt-work h2,.dt-work p,.dt-work label,.dt-work details{margin:0}.dt-work h2{font-size:20px;letter-spacing:-.03em}
.dt-work .choices,.dt-work .fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dt-work button.choice{display:grid;align-content:start;gap:5px;padding:14px;text-align:start;border:1px solid var(--edge);border-radius:12px;cursor:pointer;color:var(--ink);font-weight:400}
.dt-work button.choice[aria-pressed=true]{border-color:var(--accent);background:var(--tint)}
.dt-work .choice strong{font-size:15px}.dt-work .choice small,.dt-work .subtle{color:var(--muted);font-size:13px}
.dt-work .badge{margin-inline-start:6px;font-size:11px;font-weight:600;background:var(--tint);color:var(--accent);border:1px solid var(--edge);border-radius:20px;padding:1px 6px;vertical-align:middle;white-space:nowrap}
.dt-work .agent-options,.dt-work .model-fields{display:grid;gap:14px}
.dt-work .workspace-row,.dt-work .actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px}
.dt-work .workspace-row select{width:auto;max-width:100%}.dt-work .actions{justify-content:flex-end}
.dt-work .workspace-row button[aria-pressed=true]{border-color:var(--accent);background:var(--tint)}
.dt-work button.confirm{color:var(--surface);background:var(--accent);border-color:var(--accent)}
.dt-work .permission{color:var(--muted);font-size:12px;line-height:1.5}
.dt-work label.field{display:grid;gap:5px;min-width:0;color:var(--muted);font-size:13px}
.dt-work select{width:100%;min-width:0;height:39px;padding:0 8px;border:1px solid var(--edge);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}
.dt-work details{padding:10px 0 0;border:0;border-top:1px solid var(--edge)}.dt-work summary{color:var(--muted);font-size:13px;cursor:pointer}.dt-work details .fields{margin-top:10px}
.dt-work button{width:auto;margin:0;border:1px solid var(--edge);border-radius:9px;padding:8px 14px;color:var(--ink);background:transparent;font:600 13px/1.4 system-ui;cursor:pointer}
.dt-work button:disabled{opacity:.5;cursor:default}.dt-work :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dt-work [role=status]:empty{display:none}.dt-work [role=status]{font-size:13px}
.dt-work button.choice{position:relative;padding:18px 40px 18px 18px;gap:8px;border-radius:16px;transition:background .15s,border-color .15s}
.dt-work button.choice::after{content:'';position:absolute;right:16px;top:20px;width:14px;height:14px;border:1.5px solid var(--edge);border-radius:50%}
.dt-work button.choice[aria-pressed=true]::after{border:4px solid var(--accent);background:var(--surface)}
.dt-work .choice strong{font-size:16px}.dt-work .choice small{line-height:1.65}
.dt-work .agent-options{padding:18px;border:1px solid var(--edge);border-radius:16px;gap:18px;background:color-mix(in srgb,var(--surface) 94%,var(--accent))}
.dt-work .workspace-row{justify-content:flex-start;gap:10px}.dt-work .workspace-row select{flex:1;min-width:160px;max-width:360px}
.dt-work .fields{gap:16px}.dt-work label.field{gap:8px}.dt-work select{height:42px;border-radius:10px;padding:0 12px}
.dt-work .auto-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--edge)}
.dt-work .auto-row label{cursor:pointer;color:var(--ink);font-size:14px}
.dt-work button.auto-toggle{position:relative;flex:0 0 40px;width:40px;height:24px;min-height:24px;padding:0;border:1px solid var(--edge);border-radius:20px;background:var(--edge)}
.dt-work button.auto-toggle::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--surface);box-shadow:0 1px 3px #0003;transition:transform .16s}
.dt-work button.auto-toggle[aria-checked=true]{background:var(--accent);border-color:var(--accent)}
.dt-work button.auto-toggle[aria-checked=true]::after{transform:translateX(16px)}
.dt-work .auto-row small{color:var(--muted);font-size:12px}.dt-work .auto-copy{display:grid;gap:3px}
@container(max-width:390px){.dt-work .choices,.dt-work .fields{grid-template-columns:1fr}}
`

async function api(path, body) {
  const response = await identityFetch(`/duplex-control/api/voice/${path}`, {
    signal:AbortSignal.timeout(10000),
    credentials:'same-origin', cache:'no-store', ...(body ? {method:'PUT',
      headers:{'Content-Type':'application/json','X-Duplex-Settings':'1'},body:JSON.stringify(body)} : {}),
  })
  if (!response.ok) throw Error('配置暂时不可用，请重试。')
  return response.json()
}

/** Shared by first-use guidance and settings. No task or audio starts here. */
export async function mountWorkMode(container, {saved=()=>{}, cancel=null, initialConfig=null, preview=false}={}) {
  let disposed=false, busy=false, choosingAgent=false
  const onboarding=Boolean(cancel)
  let draft=null, dedicated=false
  const [config, options] = preview
    ? [{work_mode_choice_version:0,agent_permission_version:0}, {workspaces:[{id:'example',name:'示例工作区'}]}]
    : await (async()=>{const c=initialConfig??await api('config')
      return [c,c.work_mode_policy==='direct_only'?{workspaces:[]}:await api('work-options')]})()
  if(!container.isConnected)return ()=>{}
  let dedicatedId=options.dedicated_workspace_id||null
  let legacyTitle=options.workspaces.some(w=>w.id===dedicatedId&&w.name==='duet')
  const prefersDedicated=opts=>!opts?.workspace_id||!!dedicatedId&&opts.workspace_id===dedicatedId
  dedicated=prefersDedicated(config.agent_options)
  const root=document.createElement('div')
  root.className='dt-work'
  const style=document.createElement('style');style.textContent=styles;root.append(style)
  if(cancel){
    const heading=document.createElement('h2');heading.textContent='想怎么用 dsh-duet？';root.append(heading)
    const intro=document.createElement('p');intro.className='subtle';intro.textContent=preview?'首次使用预览 · 不会更改你的设置。':'选一种工作方式，以后可以在设置中更改。';root.append(intro)
  }
  const choices=document.createElement('div');choices.className='choices';choices.setAttribute('role','group');choices.setAttribute('aria-label','工作方式');root.append(choices)
  const cards={}
  for(const value of ['agent','direct']) {
    const item=WORK_MODES[value]
    const label=document.createElement('button');label.type='button';label.className='choice';label.dataset.workMode=value
    const title=document.createElement('strong'),detail=document.createElement('small')
    title.textContent=item.name;detail.textContent=item.description
    if(value==='agent'&&(!config.work_mode_policy||config.work_mode_policy==='recommend_agent')){const badge=document.createElement('span');badge.className='badge';badge.textContent='推荐';title.append(badge)}
    label.append(title,detail)
    if(value==='agent'){
      const warning=document.createElement('small'),emphasis=document.createElement('b')
      const [before,after]=AGENT_WORKSPACE_NOTICE.split('只能');emphasis.textContent='只能'
      warning.append(before,emphasis,after);label.append(warning)
    }
    choices.append(label);cards[value]=label
  }
  const agent=document.createElement('div');agent.className='agent-options'
  const permission=document.createElement('small');permission.className='permission';permission.id='dt-permission-'+crypto.randomUUID()
  permission.textContent=AGENT_PERMISSION_TEXT;cards.agent.append(permission);cards.agent.title=AGENT_PERMISSION_TEXT
  cards.agent.setAttribute('aria-describedby',permission.id)
  if(config.work_mode_policy==='direct_only'){cards.agent.remove();choices.style.gridTemplateColumns='1fr'}
  const fields=document.createElement('div');fields.className='fields';agent.append(fields)
  const select=(title, entries, value)=>{
    const label=document.createElement('label');label.className='field';label.textContent=title
    const input=document.createElement('select');input.setAttribute('aria-label',title)
    for(const [id,name] of entries){const option=document.createElement('option');option.value=id;option.textContent=name;input.append(option)}
    input.value=value||'';label.append(input);return {label,input}
  }
  const workspace=select('工作区', [['','请选择工作区'],...options.workspaces.filter(w=>w.id!==dedicatedId).map(w=>[w.id,w.name||w.path])],dedicated?'':config.agent_options?.workspace_id)
  const workspaceRow=(tag,text,control)=>{
    const row=document.createElement(tag);row.className='workspace-row subtle'
    const caption=document.createElement('span');caption.textContent=text;row.append(caption,control);return row
  }
  const create=document.createElement('button');create.type='button'
  const dedicatedRow=workspaceRow('div','建议为 dsh-duet 使用单独的工作区',create)
  const existingRow=workspaceRow('label','或者选择已有工作区',workspace.input)
  agent.prepend(dedicatedRow,existingRow)
  const models=(options.models?.groups||[]).flatMap(g=>g.models.map(m=>({...m,provider:g.id,label:`${g.name||g.id} / ${m.name||m.id}`})))
  const key=m=>m?JSON.stringify([m.provider,m.model]):''
  const modelSelect=(title,defaultLabel,value)=>{
    const field=select(title,[['',defaultLabel],...models.map(m=>[key({provider:m.provider,model:m.id}),m.label])],key(value))
    if(value&&!models.some(m=>m.provider===value.provider&&m.id===value.model)) {
      const missing=document.createElement('option');missing.value=key(value);missing.textContent=`${value.model}（当前不可用，请重新选择）`;missing.disabled=true;field.input.append(missing);field.input.value=missing.value
    }
    const effort=select('推理强度',[['','使用模型默认值']],value?.reasoningEffort)
    const refresh=()=>{
      const model=models.find(m=>key({provider:m.provider,model:m.id})===field.input.value)
      effort.input.replaceChildren(new Option('使用模型默认值',''),...(model?.reasoning?.efforts||[]).map(e=>new Option(e.name||e.id,e.id)))
      effort.label.hidden=!model?.reasoning?.efforts?.length
    }
    refresh();effort.input.value=value?.reasoningEffort||'';field.input.onchange=refresh
    return {...field,effort,restore:v=>{field.input.value=key(v);refresh();effort.input.value=v?.reasoningEffort||''},value:()=>{
      if(!field.input.value)return null
      if(field.input.selectedOptions[0]?.disabled)throw Error('请选择可用模型。')
      const [provider,model]=JSON.parse(field.input.value)
      return {provider,model,...(effort.input.value?{reasoningEffort:effort.input.value}:{})}
    }}
  }
  const executor=modelSelect('任务模型','跟随 DSH 默认模型',config.agent_options?.executor_model)
  fields.append(executor.label,executor.effort.label)
  const autoRow=document.createElement('div');autoRow.className='auto-row'
  const autoLabel=document.createElement('label');autoLabel.textContent='自动跳转会话'
  const autoSwitch=document.createElement('button');autoSwitch.type='button';autoSwitch.setAttribute('role','switch');autoSwitch.setAttribute('aria-label','自动跳转会话')
  autoSwitch.className='auto-toggle';autoSwitch.id='dt-auto-'+crypto.randomUUID();autoLabel.htmlFor=autoSwitch.id
  const autoCopy=document.createElement('div');autoCopy.className='auto-copy'
  const autoHelp=document.createElement('small');autoHelp.textContent='跟随任务，打开正在处理或刚完成的会话';autoCopy.append(autoLabel,autoHelp)
  let autoEnabled=config.agent_options?.auto_switch_session!==false
  const drawAuto=()=>{autoSwitch.setAttribute('aria-checked',String(autoEnabled));autoSwitch.title=autoEnabled?'关闭自动跳转':'开启自动跳转'}
  drawAuto();autoRow.append(autoSwitch,autoCopy);agent.append(autoRow)
  const advanced=document.createElement('details'),summary=document.createElement('summary');summary.textContent='高级设置 · 任务管理模型'
  const manager=modelSelect('任务管理模型','与任务模型相同',config.agent_options?.manager_model)
  const extra=document.createElement('div');extra.className='fields';extra.append(manager.label,manager.effort.label)
  advanced.append(summary,extra);agent.append(advanced)
  const tasks=document.createElement('details')
  if(!cancel&&!preview){
    const title=document.createElement('summary'),list=document.createElement('ul'),refresh=document.createElement('button')
    title.textContent='会话与模型';refresh.type='button';refresh.textContent='刷新'
    const load=async()=>{
      refresh.disabled=true
      try{
        const {rows=[],main}=await api('agent-tasks')
        list.replaceChildren()
        const append=(name,info)=>{
          const li=document.createElement('li'),label=document.createElement('strong'),model=document.createElement('small')
          label.textContent=name;model.textContent=taskModelLabel(info);model.style.cssText='display:block;overflow-wrap:anywhere;color:var(--muted)'
          li.style.cssText='margin:10px 0;list-style:none';li.append(label,model);list.append(li)
        }
        if(main)append('dsh-duet 主会话',main.model_info)
        for(const row of rows){
          append((row.name||'未命名任务')+' · '+(TASK_STATES[row.state]||'状态待确认'),row.model_info)
        }
        if(!rows.length&&!main)list.textContent='还没有任务'
      }catch{list.textContent='暂时无法读取任务状态'}
      finally{refresh.disabled=false}
    }
    tasks.ontoggle=()=>{if(tasks.open)void load()};refresh.onclick=load
    tasks.append(title,list,refresh);agent.append(tasks)
  }
  root.append(agent)
  const status=document.createElement('p');status.setAttribute('role','status');status.style.margin='0'
  root.append(status)
  const confirm=document.createElement('button')
  if(onboarding){
    const actions=document.createElement('div');actions.className='actions'
    const back=document.createElement('button');back.type='button';back.textContent=preview?'退出预览':'稍后选择';back.onclick=cancel
    confirm.type='button';confirm.className='confirm';confirm.textContent='确定'
    actions.append(back,confirm);root.append(actions)
  }
  const currentMode=()=>config.work_mode_choice_version===1?config.work_mode:null
  const draw=()=>{
    for(const [mode,button] of Object.entries(cards))button.setAttribute('aria-pressed',String((onboarding?draft:currentMode())===mode))
    const activeAgent=currentMode()==='agent'&&config.agent_permission_version===1
    tasks.hidden=!activeAgent
    agent.hidden=onboarding?draft!=='agent':!activeAgent&&!choosingAgent
    fields.hidden=executor.label.hidden=advanced.hidden=!activeAgent
    autoRow.hidden=!activeAgent
    if(!activeAgent)executor.effort.label.hidden=true
    workspace.input.options[0].disabled=activeAgent
    permission.hidden=activeAgent
    root.querySelectorAll('button,select').forEach(el=>{el.disabled=busy})
    create.textContent=dedicatedId?'使用 dsh-duet 专属工作区':'创建 dsh-duet 专属工作区'
    dedicatedRow.firstElementChild.hidden=!!dedicatedId
    create.setAttribute('aria-pressed',String(dedicated))
    if(onboarding){
      confirm.disabled=busy||!draft||(draft==='agent'&&!dedicated&&!workspace.input.value)
    }
  }
  const restoreFields=()=>{const opts=config.agent_options;dedicated=prefersDedicated(opts);workspace.input.value=dedicated?'':opts?.workspace_id||'';executor.restore(opts?.executor_model);manager.restore(opts?.manager_model);autoEnabled=opts?.auto_switch_session!==false;drawAuto()}
  const persist=async(mode)=>{
    if(busy||disposed)return
    status.textContent=''
    if(mode==='agent'&&!workspace.input.value&&!dedicated){
      choosingAgent=true;draw()
      workspace.input.focus();return
    }
    busy=true;draw()
    try {
      if(preview){saved();return}
      const current=await api('config')
      if(disposed)return
      // Do not overwrite another page's configuration during a long-open dialog.
      if(current.revision!==config.revision)throw Error('配置已在其他页面更新，请重新打开。')
      if(mode==='agent'&&dedicated&&(!dedicatedId||legacyTitle))await createWorkspace()
      if(disposed)return
      const result=await api('config',{backend_url:current.backend_url,revision:current.revision,work_mode:mode,
        agent_permission:mode==='agent',agent_options:mode==='agent'?{workspace_id:dedicated?dedicatedId:workspace.input.value,
          executor_model:executor.value(),manager_model:manager.value(),auto_switch_session:autoEnabled}:current.agent_options})
      Object.assign(config,result);choosingAgent=false;restoreFields()
      if(!disposed)saved(result)
    }catch(error){if(!disposed){if(!onboarding){choosingAgent=false;restoreFields()}status.textContent=error.message}}
    finally{busy=false;if(!disposed)draw()}
  }
  const createWorkspace=async()=>{
    const response=await identityFetch('/duplex-control/api/voice/dedicated-workspace',{
      method:'POST',credentials:'same-origin',headers:{'X-Duplex-Settings':'1','Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(12000)})
    if(!response.ok)throw Error('未能创建工作区，可以重试或选择已有工作区。')
    const row=await response.json()
    if(disposed)return
    if(!row.id)throw Error('未能读取专属工作区，请重试。')
    dedicatedId=row.id;legacyTitle=false
  }
  confirm.onclick=()=>{if(!confirm.disabled)void persist(draft)}
  autoSwitch.onclick=()=>{if(busy)return;autoEnabled=!autoEnabled;drawAuto();if(!onboarding)void persist('agent')}
  create.onclick=async()=>{
    if(busy||disposed)return
    status.textContent=''
    dedicated=true;workspace.input.value='';draw()
    if(!onboarding)await persist('agent')
  }
  for(const [mode,button] of Object.entries(cards))button.onclick=()=>{
    if(onboarding){draft=mode;status.textContent='';draw();return}
    if(mode==='direct'&&currentMode()==='direct'&&!config.agent_permission_version){choosingAgent=false;restoreFields();status.textContent='';draw();return}
    if(mode==='agent'&&currentMode()==='agent'&&!workModeIssue(config))return
    // Show the default workspace choice before creating it or granting permissions.
    if(mode==='agent'&&!choosingAgent&&!config.agent_options?.workspace_id){choosingAgent=true;draw();return}
    void persist(mode)
  }
  agent.addEventListener('change',event=>{
    if(event.target===workspace.input)dedicated=false
    if(onboarding){status.textContent='';draw();return}
    if(choosingAgent||currentMode()==='agent')void persist('agent')
  })
  draw()
  container.replaceChildren(root)
  return ()=>{disposed=true;root.remove()}
}

export function workModeOnboarding(onReady=()=>{}, {preview=false}={}) {
  const deferKey='dsh.duet.defer-work-mode.v1'
  let panel,disposeForm,disposed=false,previous,chosen=false
  const close=()=>{disposeForm?.();disposeForm=null;panel?.remove();panel=null;if(previous?.isConnected)previous.focus({preventScroll:true});previous=null}
  const defer=()=>{if(!preview){try{sessionStorage.setItem(deferKey,'1')}catch{}}close()}
  const show=async(initialConfig=null)=>{
    chosen=false
    if(panel||disposed)return
    previous=document.activeElement
    panel=document.createElement('section');panel.setAttribute('aria-label','dsh-duet 工作方式')
    const target=panel
    panel.tabIndex=-1;panel.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();defer()}}
    panel.style.cssText='position:fixed;box-sizing:border-box;z-index:2147483000;left:50%;top:8vh;transform:translateX(-50%);width:min(520px,94vw);max-height:84vh;overflow:auto;padding:clamp(16px,4vw,26px);border-radius:18px;color-scheme:light dark;background:light-dark(#fff,#191f1d);color:light-dark(#20392d,#e3eee7);border:1px solid light-dark(#cbd7cf,#3b4a40);box-shadow:0 12px 48px #0003'
    panel.textContent='正在读取工作方式…';document.body.append(panel)
    target.focus({preventScroll:true})
    try{const cleanup=await mountWorkMode(target,{initialConfig,preview,saved:()=>{chosen=true;close();if(!preview)onReady()},cancel:defer});if(target===panel)disposeForm=cleanup;else cleanup()}
    catch{if(panel===target){panel.textContent='暂时无法读取工作方式，请稍后从 duet 设置重试。';const b=document.createElement('button');b.textContent='关闭';b.onclick=defer;panel.append(b)}}
  }
  return {show,async ready({passive=false}={}){
    // The connection already fetches and validates live config within its cancellable handshake.
    if(chosen)return !disposed
    const configuration=await api('config')
    if(disposed)return false
    if(!workModeIssue(configuration)){chosen=true;if(panel)close();onReady();return true}
    if(passive){try{if(sessionStorage.getItem(deferKey))return false}catch{}}
    await show(configuration);return false
  },
    dispose(){disposed=true;close()}}
}
