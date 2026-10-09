import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { DEFAULT_DUET_URL, registerDuetProxy, duetConfig } from '../../src/host/proxy.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteFeedback } from '../../src/host/feedback-files.mjs'
import { FeedbackService } from '../../src/host/feedback-store.mjs'
import { EndpointDiscovery } from '../../src/host/endpoint-discovery.mjs'
import { PLUGIN_VERSION } from '../../src/shared/state.mjs'

test('both modes default to the public trial address and retain explicit overrides', () => {
  assert.equal(new URL(DEFAULT_DUET_URL).hostname, 'duet-router-acc.router.dsh-duet.com')
  assert.equal(new URL(DEFAULT_DUET_URL).protocol, 'wss:')
  assert.deepEqual(duetConfig({}).endpoints, { online: DEFAULT_DUET_URL, tts_only: DEFAULT_DUET_URL })
  assert.ok(duetConfig({}).authorization)
  assert.equal(duetConfig({ DUET_AUTHORIZATION: 'ignored', DUPLEX_VOICE_AUTHORIZATION: 'also-ignored' }).authorization, duetConfig({}).authorization)
  assert.equal(duetConfig({ DUET_URL: 'ws://localhost/shared', DUET_AUTHORIZATION: 'ignored' }).authorization, '')
  assert.deepEqual(duetConfig({ DUPLEX_VOICE_URL: 'ws://localhost/shared', DUPLEX_VOICE_ONLINE_URL: 'ws://localhost/online' }).endpoints,
    { online: 'ws://localhost/online', tts_only: 'ws://localhost/shared' })
})

async function fixture(t, rejectStatus, overrides = {}) {
  const upstream = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  const connections = [], messages = [], headers = []
  upstream.on('upgrade', (req, socket, head) => {
    headers.push(req.headers)
    if (rejectStatus) { socket.end(`HTTP/1.1 ${rejectStatus} Busy\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return }
    wss.handleUpgrade(req, socket, head, ws => {
      connections.push(ws)
      ws.on('message', (raw, binary) => {
        const value = binary ? raw : JSON.parse(raw)
        messages.push(value)
        if (value.type === 'session.update') ws.send(JSON.stringify({ type: 'session.created', ...(overrides.resultPush ? {harness_sync:{protocol:'harness_sync_v1',connection_id:'a'.repeat(32),cursor:64,epoch:'fixture'}} : {}), connection_hint_reporting:overrides.hintReporting===true, session: { id:'voice-from-upstream', config: { harness_control_transport: 'client_rpc_v1', external_message_protocol: overrides.resultProtocol === false ? undefined : 'harness_result_v2' } } }))
        if(value.type==='harness.sync.subscribe') ws.send(JSON.stringify({type:'harness.sync.ready',connection_id:value.connection_id}))
        if(value.type==='harness.sync.push') ws.send(JSON.stringify({type:'harness.sync.ack',connection_id:value.connection_id,event_id:value.event_id,accepted:true}))
        if (value.type === 'external_message') ws.send(JSON.stringify({ type: 'external_message.done', message_id: value.message_id }))
      })
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const host = http.createServer()
  const url = `ws://127.0.0.1:${upstream.address().port}`
  const stop = registerDuetProxy({ webServer: { registerUpgrade({ handler }) { host.on('upgrade', handler); return () => host.off('upgrade', handler) } } }, { ...duetConfig(), authorization: '', ...overrides, endpoints: { online: url, tts_only: url } }, overrides.feedback, overrides.canUseVoice, overrides.discoveryFactory?.(url))
  host.listen(0, '127.0.0.1'); await once(host, 'listening')
  t.after(async () => {
    stop()
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    await Promise.all([new Promise(r => host.close(r)), new Promise(r => upstream.close(r))])
  })
  return { connections, messages, headers, connect(mode = 'tts_only', version = '0.1.0', protocols) {
    return new WebSocket(`ws://127.0.0.1:${host.address().port}/duplex-control/voice/ws?mode=${mode}&plugin_version=${version}`, protocols)
  } }
}

const next = ws => once(ws, 'message').then(([raw]) => JSON.parse(raw))
test('negotiated result events traverse proxy while old servers never receive unsolicited pushes', async t => {
  const f=await fixture(t,null,{resultPush:true}),ws=await begin(f,'online')
  const ready=next(ws)
  ws.send(JSON.stringify({type:'harness.sync.subscribe',connection_id:'a'.repeat(32),protocol:'harness_sync_v1'}))
  assert.equal((await ready).type,'harness.sync.ready')
  const ack=next(ws)
  ws.send(JSON.stringify({type:'harness.sync.push',connection_id:'a'.repeat(32),event_id:'fixture:65:j',result:{id:'j'}}))
  assert.equal((await ack).accepted,true)
  assert.equal(ws.readyState,WebSocket.OPEN)
  ws.close();await once(ws,'close')
  const old=await fixture(t),legacy=await begin(old,'online')
  assert.equal(old.messages.some(e=>e.type?.startsWith('harness.sync.')),false)
  legacy.close();await once(legacy,'close')
})
test('a long result does not close broadcast or block the next notification', {timeout:5000}, async t => {
  const f = await fixture(t), ws = await begin(f, 'tts_only')
  for (const [id, text] of [['long', '字'.repeat(8001)], ['next', '下一项已完成']]) {
    const received = next(ws)
    ws.send(JSON.stringify({type:'external_message', message_id:id, text,
      source:{session_id:'s1',session_name:'工作',job_id:id,status:'completed'}}))
    assert.equal((await received).message_id, id)
    assert.equal(ws.readyState, WebSocket.OPEN)
  }
  const notifications = f.messages.filter(m => m.type === 'external_message')
  assert.equal(notifications.length, 2)
  assert.match(notifications[0].text, /内容较长/)
  assert.equal(notifications[1].text, '下一项已完成')
  assert.equal(f.connections.length, 1)
  ws.close(); await once(ws, 'close')
})
test('online and broadcast send the same session diagnostic schema',async t=>{
  const values=[]
  for(const mode of ['online','tts_only']){
    const f=await fixture(t),ws=await begin(f,mode)
    const payload=f.messages[0]
    assert.equal(payload.client.mode,mode)
    assert.equal(payload.session.io_mode,mode==='online'?'online':'external_only')
    assert.equal(payload.client.metadata_version,'duet_session_v1')
    values.push(Object.keys(payload.client).sort())
    ws.close();await once(ws,'close')
  }
  assert.deepEqual(values[0],values[1])
})
test('hint telemetry is once-only, online-only, and negotiated with the server',async t=>{
  for(const [mode,support,expected] of [['online',true,1],['online',false,0],['tts_only',true,0]]){
    const f=await fixture(t,null,{hintReporting:support}),ws=await begin(f,mode)
    const done=new Promise(resolve=>f.connections[0].on('message',raw=>{
      if(JSON.parse(raw).type==='session.close')resolve()
    }))
    ws.send(JSON.stringify({type:'client.connection_hint',connection_hint:{text:'spoof',source:'router'}}))
    ws.send(JSON.stringify({type:'client.connection_hint'}))
    ws.send(JSON.stringify({type:'session.close'}));await done
    const hints=f.messages.filter(m=>m.type==='client.connection_hint')
    assert.equal(hints.length,expected)
    if(expected)assert.deepEqual(hints[0].connection_hint,f.messages[0].client.connection_route.connection_hint)
    ws.close();await once(ws,'close')
  }
})
test('real proxy falls back before sending initial state and annotates the chosen connection',async t=>{
  const unavailable=http.createServer()
  let attempts=0
  unavailable.on('upgrade',(_req,socket)=>{attempts++;socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')})
  unavailable.listen(0,'127.0.0.1');await once(unavailable,'listening')
  t.after(()=>new Promise(resolve=>unavailable.close(resolve)))
  let selection
  const f=await fixture(t,null,{discoveryFactory:url=>{
    const config={endpoints:{online:url,tts_only:url},authorization:''}
    selection=new EndpointDiscovery(()=>config)
    selection.plan=async()=>[{url:`ws://127.0.0.1:${unavailable.address().port}`,config,selection:'recommended'},
      {url,config,selection:'default'}]
    return selection
  }})
  const ws=await begin(f,'online')
  assert.equal(attempts,1);assert.equal(f.messages.filter(m=>m.type==='session.update').length,1)
  const route=f.messages[0].client.connection_route
  assert.equal(route.selection,'fallback');assert.equal(route.fallback_reason,'http_502')
  assert.equal(route.selected_endpoint,(await selection.effective('online')).endpoints.online)
  assert.equal(f.connections.length,1)
  ws.close();await once(ws,'close')
})
test('no workspace blocks both modes before any upstream connection', async t => {
  let available = false
  const f = await fixture(t, null, { canUseVoice: () => available })
  for (const mode of ['online', 'tts_only']) {
    const ws = f.connect(mode)
    assert.equal((await next(ws)).error.code, 'workspace_required')
    await once(ws, 'close')
  }
  assert.equal(f.connections.length, 0)
  available = true
  const ws = await begin(f, 'tts_only')
  assert.equal(f.connections.length, 1)
  ws.close(); await once(ws, 'close')
})
test('session rating ticket is minted from upstream identity and marked closed by proxy',{timeout:5000},async t=>{
  const anonymousId='anon_'+'a'.repeat(32)
  const feedback=new FeedbackService({userId:()=> anonymousId,insert:async()=>{}})
  const f=await fixture(t,null,{feedback})
  for(const mode of ['online','tts_only']){
  const ws=f.connect(mode)
  await once(ws,'open');const response=next(ws);ws.send(JSON.stringify({type:'session.update'}))
  const event=await response;const row=feedback.sessions.get(event.feedback_session_ticket)
  assert.equal(row.sessionId,'voice-from-upstream');assert.equal(row.closed,false)
  const metadata=f.messages.filter(message=>message.type==='session.update').at(-1).client
  assert.equal(metadata.anonymous_user_id,row.user)
  assert.equal(metadata.identity_kind,'anonymous_browser')
  // Client-side close may precede the proxy's close handler on macOS.
  // The proxy closes upstream after recording feedback closure.
  const upstreamClosed=once(f.connections.at(-1),'close')
  ws.close();await Promise.all([once(ws,'close'),upstreamClosed])
  assert.equal(row.closed,true)
  }
})
async function begin(f, mode) {
  const ws = f.connect(mode)
  await once(ws, 'open')
  const created = next(ws)
  ws.send(JSON.stringify({ type: 'session.update', session: { io_mode: 'malicious_override' } }))
  assert.equal((await created).type, 'session.created')
  return ws
}

test('composer updates are sent only on online client-RPC connections', async t => {
  const f = await fixture(t), ws = await begin(f, 'online')
  ws.send(JSON.stringify({ type: 'harness.composer.update', sequence: 1, composer: null }))
  // Ordered barrier: an RPC reply from upstream arrives after it saw the push.
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.messages.at(-1).type, 'harness.composer.update')
  const tts = await begin(f, 'tts_only'), error = next(tts)
  tts.send(JSON.stringify({ type: 'harness.composer.update', sequence: 1, composer: null }))
  assert.equal((await error).error.code, 'invalid_composer_push')
})

test('old plugin is rejected before connecting upstream', async t => {
  const f = await fixture(t), ws = f.connect('tts_only', '0.7.1')
  assert.equal((await next(ws)).error.code, 'plugin_upgrade_required')
  await once(ws, 'close')
  assert.equal(f.connections.length, 0)
})

test('tts_only freezes wire mode, buffers state without inference, forwards only notifications', async t => {
  const f = await fixture(t), ws = await begin(f, 'tts_only')
  assert.equal(f.messages[0].session.io_mode, 'external_only')
  const {connection_route,...client}=f.messages[0].client
  assert.equal(connection_route.selection,'custom')
  assert.match(connection_route.selected_endpoint,/^ws:\/\/127\.0\.0\.1:/)
  assert.deepEqual(client, { name: 'dsh-duet', version: '0.1.0', protocol_major: 1,
    metadata_version:'duet_session_v1',mode:'tts_only',
    host_version: PLUGIN_VERSION, page_binding: 'connection_owner_v1', client_trace_id: client.client_trace_id, page_id: '' })
  assert.match(client.client_trace_id,/^[a-f0-9-]{36}$/)
  ws.send(JSON.stringify({ type: 'harness.state', state: { focused_session_id: 's1' } }))
  const done = next(ws)
  ws.send(JSON.stringify({ type: 'external_message', message_id: 'a', text: '任务完成' }))
  assert.equal((await done).message_id, 'a')
  assert.equal(f.messages.length, 2)
  assert.equal(f.messages[1].text, '任务完成')
  assert.equal(JSON.stringify(f.messages[1]).includes('focused_session_id'), false)
  const rejected = next(ws)
  ws.send(Buffer.alloc(2560))
  assert.equal((await rejected).error.code, 'input_audio_disabled')
  await once(ws, 'close')
})

test('online carries microphone frames but does not duplicate server-side Harness results', async t => {
  const f = await fixture(t), ws = await begin(f, 'online')
  assert.equal(f.messages[0].session.io_mode, 'online')
  assert.deepEqual(f.messages[0].session.harness, { transport: 'client_rpc_v1' })
  const got = once(f.connections[0], 'message')
  ws.send(Buffer.alloc(2560))
  await got
  assert.equal(f.messages[1].length, 2560)
  const rejected = next(ws)
  ws.send(JSON.stringify({ type: 'external_message', text: 'duplicate' }))
  assert.equal((await rejected).error.code, 'external_only_session_required')
  await once(ws, 'close')
})

test('upstream HTTP saturation produces busy instead of an opaque connection failure', async t => {
  const f = await fixture(t, 503), ws = f.connect()
  assert.equal((await next(ws)).error.code, 'capacity_exhausted')
  const [code] = await once(ws, 'close')
  assert.equal(code, 1013)
})

test('reverse RPC request and response stay on their own voice connection', async t => {
  const f = await fixture(t), ws = await begin(f, 'online')
  const request = { type: 'harness.rpc.request', connection_id: 'a'.repeat(32), request_id: 'b'.repeat(32), method: 'GET', path: '/api/sessions' }
  const received = next(ws)
  f.connections[0].send(JSON.stringify(request))
  assert.deepEqual(await received, request)
  const reply = { type: 'harness.rpc.response', connection_id: request.connection_id, request_id: request.request_id, status: 200, body: { sessions: [] } }
  const upstream = once(f.connections[0], 'message')
  ws.send(JSON.stringify(reply))
  const [raw] = await upstream
  assert.deepEqual(JSON.parse(raw), reply)
  const rejected = next(ws)
  ws.send(JSON.stringify(reply))
  assert.equal((await rejected).error.code, 'harness_rpc_unmatched_response')
  await once(ws, 'close')
})

test('HTTP control mode uses the configured authorization', async t => {
  const f = await fixture(t, undefined, { control_transport: 'http', authorization: 'fixture-secret' })
  const ws = await begin(f, 'online')
  assert.equal(f.messages[0].session.harness, undefined)
  assert.equal(f.headers[0].authorization, 'fixture-secret')
  assert.equal(JSON.stringify(f.messages).includes('fixture-secret'), false)
  ws.close(); await once(ws, 'close')
})

test('one central voice URL serves both modes without any personal DSH URL', () => {
  const config = duetConfig({ DUPLEX_VOICE_URL: 'wss://central/ws?protocol=realtime_v2' })
  assert.equal(config.endpoints.online, config.endpoints.tts_only)
  assert.equal(config.control_transport, 'client_rpc_v1')
})

test('result metadata survives proxy independently of unrelated UI state', async t => {
  const f = await fixture(t), ws = await begin(f, 'tts_only')
  ws.send(JSON.stringify({ type: 'harness.state', state: { focused_session_id: 'other', composer_state: { text: 'private draft' } } }))
  const source = { session_id: 'real-session', session_name: '日报', job_id: 'real-job', status: 'failed' }
  const done = next(ws)
  ws.send(JSON.stringify({ type: 'external_message', message_id: 'notice', source, text: '测试没有通过。' }))
  await done
  assert.deepEqual(f.messages[1], { type: 'external_message', message_id: 'notice', source, text: '测试没有通过。' })
  ws.close(); await once(ws, 'close')
})

test('old result backend is rejected instead of silently losing task identity', async t => {
  const f = await fixture(t, undefined, { resultProtocol: false }), ws = f.connect()
  await once(ws, 'open')
  const event = next(ws)
  ws.send(JSON.stringify({ type: 'session.update' }))
  assert.equal((await event).error.code, 'harness_result_backend_upgrade_required')
  await once(ws, 'close')
})


test('cookie-stripping Desktop sends signed WS identity, receives a rating ticket, and submits as the same user', {timeout:10000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'duet-desktop-proxy-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const store=new RemoteFeedback(()=>({}),{keyPath:join(dir,'key')})
  const rows=[];store.insert=async record=>{rows.push(record);return {archive_id:'fixture-only'}}
  const token=store.ensureCredential({headers:{}},{setHeader(){}})
  const feedback=new FeedbackService(store)
  const f=await fixture(t,null,{feedback})
  for(const mode of ['online','tts_only']){
    const ws=f.connect(mode,PLUGIN_VERSION,['duet-voice-v1','duet-identity.'+token])
    await once(ws,'open');assert.equal(ws.protocol,'duet-voice-v1')
    const response=next(ws);ws.send(JSON.stringify({type:'session.update'}))
    const event=await response
    assert.ok(event.feedback_session_ticket)
    assert.equal(f.messages.at(-1).client.anonymous_user_id,store.userId({headers:{'x-duet-identity':token}}))
    assert.equal(f.headers.at(-1)['sec-websocket-protocol'],undefined)
    assert.equal(f.headers.at(-1)['x-duet-identity'],undefined)
    assert.ok(!JSON.stringify(f.messages).includes(token))
    const closed=once(f.connections.at(-1),'close');ws.close();await once(ws,'close');await closed
    await feedback.submit({headers:{'x-duet-identity':token}},{kind:'rating',request_id:crypto.randomUUID(),rating:5,session_ticket:event.feedback_session_ticket})
    assert.equal(rows.at(-1).user_id,f.messages.at(-1).client.anonymous_user_id)
  }
  const bad=token.slice(0,-1)+(token.endsWith('0')?'1':'0')
  const ws=f.connect('tts_only',PLUGIN_VERSION,['duet-voice-v1','duet-identity.'+bad])
  await once(ws,'open');const response=next(ws);ws.send(JSON.stringify({type:'session.update'}))
  assert.equal((await response).feedback_session_ticket,undefined)
  assert.equal(f.messages.at(-1).client.anonymous_user_id,undefined)
  ws.close();await once(ws,'close')
})
