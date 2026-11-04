import test from 'node:test'
import assert from 'node:assert/strict'
import {AvatarNotices,avatarLocalState,avatarMenuAction,avatarMenuResult,noticePreferences,saveNoticePreferences} from '../../src/shared/avatar-menu.mjs'
const sessions=[{session_id:'s1',label:'灵感笔记',workspace_id:'w1',running:true}]
const prefs={enabled:true,snoozeUntil:0,bubble:'medium'}
const done=(id='j1',reason='completed')=>({id,session_id:'s1',status:'succeeded',completion_seq:1,turn_end_reason:reason,result:'text cannot set status'})
test('local notices use explicit turn outcome, not assistant text, and deduplicate',()=>{
 const m=new AvatarNotices(),update=results=>m.update({scope:'w1',epoch:'e1',sessions,results})
 update([done(),done('unknown','unknown'),{...done('bad'),session_id:'other'}, {...done('child'),session_id:'child'}])
 assert.equal(m.items.size,1);assert.equal(m.running,1)
 const id=[...m.items.keys()][0];m.read(id);update([done()])
 assert.equal(m.items.size,1);assert.equal(m.items.get(id).unread,false)
 update([{...done('abort','aborted'),status:'failed'}])
 assert.equal([...m.items.values()].find(i=>i.id.includes(':abort:')).status,'stopped')
 m.update({scope:'w2',epoch:'e1',sessions:[],results:[done()]});assert.equal(m.items.size,0)
})
test('pending notifications resolve only from snapshots, dismiss and read do not answer',()=>{
 const m=new AvatarNotices(),p={id:'q1',session_id:'s1',kind:'question',questions:[{question:'请选择颜色'}]}
 const update=interactions=>m.update({scope:'w1',epoch:'e1',sessions,results:[done()],interactions})
 update([p]);assert.equal(m.state(prefs,'large').toast,'pending:q1')
 m.dismiss('pending:q1');assert.equal(m.items.get('pending:q1').pending,true)
 update([p]);assert.notEqual(m.state(prefs,'large').toast,'pending:q1')
 assert.equal(m.state({...prefs,enabled:false},'large').toast,null)
 assert.equal(m.state({...prefs,snoozeUntil:Date.now()+10000},'large').toast,null)
 assert.equal(m.state(prefs,'large',false).toast,null)
 update([]);assert.equal(m.items.has('pending:q1'),false)
})
test('local protocol strips unknown fields and forbids arbitrary commands',()=>{
 assert.throws(()=>avatarMenuAction({type:'menu_action',request_id:'a',action:'exec',value:'rm'}))
 assert.throws(()=>avatarMenuAction({type:'menu_action',request_id:'a',action:'size',value:'xx'}))
 assert.deepEqual(avatarMenuAction({type:'menu_action',request_id:'a',action:'open_dsh',url:'https://evil'}),{type:'menu_action',request_id:'a',action:'open_dsh'})
 assert.deepEqual(avatarMenuResult({type:'menu_result',request_id:'a',ok:true,secret:'no'}),{type:'menu_result',request_id:'a',ok:true,message:''})
 const m=new AvatarNotices();for(let n=0;n<100;n++)m.update({scope:'w1',epoch:'e1',sessions,results:[{...done('j'+n),completion_seq:n}]})
 assert.ok(m.items.size<=32)
 const raw=m.state(prefs,'large');raw.items=raw.items.map(i=>({...i,id:'字'.repeat(512),summary:'字'.repeat(240),name:'字'.repeat(100)}))
 const safe=avatarLocalState(raw);assert.ok(Buffer.byteLength(JSON.stringify(safe))<65536)
})
test('notification preferences stay separate from voice and avatar enablement',()=>{
 let raw;const storage={getItem:()=>raw,setItem:(k,v)=>raw=v}
 assert.deepEqual(noticePreferences(storage),prefs)
 saveNoticePreferences({enabled:false,snoozeUntil:10,bubble:'large',mode:'online'},storage)
 assert.deepEqual(noticePreferences(storage),{enabled:false,snoozeUntil:0,bubble:'large'})
 assert.ok(!raw.includes('online'))
})
