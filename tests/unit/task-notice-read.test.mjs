import test from 'node:test'
import assert from 'node:assert/strict'
import {noteTaskVisit,noteTaskNoticeVisit,visibleTaskRows,taskCardState} from '../../src/shared/work-mode.mjs'
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
