import test from 'node:test'
import assert from 'node:assert/strict'
import {AgentConnection,AGENT_PROTOCOL,overviewDelta} from '../../src/host/agent-connection.mjs'
import {agentOptions} from '../../src/shared/work-mode.mjs'
test('settings and connection accept the same workspace ID lengths',async()=>{
  const id='w'.repeat(512)
  const c=new AgentConnection({open:async workspace=>{
    assert.equal(workspace,id);return {overview:()=>({})}
  }},()=>{})
  await c.prepare(agentOptions({workspace_id:id}).workspace_id)
  c.close()
  for(const bad of ['',id+'w']){
    assert.throws(()=>agentOptions({workspace_id:bad}),/invalid_agent_workspace/)
    await assert.rejects(c.prepare(bad),/workspace_selection_required/)
  }
})
const offer={session:{config:{agent_protocol:AGENT_PROTOCOL}}}
test('task progress uses the current report or pending question, never old runs or model labels',async()=>{
  const f=fixture(),ui=[],up=[],c=new AgentConnection(f.service,e=>up.push(e),e=>ui.push(e))
  const ticket={assignments:[{report:{summary:'旧进度'}},{report:{summary:'正在检查页面布局'}}]}
  f.source.taskRows=()=>[{session_id:'worker-native',task_id:'t',state:'running'}]
  f.source.runtime={store:{tickets:{get:()=>ticket}}}
  await c.prepare('workspace');c.offer(offer)
  assert.equal(ui.at(-1).rows[0].progress,'正在检查页面布局')
  assert.ok(!JSON.stringify(up).includes('正在检查页面布局'))
  ticket.attention={id:'q',question:'要保留蓝色配色吗？'};c.showTasks()
  assert.equal(ui.at(-1).rows[0].progress,'要保留蓝色配色吗？')
  delete ticket.attention;ticket.assignments.push({state:'running'});c.showTasks()
  assert.equal(ui.at(-1).rows[0].progress,undefined)
  c.close()
})
test('task presentation is local: replay has no focus, live current run can navigate, other runs cannot',async()=>{
  const f=fixture(),ui=[],up=[],c=new AgentConnection(f.service,e=>up.push(e),e=>ui.push(e))
  f.source.taskRows=()=>[{session_id:'worker-native',task_id:'ticket',run_id:'run1',name:'测试',state:'running'}]
  f.source.ids={raw:()=> 'req1'}
  f.source.runtime={masterId:'orchestrator-'+ 'a'.repeat(32),store:{tickets:{get:()=>({attention:{id:'native-question-1'}})}}}
  await c.prepare('workspace');c.offer(offer)
  assert.equal(ui[0].main_session_id,f.source.runtime.masterId)
  assert.equal(ui[0].rows[0].attention_id,'native-question-1')
  assert.ok(!JSON.stringify(up).includes('native-question-1'))
  assert.ok(!JSON.stringify(up).includes(f.source.runtime.masterId))
  const event={purpose:'result',task_id:'ticket',run_id:'run1',request_id:'req1'}
  c.showTasks([event]);assert.deepEqual(ui.map(e=>e.focus),[null])
  c.handle({type:'duet.agent.request',protocol:AGENT_PROTOCOL,request_id:'req1',message:{text:'继续'}})
  c.showTasks([{...event,run_id:'old'}]);assert.equal(ui.length,1)
  c.showTasks([event]);assert.equal(ui.at(-1).focus,'worker-native')
  assert.ok(!JSON.stringify(up).includes('worker-native'))
  c.close()
})
test('completed managed runs navigate once without the originating request; reconnect replay never steals focus',async()=>{
  const f=fixture(),ui=[],c=new AgentConnection(f.service,()=>{},e=>ui.push(e))
  const row={task_id:'t',run_id:'r1',session_id:'native',state:'running',finished_at:null}
  f.source.taskRows=()=>[{...row}]
  f.source.ids={raw:()=>null}; f.source.latestSequence=()=>10
  await c.prepare('w');c.offer(offer)
  const event={purpose:'result',task_id:'t',run_id:'r1',request_id:'different',sequence:9}
  c.showTasks([event]);assert.deepEqual(ui.map(r=>r.focus),[null])
  row.finished_at=Date.now();row.state='completed'
  c.showTasks([{...event,sequence:11}]);c.showTasks([{...event,sequence:11}]);c.showTasks()
  assert.deepEqual(ui.map(r=>r.focus),[null,'native'])
  row.run_id='r2';row.finished_at=null;row.state='running';c.showTasks()
  row.finished_at=Date.now();row.state='completed';c.showTasks()
  assert.equal(ui.at(-1).focus,'native')
  c.close()
})
function fixture() {
  let cursor=0,listener,closed=0
  const source={overview:()=>({version:'harness_overview_v1',sessions:[]}),
    events:after=>({events:after?[]:[{sequence:1,message_id:'m1',purpose:'answer',text:'好'}],cursor:after||1}),
    cursor:()=>cursor,acknowledge:n=>{cursor=n},subscribe:fn=>{listener=fn;return()=>{listener=null;closed++}},
    receive:body=>({received:true,request_id:body.request_id})}
  const service={open:async()=>source},sent=[]
  return {service,source,sent,connection:new AgentConnection(service,e=>sent.push(e)),notify:()=>listener?.(),closed:()=>closed}
}
test('requires explicit protocol; original RPC is not silently used',async()=>{
  const f=fixture();await f.connection.prepare('w1')
  assert.throws(()=>f.connection.offer({session:{config:{}}}),/upgrade_required/)
  f.connection.close()
})
test('pushes durable batches, advances only on exact ack, close does not stop tasks',async()=>{
  const f=fixture();await f.connection.prepare('w1');f.connection.offer(offer)
  f.notify();assert.equal(f.sent.length,1)
  assert.throws(()=>f.connection.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:2}),/invalid_agent_cursor/)
  f.connection.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:1})
  f.connection.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:1})
  assert.equal(f.source.cursor(),1)
  f.connection.close();assert.equal(f.closed(),1)
})
test('binds one connection per workspace and keeps other workspaces independent',async()=>{
  const f=fixture();await f.connection.prepare('one')
  const second=new AgentConnection(f.service,()=>{})
  await assert.rejects(second.prepare('one'),/workspace_in_use/)
  await second.prepare('two');second.close();f.connection.close()
  const next=new AgentConnection(f.service,()=>{});await next.prepare('one');next.close()
})

test('pure state changes push once, and never overtake an outstanding event',async()=>{
  const f=fixture(),c=f.connection
  await c.prepare('w1');c.offer(offer)
  f.source.overview=()=>({version:'harness_overview_v1',sessions:{s1:{state:'running'}}})
  f.notify();assert.equal(f.sent.length,1)
  c.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:1})
  assert.deepEqual(f.sent.at(-1).delta,{set:{sessions:{s1:{state:'running'}}},unset:[]})
  f.source.overview=()=>({version:'harness_overview_v1',sessions:{s1:{state:'completed'}}})
  f.notify();f.notify()
  assert.equal(f.sent.length,3)
  assert.deepEqual(f.sent.at(-1).delta,{set:{sessions:{s1:{state:'completed'}}},unset:[]})
  c.close()
})

test('managed startup and completion wait for their notification ACK; UI remains live',async()=>{
  const f=fixture(),ui=[],c=new AgentConnection(f.service,e=>f.sent.push(e),e=>ui.push(e))
  let events=[],view={sessions:{},session_order:[]},run='r1',finished=false
  f.source.overview=()=>structuredClone(view)
  f.source.events=after=>{const pending=events.filter(e=>e.sequence>after);return {events:pending,cursor:pending.at(-1)?.sequence??after}}
  f.source.taskRows=()=>Object.keys(view.sessions).length?[{task_id:'t1',run_id:run,session_id:'native',state:view.sessions.s1.state,finished_at:finished?1:null}]:[]
  f.source.ids={raw:()=>null}
  await c.prepare('w');c.offer(offer)
  view={sessions:{s1:{name:'画铅笔',state:'queued',latest_task_id:'t1',run_count:1}},session_order:['s1']}
  f.notify();assert.equal(f.sent.length,0)
  view.sessions.s1.state='running';f.notify();assert.equal(f.sent.length,0)
  assert.equal(ui.at(-1).rows[0].state,'running')
  events.push({sequence:1,message_id:'a1',purpose:'acknowledgement',task_id:'t1',run_id:run,text:'开始画铅笔'})
  f.notify();assert.equal(f.sent.at(-1).type,'duet.agent.events')
  // Completion can race with the acceptance ACK. Do not leak it into that ACK's snapshot.
  view.sessions.s1.state='completed';finished=true;f.notify()
  c.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:1})
  assert.equal(f.sent.at(-1).delta.set.sessions.s1.state,'queued')
  const count=f.sent.length;f.notify();assert.equal(f.sent.length,count)
  events.push({sequence:2,message_id:'z1',purpose:'result',task_id:'t1',run_id:run,status:'completed',text:'铅笔画好了'})
  f.notify();assert.equal(f.sent.at(-1).type,'duet.agent.events')
  c.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:2})
  assert.equal(f.sent.at(-1).delta.set.sessions.s1.state,'completed')
  assert.equal(f.sent.at(-1).delta.set.sessions.s1.latest_report.body_excerpt.text,'铅笔画好了')
  const done=f.sent.length;f.notify();f.notify();assert.equal(f.sent.length,done)
  // Follow-up on the same ticket is a new run, not a duplicate completion.
  run='r2';finished=false;view.sessions.s1.state='running';view.sessions.s1.run_count=2
  f.notify();assert.equal(f.sent.length,done)
  events.push({sequence:3,message_id:'old',purpose:'result',task_id:'t1',run_id:'r1',status:'completed',text:'旧轮次'})
  f.notify();c.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:3})
  assert.equal(c.overview.sessions.s1.run_count,1)
  events.push({sequence:4,message_id:'a2',purpose:'acknowledgement',task_id:'t1',run_id:'r2',text:'改成绿色'})
  f.notify();c.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:4})
  assert.equal(c.overview.sessions.s1.run_count,2)
  assert.equal(c.overview.sessions.s1.state,'running')
  view.sessions.s1.state='failed';f.notify();assert.equal(c.overview.sessions.s1.state,'running')
  events.push({sequence:5,message_id:'f2',purpose:'result',task_id:'t1',run_id:'r2',status:'failed',text:'写入失败'})
  f.notify();c.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:5})
  assert.equal(c.overview.sessions.s1.state,'failed')
  c.close()
})
test('action receipt is delivery only, overview refresh does not become speech',async()=>{
  const f=fixture();await f.connection.prepare('w1');f.connection.offer(offer)
  assert.equal(f.connection.handle({type:'duet.agent.request',protocol:AGENT_PROTOCOL,request_id:'r1',message:{text:'hello'}}),true)
  assert.deepEqual(f.sent.at(-1).body,{received:true,request_id:'r1'})
  assert.equal(f.sent.filter(e=>e.type==='duet.agent.state').length,0)
  f.connection.close()
})

test('one task notification never releases a different task completion',async()=>{
  const f=fixture(),c=f.connection
  const view={sessions:{
    s1:{latest_task_id:'t1',state:'running',run_count:1},
    s2:{latest_task_id:'t2',state:'running',run_count:1},
  },session_order:['s1','s2']}
  let events=[]
  f.source.overview=()=>structuredClone(view)
  f.source.taskRows=()=>[{task_id:'t1',run_id:'r1'},{task_id:'t2',run_id:'r2'}]
  f.source.events=after=>{const pending=events.filter(e=>e.sequence>after);return {events:pending,cursor:pending.at(-1)?.sequence??after}}
  await c.prepare('w');c.offer(offer)
  view.sessions.s1.state='completed';view.sessions.s2.state='completed';f.notify()
  assert.equal(f.sent.length,0)
  events.push({sequence:1,message_id:'m1',task_id:'t1',run_id:'r1',purpose:'result',status:'completed',text:'封面好了'})
  f.notify();c.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:1})
  assert.equal(c.overview.sessions.s1.state,'completed')
  assert.equal(c.overview.sessions.s2.state,'running')
  events.push({sequence:2,message_id:'m2',task_id:'t2',run_id:'r2',purpose:'result',status:'completed',text:'铅笔好了'})
  f.notify();c.handle({type:'duet.agent.ack',protocol:AGENT_PROTOCOL,cursor:2})
  assert.equal(c.overview.sessions.s2.state,'completed')
  assert.equal(f.sent.filter(e=>e.type==='duet.agent.events').length,2)
  c.close()
})
test('overview delta changes only touched fields, preserves nulls and escapes removal paths',()=>{
  assert.deepEqual(overviewDelta({sessions:{s1:{state:'running',old:1}},'a/b':1,order:['s1']},
    {sessions:{s1:{state:'waiting',report:null}},order:['s2','s1']}),
    {set:{sessions:{s1:{state:'waiting',report:null}},order:['s2','s1']},unset:['/a~1b','/sessions/s1/old']})
})

test('rejects model-selected task IDs before delivery but accepts explicit question replies',async()=>{
  const f=fixture();await f.connection.prepare('w1');f.connection.offer(offer)
  const received=[]
  f.source.receive=body=>{received.push(body);return {received:true,request_id:body.request_id}}
  f.connection.handle({type:'duet.agent.request',protocol:AGENT_PROTOCOL,request_id:'bad',message:{text:'停止那个任务',task_id:'t1'}})
  assert.equal(f.sent.at(-1).status,400)
  assert.equal(f.sent.at(-1).body.error_code,'invalid_agent_message')
  assert.equal(received.length,0)
  f.connection.handle({type:'duet.agent.request',protocol:AGENT_PROTOCOL,request_id:'good',message:{text:'用第二个方案',reply_to:'q1'}})
  assert.deepEqual(received[0].message,{text:'用第二个方案',reply_to:'q1'})
  assert.equal(f.sent.at(-1).status,200)
  f.connection.close()
})

test('reports delivery failures without closing the connection, leaking details or resubmitting',async()=>{
  const f=fixture();await f.connection.prepare('w1');f.connection.offer(offer)
  let calls=0
  f.source.receive=()=>{calls++;throw Error('question_not_pending')}
  const request={type:'duet.agent.request',protocol:AGENT_PROTOCOL,request_id:'same-id',message:{text:'同意',reply_to:'q1'}}
  f.connection.handle(request)
  assert.equal(f.sent.at(-1).status,400)
  assert.equal(f.sent.at(-1).body.error_code,'question_not_pending')
  f.source.overview=()=>{throw Error('storage unavailable too')}
  f.source.receive=()=>{calls++;throw Error('private/path database error')}
  f.connection.handle(request)
  assert.equal(f.sent.at(-1).request_id,'same-id')
  assert.equal(f.sent.at(-1).status,503)
  assert.deepEqual(f.sent.at(-1).body,{error_code:'agent_delivery_unconfirmed'})
  assert.equal(f.closed(),0)
  assert.equal(calls,2)
  f.source.receive=()=>({received:false})
  f.connection.handle(request)
  assert.equal(f.sent.at(-1).status,503)
  f.connection.close()
})
