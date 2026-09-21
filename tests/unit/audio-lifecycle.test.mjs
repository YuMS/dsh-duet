import test from 'node:test'
import assert from 'node:assert/strict'
import {DuetAudio} from '../../src/client/audio.mjs'

async function fixture(t) {
  const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator')
  const originalWorklet=globalThis.AudioWorkletNode
  class Track extends EventTarget {readyState='live';muted=false;stops=0;stop(){this.readyState='ended';this.stops++}}
  class Node extends EventTarget {port={};gain={value:1};connect(next){return next}disconnect(){}}
  const track=new Track(),stream={getTracks:()=>[track],getAudioTracks:()=>[track]},errors=[]
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>stream}}})
  globalThis.AudioWorkletNode=Node
  const audio=new DuetAudio();audio.captureLoaded=true
  audio.context={createMediaStreamSource:()=>new Node(),createGain:()=>new Node(),destination:{},currentTime:0}
  t.after(()=>{audio.stop();if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator;if(originalWorklet)globalThis.AudioWorkletNode=originalWorklet;else delete globalThis.AudioWorkletNode})
  await audio.startMic(()=>{},code=>errors.push(code))
  return {audio,track,errors,stream}
}
test('ended microphone stops capture and reports exactly once',async t=>{
  const {audio,track,errors}=await fixture(t)
  track.readyState='ended';track.dispatchEvent(new Event('ended'));track.dispatchEvent(new Event('ended'))
  assert.deepEqual(errors,['microphone_disconnected']);assert.equal(audio.stream,null);assert.equal(track.stops,1)
})
test('processor failure stops capture and normal close never reports a fault',async t=>{
  const {audio,track,errors}=await fixture(t),capture=audio.capture
  capture.dispatchEvent(new Event('processorerror'))
  audio.stop();track.dispatchEvent(new Event('ended'));capture.dispatchEvent(new Event('processorerror'))
  assert.deepEqual(errors,['audio_capture_failed'])
})
test('short track mute recovers; sustained mute fails, not ordinary silence',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const {audio,track,errors}=await fixture(t)
  t.mock.timers.tick(20000);assert.deepEqual(errors,[])
  track.muted=true;track.dispatchEvent(new Event('mute'));t.mock.timers.tick(5000)
  track.muted=false;track.dispatchEvent(new Event('unmute'));t.mock.timers.tick(10000);assert.deepEqual(errors,[])
  track.muted=true;track.dispatchEvent(new Event('mute'));t.mock.timers.tick(10000)
  assert.deepEqual(errors,['audio_capture_failed']);assert.equal(audio.stream,null)
})
test('close removes track watchers and cancels pending mute timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const {audio,track,errors}=await fixture(t)
  track.muted=true;track.dispatchEvent(new Event('mute'));audio.stop()
  t.mock.timers.tick(20000);track.dispatchEvent(new Event('ended'));assert.deepEqual(errors,[])
})
test('permission resolving after close cannot resurrect the microphone',async t=>{
  const {audio,track,errors,stream}=await fixture(t);audio.stop()
  let resolve;globalThis.navigator.mediaDevices.getUserMedia=()=>new Promise(r=>resolve=r)
  const pending=audio.startMic(()=>{},code=>errors.push(code));audio.stop();resolve(stream);await pending
  assert.equal(audio.stream,null);assert.deepEqual(errors,[]);assert.ok(track.stops>=2)
})
