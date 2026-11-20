import test from 'node:test'
import assert from 'node:assert/strict'
import {agentToolCard,agentTurnLinks,navigateAgentTool,taskLinkPresentation} from '../../src/client/agent-tool-views.mjs'
const id='a'.repeat(32)
test('task card names and states only use known evidence',()=>{
  assert.deepEqual(taskLinkPresentation({name:'画小猫',state:'running'}),{name:'画小猫',label:'开始执行',tone:'running'})
  assert.equal(taskLinkPresentation({name:'画小猫',state:'running'},{running:false}).label,'开始执行','history does not change when the session stops')
  assert.deepEqual(taskLinkPresentation({state:'ready'},{title:'小猫结果'}),{name:'小猫结果',label:'结果就绪',tone:'completed'})
  assert.equal(taskLinkPresentation({state:'waiting_user'}).tone,'waiting')
  assert.equal(taskLinkPresentation({state:'failed'}).tone,'failed')
  assert.deepEqual(taskLinkPresentation({state:'toString',name:{}},{title:[]}),{name:'任务会话',label:'已关联任务',tone:'neutral'})
  assert.deepEqual(taskLinkPresentation({},{displayTitle:'worker-private-id'}),{name:'任务会话',label:'已关联任务',tone:'neutral'})
})
test('turn links are scoped, deduplicated, and prefer results over route links',()=>{
  const route={kind:'tool-call',data:{root:settled({}, {results:[{ticket:{ticket_id:id,title:'Original task'}}]}, {call:{name:'orchestrator_route',argsRaw:'{}'}})}}
  const reply={kind:'tool-call',data:{root:settled({}, {status:'sent'}, {call:{name:'orchestrator_reply',argsRaw:JSON.stringify({ticket_id:id,purpose:'result'})}})}}
  const snapshot={locations:{getTurn:turn=>turn===1?['a','b']:[]},nodes:new Map([['a',route],['b',reply]])}
  const links=agentTurnLinks(snapshot,1)
  assert.equal(links.length,1);assert.equal(links[0].name,'Original task');assert.equal(links[0].result,true)
  assert.deepEqual(agentTurnLinks(snapshot,2),[])
})
const settled=(args,result,extra={})=>({kind:'tool-result',call:{argsRaw:JSON.stringify(args)},content:[{type:'text',text:JSON.stringify(result)}],time:123,callTime:120,...extra})
test('real route receipts use working stages and separate accept/attach/stop events',()=>{
  for(const [receipt,state] of [[{kind:'accept',decision:'accept'},'running'],[{kind:'attach'},'progress'],[{kind:'stop',decision:'stop'},'stopped']]){
    const card=agentToolCard('orchestrator_route',settled({}, {results:[{...receipt,ticket:{ticket_id:id,title:'画一张小猫',state:'working/queued'}}]}))
    assert.equal(card.links[0].state,state)
  }
  const ignored=agentToolCard('orchestrator_route',settled({decisions:[{kind:'stop'}]}, {results:[{kind:'stop',decision:'ignore',ticket:{ticket_id:id,state:'open'}}]}))
  assert.equal(taskLinkPresentation(ignored.links[0]).tone,'neutral','a proposed stop is not an executed stop')
  const refused=agentToolCard('orchestrator_route',settled({}, {results:[{kind:'accept',refused:'not accepted',ticket:{ticket_id:id,state:'open'}}]}))
  assert.equal(refused.links.length,0)
  for(const [stage,state] of [['working','running'],['working/queued','queued'],['person/answer','waiting_user'],['person/failed','failed']]){
    const card=agentToolCard('orchestrator_route',settled({}, {results:[{ticket:{ticket_id:id,state:stage}}]}))
    assert.equal(card.links[0].state,state)
  }
})
test('task links come from successful route results, not proposed or refused decisions',()=>{
  const card=agentToolCard('orchestrator_route',settled({decisions:[{ticket_id:id}]},{results:[{ticket:{ticket_id:id,title:'Task'}},{ticket:{ticket_id:id,title:'duplicate'}},{refused:'Not accepted',ticket:{ticket_id:'b'.repeat(32)}},{ticket:{ticket_id:'javascript:alert(1)'}}]}))
  assert.equal(card.links.length,1);assert.equal(card.links[0].ticket,id)
  assert.deepEqual(card.messages,['Not accepted'])
  assert.equal(agentToolCard('orchestrator_route',{argsRaw:'{"decisions":[]}'}).links.length,0)
})
test('result and attention cards expose explicit links; ordinary answers and failed calls do not',()=>{
  const card=agentToolCard('orchestrator_reply',settled({ticket_id:id,purpose:'result',text:'Done'},{status:'sent'}))
  assert.equal(card.links[0].label,'跳转到结果');assert.equal(card.links[0].at,120)
  assert.equal(agentToolCard('orchestrator_reply',settled({ticket_id:id,purpose:'attention'},{status:'sent'})).links[0].label,'打开会话')
  for(const block of [settled({purpose:'answer',text:'Hi'},{status:'sent'}),settled({ticket_id:id},{status:'dropped'}),settled({ticket_id:id},{},{isError:true}),{kind:'tool-result',call:null,content:[]}])assert.equal(agentToolCard('orchestrator_reply',block).links.length,0)
})
test('manual navigation validates catalog membership and never creates a task',async()=>{
  const snap={current:'main',byId:{['worker-'+id]:{}}},opened=[]
  const ctx={sessions:{list:{getSnapshot:()=>snap},refresh:async()=>{},open:x=>{snap.current=x;opened.push(x)}}}
  await navigateAgentTool(ctx,{ticket:id},new AbortController().signal)
  assert.deepEqual(opened,['worker-'+id])
  await assert.rejects(navigateAgentTool(ctx,{ticket:'b'.repeat(32)},new AbortController().signal),/暂时不可用/)
  const abort=new AbortController();abort.abort()
  await assert.rejects(navigateAgentTool(ctx,{ticket:id},abort.signal),/abort/i)
})
test('malformed tool content and unknown receipt statuses cannot fabricate navigation',()=>{
  for(const content of [null,{},[null,{type:'text',text:123}],[{type:'text',text:'invalid'}]]){
    assert.deepEqual(agentToolCard('orchestrator_route',{kind:'tool-result',content}).links,[])
  }
  assert.deepEqual(agentToolCard('orchestrator_reply',settled({ticket_id:id,purpose:'result'},{})).links,[])
})
