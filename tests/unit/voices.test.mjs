import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHmac} from 'node:crypto'
import {DuetVoices} from '../../src/host/voices.mjs'

test('missing references restore original bytes explicitly; blocked voices never auto-upload',async t=>{
  const root=await mkdtemp(join(tmpdir(),'duet-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const id='voice_'+'a'.repeat(32),raw=Buffer.from('original reference'),calls=[];let blocked=false
  const voices=new DuetVoices(async()=>({endpoints:{online:'https://voice.test/ws'}}),{root,fetchImpl:async(url,options)=>{
    const op=url.pathname.split('/').at(-1);calls.push(op)
    if(op==='status')return new Response(JSON.stringify({enabled:true,revision:0}))
    if(op==='restore'){
      assert.equal(options.headers['X-Voice-Id'],id);assert.deepEqual(options.body,raw)
      if(blocked)return new Response(JSON.stringify({error:{code:'voice_disabled'}}),{status:403})
    }
    return new Response(JSON.stringify({voice_id:id,status:'ready',ref_text:'用户修正后的原话'}))
  }})
  await voices.update({op:'upload',name:'声音',audio:raw.toString('base64')})
  await voices.update({op:'select',voice_id:id})
  await voices.applyIssue({voice_id:id,code:'voice_audio_missing'})
  assert.equal(await voices.prepare(),'default');assert.equal(calls.filter(c=>c==='upload').length,1)
  assert.equal((await voices.public()).voices[0].issue,'voice_audio_missing')
  const restored=await voices.update({op:'restore',voice_id:id})
  assert.equal(restored.selected,id);assert.equal(restored.voices.length,1)
  assert.equal(restored.voices[0].ref_text,'用户修正后的原话');assert.equal(restored.voices[0].issue,undefined)
  blocked=true;await voices.applyIssue({voice_id:id,code:'voice_disabled'})
  await assert.rejects(voices.update({op:'restore',voice_id:id}),/voice_disabled/)
  const state=await voices.public();assert.equal(state.selected,'default');assert.equal(state.voices[0].issue,'voice_disabled')
  assert.equal(state.custom_voice_enabled,true)
  assert.equal(calls.filter(c=>c==='upload').length,1)
})

test('voice links are bounded; only use challenges; proof requires original bytes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'duet-voices-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const calls=[],raw=Buffer.from('original reference bytes');let sequence=0,challenge,verified=false
  const fetchImpl=async(url,options)=>{
    const op=new URL(url).pathname.split('/').at(-1);calls.push(op)
    const body=op==='upload'?null:JSON.parse(options.body)
    let value={}
    if(op==='status')value={enabled:true,revision:0}
    if(op==='upload')value={voice_id:'voice_'+(++sequence).toString(16).padStart(32,'0'),ref_text:'测试语音',status:'ready'}
    if(op==='challenge'){
      challenge={protocol:'voice_possession_v1',voice_id:body.voice_id,nonce:'a'.repeat(64),binding:'b'.repeat(64),challenge_id:'c'.repeat(32),expires_at:Math.floor(Date.now()/1000)+120}
      value=verified?{authorized:true}:challenge
    }
    if(op==='verify'){
      const context={};for(const k of ['binding','challenge_id','expires_at','protocol','voice_id'])context[k]=challenge[k]
      assert.equal(body.proof,createHmac('sha256',Buffer.from(challenge.nonce,'hex')).update(JSON.stringify(context)).update(Buffer.from([0])).update(raw).digest('hex'))
      verified=true;value={authorized:true}
    }
    return new Response(JSON.stringify(value),{status:200})
  }
  const voices=new DuetVoices(async()=>({endpoints:{online:'wss://voice.test/ws'}}),{root,fetchImpl})
  assert.equal(await voices.prepare(),'default');assert.deepEqual(calls,[])
  for(let i=0;i<5;i++)await voices.update({op:'upload',name:'声音'+i,audio:raw.toString('base64')})
  await assert.rejects(voices.update({op:'upload',name:'第六个',audio:raw.toString('base64')}),/local_voice_limit/)
  assert.deepEqual(calls.filter(c=>c!=='status'),['upload','upload','upload','upload','upload'])
  const v=(await voices.public()).voices[0]
  await voices.update({op:'select',voice_id:v.voice_id})
  assert.equal(await voices.prepare(),v.voice_id)
  assert.deepEqual(calls.filter(c=>c!=='status'),['upload','upload','upload','upload','upload'])
  challenge={protocol:'voice_possession_v1',voice_id:v.voice_id,nonce:'a'.repeat(64),binding:'b'.repeat(64),challenge_id:'c'.repeat(32),expires_at:Math.floor(Date.now()/1000)+120}
  const answer=await voices.respondChallenge(challenge)
  await fetchImpl(new URL('https://voice.test/voices/verify'),{body:JSON.stringify(answer)})
  await assert.rejects(voices.respondChallenge({...challenge,voice_id:'voice_'+'f'.repeat(32)}),/voice_proof_invalid/)
  assert.equal(await voices.prepare(),v.voice_id)
  assert.equal(calls.filter(x=>x==='verify').length,1)
  const restored=new DuetVoices(async()=>({endpoints:{online:'wss://voice.test/ws'}}),{root,fetchImpl})
  assert.equal((await restored.public()).selected,v.voice_id)
  assert.ok(!(await restored.public()).voices.some(x=>'file' in x))
})

test('disabled policy selects default, retains links and survives transient status failures',async t=>{
  const root=await mkdtemp(join(tmpdir(),'duet-voice-policy-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const id='voice_'+'a'.repeat(32);let enabled=true,revision=0,unavailable=false;const calls=[]
  const voices=new DuetVoices(async()=>({endpoints:{online:'wss://voice.test/ws'}}),{root,fetchImpl:async(url)=>{
    const op=url.pathname.split('/').at(-1);calls.push(op)
    if(op==='status'&&unavailable)throw Error('offline')
    return new Response(JSON.stringify(op==='status'?{enabled,revision}:{voice_id:id,status:'ready',ref_text:'原话'}))
  }})
  assert.equal(await voices.prepare(),'default');assert.deepEqual(calls,[])
  await voices.update({op:'upload',name:'音色',audio:Buffer.from('original').toString('base64')})
  await voices.update({op:'select',voice_id:id})
  enabled=false;revision=1
  assert.equal(await voices.prepare(),'default')
  assert.equal((await voices.public()).voices.length,1)
  assert.equal((await voices.public()).custom_voice_enabled,false)
  await assert.rejects(voices.update({op:'select',voice_id:id}),/custom_voice_disabled/)
  unavailable=true;voices.featureAt=0
  assert.equal((await voices.refreshAvailability()).custom_voice_enabled,false)
  unavailable=false;enabled=true;revision=2;voices.featureAt=0
  assert.equal((await voices.refreshAvailability()).custom_voice_enabled,true)
  assert.equal(await voices.prepare(),'default') // Never silently restore an old selection.
  await voices.update({op:'select',voice_id:id})
  const reset=voices.applyPolicy({enabled:false,selected:'default'})
  enabled=false;revision=3
  assert.equal(await voices.prepare(),'default');await reset
  assert.equal((await voices.public()).voices.length,1)
})
