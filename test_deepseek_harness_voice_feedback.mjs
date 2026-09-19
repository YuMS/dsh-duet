import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { FeedbackService } from './deepseek_harness_voice_feedback_store.mjs'
const req={user:'alice'}
const text=()=>({kind:'text',request_id:randomUUID(),text:'希望声音更自然'})
function fixture(){
  const rows=[];let now=100000
  const store={userId:r=>r.user,insert:async row=>rows.push(row)}
  return {s:new FeedbackService(store,{now:()=>now}),rows,store,advance:n=>{now+=n}}
}
test('unconfigured persistence never reports success',async()=>{
  const s=new FeedbackService();assert.equal(s.enabled,false);assert.equal(s.open(req,'s','online'),null)
  await assert.rejects(s.submit(req,text()),/unavailable/)
})
test('text identity is host-resolved; no browser user/session forgery',async()=>{
  const {s,rows}=fixture();const result=await s.submit(req,text())
  assert.equal(result.persisted,true);assert.equal(rows[0].user_id,'alice');assert.equal(rows[0].session_id,null)
  await assert.rejects(s.submit(req,{...text(),user_id:'bob'}),/fields/)
  await assert.rejects(s.submit(req,{...text(),session_id:'spoof'}),/fields/)
})
test('rating requires an ended server-observed session belonging to the user',async()=>{
  const {s,rows}=fixture();const t=s.open(req,'actual-voice-session','tts_only')
  const data={kind:'rating',request_id:randomUUID(),rating:5,session_ticket:t}
  await assert.rejects(s.submit(req,data),/session_unavailable/)
  s.close(t);await assert.rejects(s.submit({user:'bob'},data),/session_unavailable/)
  await s.submit(req,data);assert.equal(rows[0].session_id,'actual-voice-session');assert.equal(rows[0].mode,'tts_only')
})
test('bad ratings, empty text, overflow and expired tickets are rejected',async()=>{
  const {s,advance}=fixture();const t=s.open(req,'s','online');s.close(t)
  for(const rating of [0,6,1.5,'5'])await assert.rejects(s.submit(req,{kind:'rating',request_id:randomUUID(),rating,session_ticket:t}),/rating/)
  for(const value of ['', '   ', 'x'.repeat(5001)])await assert.rejects(s.submit(req,{...text(),text:value}),/text/)
  advance(86400001);await assert.rejects(s.submit(req,{kind:'rating',request_id:randomUUID(),rating:1,session_ticket:t}),/session_unavailable/)
})
test('database commit failure is returned, not claimed saved',async()=>{
  const {s,store}=fixture();store.insert=async()=>{throw Error('database down')}
  await assert.rejects(s.submit(req,text()),/database down/)
})
