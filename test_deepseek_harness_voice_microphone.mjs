import assert from 'node:assert/strict'
import test from 'node:test'
import { MICROPHONE_KEY, selectedMicrophone, microphoneConstraints } from './deepseek_harness_voice_microphone.mjs'
import { VoiceAudio } from './deepseek_harness_voice_audio.mjs'

test('microphone preference is browser-local with safe system default', () => {
  assert.equal(selectedMicrophone(null), '')
  assert.equal(selectedMicrophone({getItem() {throw Error('blocked')}}), '')
  assert.equal(selectedMicrophone({getItem(key) {assert.equal(key, MICROPHONE_KEY);return 'usb-mic'}}), 'usb-mic')
  assert.equal(microphoneConstraints('').audio.deviceId, undefined)
  assert.deepEqual(microphoneConstraints('usb-mic').audio.deviceId, {exact:'usb-mic'})
  assert.equal(microphoneConstraints('usb-mic').video, false)
})

test('capture uses selected device; missing device never retries a different microphone', async t => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  t.after(() => {
    for (const [key, descriptor] of [['localStorage', storage], ['navigator', navigator]]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  Object.defineProperty(globalThis, 'localStorage', {configurable:true,value:{getItem:()=>'usb-mic'}})
  const seen=[]
  Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{mediaDevices:{getUserMedia:async c=>{
    seen.push(c);throw new DOMException('missing', 'OverconstrainedError')
  }}}})
  await assert.rejects(new VoiceAudio().startMic(()=>{}), {name:'OverconstrainedError'})
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].audio.deviceId, {exact:'usb-mic'})
})
