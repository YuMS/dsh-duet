import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'
import { registerSyncFeed } from '../../src/host/sync-feed.mjs'
import { LocalSync } from '../../src/client/local-sync.mjs'

const wait = ms => new Promise(r => setTimeout(r, ms))
async function until(fn) { for(let i=0;i<100;i++){if(fn())return;await wait(10)}assert.ok(fn()) }

test('local event stream authenticates, stays idle and targets the connection owner',async t=>{
  const server=http.createServer();let upgrade, reads=0, commands=[], head=0
  const feed=registerSyncFeed({connection:{requestRejection:r=>r.headers.cookie==='fixture=ok'?null:403},
    webServer:{registerUpgrade:r=>{upgrade=r.handler;return()=>{}}}}, {
    snapshot:async(cursor,epoch)=>{reads++;return {epoch:'e',cursor:head,sessions:[],results:cursor!==null&&head>cursor?[{id:'j',completion_seq:head}]:[],health:{result_cursor:head,focus_epoch:'e'}}},
    touch:()=>{},commands:id=>commands.filter(r=>r.target_client_id===id),
  })
  server.on('upgrade',(req,sock,h)=>upgrade(req,sock,h));server.listen(0,'127.0.0.1');await once(server,'listening')
  const url=`ws://127.0.0.1:${server.address().port}/duplex-control/sync/ws`
  const sockets=[]
  t.after(async()=>{for(const ws of sockets)ws.terminate();feed.close();await new Promise(r=>server.close(r))})
  const denied=new WebSocket(url);denied.on('error',()=>{});const rejection=once(denied,'unexpected-response');const [,res]=await rejection;assert.equal(res.statusCode,403);denied.terminate()
  const cross=new WebSocket(url,{headers:{cookie:'fixture=ok',origin:'http://other.test'}});cross.on('error',()=>{});const [,bad]=await once(cross,'unexpected-response');assert.equal(bad.statusCode,403);cross.terminate()
  const connect=async id=>{const ws=new WebSocket(url,{headers:{cookie:'fixture=ok'}});sockets.push(ws);const values=[];ws.on('message',r=>values.push(JSON.parse(r)));await once(ws,'open')
    ws.send(JSON.stringify({type:'harness.sync.subscribe',protocol:'harness_sync_v1'}))
    ws.send(JSON.stringify({type:'harness.sync.heartbeat',owner:{client_id:id,session_id:'s'}}));return {ws,values}}
  const a=await connect('a'),b=await connect('b');await until(()=>reads===2)
  await wait(100);assert.equal(reads,2,'no periodic catalog/results queries')
  commands=[{id:'r',target_client_id:'a'}];feed.commands();await until(()=>a.values.some(v=>v.type==='harness.sync.command'))
  assert.ok(!b.values.some(v=>v.type==='harness.sync.command'))
  head=1;feed.changed();await until(()=>a.values.some(v=>v.results?.length))
})

test('Desktop local feed uses streamBaseUrl, restores cursor and closes cleanly',()=>{
  const previous=globalThis.__DSH_TRANSPORT__
  globalThis.__DSH_TRANSPORT__={streamBaseUrl:'http://127.0.0.1:12345/'}
  const sockets=[]
  class FakeSocket {
    readyState=1; sent=[]
    constructor(url){this.url=url;sockets.push(this)}
    send(raw){this.sent.push(JSON.parse(raw))}
    close(){this.readyState=3;this.onclose?.()}
  }
  const feed=new LocalSync({WebSocketImpl:FakeSocket})
  try{
    feed.start();const ws=sockets[0];assert.equal(ws.url,'ws://127.0.0.1:12345/duplex-control/sync/ws')
    ws.onopen();assert.equal(ws.sent[0].protocol,'harness_sync_v1')
    ws.onmessage({data:JSON.stringify({type:'harness.sync.snapshot',protocol:'harness_sync_v1',epoch:'e',cursor:7,sessions:[],results:[],health:{}})})
    assert.equal(feed.active,true);assert.equal(feed.cursor,7)
    const off=feed.bindOwner(()=>({client_id:'owner',session_id:'s'}));assert.equal(ws.sent.at(-1).owner.client_id,'owner')
    off();assert.equal(ws.sent.at(-1).owner,null)
    feed.replay(3,'e');assert.equal(ws.sent.at(-1).cursor,3)
  }finally{feed.close();globalThis.__DSH_TRANSPORT__=previous}
})
