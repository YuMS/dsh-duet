import test from 'node:test'
import assert from 'node:assert/strict'
import {DuetAudio, AUDIO_STOP_PROTOCOL} from '../../src/client/audio.mjs'

function fixture() {
  const audio = new DuetAudio(), events = [], nodes = []
  const send = event => events.push(event)
  audio.context = {currentTime:0, destination:{},
    createBuffer:(_, length)=>({getChannelData:()=>new Float32Array(length)}),
    createGain:()=>({connect(){},disconnect(){},gain:{setValueAtTime(){},linearRampToValueAtTime(){}}}),
    createBufferSource:()=>{
      const node = {connect(){}, disconnect(){}, start(time){this.startAt=time}, stop(time){this.stopAt=time}}
      nodes.push(node); return node
    }}
  const delta = (id='r', generation=1, samples=16000) => audio.event({type:'response.output_audio.delta',
    response_id:id,generation,sample_rate:16000,delta:Buffer.alloc(samples*2).toString('base64')},send)
  const clear = (candidates, extras={}) => audio.event({type:'output_audio_buffer.clear',response_id:'r',generation:1,
    audio_stop_protocol:AUDIO_STOP_PROTOCOL,stop_candidates_samples:candidates,max_wait_ms:300,fade_ms:12,...extras},send)
  const end = (node, time) => {audio.context.currentTime=time;node.onended?.()}
  return {audio,events,nodes,send,delta,clear,end}
}
test('uses actual local playback, skips passed candidates, acknowledges only after stop',()=>{
  const f=fixture(); f.delta();f.audio.context.currentTime=.54 // 8000 samples played
  f.clear([7000,9600,12000]);assert.equal(f.nodes[0].stopAt,.64)
  assert.equal(f.events.some(e=>e.type==='output_audio_buffer.cleared'),false)
  f.audio.context.currentTime=.59;f.audio.progress(f.send)
  assert.equal(f.events.at(-1).played_samples,8800)
  f.end(f.nodes[0],1.5) // Delayed callback cannot inflate played samples.
  assert.equal(f.events.at(-1).played_samples,9600)
  assert.equal(f.events.at(-1).selected_stop_sample,9600)
  assert.equal(f.events.at(-1).stop_reason,'candidate')
})
test('duplicate clear, late PCM and a stale generation never affect the next response',()=>{
  const f=fixture();f.delta();f.audio.context.currentTime=.54;f.clear([9600]);
  f.clear([10000]);assert.equal(f.nodes[0].stopAt,.64)
  f.delta();assert.equal(f.nodes.length,1)
  f.delta('r',2);const next=f.nodes[1]
  f.clear([12000]);assert.equal(next.stopAt,undefined)
  f.end(f.nodes[0],.64);f.end(f.nodes[0],.65)
  assert.equal(f.events.filter(e=>e.type==='output_audio_buffer.cleared').length,1)
  assert.ok(f.audio.responses.has('r:2'));assert.ok(f.audio.nodes.has(next))
})
test('malformed, passed, unavailable and distant candidates fade immediately within hard cap',()=>{
  for(const candidates of [[],null,[7000,8000],[9000,8500],[9600,NaN],[17000],[9000,9200,9400,9600],[15000]]){
    const f=fixture();f.delta();f.audio.context.currentTime=.54;f.clear(candidates)
    assert.ok(Math.abs(f.nodes[0].stopAt-.552)<1e-9,JSON.stringify(candidates))
    f.end(f.nodes[0],.552);assert.equal(f.events.at(-1).stop_reason,'immediate_fallback')
  }
  const f=fixture();f.delta();f.audio.context.currentTime=.54;f.clear([15000],{max_wait_ms:10000})
  assert.ok(f.nodes[0].stopAt<=.84)
})
test('sample positions span packets; queued future packets stop without starting',()=>{
  const f=fixture();f.delta('r',1,8000);f.delta('r',1,8000);f.delta('r',1,8000)
  f.audio.context.currentTime=.54;f.audio.progress(f.send);f.clear([9600])
  assert.equal(f.nodes[1].stopAt,.64);assert.equal(f.nodes[2].stopAt,.54)
  f.end(f.nodes[2],.54);assert.equal(f.events.some(e=>e.type==='output_audio_buffer.cleared'),false)
  f.end(f.nodes[1],.64);assert.equal(f.events.at(-1).played_samples,9600)
})
test('user disconnect immediately disposes scheduled stops without a later callback',()=>{
  const f=fixture();f.delta();f.audio.context.currentTime=.54;f.clear([9600]);f.audio.stop()
  assert.equal(f.nodes[0].onended,null);assert.equal(f.audio.nodes.size,0)
  assert.equal(f.audio.responses.size,0);assert.equal(f.events.length,0)
})
