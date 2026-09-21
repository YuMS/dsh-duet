import test from 'node:test'
import assert from 'node:assert/strict'
import {tutorialAdapter} from '../../src/client/tutorial-adapter.mjs'

function fixture() {
  let current='tutorial';const calls=[]
  const snapshot={draft:'',draftRev:1,phase:'plain',attachmentIds:[]}
  const input={state:{getSnapshot:()=>snapshot},setDraft:text=>{snapshot.draft=text;snapshot.draftRev++;calls.push(['draft',text])}}
  const ctx={sessions:{list:{getSnapshot:()=>({current})},scope:id=>({id})},conversation:{input:{for:()=>input}}}
  const state={mode:'off',setMode:async mode=>{state.mode=mode;calls.push(['mode',mode])}}
  return {a:tutorialAdapter(ctx,state,{},()=>{}),snapshot,calls,focus:id=>{current=id},signal:new AbortController().signal}
}
test('direct editor adapter preserves unrelated edits and attachments',async()=>{
  const f=fixture();await f.a.write('tutorial','hello','',f.signal);assert.equal(f.snapshot.draft,'hello')
  await assert.rejects(f.a.write('tutorial','overwrite','',f.signal),/已被修改/)
  f.snapshot.attachmentIds=['file'];await assert.rejects(f.a.write('tutorial','overwrite','hello',f.signal),/已被修改/)
  f.focus('other');await assert.rejects(f.a.write('tutorial','overwrite','hello',f.signal),/焦点/)
  assert.equal(f.calls.length,1)
})
test('submit uses exact revision and hash and does not open voice',async()=>{
  const f=fixture(),previous=globalThis.fetch,requests=[];f.snapshot.draft='fixed'
  globalThis.fetch=async(url,options)=>{
    requests.push([url,options]);return {ok:true,json:async()=>url.endsWith('/submit')?{job:{id:'j1'}}:{composer:{text:'fixed',revision:1,hash:'a'.repeat(64)}}}
  }
  try{
    assert.deepEqual(await f.a.submit('tutorial','fixed',f.signal),{id:'j1'})
    assert.deepEqual(JSON.parse(requests[1][1].body),{expected_revision:1,expected_hash:'a'.repeat(64)})
    assert.equal(f.calls.length,0)
  }finally{globalThis.fetch=previous}
})
test('a draft change during snapshot fetch prevents submit',async()=>{
  const f=fixture(),previous=globalThis.fetch;let n=0;f.snapshot.draft='fixed'
  globalThis.fetch=async()=>{n++;f.snapshot.draft='user edit';return{ok:true,json:async()=>({composer:{text:'fixed',revision:1,hash:'a'.repeat(64)}})}}
  try{await assert.rejects(f.a.submit('tutorial','fixed',f.signal),/已被修改/);assert.equal(n,1)}finally{globalThis.fetch=previous}
})
test('aborted write never touches the editor',async()=>{
  const f=fixture(),c=new AbortController();c.abort()
  await assert.rejects(f.a.write('tutorial','bad','',c.signal),{name:'AbortError'});assert.equal(f.calls.length,0)
})
test('tutorial exposes missing workspace and rejects creation before API calls',async()=>{
  const ctx={workspaces:{list:{getSnapshot:()=>({phase:'ready',items:[]})}}}
  const adapter=tutorialAdapter(ctx,{}, {},()=>{})
  assert.equal(adapter.workspaceIssue(),'workspace_required')
  await assert.rejects(adapter.create('tutorial',new AbortController().signal),/workspace_required/)
})
