import assert from 'node:assert/strict'
import test from 'node:test'
import {buildSessionCatalog, orderSessionCatalog, WORKSPACE_VIEW_KEY} from './deepseek_harness_voice_catalog.mjs'
import {HarnessRPCExecutor} from './deepseek_harness_voice_rpc.mjs'

const ids = rows => rows.map(row=>row.session_id)
const items = [
  {sessionId:'newer',updatedAt:300}, {sessionId:'archived',updatedAt:400},
  {sessionId:'hahas',updatedAt:10}, {sessionId:'empty',blank:true},
  {sessionId:'child',origin:'subagent'}, {sessionId:'loose',updatedAt:5},
]
const options = {archivedIds:['archived'],workspaces:[
  {id:'first-workspace',sessionIds:['archived','hahas','child','empty']},
  {id:'second-workspace',sessionIds:['newer']},
]}
test('catalog follows workspace/sidebar order rather than global update time; archives never take a rank',()=>{
  const rows=buildSessionCatalog(items,options)
  assert.deepEqual(ids(rows),['hahas','newer','loose'])
  assert.equal(rows[0].workspace_id,'first-workspace')
  assert.deepEqual(ids(buildSessionCatalog(items,{...options,activeId:'empty'})),['hahas','empty','newer','loose'])
})
test('hidden blank remains addressable for native focus synchronization',()=>{
  assert.ok(ids(buildSessionCatalog(items,{...options,includeBlank:true})).includes('empty'))
  assert.ok(!ids(buildSessionCatalog(items,{...options,includeBlank:true})).includes('archived'))
})
test('flat manual order reconciles stale and duplicated ids; grouped orders stay within their workspace',()=>{
  const rows=buildSessionCatalog(items,options)
  assert.deepEqual(ids(orderSessionCatalog(rows,{groupBy:'flat',sessionOrderByAccount:{__flat_session_order__:['hahas','archived','hahas','loose']}})),['hahas','loose','newer'])
  assert.deepEqual(ids(orderSessionCatalog(rows,{groupBy:'workspace',sessionOrderByAccount:{'first-workspace':['newer','hahas']}})),['hahas','newer','loose'])
  assert.deepEqual(ids(orderSessionCatalog(rows,{groupBy:'flat'})),['newer','hahas','loose'])
})
test('RPC startup catalog and subsequent ordinal resolution use the same live browser order',async()=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
  let order=['hahas','newer','loose'];const sent=[]
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(key){assert.equal(key,WORKSPACE_VIEW_KEY);return JSON.stringify({groupBy:'flat',sessionOrderByAccount:{__flat_session_order__:order}})}}})
  try {
    const rows=buildSessionCatalog(items,options)
    const executor=new HarnessRPCExecutor(x=>sent.push(x),async()=>({status:200,text:async()=>JSON.stringify({sessions:rows})}))
    const request={type:'harness.rpc.request',request_id:'1'.repeat(32),connection_id:'2'.repeat(32),method:'GET',path:'/api/sessions'}
    await executor.execute(request)
    assert.equal(sent.at(-1).body.sessions[0].session_id,'hahas')
    order=['loose','hahas','newer']
    await executor.execute({...request,request_id:'3'.repeat(32)})
    assert.equal(sent.at(-1).body.sessions[0].session_id,'loose')
    executor.close()
  } finally {
    if(old)Object.defineProperty(globalThis,'localStorage',old);else delete globalThis.localStorage
  }
})
