import test from 'node:test'
import assert from 'node:assert/strict'
import {agentEntryNavigation} from '../../src/client/agent-entry.mjs'
import {agentEntryReminder} from '../../src/shared/work-mode.mjs'
const main='orchestrator-'+ 'a'.repeat(32)
const tick=()=>new Promise(resolve=>setTimeout(resolve,20))
function fixture(){
  const snapshot={current:'previous',byId:{[main]:{}}},opened=[]
  const ctx={sessions:{refresh:async()=>{},list:{getSnapshot:()=>snapshot},open:id=>{opened.push(id);snapshot.current=id}}}
  const abort=new AbortController()
  return {snapshot,opened,ctx,abort,entry:agentEntryNavigation(ctx,abort.signal)}
}
test('main session navigation waits for audio readiness and runs once',async()=>{
  const f=fixture();f.entry.frame({main_session_id:main});await tick();assert.deepEqual(f.opened,[])
  f.entry.connected();await tick();assert.deepEqual(f.opened,[main])
  f.snapshot.current='other';f.entry.frame({main_session_id:main});f.entry.connected();await tick()
  assert.deepEqual(f.opened,[main])
})
test('late main-session metadata navigates; aborted and invalid targets never do',async()=>{
  const f=fixture();f.entry.connected();f.entry.frame({main_session_id:'worker-'+ 'a'.repeat(32)})
  await tick();assert.deepEqual(f.opened,[])
  f.entry.frame({main_session_id:main});await tick();assert.deepEqual(f.opened,[main])
  const g=fixture();g.abort.abort();g.entry.connected();g.entry.frame({main_session_id:main});await tick();assert.deepEqual(g.opened,[])
})
test('registration delay does not override a manual session switch',async()=>{
  const f=fixture();f.ctx.sessions.refresh=async()=>{f.snapshot.current='manual'}
  f.entry.frame({main_session_id:main});f.entry.connected();await tick();assert.deepEqual(f.opened,[])
})
test('disabled automatic navigation leaves the current session unchanged',async()=>{
  const f=fixture(),entry=agentEntryNavigation(f.ctx,f.abort.signal,()=>false)
  entry.frame({main_session_id:main});entry.connected();await tick();assert.deepEqual(f.opened,[])
})
test('agent entry reminder persists ten uses and deduplicates connections',()=>{
  const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)}
  assert.equal(agentEntryReminder(null,storage),false)
  for(let n=1;n<=11;n++){
    assert.equal(agentEntryReminder('entry-'+n,storage),n<=10)
    assert.equal(agentEntryReminder('entry-'+n,storage),n<=10)
    assert.equal([...data.values()][0],String(Math.min(n,10)))
  }
})
