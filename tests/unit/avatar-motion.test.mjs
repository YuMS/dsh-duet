import test from 'node:test'
import assert from 'node:assert/strict'
import {MotionDirector,MOTION_DURATION_MS,gesturePose} from '../../src/avatar/motion.mjs'
test('semantic and random gestures have nonzero poses',()=>{
 for(const [word,kind,axis] of [['不行','shake','yaw'],['好的','nod','nod'],['可以','nod','nod']]){
  const director=new MotionDirector()
  director.sample({text:word,utterance:word},0)
  const action=director.sample({text:word,utterance:word},600)
  assert.equal(action.kind,kind)
  assert.ok(Math.abs(gesturePose(action)[axis])>.05)
  assert.deepEqual(gesturePose(director.sample({text:word,utterance:word},1800)),{nod:0,yaw:0,roll:0})
 }
 for(const kind of ['glance_left','glance_right','tilt'])assert.ok(Object.values(gesturePose({kind,elapsed:.6,envelope:1})).some(x=>Math.abs(x)>.05))
})
const frame=(text,rms=0,utterance='u')=>({text,rms,utterance})
test('short captions at the end of audible speech still trigger a complete motion',()=>{
 const d=new MotionDirector(()=>0)
 assert.equal(d.sample(frame(''),0).kind,'')
 assert.equal(d.sample(frame('收到'),100).kind,'nod')
 assert.equal(d.sample(frame('',0,''),1200).kind,'nod')
 assert.equal(d.sample(frame('',0,''),100+MOTION_DURATION_MS).kind,'')
})
test('partial words do not spend the motion opportunity on a random gesture',()=>{
 for(const [partial,complete,kind] of [['收','收到','nod'],['哈','哈哈','laugh'],['可','可以','nod']]){
  const d=new MotionDirector(()=>0)
  assert.equal(d.sample(frame(partial,.1),0).kind,'')
  assert.equal(d.sample(frame(partial,.1),400).kind,'')
  assert.equal(d.sample(frame(complete,.1),500).kind,kind)
 }
})
test('a new semantic motion waits for the current motion to complete',()=>{
 const d=new MotionDirector(()=>0)
 assert.equal(d.sample(frame('收到'),0).kind,'nod')
 assert.equal(d.sample(frame('收到，哈哈'),500).kind,'nod')
 assert.equal(d.sample(frame('收到，哈哈'),1799).sequence,1)
 assert.equal(d.sample(frame('收到，哈哈'),1800).kind,'laugh')
 assert.equal(d.sample(frame('收到，哈哈'),1800).sequence,2)
 assert.equal(d.sample(frame('',0,''),3600).kind,'')
})
test('same motion is blocked for five seconds after completion, across utterances',()=>{
 const d=new MotionDirector(()=>.999)
 d.sample(frame('收到'),0);d.sample(frame('收到'),1800)
 assert.equal(d.sample(frame('收到',0,'two'),5000).kind,'')
 assert.equal(d.sample(frame('收到',0,'three'),6799).kind,'')
 assert.equal(d.sample(frame('收到',0,'four'),6800).kind,'nod')
})
test('cumulative captions and expired pending motions never replay stale keywords',()=>{
 const d=new MotionDirector(()=>0)
 d.sample(frame('收到'),0);d.sample(frame('收到'),1800)
 assert.notEqual(d.sample(frame('收到，任务正在进行'),7000).kind,'nod')
 assert.notEqual(d.sample(frame('收到，任务正在进行。'),8000).kind,'nod')
 const e=new MotionDirector(()=>0);e.sample(frame('收到'),0);e.sample(frame('收到，哈哈'),500)
 assert.equal(e.sample(frame('收到，哈哈'),5000).kind,'')
})
test('a standalone 好 waits briefly and does not misread 好像',()=>{
 const d=new MotionDirector(()=>0)
 assert.equal(d.sample(frame('好'),0).kind,'')
 assert.equal(d.sample(frame('好像'),100).kind,'')
 assert.equal(d.sample(frame('好像'),300).kind,'')
 const e=new MotionDirector(()=>0);e.sample(frame('好'),0)
 assert.equal(e.sample(frame('好'),250).kind,'nod')
 const punctuation=new MotionDirector(()=>0);punctuation.sample(frame('好'),0)
 punctuation.sample(frame('好，'),100)
 assert.equal(punctuation.sample(frame('好，'),250).kind,'nod')
})
test('random gestures also obey the completion-based repetition cooldown',()=>{
 const d=new MotionDirector(()=>0),f=frame('')
 d.sample(f,0);assert.equal(d.sample(f,3999).kind,'')
 assert.equal(d.sample(f,4000).kind,'glance_left')
 assert.equal(d.sample(f,5800).kind,'')
 assert.equal(d.sample(f,9799).kind,'')
 assert.equal(d.sample(f,9800).kind,'glance_right')
 assert.equal(d.sample(f,11600).kind,'')
 assert.equal(d.sample(f,15600).kind,'glance_left')
})
test('random timer works without speech and stays within four to eight seconds',()=>{
 for(const r of [0,.5,.999]){
  const d=new MotionDirector(()=>r),f=frame(''),due=4000+r*4000
  d.sample(f,0);assert.equal(d.sample(f,due-1).kind,'')
  assert.ok(['glance_left','glance_right','tilt'].includes(d.sample(f,due).kind))
 }
})
test('semantic cues take priority over due random gestures without interrupting active motion',()=>{
 const d=new MotionDirector(()=>0),f=frame('')
 d.sample(f,0);assert.equal(d.sample(frame('好的'),4000).kind,'nod')
 d.sample(f,5800);assert.equal(d.sample(f,9800).kind,'glance_left')
 assert.equal(d.sample(frame('不行'),9900).kind,'glance_left')
 assert.equal(d.sample(frame('不行'),11600).kind,'shake')
 assert.equal(d.sample(frame('不行'),11600).sequence,3)
})
