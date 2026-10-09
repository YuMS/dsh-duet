import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnosticPayload } from '../../src/shared/diagnostics.mjs'
import { ConnectionDiagnostics } from '../../src/host/diagnostics.mjs'
import { DuetState } from '../../src/shared/state.mjs'

test('diagnostic whitelist removes content, devices, stack and credentials', () => {
  assert.equal(diagnosticPayload({event:'harness.rpc.request',message:'private'}),null)
  const row=diagnosticPayload({event:'browser.microphone_failed',event_id:'id',name:'NotAllowedError',phase:'permission',
    stack:'private',message:'private',device_id:'private',authorization:'secret',reason:'a private sentence',code:'/private/path',elapsed_ms:NaN})
  assert.deepEqual(row,{event:'browser.microphone_failed',event_id:'id',name:'NotAllowedError',reason:'unknown',phase:'permission'})
})

test('remote upload is capability-gated, bounded, deduplicated and best effort', async () => {
  const sent=[]
  const d=new ConnectionDiagnostics({mode:'online',client_trace_id:'trace'},async(url,opts)=>{
    sent.push({url,opts,body:JSON.parse(opts.body)});return {ok:true}
  })
  d.add({event:'browser.connection_close',event_id:'one',reason:'user_off'})
  await d.flush();assert.equal(sent.length,0,'old server never receives new requests')
  d.offer({protocol:'client_diagnostics_v1',ticket:'opaque'}, {authorization:'test-token'}, 'wss://voice.example/ws?secret=remove')
  d.add({event:'browser.connection_close',event_id:'one',reason:'user_off'})
  await d.flush();clearTimeout(d.timer);d.timer=null
  assert.equal(sent[0].url,'https://voice.example/client-diagnostics')
  assert.equal(sent[0].opts.headers.Authorization,'test-token')
  assert.equal(sent[0].opts.redirect,'error')
  assert.equal(sent[0].body.events.length,1)
  for(let i=0;i<200;i++)d.add({event:'browser.ws_error',event_id:'e'+i})
  assert.equal(d.count,96)
  clearTimeout(d.timer);d.timer=null
  d.fetcher=async()=>{throw Error('offline')}
  for(let i=0;i<3;i++){await d.flush();clearTimeout(d.timer);d.timer=null}
  assert.equal(d.failures,3)
})

test('close reasons distinguish switching, user stop, idle, errors and unmount',async()=>{
  const reasons=[]
  let now=0
  const state=new DuetState({now:()=>now,connect:()=>({close:async d=>reasons.push(d),playing:()=>false})})
  await state.setMode('online');await state.setMode('tts_only');await state.setMode('off')
  await state.setMode('online');state.fail('microphone_unavailable');await state.retiring
  await state.setMode('tts_only');state.hidden=true;state.tick();now=61000;state.tick();await state.retiring
  await state.setMode('online');await state.dispose()
  assert.deepEqual(reasons.map(r=>r.reason),['mode_switch','user_off','error','idle_release','unmount'])
  assert.equal(reasons[2].code,'microphone_unavailable')
})
