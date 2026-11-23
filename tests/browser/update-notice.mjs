import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
  const page=await browser.newPage({viewport:{width:400,height:600}})
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.route('http://fixture.test/**',async route=>{
    if(new URL(route.request().url()).pathname==='/notice.mjs')return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/client/notice.mjs',import.meta.url),'utf8')})
    return route.fulfill({contentType:'text/html',body:'<div style="position:fixed;bottom:20px;right:0;overflow:hidden;width:50px"><button id="anchor">duet</button></div><script type="module">import {mountNotice} from "/notice.mjs";window.notice=mountNotice(()=>document.querySelector("#anchor"))</script>'})
  })
  await page.goto('http://fixture.test/');await page.waitForFunction(()=>window.notice)
  await page.evaluate(()=>notice.show('当前版本可以继续使用',{upgrade:true,releaseNotes:'支持自定义音色\n<img src=x onerror=alert(1)>'}))
  const panel=page.locator('[data-duet-notice]')
  assert.match(await panel.innerText(),/更新内容/)
  assert.match(await panel.innerText(),/添加插件.*dsh-duet/)
  assert.match(await panel.innerText(),/卸载 duet/)
  assert.doesNotMatch(await panel.innerText(),/dsh plugin --profile/)
  assert.doesNotMatch(await panel.innerText(),/正常重装会保留|请勿清除/)
  assert.match(await panel.innerText(),/安装完成后，如果插件不可用，可能需要重启 DSH 哦/)
  assert.equal(await panel.locator('details').getAttribute('open'),'')
  assert.equal(await panel.locator('img').count(),0)
  assert.equal(await panel.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(239, 249, 255)')
  const check=async()=>{await page.waitForFunction(()=>{const b=document.querySelector('[data-duet-notice]').getBoundingClientRect();return b.x>=12&&b.y>=12&&b.right<=innerWidth-12&&b.bottom<=innerHeight-12})}
  await check();await panel.locator('summary').click();await check()
  await page.setViewportSize({width:280,height:320});await check()
  await panel.getByRole('button',{name:'知道了'}).click();assert.equal(await panel.isVisible(),false)
  await page.evaluate(()=>notice.show('请升级插件',{upgrade:true}))
  assert.equal(await panel.locator('[data-duet-release-notes]').count(),0)
  await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false)
  await page.evaluate(()=>notice.show('new',{upgrade:true,releaseNotes:'长'.repeat(2000)}))
  assert.equal((await panel.locator('[data-duet-release-notes]').innerText()).length,1000)
  await page.evaluate(()=>notice.show('推荐更新',{upgrade:true,currentVersion:'0.3.0',targetVersion:'0.3.3',releases:[
    {version:'0.3.3',notes:'支持 DSH 0.2.3\n<img src=x onerror=alert(1)>'},
    {version:'0.3.2',notes:'任务进度'}, {version:'0.3.1',notes:'其他更新'},
  ]}))
  assert.match(await panel.innerText(),/0.3.0 → 0.3.3/)
  assert.equal(await panel.locator('[data-duet-release-history] section').count(),3)
  assert.equal(await panel.locator('img').count(),0)
  await check()
  await panel.getByRole('button',{name:'知道了'}).click();assert.equal(await panel.isVisible(),false)
  await page.evaluate(()=>notice.dispose());assert.equal(await panel.count(),0)
  assert.deepEqual(errors,[])
  console.log('Update notice: safe notes, legacy fallback, shared styling, narrow viewport and dismissal passed')
}finally{await browser.close()}
