import test from 'node:test'
import assert from 'node:assert/strict'
import {sessionMetadata} from '../../src/host/session-metadata.mjs'

test('both modes use identical bounded session fields',()=>{
  const params=new URLSearchParams({plugin_version:'0.1.3',page_id:'page-one',client_trace_id:'connection-one'})
  const online=sessionMetadata(params,'online'),tts=sessionMetadata(params,'tts_only')
  assert.deepEqual({...online,mode:'tts_only'},tts)
  assert.deepEqual(Object.keys(online).sort(),['name','version','protocol_major','metadata_version','mode',
    'host_version','page_binding','client_trace_id','page_id'].sort())
  assert.equal(Object.isFrozen(online),true)
  assert.equal(online.page_id,'page-one')
  assert.equal(online.client_trace_id,'connection-one')
})
test('legacy pages receive distinct per-connection IDs',()=>{
  const params=new URLSearchParams({page_id:'bad\nvalue',client_trace_id:'x'.repeat(65)})
  const a=sessionMetadata(params,'online'),b=sessionMetadata(params,'online')
  assert.equal(a.page_id,'');assert.notEqual(a.client_trace_id,b.client_trace_id)
  assert.match(a.client_trace_id,/^[a-f0-9-]{36}$/)
  assert.throws(()=>sessionMetadata(params,'off'),/invalid_voice_mode/)
})
