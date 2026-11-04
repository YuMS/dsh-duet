import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('http://effect.test/**',async route=>{
  if(route.request().url().endsWith('.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/client/input-effect.mjs',import.meta.url),'utf8')})
  return route.fulfill({contentType:'text/html',body:`<div id="anchor" style="position:fixed;left:30px;top:500px;width:200px;height:100px"></div><textarea id="search" style="position:fixed;top:20px"></textarea><div data-composer-input contenteditable="true" role="textbox" style="position:fixed;left:400px;top:650px;width:400px;height:100px;border:1px solid"></div><script type="module">import{mountInputEffect}from'/effect.mjs';window.focusId='one';window.fx=mountInputEffect({anchor:()=>document.querySelector('#anchor'),isCurrent:id=>id===focusId});</script>`})
 })
 await page.goto('http://effect.test/');await page.waitForFunction(()=>window.fx)
 await page.evaluate(()=>fx.show('<img src=x onerror=alert(1)>输入测试','one'))
 const bubble=page.locator('[data-duet-input-effect]')
 assert.equal(await bubble.locator('img').count(),0)
 assert.equal(await bubble.locator('[data-duet-input-text]').textContent(),'<img src=x onerror=alert(1)>输入测试')
 assert.equal(await bubble.locator('svg').count(),1)
 const before=await bubble.boundingBox()
 await page.waitForFunction(()=>document.querySelector('[data-duet-input-effect]')?.dataset.phase==='flying')
 const flight=await bubble.evaluate(el=>el.getAnimations()[0].effect.getKeyframes().at(-1).transform)
 const to=await page.locator('[data-composer-input]').boundingBox()
 assert.ok(flight.includes(String(to.x+to.width/2-before.x-before.width/2)),flight)
 await bubble.waitFor({state:'detached'})
 await page.evaluate(()=>{fx.show('旧内容','one');fx.show('新内容','one')})
 assert.equal(await bubble.count(),1);assert.equal(await bubble.locator('[data-duet-input-text]').textContent(),'新内容')
 await page.evaluate(()=>focusId='two');await bubble.waitFor({state:'detached'})
 await page.evaluate(()=>fx.show('其他会话','one'));assert.equal(await bubble.count(),0)
 await page.evaluate(()=>{focusId='one';document.querySelector('[data-composer-input]').remove();fx.show('没有目标时淡出','one')})
 await page.waitForFunction(()=>document.querySelector('[data-duet-input-effect]')?.dataset.phase==='fading')
 await bubble.waitFor({state:'detached'})
 await page.evaluate(()=>{fx.show('','one')});assert.equal(await bubble.count(),0)
 await page.evaluate(()=>{fx.show('退出清理','one');fx.dispose()});assert.equal(await bubble.count(),0)
 await page.evaluate(()=>fx.show('已销毁','one'));assert.equal(await bubble.count(),0)
 assert.deepEqual(errors,[])
 console.log('Input effect: safe text, keyboard, composer-directed flight, replacement, focus fencing, no-target fade and disposal passed')
}finally{await browser.close()}
