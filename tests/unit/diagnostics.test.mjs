import assert from 'node:assert/strict'
import test from 'node:test'
import { diagnosticPayload } from '../../src/shared/diagnostics.mjs'
import { ConnectionDiagnostics, DiagnosticOutbox } from '../../src/host/diagnostics.mjs'
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('failed terminal diagnostics survive restart and keep their idempotency IDs', async()=>{
  const root=mkdtempSync(join(tmpdir(),'duet-outbox-'))
  let box, recovered
  try {
    box=new DiagnosticOutbox({root,fetcher:async()=>{throw Error('offline')}})
    const d=new ConnectionDiagnostics({mode:'online'},box.fetcher,box)
    d.offer({protocol:'client_diagnostics_v1',ticket:'opaque'},{authorization:'test'},'https://unused.example/ws'.replace('https:','wss:'))
    d.add({event:'browser.connection_close',event_id:'terminal',reason:'user_off'})
    clearTimeout(d.timer);d.timer=null
    for(let i=0;i<4;i++){await d.flush();assert.ok(d.timer);clearTimeout(d.timer);d.timer=null}
    assert.equal(d.pending.length,1,'four transient failures must not drop the ending')
    const files=readdirSync(root).filter(n=>n.endsWith('.json'))
    assert.equal(files.length,1)
    assert.equal(statSync(join(root,files[0])).mode & 0o777,0o600)
    box.dispose()
    const sent=[]
    recovered=new DiagnosticOutbox({root,isOwnerAlive:()=>false,fetcher:async(_url,opts)=>{
      sent.push(JSON.parse(opts.body));return {ok:true,status:200}
    }})
    const restored=[...recovered.active][0]
    clearTimeout(restored.timer);restored.timer=null
    await restored.flush()
    assert.equal(sent[0].events[0].event_id,'terminal')
    assert.equal(sent[0].events[0].sequence,0)
    assert.equal(readdirSync(root).filter(n=>n.endsWith('.json')).length,0)
  } finally { box?.dispose();recovered?.dispose();rmSync(root,{recursive:true,force:true}) }
})

test('outbox expiry and permanent rejection stop retries',async()=>{
  const root=mkdtempSync(join(tmpdir(),'duet-outbox-'))
  let now=0
  const box=new DiagnosticOutbox({root,now:()=>now,fetcher:async()=>({ok:false,status:403})})
  try{
    const d=new ConnectionDiagnostics({},box.fetcher,box)
    d.offer({protocol:'client_diagnostics_v1',ticket:'opaque'},{authorization:''},'wss://example.test/ws')
    d.add({event:'proxy.browser_closed',code:1006})
    clearTimeout(d.timer);d.timer=null
    await d.flush()
    assert.equal(d.pending.length,0);assert.equal(d.timer,null)
    d.add({event:'proxy.upstream_closed',code:1006})
    clearTimeout(d.timer);d.timer=null
    now=7*60*60*1000
    await d.flush()
    assert.equal(d.pending.length,0)
    assert.equal(readdirSync(root).filter(n=>n.endsWith('.json')).length,0)
  }finally{box.dispose();rmSync(root,{recursive:true,force:true})}
})

test('normal telemetry cannot consume the terminal event reserve',()=>{
  const d=new ConnectionDiagnostics({})
  for(let i=0;i<100;i++)d.add({event:'browser.audio_ready',event_id:'ready'+i})
  assert.equal(d.count,80)
  d.add({event:'proxy.browser_closed',code:1006})
  assert.equal(d.count,81)
})
