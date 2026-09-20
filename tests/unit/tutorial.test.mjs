import test from 'node:test'
import assert from 'node:assert/strict'
import { TutorialRun, QUESTION, INPUT, EDIT } from '../../src/client/tutorial.mjs'

function fixture() {
  const calls=[], drafts=new Map();let current='original',mode='off'
  const a={
    mode:()=>mode,current:()=>current,
    create:async name=>{const id='tutorial-'+drafts.size;drafts.set(id,'');calls.push(['create',name]);return id},
    focus:async id=>{current=id;calls.push(['focus',id])},
    write:async(id,text,expected)=>{assert.equal(drafts.get(id),expected);drafts.set(id,text);calls.push(['write',text])},
    submit:async(id,text)=>{assert.equal(drafts.get(id),text);drafts.set(id,'');calls.push(['submit',text]);return {id:'job'}},
    enableBroadcast:async()=>{mode='tts_only';calls.push(['mode',mode])},
    waitBroadcast:async()=>{calls.push(['broadcast_done'])},
    off:async()=>{mode='off';calls.push(['mode',mode])},
    narrate:async name=>{assert.equal(mode,'off');calls.push(['narrate',name])},
    stopNarration:()=>calls.push(['stop_audio']),status:()=>{},
  }
  return {a,calls,drafts,run:new TutorialRun(a),changeFocus:id=>{current=id}}
}
test('no mutation before start; missing dual consent never submits or opens voice',async()=>{
  const {run,calls}=fixture();assert.equal(calls.length,0)
  await run.begin({sound:true,chat:true});await assert.rejects(run.broadcast({sound:true,chat:false}),/未确认/)
  assert.equal(calls.filter(c=>c[0]==='submit'||c[0]==='mode').length,0)
})
test('first screen consent is required before creating a session or speaking',async()=>{
  for(const consent of [undefined,{sound:true,chat:false},{sound:false,chat:true}]){
    const {run,calls}=fixture();await assert.rejects(run.begin(consent),/确认/)
    assert.deepEqual(calls,[])
  }
})
test('mode descriptions narrate separately and do not enable either mode',async()=>{
  const {run,calls}=fixture();await run.begin({sound:true,chat:true})
  await run.explainMode('broadcast');await run.explainMode('interaction')
  assert.deepEqual(calls.filter(c=>c[0]==='narrate'),[['narrate','modes_broadcast'],['narrate','modes_interaction']])
  assert.equal(calls.some(c=>c[0]==='mode'||c[0]==='submit'),false)
})
test('causal two-mode walkthrough: TTS narration precedes writes, second send separately gated',async()=>{
  const {run,calls}=fixture();await run.begin({sound:true,chat:true});await run.broadcast({sound:true,chat:true})
  await run.input();await run.edit();await run.clear();await run.reinput();await run.explainSend()
  assert.deepEqual(calls.filter(c=>['narrate','write','submit'].includes(c[0])),[
    ['narrate','broadcast'],['write',QUESTION],['submit',QUESTION],['narrate','input'],['write',INPUT],['narrate','edit'],['write',EDIT],['narrate','clear'],['write',''],['narrate','reinput'],['write',EDIT],['narrate','send'],
  ])
  await run.send(true);await run.switchSession();assert.equal(run.step,'done')
  assert.equal(calls.some(c=>c[1]==='online'),false)
  await assert.rejects(run.send(true),/步骤/)
})
test('cancel second send keeps the draft and never makes another model request',async()=>{
  const {run,calls,drafts}=fixture();await run.begin({sound:true,chat:true});await run.broadcast({sound:true,chat:true})
  await run.input();await run.edit();await run.clear();await run.reinput();await run.explainSend();await assert.rejects(run.send(false),{name:'AbortError'})
  assert.equal(calls.filter(c=>c[0]==='submit').length,1);assert.equal(drafts.get(run.second),EDIT)
})
test('leaving teaching session prevents input and send into unrelated sessions',async()=>{
  const {run,changeFocus,calls}=fixture();await run.begin({sound:true,chat:true});changeFocus('original')
  await assert.rejects(run.broadcast({sound:true,chat:true}),/会话已切换/)
  assert.equal(calls.filter(c=>c[0]==='write'||c[0]==='submit').length,0)
})
test('exit during narration prevents the delayed edit; shutdown owns only teaching connection',async()=>{
  const f=fixture();await f.run.begin({sound:true,chat:true});await f.run.broadcast({sound:true,chat:true});await f.run.input()
  let resolve;f.a.narrate=()=>new Promise(r=>resolve=r)
  const pending=f.run.edit();await f.run.stop();resolve();await assert.rejects(pending,{name:'AbortError'})
  assert.equal(f.drafts.get(f.run.second),INPUT)
})
test('double click is not a duplicate create or send',async()=>{
  const f=fixture();let resolve;f.a.create=()=>new Promise(r=>resolve=r)
  const pending=f.run.begin({sound:true,chat:true});await assert.rejects(f.run.begin({sound:true,chat:true}),/尚未完成/)
  resolve('one');await pending;assert.equal(f.run.owned.size,1)
})
test('clearing is visible and cannot skip reinput before send',async()=>{
  const f=fixture();await f.run.begin({sound:true,chat:true});await f.run.broadcast({sound:true,chat:true})
  await f.run.input();await f.run.edit();await f.run.clear()
  assert.equal(f.drafts.get(f.run.second),'')
  await assert.rejects(f.run.explainSend(),/步骤/)
  await f.run.reinput();assert.equal(f.drafts.get(f.run.second),EDIT)
})
test('exit during clear narration preserves existing draft',async()=>{
  const f=fixture();await f.run.begin({sound:true,chat:true});await f.run.broadcast({sound:true,chat:true})
  await f.run.input();await f.run.edit()
  let resolve;f.a.narrate=()=>new Promise(r=>resolve=r)
  const pending=f.run.clear();await f.run.stop();resolve();await assert.rejects(pending,{name:'AbortError'})
  assert.equal(f.drafts.get(f.run.second),EDIT)
})
test('user edits after clear are never overwritten by reinput',async()=>{
  const f=fixture();await f.run.begin({sound:true,chat:true});await f.run.broadcast({sound:true,chat:true})
  await f.run.input();await f.run.edit();await f.run.clear()
  f.drafts.set(f.run.second,'用户自己输入的内容')
  await assert.rejects(f.run.reinput())
  assert.equal(f.drafts.get(f.run.second),'用户自己输入的内容')
})
