import test from 'node:test'
import assert from 'node:assert/strict'
import { StopTasks } from '../../src/host/stop-task.mjs'
import { HarnessRPCExecutor, validateRPC } from '../../src/client/rpc.mjs'
import { resultNotification } from '../../src/shared/result-notification.mjs'

test('cancellation receipts are idempotent and never stop a later turn', async () => {
  const calls = [], stops = new StopTasks(input => { calls.push(input); return {accepted:true} })
  stops.start('s1', 1)
  const id = stops.snapshot('s1').execution_id
  stops.start('s1', 1)
  assert.equal(stops.snapshot('s1').execution_id, id)
  assert.equal((await stops.request('s1', id, 'page1')).accepted, true)
  stops.end('s1', 1); stops.start('s1', 2)
  assert.equal((await stops.request('s1', id, 'page1')).accepted, true)
  assert.equal(calls.length, 1)
  assert.throws(() => stops.request('s1', id, 'page2'), /execution_changed/)
  stops.end('s1', 1) // late old terminal must not clear new execution
  assert.notEqual(stops.snapshot('s1').execution_id, id)
})

test('idle, wrong owner, ended execution, and cancellation rejection fail safely', async () => {
  const stops = new StopTasks(() => ({accepted:false}))
  assert.throws(() => stops.snapshot('s1'), /no_running_task/)
  stops.start('s1', 1)
  const id = stops.snapshot('s1').execution_id
  assert.throws(() => stops.request('s1', id, ''), /owner_required/)
  await assert.rejects(stops.request('s1', id, 'page'), /stop_not_accepted/)
  stops.end('s1', 1)
  assert.throws(() => stops.request('s1', id, 'other'), /execution_changed/)
})

test('pending question or approval can be cancelled without resolving it', async () => {
  const calls = [], stops = new StopTasks(request => {calls.push(request);return {accepted:true}})
  stops.start('approval-session', 7)
  const snapshot = stops.snapshot('approval-session')
  const receipt = await stops.request(snapshot.session_id,snapshot.execution_id,'page')
  assert.equal(receipt.accepted,true)
  // Receipt alone leaves the execution pending; only native terminal clears it.
  assert.equal(stops.snapshot('approval-session').execution_id,snapshot.execution_id)
  stops.end('approval-session',7)
  assert.throws(() => stops.snapshot('approval-session'),/no_running_task/)
  assert.deepEqual(calls,[{sessionId:'approval-session'}])
})

const event = (path, method = 'GET', payload = null) => ({type:'harness.rpc.request',
  connection_id:'a'.repeat(32), request_id:crypto.randomUUID().replaceAll('-',''), method, path, payload})
test('browser negotiates Host capability, validates focus, and does not navigate on stop', async () => {
  const calls = [], replies = [], id = 'b'.repeat(36)
  let focus = 's1', supported = true
  const rpc = new HarnessRPCExecutor(e => replies.push(e), async (url, options) => {
    calls.push([url, options])
    return new Response(JSON.stringify(url.endsWith('/sessions')
      ? {sessions:[],duet_rpc_capabilities:supported ? ['stop_task_v1'] : []} : {accepted:true}))
  }, () => {}, null, rows => rows, {id:'page1',focused:() => focus})
  await rpc.execute(event('/api/sessions'))
  assert.ok(replies.at(-1).body.duet_rpc_capabilities.includes('stop_task_v1'))
  const request = event('/api/sessions/s1/cancel','POST',{execution_id:id,require_focus:true})
  focus = 's2'
  await rpc.execute(request)
  assert.equal(replies.at(-1).body.error_code,'focus_conflict'); assert.equal(calls.length,1)
  await rpc.execute(event('/api/sessions/s1/cancel','POST',{execution_id:id,require_focus:false}))
  assert.equal(calls.length,2); assert.equal(calls[1][1].headers['X-Duet-Browser-Client'],'page1')
  supported = false
  await rpc.execute(event('/api/sessions'))
  await rpc.execute(event('/api/sessions/s1/execution'))
  assert.equal(replies.at(-1).body.error_code,'harness_stop_task_upgrade_required')
  assert.equal(calls.length,3)
  rpc.close()
})

test('stop payload cannot broaden cancellation scope or carry arbitrary fields', () => {
  for (const payload of [{}, {execution_id:'a'.repeat(36),require_focus:false,all:true}]) {
    assert.throws(() => validateRPC(event('/api/sessions/s1/cancel','POST',payload)), /invalid_stop_request/)
  }
  assert.throws(() => validateRPC(event('/api/sessions/..%2fs1/cancel','POST',{})), /route_not_allowed/)
})

test('terminated task remains failed, never a fabricated completed result', () => {
  const n = resultNotification({id:'j',session_id:'s',status:'failed',error:'任务执行已终止，未完成。',result:'旧的成功输出'},'研究')
  assert.equal(n.source.status,'failed'); assert.equal(n.text,'任务执行已终止，未完成。')
})
