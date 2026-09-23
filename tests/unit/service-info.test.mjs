import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceInfo } from '../../src/host/service-info.mjs'

const config = {endpoints:{online:'wss://voice.example/ws?protocol=realtime_v2'},authorization:'fixture-secret'}
const models = {duplex:'duet-duplex-v0.1',tts:'duet-tts-v0.1'}
test('service model aliases are fetched, validated, cached and never expose credentials', async () => {
  let calls=0
  const info=new ServiceInfo(()=>config,async(url,options)=>{
    calls++;assert.equal(url.toString(),'https://voice.example/api/service-info')
    assert.equal(options.headers.Authorization,'fixture-secret');assert.equal(options.redirect,'error')
    return new Response(JSON.stringify({schema_version:1,models,private_path:'/secret'}))
  })
  const [a,b]=await Promise.all([info.get(),info.get()])
  assert.deepEqual(a,{status:'ok',models});assert.deepEqual(b,a);assert.equal(calls,1)
  assert.ok(!JSON.stringify(a).includes('secret'))
  await info.get();assert.equal(calls,1);info.invalidate();await info.get();assert.equal(calls,2)
})
test('unavailable, oversized and path-like names do not invent or expose models', async () => {
  for (const body of ['x'.repeat(9000),JSON.stringify({schema_version:1,models:{...models,duplex:'/private/model'}}),'{}']) {
    const info=new ServiceInfo(()=>config,async()=>new Response(body))
    assert.deepEqual(await info.get(),{status:'unavailable',models:null})
  }
})
test('changing service discards in-flight model metadata from previous service', async () => {
  let resolve
  const info=new ServiceInfo(()=>config,()=>new Promise(r=>{resolve=r}))
  const pending=info.get();await Promise.resolve();info.invalidate();resolve(new Response(JSON.stringify({schema_version:1,models})))
  assert.deepEqual(await pending,{status:'unavailable',models:null})
})
