import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {RemoteFeedback} from '../../src/host/feedback-files.mjs'

test('signed anonymous browser identity survives host restart; tampering is rejected',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'feedback-identity-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const keyPath=join(dir,'key');const a=new RemoteFeedback(()=>({}),{keyPath})
  let cookie;const req={headers:{}},res={setHeader:(k,v)=>{assert.equal(k,'Set-Cookie');cookie=v}}
  const id=a.ensureIdentity(req,res);assert.match(id,/^anon_[a-f0-9]{32}$/)
  assert.match(cookie,/HttpOnly; SameSite=Strict/)
  req.headers.cookie=cookie.split(';')[0]
  assert.equal(new RemoteFeedback(()=>({}),{keyPath}).userId(req),id)
  req.headers.cookie=req.headers.cookie.replace(/.$/,x=>x==='0'?'1':'0')
  assert.throws(()=>a.userId(req),/unavailable/)
})
test('feedback uses the configured endpoint only, never redirects or reports unsaved success',async()=>{
  let response={ok:true,text:async()=>JSON.stringify({persisted:true,archive_id:'day/id'})}
  const a=new RemoteFeedback(()=>({endpoints:{online:'wss://voice.example.test/prefix/ws?protocol=realtime_v2'},authorization:'private'}),{fetchImpl:async(url,opts)=>{
    assert.equal(String(url),'https://voice.example.test/prefix/feedback');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'private');return response
  }})
  assert((await a.insert({text:'test'})).persisted)
  response={ok:true,text:async()=>JSON.stringify({persisted:false})};await assert.rejects(a.insert({}),/invalid_receipt/)
  response={ok:false,status:503};await assert.rejects(a.insert({}),/unavailable/)
})

test('Desktop header and WebSocket reuse the exact signed cookie; invalid explicit credentials cannot fall back',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'feedback-desktop-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const keyPath=join(dir,'key'),store=new RemoteFeedback(()=>({}),{keyPath})
  let cookie
  const token=store.ensureCredential({headers:{}},{setHeader:(_k,v)=>{cookie=v}})
  assert.equal(cookie.split(';')[0],'duplex_feedback_user='+token)
  const req={headers:{'x-duet-identity':token}}
  const id=store.userId(req)
  assert.equal(new RemoteFeedback(()=>({}),{keyPath}).userId(req),id)
  assert.equal(store.userId({headers:{'sec-websocket-protocol':'duet-voice-v1, duet-identity.'+token}}),id)
  assert.equal(store.ensureCredential(req,{setHeader(){assert.fail('must reuse identity')}}),token)
  const bad=token.slice(0,-1)+(token.endsWith('0')?'1':'0')
  for(const headers of [
    {'x-duet-identity':bad,cookie:cookie.split(';')[0]},
    {'x-duet-identity':'anon_'+'a'.repeat(32)},
    {'sec-websocket-protocol':'duet-identity.'+bad},
    {'sec-websocket-protocol':`duet-identity.${token},duet-identity.${token}`},
  ])assert.throws(()=>store.userId({headers}),/feedback_identity_unavailable/)
  assert.notEqual(store.ensureCredential({headers:{'x-duet-identity':bad}},{setHeader(){}}),token)
  const other=new RemoteFeedback(()=>({}),{keyPath:join(dir,'other-key')})
  assert.throws(()=>other.userId(req),/feedback_identity_unavailable/)
})
