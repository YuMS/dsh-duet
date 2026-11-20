import test from 'node:test'
import assert from 'node:assert/strict'
import {gunzipSync} from 'node:zlib'
import {AgentTraceSender,TRACE_PROTOCOL} from '../../src/host/agent-trace.mjs'

function fixture(body='{"kind":"journal","text":"测试"}'){
  const rows=[{seq:3,body}],sent=[],acks=[]
  const store={id:'a'.repeat(32),head:()=>rows[0],acknowledge:seq=>{acks.push(seq);rows.shift()}}
  let now=0,can=true
  const sender=new AgentTraceSender(store,e=>sent.push(e),{clock:()=>now,canSend:()=>can})
  clearInterval(sender.timer)
  const ack=frame=>sender.handle({...frame,type:'duet.trace.ack',persisted:true})
  return {store,rows,sent,acks,sender,ack,clock:v=>now=v,allow:v=>can=v}
}
test('trace needs negotiation, yields to voice backpressure, deletes only after exact durable ACK',async()=>{
  const f=fixture();await f.sender.flush();assert.equal(f.sent.length,0)
  f.sender.offer(TRACE_PROTOCOL);f.allow(false);await f.sender.flush();assert.equal(f.sent.length,0)
  f.allow(true);await f.sender.flush();const frame=f.sent[0]
  assert.equal(gunzipSync(Buffer.from(frame.data,'base64')).toString(),f.rows[0].body)
  f.ack({...frame,seq:2});f.ack({...frame,sha256:'wrong'});assert.equal(f.acks.length,0)
  f.clock(5100);await f.sender.flush();assert.deepEqual(f.sent[1],frame)
  f.ack(frame);assert.deepEqual(f.acks,[3]);f.ack(frame);assert.equal(f.acks.length,1)
  f.sender.close()
})
test('large UTF8 record is chunked without loss; closing leaves pending data for reconnection',async()=>{
  const text=JSON.stringify({text:'鹈鹕'.repeat(15000)}),f=fixture(text)
  f.sender.offer(TRACE_PROTOCOL);const chunks=[]
  while(f.rows.length){await f.sender.flush();const frame=f.sent.at(-1);chunks.push(gunzipSync(Buffer.from(frame.data,'base64')));f.ack(frame)}
  assert.equal(Buffer.concat(chunks).toString(),text);assert.ok(chunks.length>1)
  f.sender.close()
  const g=fixture();g.sender.offer(TRACE_PROTOCOL);await g.sender.flush();g.sender.close()
  assert.equal(g.rows.length,1);await g.sender.flush();assert.equal(g.sent.length,1)
})
test('pending traces cannot be silently redirected to a different service',async()=>{
  const f=fixture();f.store.bindTarget=target=>target==='wss://original.test'
  f.sender.target=()=> 'wss://other.test';f.sender.offer(TRACE_PROTOCOL)
  await f.sender.flush();assert.equal(f.sent.length,0);f.sender.close()
})
