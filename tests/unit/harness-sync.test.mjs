import test from 'node:test'
import assert from 'node:assert/strict'
import { HarnessSync, SYNC_CAPABILITIES } from '../../src/client/harness-sync.mjs'

const offer = {protocol:'harness_sync_v1',capabilities:SYNC_CAPABILITIES,connection_id:'a'.repeat(32),cursor:64,epoch:'host-epoch'}
const tick = () => new Promise(resolve => setImmediate(resolve))
function setup(resume={}) {
  const sent=[],listeners=new Set(),feed={active:true,epoch:offer.epoch,results:new Map(),
    subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},replay:(...args)=>{feed.replayed=args}}
  let state={sessions:[{session_id:'s',label:'会话',active:true}],interactions:[]}
  const client=new HarnessSync(e=>sent.push(e),feed,()=>state,()=>{},resume)
  const ready=()=>{client.offer(offer);client.event({type:'harness.sync.ready',connection_id:offer.connection_id,capabilities:SYNC_CAPABILITIES})}
  return {client,sent,feed,ready,change:value=>{state=value;client.changed()},listeners}
}
test('old/partial servers do not enable sync; explicit matching ready required', () => {
  const {client,sent}=setup()
  client.offer(undefined);client.offer({...offer,capabilities:['task_results']});assert.equal(sent.length,0)
  client.offer(offer);assert.equal(sent[0].type,'harness.sync.subscribe');assert.equal(client.active,false)
  client.event({type:'harness.sync.ready',connection_id:'wrong'});assert.equal(client.active,false);client.close()
})
test('no result polling; task cursor advances only after acceptance',async()=>{
  const resume={}, {client,sent,feed,ready}=setup(resume);ready()
  feed.results.set(65,{id:'j',session_id:'s',completion_seq:65,status:'succeeded',result:'好了'})
  const done=client.drain();assert.equal(client.cursor,64)
  const pushed=sent.find(e=>e.type==='harness.sync.push');assert.ok(pushed)
  client.event({type:'harness.sync.ack',connection_id:offer.connection_id,event_id:pushed.event_id,accepted:true})
  await done;assert.equal(resume.cursor,65);await client.drain()
  assert.equal(sent.filter(e=>e.type==='harness.sync.push').length,1);client.close()
})
test('coalesce pending snapshots, including removal of answered questions',()=>{
  const {client,sent,ready,change}=setup();ready()
  change({sessions:[],interactions:[{id:'q'}]});change({sessions:[],interactions:[]})
  assert.equal(sent.filter(e=>e.type==='harness.sync.state').length,1)
  client.event({type:'harness.sync.state_ack',connection_id:offer.connection_id,sequence:1,accepted:true})
  const states=sent.filter(e=>e.type==='harness.sync.state');assert.equal(states.length,2)
  assert.deepEqual(states[1].state,{sessions:[],interactions:[]});client.close()
})
test('resume cursor and host epoch; heartbeat falls back when local feed unavailable',t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout']})
  const {client,sent,feed,ready}=setup({epoch:offer.epoch,cursor:60});ready()
  assert.equal(sent[0].cursor,60);assert.deepEqual(feed.replayed,[60,offer.epoch])
  feed.active=false;t.mock.timers.tick(15000)
  assert.equal(sent.at(-1).type,'harness.sync.fallback');assert.equal(client.active,false)
  client.close()
})
test('lost ACK retries identical event without duplicate cursor advancement',async t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout']})
  const {client,sent}=setup();client.offer(offer)
  const done=client.deliver({id:'j',session_id:'s',status:'failed',completion_seq:65,error:'失败'})
  t.mock.timers.tick(2000)
  const pushes=sent.filter(e=>e.type==='harness.sync.push');assert.equal(pushes.length,2);assert.deepEqual(pushes[0],pushes[1])
  client.event({type:'harness.sync.ack',connection_id:offer.connection_id,event_id:pushes[0].event_id,accepted:true})
  await done;client.close();await tick()
})
