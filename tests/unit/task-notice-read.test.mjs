import test from 'node:test'
import assert from 'node:assert/strict'
import {noteTaskVisit,noteTaskNoticeVisit,visibleTaskRows,taskCardState,taskCompletionSeconds} from '../../src/shared/work-mode.mjs'
test('completed task countdown survives repeated frames and reload; new runs get ten seconds',async t=>{
  let now=10000;t.mock.method(Date,'now',()=>now)
  const saved=new Map(),before=Object.getOwnPropertyDescriptor(globalThis,'localStorage')
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)}})
  t.after(()=>{if(before)Object.defineProperty(globalThis,'localStorage',before);else delete globalThis.localStorage})
  const row={session_id:'worker-'+'9'.repeat(32),run_id:'one',state:'completed',finished_at:50000}
  assert.equal(taskCompletionSeconds(row),10)
  now+=3000;assert.equal(taskCompletionSeconds({...row}),7)
  now+=6999;assert.equal(visibleTaskRows([row]).length,1)
  now++;assert.equal(visibleTaskRows([row]).length,0)
  const reloaded=await import('../../src/shared/work-mode.mjs?countdown-reload')
  assert.equal(reloaded.visibleTaskRows([row]).length,0)
  assert.equal(taskCompletionSeconds({...row,run_id:'two',finished_at:50001}),10)
  for(const state of ['running','waiting_user','failed','stopped'])assert.equal(taskCompletionSeconds({...row,state}),null)
})
test('running stays visible; yellow notices alone become read and new questions reappear',()=>{
  const session_id='worker-'+'f'.repeat(32)
  const running={session_id,run_id:'r1',state:'running'}
  const waiting={...running,state:'waiting_user',attention_id:'q1'}
  noteTaskVisit(session_id,100)
  noteTaskNoticeVisit(running,100)
  assert.deepEqual(visibleTaskRows([running,waiting]),[running,waiting])
  noteTaskNoticeVisit(waiting,100)
  assert.deepEqual(visibleTaskRows([running,waiting]),[running])
  const next={...waiting,attention_id:'q2'}
  assert.deepEqual(visibleTaskRows([waiting,next]),[next])
  for(const state of ['queued','pending','running','progress']){
    assert.equal(taskCardState({...running,state}),'running')
    assert.equal(visibleTaskRows([{...running,state}]).length,1)
  }
  const complete={...running,state:'completed',finished_at:101}
  assert.equal(visibleTaskRows([complete]).length,1)
  noteTaskNoticeVisit(complete,102)
  assert.equal(visibleTaskRows([complete]).length,0)
})
