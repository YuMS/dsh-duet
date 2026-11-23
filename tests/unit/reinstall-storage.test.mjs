import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {DuetVoices} from '../../src/host/voices.mjs'
import {RemoteFeedback} from '../../src/host/feedback-files.mjs'

test('reloading a plugin preserves voice files and browser identity with the same private storage',async t=>{
  const home=await mkdtemp(join(tmpdir(),'duet-reinstall-'));t.after(()=>rm(home,{recursive:true,force:true}))
  const root=join(home,'dsh-duet','voices'),keyPath=join(home,'dsh-duet','feedback-identity.key')
  await mkdir(root,{recursive:true})
  const raw=Buffer.from('fixture original voice'),file=createHash('sha256').update(raw).digest('hex')+'.audio'
  await writeFile(join(root,file),raw)
  const getConfig=async()=>({endpoints:{online:'https://fixture.test/ws'}})
  const options={root,fetchImpl:async()=>{throw Error('no network in persistence test')}}
  const before=new DuetVoices(getConfig,options)
  const state={selected:'voice_'+'a'.repeat(32),voices:[{voice_id:'voice_'+'a'.repeat(32),name:'我的音色',ref_text:'测试',file}]}
  await before.save(state)
  const identity=new RemoteFeedback(getConfig,{keyPath})
  let cookie
  identity.ensureCredential({headers:{},socket:{}},{setHeader:(_,value)=>{cookie=value.split(';')[0]}})
  const request={headers:{cookie}},oldUser=identity.userId(request),oldKey=await readFile(keyPath)
  before.close()
  const after=new DuetVoices(getConfig,options)
  assert.deepEqual(await after.state(),state)
  assert.deepEqual(await after.original(state.voices[0]),raw)
  const restored=new RemoteFeedback(getConfig,{keyPath})
  assert.equal(restored.userId(request),oldUser)
  assert.deepEqual(await readFile(keyPath),oldKey)
  // Losing browser storage is different from uninstalling the plugin.
  assert.throws(()=>restored.userId({headers:{}}),/feedback_identity_unavailable/)
  after.close()
})
