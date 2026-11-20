/** Exercise official keyed-tool views with synthetic DSH state; no tasks or audio. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
  const page=await browser.newPage({viewport:{width:800,height:600}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('http://localhost:19378/**',async route=>{
    const path=new URL(route.request().url()).pathname
    if(path==='/react.js'||path==='/react-dom.js'){
      const file=path==='/react.js'?'react/umd/react.development.js':'react-dom/umd/react-dom.development.js'
      return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../vendor/dsh-duet-superagent/node_modules/'+file,import.meta.url),'utf8')})
    }
    if(path.endsWith('.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/'+path.replace('/duet/assets/',''),import.meta.url),'utf8')})
    return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><div id="cards"></div><div id="chat"></div>
      <script src="/react.js"></script><script src="/react-dom.js"></script><script type="module">
      import {mountAgentToolViews} from '/duet/assets/client/agent-tool-views.mjs';
      const id='a'.repeat(32),next='b'.repeat(32),views={},roots=[];
      window.opened=[];window.scrolled=[];window.removed=[];window.inspectCount=0;
      const snap={current:'main',byId:{['worker-'+id]:{title:'画鹈鹕'},['worker-'+next]:{title:'灵感笔记'}}};
      const ctx={sessions:{refresh:async()=>{},list:{getSnapshot:()=>snap}},uiWorkspace:{openSession(target){snap.current=target;opened.push(target)}},
        slots:{inject(name,fn){return fn()},register({name,key,id},Card){views[key||id]=Card;return ()=>removed.push(key||id)}}};
      Element.prototype.scrollIntoView=function(){scrolled.push(this.id)};
      window.dispose=mountAgentToolViews(ctx,React);
      const block=(args,result,time=200)=>({kind:'tool-result',call:{argsRaw:JSON.stringify(args)},content:[{type:'text',text:JSON.stringify(result)}],time,callTime:time-1});
      function render(name,args,result,time=200,parent=document.querySelector('#cards')){
        const node=document.createElement('div');parent.append(node);const root=ReactDOM.createRoot(node);roots.push(root);
        root.render(React.createElement(views[name],{toolName:name,block:block(args,result,time),inspect:()=>inspectCount++}));
      }
      render('orchestrator_route',{}, {results:[{kind:'accept',decision:'accept',ticket:{ticket_id:id,title:'画鹈鹕',state:'working/queued'}},{ticket:{ticket_id:next,title:'灵感笔记',state:'person/answer'}}]});
      render('orchestrator_reply',{ticket_id:id,purpose:'result',text:'画好了。'},{status:'sent'});
      window.drawReports=()=>{
        document.querySelector('#chat').innerHTML='<div data-chat-turn="old" id="report-old"></div><div data-chat-turn="old" data-chat-flow-kind="assistant" id="final-old">完整结果</div><div data-chat-turn="new" id="report-new"></div><div data-chat-turn="new" data-chat-flow-kind="assistant" id="final-new">更新后的结果</div>';
        render('orchestrator_report',{state:'ready',summary:'简短报告'},{reported:true},150,document.querySelector('#report-old'));
        render('orchestrator_report',{state:'ready',summary:'后来的报告'},{reported:true},250,document.querySelector('#report-new'));
      };
      window.clearReports=()=>{document.querySelector('#chat').innerHTML=''};
      window.changeFocus=()=>{snap.current='manual'};
      window.addMissing=()=>render('orchestrator_reply',{ticket_id:'c'.repeat(32),purpose:'result',text:'不会新建任务'},{status:'sent'});
      window.renderTail=()=>{
        document.querySelector('#cards').hidden=true;
        const nodes=new Map([['route',{kind:'tool-call',data:{root:{...block({}, {results:[{ticket:{ticket_id:id,title:'画鹈鹕'}}]}),call:{name:'orchestrator_route',argsRaw:'{}'}}}}],['reply',{kind:'tool-call',data:{root:{...block({ticket_id:id,purpose:'result'}, {status:'sent'}),call:{name:'orchestrator_reply',argsRaw:JSON.stringify({ticket_id:id,purpose:'result'})}}}}]]);
        const node=document.createElement('div');node.id='turn-tail';document.body.append(node);const root=ReactDOM.createRoot(node);roots.push(root);
        root.render(React.createElement(views['dsh-duet-task-links'],{turn:{turn:1},useChat:fn=>fn({locations:{getTurn:()=>['route','reply']},nodes})}));
      };
      window.cleanup=()=>{roots.forEach(r=>r.unmount());dispose()};
      window.ready=true;
      </script>`})
  })
  await page.goto('http://localhost:19378/')
  await page.getByRole('button',{name:'打开会话',exact:true}).first().waitFor()
  assert.equal(await page.getByRole('button',{name:'打开会话',exact:true}).count(),2)
  assert.equal(await page.locator('.duet-task-link button').count(),0,'no nested buttons')
  assert.equal(await page.locator('[data-duet-task-tone=running] .task-status').innerText(),'开始执行')
  assert.equal(await page.locator('[data-duet-task-tone=running] .task-icon svg').getAttribute('data-heroicon'),'rocket-launch')
  assert.equal(await page.locator('[data-duet-task-tone=waiting] .task-icon svg').getAttribute('data-heroicon'),'question-mark-circle')
  assert.equal(await page.locator('[data-duet-task-tone=completed] .task-icon svg').getAttribute('data-heroicon'),'check-circle')
  assert.equal(await page.locator('.task-emoji').count(),0,'task icons use Heroicons rather than emoji')
  assert.equal(await page.locator('[data-duet-task-tone=waiting] .task-status').innerText(),'向你提问')
  assert.equal(await page.locator('[data-duet-task-tone=completed] .task-name').innerText(),'画鹈鹕')
  for(const width of [800,360]){
    await page.setViewportSize({width,height:600})
    assert.ok(await page.locator('.duet-task-link').first().evaluate(node=>{
      const card=node.getBoundingClientRect(),name=node.querySelector('.task-copy').getBoundingClientRect(),action=node.querySelector('.task-destination').getBoundingClientRect()
      return card.right<=innerWidth&&action.left>=name.right&&action.right<=card.right
    }))
  }
  await page.setViewportSize({width:800,height:600})
  await page.screenshot({path:'/tmp/duet-task-cards-preview.png'})
  await page.getByRole('button',{name:'打开会话',exact:true}).nth(1).click()
  assert.equal(await page.evaluate(()=>opened.at(-1)),'worker-'+'b'.repeat(32))
  await page.evaluate(()=>drawReports())
  await page.locator('[data-duet-report-time="150"]').waitFor()
  await page.locator('[data-duet-report-time="150"]').evaluate(node=>node.style.display='none')
  await page.getByRole('button',{name:'跳转到结果',exact:true}).click()
  await page.waitForFunction(()=>scrolled.includes('final-old'))
  assert.equal(await page.evaluate(()=>scrolled.includes('final-new')),false,'does not jump to a later run of the ticket')
  await page.getByText('调用详情',{exact:true}).first().click()
  await page.getByRole('button',{name:'查看调用记录',exact:true}).first().click()
  assert.equal(await page.evaluate(()=>inspectCount),1)
  await page.evaluate(()=>clearReports())
  await page.getByRole('button',{name:'跳转到结果',exact:true}).click()
  await page.getByRole('status').filter({hasText:'历史内容尚未加载'}).waitFor()
  await page.evaluate(()=>addMissing())
  await page.getByRole('button',{name:'跳转到结果',exact:true}).nth(1).click()
  await page.getByRole('status').filter({hasText:'暂时不可用'}).waitFor()
  assert.equal(await page.evaluate(()=>opened.some(x=>x.endsWith('c'.repeat(32)))),false)
  await page.evaluate(()=>renderTail())
  const tail=page.getByRole('navigation',{name:'任务快捷操作'})
  await tail.waitFor()
  assert.equal(await tail.getByRole('button',{name:'跳转到结果',exact:true}).count(),1,'folded tools still expose one result link per task')
  assert.match(await tail.innerText(),/画鹈鹕/)
  await tail.getByRole('button',{name:'跳转到结果',exact:true}).click()
  assert.equal(await page.evaluate(()=>opened.at(-1)),'worker-'+'a'.repeat(32))
  await page.evaluate(()=>cleanup())
  assert.equal(await page.locator('.duet-tool-card').count(),0)
  assert.equal(await page.evaluate(()=>removed.length),4)
  assert.deepEqual(errors,[])
  console.log('Agent tool views: keyed cards, manual navigation, matching result, missing history/session, inspection and cleanup passed')
}finally{await browser.close()}
