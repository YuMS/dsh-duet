/** First-upgrade choice with mocked authenticated config; never starts audio or tasks. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  const page=await browser.newPage({viewport:{width:360,height:740}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  let created=0
  const config={revision:0,backend_url:'wss://fixture.test/ws',work_mode:'direct',work_mode_choice_version:0,agent_permission_version:0}
  await page.route('http://localhost:19371/**',async route=>{
    const path=new URL(route.request().url()).pathname
    if(path.endsWith('.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/'+path.replace('/duet/assets/',''),import.meta.url),'utf8')})
    if(path.endsWith('/voice/work-options'))return route.fulfill({json:{dedicated_workspace_id:created?'dedicated':null,workspaces:[{id:'existing',name:'项目'},...(created?[{id:'dedicated',name:'dsh-duet'}]:[])],models:{groups:[]}}})
    if(path.endsWith('/voice/dedicated-workspace')){
      assert.equal(route.request().method(),'POST')
      assert.match(route.request().headers()['content-type'],/application\/json/)
      created++
      return route.fulfill({json:{id:'dedicated',name:'dsh-duet'}})
    }
    if(path.endsWith('/voice/config')) {
      if(route.request().method()==='PUT'){
        const input=route.request().postDataJSON()
        if(input.work_mode==='agent'){
          assert.ok(['existing','dedicated'].includes(input.agent_options.workspace_id))
          assert.equal(input.agent_permission,true)
        }else assert.equal(input.work_mode,'direct')
        Object.assign(config,input,{revision:config.revision+1,work_mode_choice_version:1,agent_permission_version:input.agent_permission?1:0})
      }
      return route.fulfill({json:config})
    }
    return route.fulfill({contentType:'text/html',body:`<script type="module">
      import {workModeOnboarding} from '/duet/assets/client/work-mode.mjs';
      window.unlocked=0;window.guide=workModeOnboarding(()=>unlocked++);window.ready=await guide.ready({passive:true});
    </script>`})
  })
  await page.goto('http://localhost:19371/')
  const panel=page.getByRole('region',{name:'dsh-duet 工作方式'})
  const confirm=panel.getByRole('button',{name:'确定',exact:true})
  await panel.waitFor()
  assert.match(await panel.locator('[data-work-mode=direct]').innerText(),/输入模式（传统）/)
  assert.match(await panel.locator('[data-work-mode=agent]').innerText(),/代理模式只能在全新工作区和会话中使用/)
  assert.equal(await panel.locator('[data-work-mode=agent] b').innerText(),'只能')
  assert.equal(await panel.locator('[aria-pressed=true]').count(),0)
  assert.equal(await confirm.isDisabled(),true)
  await panel.getByRole('button',{name:'稍后选择'}).click()
  assert.equal(config.work_mode_choice_version,0)
  await page.reload()
  await page.waitForFunction(()=>window.ready===false)
  assert.equal(await panel.count(),0)
  assert.equal(await page.evaluate(()=>unlocked),0)
  await page.evaluate(()=>guide.ready())
  await panel.locator('[data-work-mode=agent]').click()
  await panel.getByRole('button',{name:'创建 dsh-duet 专属工作区'}).waitFor()
  assert.equal(await panel.locator('[data-work-mode=agent]').getAttribute('aria-pressed'),'true')
  assert.equal(await confirm.isDisabled(),true)
  assert.equal(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth),true)
  assert.equal(config.work_mode_choice_version,0)
  await panel.getByRole('button',{name:'创建 dsh-duet 专属工作区'}).click()
  await panel.locator('[data-work-mode=direct]').click()
  assert.equal(await panel.locator('[data-work-mode=direct]').getAttribute('aria-pressed'),'true')
  assert.equal(config.work_mode_choice_version,0)
  await confirm.click()
  await panel.waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>guide.ready()),true)
  await page.reload()
  await page.waitForFunction(()=>window.ready===true)
  assert.equal(await panel.count(),0)
  assert.equal(created,0)
  Object.assign(config,{work_mode_choice_version:0})
  await page.evaluate(()=>sessionStorage.clear())
  await page.reload()
  await panel.locator('[data-work-mode=agent]').click()
  await panel.getByRole('button',{name:'创建 dsh-duet 专属工作区'}).click()
  assert.equal(await panel.getByRole('button',{name:'创建 dsh-duet 专属工作区'}).getAttribute('aria-pressed'),'true')
  assert.equal(created,0)
  assert.equal(config.work_mode_choice_version,0)
  await confirm.click()
  await panel.waitFor({state:'detached'})
  assert.equal(config.agent_options.workspace_id,'dedicated')
  assert.equal(created,1)
  Object.assign(config,{work_mode_choice_version:0,agent_permission_version:0,agent_options:{}})
  await page.reload()
  await panel.locator('[data-work-mode=agent]').click()
  await panel.getByRole('button',{name:'使用 dsh-duet 专属工作区'}).click()
  assert.equal(await panel.getByRole('button',{name:'创建 dsh-duet 专属工作区'}).count(),0)
  await panel.getByLabel('工作区',{exact:true}).selectOption('existing')
  assert.equal(await panel.getByRole('button',{name:'使用 dsh-duet 专属工作区'}).getAttribute('aria-pressed'),'false')
  assert.equal(config.work_mode_choice_version,0)
  await confirm.click()
  await panel.waitFor({state:'detached'})
  assert.equal(config.agent_options.workspace_id,'existing')
  assert.equal(created,1)
  await page.evaluate(async()=>{
    const box=document.createElement('div');box.id='settings';document.body.append(box)
    await (await import('/duet/assets/client/work-mode.mjs')).mountWorkMode(box)
  })
  const auto=page.getByRole('switch',{name:'自动跳转会话'})
  assert.equal(await auto.getAttribute('aria-checked'),'true')
  await auto.click()
  await page.waitForFunction(()=>{const el=document.querySelector('[role=switch]');return el?.getAttribute('aria-checked')==='false'&&!el.disabled})
  assert.equal(config.agent_options.auto_switch_session,false)
  await page.reload()
  await page.evaluate(async()=>{
    const box=document.createElement('div');box.id='settings';document.body.append(box)
    await (await import('/duet/assets/client/work-mode.mjs')).mountWorkMode(box)
  })
  assert.equal(await auto.getAttribute('aria-checked'),'false','choice persists across settings reload')
  await auto.click()
  await page.waitForFunction(()=>{const el=document.querySelector('[role=switch]');return el?.getAttribute('aria-checked')==='true'&&!el.disabled})
  assert.equal(config.agent_options.auto_switch_session,true)
  for(const rule of ['default_direct','direct_only']){
    Object.assign(config,{work_mode:'direct',work_mode_choice_version:1,agent_permission_version:0,work_mode_policy:rule})
    await page.reload();await page.waitForFunction(()=>window.ready===true)
    assert.equal(await panel.count(),0)
    await page.evaluate(async()=>{
      const box=document.createElement('div');document.body.append(box)
      await (await import('/duet/assets/client/work-mode.mjs')).mountWorkMode(box)
    })
    assert.equal(await page.locator('[data-work-mode=agent]').count(),rule==='direct_only'?0:1)
    assert.equal(await page.locator('.choice .badge').count(),0)
  }
  assert.deepEqual(errors,[])
  console.log('Work mode: mandatory upgrade choice, defer, no workspace agent refusal, Ungrouped direct, persisted selection passed')
} finally {await browser.close()}
