import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { DEFAULT_VOICE_URL, registerVoiceProxy, voiceConfig } from './deepseek_harness_voice_proxy.mjs'
import { FeedbackService } from './deepseek_harness_voice_feedback_store.mjs'

test('both modes default to the public trial address and retain explicit overrides', () => {
  assert.equal(new URL(DEFAULT_VOICE_URL).hostname, 'duet-router.1781574661016173.ap-southeast-1.pai-eas.aliyuncs.com')
  assert.deepEqual(voiceConfig({}).endpoints, { online: DEFAULT_VOICE_URL, tts_only: DEFAULT_VOICE_URL })
  assert.equal(voiceConfig({}).authorization, '')
  assert.deepEqual(voiceConfig({ DUPLEX_VOICE_URL: 'ws://localhost/shared', DUPLEX_VOICE_ONLINE_URL: 'ws://localhost/online' }).endpoints,
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
        if (value.type === 'session.update') ws.send(JSON.stringify({ type: 'session.created', session: { id:'voice-from-upstream', config: { harness_control_transport: 'client_rpc_v1', external_message_protocol: overrides.resultProtocol === false ? undefined : 'harness_result_v2' } } }))
        if (value.type === 'external_message') ws.send(JSON.stringify({ type: 'external_message.done', message_id: value.message_id }))
      })
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const host = http.createServer()
  const url = `ws://127.0.0.1:${upstream.address().port}`
  const stop = registerVoiceProxy({ webServer: { registerUpgrade({ handler }) { host.on('upgrade', handler); return () => host.off('upgrade', handler) } } }, { ...voiceConfig(), ...overrides, endpoints: { online: url, tts_only: url } }, overrides.feedback)
  host.listen(0, '127.0.0.1'); await once(host, 'listening')
  t.after(async () => {
    stop()
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    await Promise.all([new Promise(r => host.close(r)), new Promise(r => upstream.close(r))])
  })
  return { connections, messages, headers, connect(mode = 'tts_only', version = '0.1.0') {
    return new WebSocket(`ws://127.0.0.1:${host.address().port}/duplex-control/voice/ws?mode=${mode}&plugin_version=${version}`)
  } }
}

const next = ws => once(ws, 'message').then(([raw]) => JSON.parse(raw))
test('session rating ticket is minted from upstream identity and marked closed by proxy',async t=>{
  const feedback=new FeedbackService({userId:()=> 'alice',insert:async()=>{}})
  const f=await fixture(t,null,{feedback}),ws=f.connect()
  await once(ws,'open');const response=next(ws);ws.send(JSON.stringify({type:'session.update'}))
  const event=await response;const row=feedback.sessions.get(event.feedback_session_ticket)
  assert.equal(row.sessionId,'voice-from-upstream');assert.equal(row.closed,false)
  ws.close();await once(ws,'close')
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(row.closed,true)
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
  assert.deepEqual(f.messages[0].client, { name: 'dsh-duet', version: '0.1.0', protocol_major: 1 })
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
  const config = voiceConfig({ DUPLEX_VOICE_URL: 'wss://central/ws?protocol=realtime_v2' })
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
