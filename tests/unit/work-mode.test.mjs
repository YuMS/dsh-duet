import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DuetSettings} from '../../src/host/settings.mjs'
import {WORK_MODES,workModeIssue,agentOptions,effectiveWorkPolicy} from '../../src/shared/work-mode.mjs'
import {WorkModePolicy} from '../../src/host/service-info.mjs'

test('recommend asks, default directly unlocks, restriction overrides grants without erasing them',()=>{
  const fresh={work_mode:'direct',work_mode_choice_version:0}
  const agent={work_mode:'agent',work_mode_choice_version:1,agent_permission_version:1,agent_options:{workspace_id:'w'}}
  assert.equal(workModeIssue(effectiveWorkPolicy(fresh,'recommend_agent')),'work_mode_choice_required')
  for(const rule of ['default_direct','direct_only'])assert.equal(workModeIssue(effectiveWorkPolicy(fresh,rule)),null)
  for(const rule of ['recommend_agent','default_direct'])assert.equal(effectiveWorkPolicy(agent,rule).work_mode,'agent')
  const effective=effectiveWorkPolicy(agent,'direct_only')
  assert.equal(effective.work_mode,'direct');assert.equal(effective.agent_permission_version,0)
  assert.equal(agent.agent_permission_version,1)
})

test('policy uses voice endpoint, coalesces reads and retains restriction on transient failure',async()=>{
  let host='one.test',calls=0,fail=false
  const p=new WorkModePolicy(()=>({endpoints:{online:'wss://'+host+'/base/ws?protocol=x'}}),async url=>{
    calls++;assert.equal(url.href,'https://'+host+'/base/api/work-mode-policy')
    if(fail)throw Error('timeout')
    return host==='one.test'?Response.json({work_mode_policy:'direct_only'}):new Response(null,{status:404})
  })
  assert.deepEqual(await Promise.all([p.get(),p.get()]),['direct_only','direct_only']);assert.equal(calls,1)
  p.entry.expires=0;fail=true;assert.equal(await p.get(),'direct_only')
  host='old.test';fail=false;assert.equal(await p.get(),'recommend_agent')
})

test('upgrades require a choice, even though the retained work mode is direct',async t=>{
  const root=await mkdtemp(join(tmpdir(),'duet-modes-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const base={endpoints:{online:'wss://example.test/ws',tts_only:'wss://example.test/ws'}}
  const settings=new DuetSettings(base,{path:join(root,'settings.json')})
  assert.equal(workModeIssue(settings.public()),'work_mode_choice_required')
  const save=(extra)=>settings.save({backend_url:settings.public().backend_url,revision:settings.revision,...extra})
  await save({});assert.equal(workModeIssue(settings.public()),'work_mode_choice_required')
  await save({work_mode:'direct'});assert.equal(workModeIssue(settings.public()),null)
  await assert.rejects(save({work_mode:'agent',agent_options:{workspace_id:'ws'}}),/agent_permission_required/)
  await assert.rejects(save({work_mode:'agent',agent_permission:true}),/workspace_selection_required/)
  assert.equal(settings.public().agent_permission_version,0)
  await save({work_mode:'agent',agent_permission:true,agent_options:{workspace_id:'ws',executor_model:{provider:'p',model:'m'}}})
  assert.equal(workModeIssue(new DuetSettings(base,{path:settings.path}).public()),null)
  await save({work_mode:'direct',agent_permission:false})
  assert.equal(settings.public().agent_permission_version,0)
  await assert.rejects(save({work_mode:'agent'}),/agent_permission_required/)
})

test('short copy and model options have a single canonical definition',()=>{
  assert.deepEqual(Object.values(WORK_MODES).map(x=>x.name),['输入模式（传统）','代理模式'])
  assert.deepEqual(agentOptions(),{workspace_id:null,executor_model:null,manager_model:null,auto_switch_session:true})
  assert.equal(agentOptions({auto_switch_session:false}).auto_switch_session,false)
  assert.throws(()=>agentOptions({auto_switch_session:'false'}),/invalid_agent_auto_switch/)
  assert.throws(()=>agentOptions({executor_model:{provider:'x',model:'m',apiKey:'secret'}}),/invalid_agent_model/)
  assert.throws(()=>agentOptions({workspace_id:'',manager_model:null}),/invalid_agent_workspace/)
})
