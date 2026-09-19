import assert from 'node:assert/strict'
import test from 'node:test'
import { VoiceState, IDLE_RELEASE_MS } from './deepseek_harness_voice_state.mjs'
import { VoiceAudio } from './deepseek_harness_voice_audio.mjs'

test('connection chime has two short voices and stops with the connection', () => {
  const audio = new VoiceAudio(), voices=[]
  audio.context={state:'running',currentTime:10,destination:{},createGain:()=>({gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}}),
    createOscillator:()=>{const voice={frequency:{},connect(gain){return gain},disconnect(){},start(t){this.begin=t},stop(t){this.end=t;this.stops=(this.stops||0)+1}};voices.push(voice);return voice}}
  audio.connectedChime()
  assert.equal(voices.length,2)
  assert.deepEqual(voices.map(v=>v.frequency.value),[523.25,659.25])
  assert.equal(voices[0].begin,10)
  assert.ok(voices[1].end-10<0.5)
  audio.stop()
  assert.ok(voices.every(v=>v.stops===2))
  assert.equal(audio.tones.size,0)
})
import { compatibleVersion, externalWithState } from './deepseek_harness_voice_proxy.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  let now = 0
  const connections = [], notices = []
  const state = new VoiceState({ now: () => now, notice: text => notices.push(text), connect(mode, receive) {
    const c = { mode, receive, closed: false, messages: [], states: [], playing: () => false, async close() { this.closed = true }, send(x) { this.messages.push(x) }, sendState(x) { this.states.push(x) } }
    connections.push(c)
    return c
  } })
  return { state, connections, notices, advance(ms) { now += ms; state.tick() } }
}

test('default off does not connect or queue model work', () => {
  const f = fixture()
  f.state.update({ hidden: false, running: true, state: {}, results: [{ message_id: 'old' }] })
  assert.equal(f.state.mode, 'off')
  assert.equal(f.connections.length, 0)
  assert.equal(f.state.pending.size, 0)
})

test('recorded malformed answer_question error is nonfatal; genuine transport failure still closes', async () => {
  const f = fixture()
  await f.state.toggleMic()
  const c = f.connections[0]
  c.receive({ type: 'ready' })
  // Captured from 9058e790d9a849c0941b2f6e255335e6 at 246.4626s.
  c.receive({ type: 'error', code: 'malformed_dense_action', message: 'answer_question payload must be canonical JSON' })
  await flush()
  assert.equal(f.state.mode, 'online')
  assert.equal(c.closed, false)
  assert.equal(f.state.ready, true)
  assert.match(f.notices.at(-1), /未执行/)
  assert.deepEqual(c.messages, []) // no invented correction or automatic mutation retry
  c.receive({ type: 'error', code: 'voice_disconnected' })
  await flush()
  assert.equal(f.state.mode, 'off')
  assert.equal(c.closed, true)
})

test('mic/speaker transitions recreate and close every old connection', async () => {
  const f = fixture()
  await f.state.toggleSpeaker()
  assert.equal(f.state.mode, 'tts_only')
  await f.state.toggleMic()
  assert.equal(f.state.mode, 'online')
  assert.ok(f.connections[0].closed)
  await f.state.toggleMic()
  assert.equal(f.state.mode, 'off')
  await f.state.toggleMic()
  assert.equal(f.state.mode, 'online')
  await f.state.toggleSpeaker()
  assert.equal(f.state.mode, 'tts_only')
  await f.state.toggleSpeaker()
  assert.equal(f.state.mode, 'off')
  assert.equal(f.connections.length, 4)
  assert.ok(f.connections.every(c => c.closed))
})

test('background no-running countdown releases only tts_only and wakes for fast results', async () => {
  const f = fixture()
  await f.state.toggleSpeaker()
  f.state.update({ hidden: true, running: false, state: {} })
  f.advance(IDLE_RELEASE_MS - 1)
  assert.equal(f.state.suspended, false)
  f.advance(1)
  await flush()
  assert.equal(f.state.mode, 'tts_only')
  assert.equal(f.state.suspended, true)
  assert.ok(f.connections[0].closed)
  f.state.update({ hidden: false, running: false, state: {} })
  assert.equal(f.connections.length, 1) // foreground alone doesn't silently reacquire
  f.state.update({ hidden: true, running: false, state: {}, results: [{ type: 'external_message', message_id: 'fast', text: '完成' }] })
  await flush()
  assert.equal(f.connections.length, 2)
  f.connections[1].receive({ type: 'ready' })
  assert.equal(f.connections[1].messages[0].message_id, 'fast')
})

test('running jobs reset idle clock and online never auto-disconnects', async () => {
  const f = fixture()
  await f.state.toggleSpeaker()
  f.state.update({ hidden: true, running: false, state: {} })
  f.advance(59000)
  f.state.update({ hidden: true, running: true, state: {} })
  f.advance(60000)
  assert.equal(f.state.suspended, false)
  await f.state.toggleMic()
  f.state.update({ hidden: true, running: false, state: {} })
  f.advance(120000)
  assert.equal(f.state.suspended, false)
})

test('state-only updates do not enqueue notifications; results are ordered once', async () => {
  const f = fixture()
  await f.state.toggleSpeaker()
  const c = f.connections[0]
  c.receive({ type: 'ready' })
  f.state.update({ hidden: false, running: false, state: { text: '草稿' } })
  assert.equal(c.messages.length, 0)
  f.state.update({ hidden: false, running: true, state: {}, results: [{ message_id: 'a' }, { message_id: 'b' }] })
  assert.equal(c.messages.length, 1)
  c.receive({ type: 'external_message.done', message_id: 'a' })
  assert.equal(c.messages[1].message_id, 'b')
})

test('busy and incompatible clients go off with non-modal notice, no reconnect', async () => {
  for (const code of ['capacity_exhausted', 'plugin_upgrade_required', 'interaction_mode_unavailable',
    'broadcast_mode_unavailable', 'client_protocol_unsupported', 'client_version_unsupported']) {
    const f = fixture()
    await f.state.toggleMic()
    f.connections[0].receive({ type: 'error', code })
    await flush()
    assert.equal(f.state.mode, 'off')
    assert.ok(f.connections[0].closed)
    assert.equal(f.notices.length, 1)
    if (code === 'interaction_mode_unavailable') assert.match(f.notices[0], /交互模式暂时不可用/)
    if (code === 'broadcast_mode_unavailable') assert.match(f.notices[0], /播报模式暂时不可用/)
    f.state.update({ hidden: false, running: true, state: {} })
    assert.equal(f.connections.length, 1)
  }
})

test('rapid toggles and stale callbacks cannot revive retired connections', async () => {
  const f = fixture()
  await f.state.toggleSpeaker()
  const old = f.connections[0]
  const a = f.state.setMode('online'), b = f.state.setMode('off')
  await Promise.all([a, b])
  old.receive({ type: 'ready' })
  assert.equal(f.state.mode, 'off')
  assert.equal(f.state.ready, false)
  assert.equal(f.connections.length, 1)
})

test('server compatibility is a configured semver range, missing and future versions fail closed', () => {
  for (const v of ['', '0.7.1', '0.8.0', '0.10.0', '1.0.0', '0.9.0junk']) assert.equal(compatibleVersion(v), false)
  assert.equal(compatibleVersion('0.1.0'), true)
  assert.equal(compatibleVersion('0.1.10'), true)
  assert.equal(compatibleVersion('0.8.3', '0.8.2', '0.9.0'), true)
  const state = { composer_state: { text: '未发送草稿' } }
  const out = externalWithState({ type: 'external_message', message_id: 'a', text: '任务完成' }, state)
  assert.equal(out.text, '任务完成')
  assert.equal(out.text.includes('未发送草稿'), false)
})

test('PCM acknowledgements follow playback time, not received bytes; old audio stays cleared', () => {
  const audio = new VoiceAudio(), sent = []
  audio.context = { currentTime: 0, destination: {}, createBuffer: (_, n) => ({ getChannelData: () => new Float32Array(n) }), createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {} }) }
  const event = { type: 'response.output_audio.delta', response_id: 'r', generation: 1, sample_rate: 16000, delta: Buffer.alloc(32000).toString('base64') }
  audio.event(event, x => sent.push(x))
  audio.progress(x => sent.push(x))
  assert.equal(sent.length, 0)
  audio.context.currentTime = 0.54
  audio.progress(x => sent.push(x))
  assert.equal(sent[0].played_samples, 8000)
  audio.event({ type: 'output_audio_buffer.clear', response_id: 'r', generation: 1 }, x => sent.push(x))
  audio.event(event, x => sent.push(x))
  assert.equal(audio.nodes.size, 0)
})
