import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EndpointDiscovery as PersistentDiscovery, DISCOVERY_INTERVAL_MS, recommendedEndpoint, connectEndpoint, endpointHTTP} from '../../src/host/endpoint-discovery.mjs'
class EndpointDiscovery extends PersistentDiscovery {
  constructor(getConfig,options={}){super(getConfig,{cachePath:null,...options})}
}
import {DEFAULT_DUET_URL} from '../../src/host/service-defaults.mjs'
const config={endpoints:{online:DEFAULT_DUET_URL,tts_only:DEFAULT_DUET_URL},authorization:'fixture'}
const response=(endpoint='47.117.104.188')=>new Response(JSON.stringify({schema_version:1,recommended_endpoint:endpoint,ttl_seconds:60,default_endpoint:'ws://evil.example/ws'}))

test('fixed bootstrap discovers recommendation, caches it, and never replaces the fallback',async()=>{
  let calls=0
  const discovery=new EndpointDiscovery(()=>config,{fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,endpointHTTP(DEFAULT_DUET_URL,'/api/connection-info'))
    assert.equal(options.redirect,'error');return response()
  }})
  const first=await discovery.plan('online')
  assert.equal(first[0].url,DEFAULT_DUET_URL)
  await discovery.inflight
  const [a,b]=await Promise.all([discovery.plan('online'),discovery.plan('tts_only')])
  assert.equal(calls,1);assert.equal(a[0].url,'ws://47.117.104.188/ws?protocol=realtime_v2')
  assert.equal(a[1].url,DEFAULT_DUET_URL);assert.equal(b[0].url,a[0].url)
  discovery.used('online',a[0]);assert.equal((await discovery.effective()).endpoints.online,a[0].url)
  discovery.failed();assert.equal((await discovery.plan('online'))[0].url,DEFAULT_DUET_URL)
  discovery.used('tts_only',a[1]);assert.equal((await discovery.effective()).endpoints.online,DEFAULT_DUET_URL)
})
test('discovery failure and old-server 404 fall back; custom settings never discover',async()=>{
  for(const fetchImpl of [async()=>new Response('',{status:404}),()=>{throw Error('offline')},async()=>new Response('x'.repeat(5000))]){
    const d=new EndpointDiscovery(()=>config,{fetchImpl})
    assert.equal((await d.plan('online'))[0].url,DEFAULT_DUET_URL)
    await d.inflight
  }
  const custom={endpoints:{online:'wss://custom.example/ws'},authorization:''}
  const d=new EndpointDiscovery(()=>custom,{fetchImpl:()=>{throw Error('must not discover')}})
  assert.equal((await d.plan('online'))[0].selection,'custom')
})
test('startup and connections coalesce; hanging discovery never blocks a connection',async()=>{
  let calls=0,finish
  const d=new EndpointDiscovery(()=>config,{fetchImpl:()=>{calls++;return new Promise(resolve=>{finish=resolve})}})
  const work=d.refreshIfDue()
  const plans=await Promise.all([d.plan('online'),d.plan('tts_only')])
  assert.equal(calls,1)
  for(const plan of plans)assert.equal(plan[0].url,DEFAULT_DUET_URL)
  assert.equal(d.refreshIfDue(),work)
  finish(response());await work
  assert.match((await d.plan('online'))[0].url,/47\.117\.104\.188/)
})
test('daily refresh retains stale recommendation on failure and never changes an active route',async()=>{
  let now=0,calls=0,offline=false
  const d=new EndpointDiscovery(()=>config,{now:()=>now,fetchImpl:async()=>{
    calls++;if(offline)throw Error('offline');return response(calls>2?'47.117.104.189':'47.117.104.188')
  }})
  await d.refreshIfDue()
  const old=(await d.plan('online'))[0];d.used('online',old)
  now=DISCOVERY_INTERVAL_MS-1
  assert.equal(d.refreshIfDue(),null);assert.equal(calls,1)
  offline=true;now++
  assert.equal((await d.plan('online'))[0].url,old.url)
  await d.inflight;assert.equal(calls,2)
  d.invalidate();await d.plan('online');assert.equal(calls,2)
  assert.equal(d.cache.candidate.url,old.url)
  offline=false;now+=DISCOVERY_INTERVAL_MS
  d.used('online',old)
  await d.refreshIfDue()
  assert.equal((await d.effective()).endpoints.online,old.url)
  assert.match((await d.plan('online'))[0].url,/47\.117\.104\.189/)
})
test('disk cache survives restart including failed-attempt cooldown and pinned DNS',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duet-discovery-')),cachePath=join(dir,'cache.json')
  let now=1000,calls=0
  const options={cachePath,now:()=>now,resolve:async()=>[{address:'47.117.104.188',family:4}],
    fetchImpl:async()=>{calls++;return response('voice.example')}}
  try {
    const first=new EndpointDiscovery(()=>config,options);await first.refreshIfDue()
    assert.equal(statSync(cachePath).mode&0o777,0o600)
    const second=new EndpointDiscovery(()=>config,{...options,resolve:()=>{throw Error('must not resolve')}})
    const route=(await second.plan('online'))[0]
    assert.equal(route.url,'ws://voice.example/ws?protocol=realtime_v2');assert.equal(calls,1)
    route.lookup('voice.example',{},(_error,ip)=>assert.equal(ip,'47.117.104.188'))
    now+=DISCOVERY_INTERVAL_MS
    const failed=new EndpointDiscovery(()=>config,{...options,fetchImpl:async()=>{calls++;throw Error('offline')}})
    await failed.refreshIfDue()
    const restart=new EndpointDiscovery(()=>config,options)
    assert.equal(restart.refreshIfDue(),null);assert.equal(calls,2)
    assert.equal((await restart.plan('online'))[0].url,route.url)
    const data=JSON.parse(readFileSync(cachePath,'utf8'))
    assert.equal(data.last_attempt_at,now);assert.equal(data.candidate.url,route.url)
    assert.equal(JSON.stringify(data).includes('Authorization'),false)
  }finally{rmSync(dir,{recursive:true,force:true})}
})
test('corrupt or malformed persisted addresses are ignored without breaking startup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duet-discovery-')),cachePath=join(dir,'cache.json')
  try {
    for(const data of ['bad json',JSON.stringify({schema_version:1,bootstrap_endpoint:DEFAULT_DUET_URL,
      last_attempt_at:Date.now(),candidate:{url:'ws://voice.example/ws',addresses:[{address:'not-an-ip',family:4}]}})]){
      writeFileSync(cachePath,data)
      const d=new EndpointDiscovery(()=>config,{cachePath,fetchImpl:async()=>new Response('',{status:404})})
      assert.equal((await d.plan('online'))[0].url,DEFAULT_DUET_URL);await d.inflight
    }
  }finally{rmSync(dir,{recursive:true,force:true})}
})
test('an explicit empty recommendation clears cache, but persistence failure is harmless',async()=>{
  let now=0,calls=0
  const d=new EndpointDiscovery(()=>config,{cachePath:'/dev/null/cache.json',now:()=>now,
    fetchImpl:async()=>response(++calls===1?'47.117.104.188':'')})
  await d.refreshIfDue();assert.ok(d.cache.candidate)
  now+=DISCOVERY_INTERVAL_MS;await d.refreshIfDue()
  assert.equal((await d.plan('online'))[0].url,DEFAULT_DUET_URL)
  assert.equal(calls,2)
})
test('recommendations reject invalid URL fields and retain pinned DNS',async()=>{
  for(const value of ['ws://localhost/ws',
    'ws://user:secret@47.117.104.188/ws','ws://47.117.104.188/admin','ws://47.117.104.188/ws?token=secret',
    'ws://47.117.104.188:8080/ws','ws://47.117.104.188/ws#secret'])await assert.rejects(recommendedEndpoint(value))
  const route=await recommendedEndpoint('wss://voice.example/ws',async()=>[{address:'47.117.104.188',family:4}])
  route.lookup('voice.example',{},(_error,address)=>assert.equal(address,'47.117.104.188'))
})
test('recommendations do not filter IP ranges',async()=>{
  for(const address of ['47.117.104.188','127.0.0.1','10.0.0.1','169.254.169.254','192.0.2.1']){
    const route=await recommendedEndpoint(`ws://${address}/ws`)
    assert.equal(route.addresses[0].address,address)
  }
  assert.equal((await recommendedEndpoint('ws://[::1]')).addresses[0].address,'::1')
  const route=await recommendedEndpoint('ws://voice.example/ws',async()=>[{address:'192.168.1.2',family:4}])
  route.lookup('voice.example',{},(_error,address)=>assert.equal(address,'192.168.1.2'))
  for(const row of [{address:'bad',family:0},{address:'127.0.0.1',family:6}]){
    await assert.rejects(recommendedEndpoint('ws://voice.example/ws',async()=>[row]))
  }
})
test('HTTP reads follow selection and can fall back; feedback writes are never replayed',async()=>{
  const calls=[]
  const d=new EndpointDiscovery(()=>config,{fetchImpl:async(url,options)=>{
    calls.push(String(url));if(String(url).includes('47.117.104.188'))throw Error('offline')
    return new Response('{}')
  }})
  assert.equal((await d.fetch('http://47.117.104.188/api/service-info',{})).status,200)
  assert.equal(calls[1],endpointHTTP(DEFAULT_DUET_URL,'/api/service-info'))
  await assert.rejects(d.fetch('http://47.117.104.188/feedback',{method:'POST'}))
  assert.equal(calls.length,3)
})
function socketClass(outcomes,attempts){return class extends EventEmitter{
  constructor(url){super();attempts.push(url);queueMicrotask(()=>{
    const outcome=outcomes[url]
    if(outcome===true)this.emit('open')
    else if(typeof outcome==='number')this.emit('unexpected-response',{}, {statusCode:outcome,resume(){}})
    else if(outcome!=='hang')this.emit('error',Error('unavailable'))
  })}
  terminate(){this.emit('close')}
}}
const routes=[{url:'recommended',config:{}},{url:'default',config:{}}]
test('handshake retries once before any model session and reports actual endpoint',async()=>{
  const attempts=[]
  const result=await connectEndpoint(socketClass({default:true},attempts),routes)
  assert.deepEqual(attempts,['recommended','default'])
  assert.equal(result.route.url,'default');assert.equal(result.fallbackReason,'network_error')
})
test('auth, upgrade and busy responses never bypass admission by fallback',async()=>{
  for(const status of [401,403,426,429,503]){
    const attempts=[]
    await assert.rejects(connectEndpoint(socketClass({recommended:status,default:true},attempts),routes))
    assert.deepEqual(attempts,['recommended'])
  }
})
test('cancelled startup never tries fallback',async()=>{
  const attempts=[],controller=new AbortController()
  const pending=connectEndpoint(socketClass({recommended:'hang'},attempts),routes,{signal:controller.signal})
  controller.abort();await assert.rejects(pending);assert.deepEqual(attempts,['recommended'])
})
