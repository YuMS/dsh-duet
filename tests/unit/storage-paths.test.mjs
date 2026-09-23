import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,statSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {duetHome,defaultStateFile} from '../../src/host/storage-paths.mjs'
import {DuetSettings} from '../../src/host/settings.mjs'
import {RemoteFeedback} from '../../src/host/feedback-files.mjs'
import {EndpointDiscovery} from '../../src/host/endpoint-discovery.mjs'
import {DuetTrace} from '../../src/host/trace.mjs'
import {DEFAULT_DUET_URL} from '../../src/host/service-defaults.mjs'

const config={endpoints:{online:DEFAULT_DUET_URL,tts_only:DEFAULT_DUET_URL}}
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'duet-storage-'))
  const keys=['DSH_HOME','DUET_SETTINGS_FILE','DUPLEX_VOICE_SETTINGS_FILE','DUET_TRACE_DIR','DUPLEX_VOICE_TRACE_DIR']
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]))
  for(const key of keys)delete process.env[key]
  process.env.DSH_HOME=home
  t.after(()=>{
    for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key]}
    rmSync(home,{recursive:true,force:true})
  })
  const old=join(home,'duplex-control'),next=join(home,'dsh-duet')
  mkdirSync(old)
  return {home,old,next}
}

test('fresh defaults use dsh-duet and leave unrelated legacy files alone',t=>{
  const {old,next}=fixture(t)
  writeFileSync(join(old,'unrelated.key'),'keep')
  assert.equal(duetHome(),next)
  assert.equal(new DuetSettings(config).path,join(next,'voice.json'))
  assert.equal(new RemoteFeedback(()=>config).keyPath,join(next,'feedback-identity.key'))
  assert.equal(new EndpointDiscovery(()=>config).cachePath,join(next,'endpoint-discovery.json'))
  assert.equal(readFileSync(join(old,'unrelated.key'),'utf8'),'keep')
  assert.equal(existsSync(join(next,'unrelated.key')),false)
})

test('settings migrate privately; writes update only the new file and never overwrite it from legacy',async t=>{
  const {old,next}=fixture(t)
  const original=JSON.stringify({backend_url:'wss://first.example/ws'})
  writeFileSync(join(old,'voice.json'),original)
  const settings=new DuetSettings(config)
  assert.equal(settings.path,join(next,'voice.json'))
  assert.equal(settings.effective().endpoints.online,'wss://first.example/ws')
  assert.equal(statSync(settings.path).mode&0o777,0o600)
  await settings.save({revision:0,backend_url:'wss://new.example/ws'})
  assert.equal(new DuetSettings(config).effective().endpoints.online,'wss://new.example/ws')
  assert.equal(readFileSync(join(old,'voice.json'),'utf8'),original)
})

test('migrated identity still accepts the existing feedback cookie',t=>{
  const {old,next}=fixture(t)
  writeFileSync(join(old,'feedback-identity.key'),Buffer.alloc(32,7))
  const previous=new RemoteFeedback(()=>config,{keyPath:join(old,'feedback-identity.key')})
  let cookie
  const id=previous.ensureIdentity({headers:{}},{setHeader:(_name,value)=>{cookie=value}})
  const current=new RemoteFeedback(()=>config)
  assert.equal(current.keyPath,join(next,'feedback-identity.key'))
  assert.equal(current.userId({headers:{cookie}}),id)
  assert.equal(statSync(current.keyPath).mode&0o777,0o600)
})

test('migrated recommendation preserves the daily refresh interval without a network call',async t=>{
  const {old,next}=fixture(t)
  writeFileSync(join(old,'endpoint-discovery.json'),JSON.stringify({schema_version:1,
    bootstrap_endpoint:DEFAULT_DUET_URL,last_attempt_at:1000,candidate:{
      url:'ws://47.117.104.188/ws?protocol=realtime_v2',addresses:[{address:'47.117.104.188',family:4}]}}))
  const d=new EndpointDiscovery(()=>config,{now:()=>2000,fetchImpl:()=>{assert.fail('should use cached recommendation')}})
  assert.equal(d.cachePath,join(next,'endpoint-discovery.json'))
  assert.equal(d.refreshIfDue(),null)
  assert.match((await d.plan('online'))[0].url,/47\.117\.104\.188/)
})

test('new logs use the new directory without moving old recordings',async t=>{
  const {old,next}=fixture(t)
  mkdirSync(join(old,'traces'));writeFileSync(join(old,'traces','old.bin'),'old audio')
  const trace=new DuetTrace({kind:'test'})
  await trace.close()
  assert.equal(trace.error,null)
  assert.ok(trace.path.startsWith(join(next,'traces')+'/'))
  assert.equal(readFileSync(join(old,'traces','old.bin'),'utf8'),'old audio')
})

test('explicit paths are not migrated',t=>{
  const {old,next}=fixture(t)
  writeFileSync(join(old,'voice.json'),'{}')
  const custom=join(old,'custom.json')
  assert.equal(new DuetSettings(config,{path:custom}).path,custom)
  assert.equal(new RemoteFeedback(()=>config,{keyPath:custom}).keyPath,custom)
  assert.equal(new EndpointDiscovery(()=>config,{cachePath:custom}).cachePath,custom)
  assert.equal(existsSync(next),false)
})

test('failed migration retains the old file instead of silently discarding configuration',t=>{
  const {old,next}=fixture(t)
  writeFileSync(join(old,'voice.json'),JSON.stringify({backend_url:'wss://first.example/ws'}))
  writeFileSync(next,'blocks directory creation')
  assert.equal(defaultStateFile('voice.json'),join(old,'voice.json'))
  assert.equal(new DuetSettings(config).effective().endpoints.online,'wss://first.example/ws')
})
