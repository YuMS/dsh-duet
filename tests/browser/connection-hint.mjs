import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 360 } })
  await page.route('http://127.0.0.1:19359/**', async route => {
    const path = new URL(route.request().url()).pathname
    if(path.endsWith('/work-mode.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/shared/work-mode.mjs',import.meta.url),'utf8')})
    if(path.includes('connection-guidance.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/shared/connection-guidance.mjs',import.meta.url),'utf8')})
    if (path.endsWith('.mjs')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../src/client/'+(path==='/layout.mjs'?'controls-layout':'connection-hint')+'.mjs', import.meta.url), 'utf8') })
    return route.fulfill({ contentType: 'text/html', body: '<div id="sidebar" style="position:absolute;bottom:30px;left:16px;width:200px;overflow:hidden;transform:translateZ(0)"><div id="controls" style="display:flex;align-items:center;gap:4px"><span id="dsh-duet-entry">duet.</span><button data-voice="mic">交互</button><button data-voice="speaker">播报</button></div></div><script type="module">import {mountConnectionHint} from "/hint.mjs"; import {mountControlsLayout} from "/layout.mjs"; window.hint=mountConnectionHint(document.querySelector("#controls"));window.stopLayout=mountControlsLayout(document.querySelector("#controls"));</script>' })
  })
  await page.goto('http://127.0.0.1:19359/')
  await page.clock.install()
  const hint = page.locator('[data-duet-connection-hint]')
  await page.evaluate(()=>{window.hint.dispose();window.shown=[];import('/hint.mjs').then(({mountConnectionHint})=>{
    window.settingsOpened=0
    window.hint=mountConnectionHint(document.querySelector('#controls'),{onShown:value=>window.shown.push(value),onSettings:()=>window.settingsOpened++})
    window.hintReady=true
  })})
  await page.waitForFunction(()=>window.hintReady)
  const update = (mode, ready, teaching = false) => page.evaluate(s => window.hint.update(s), { mode, ready, teaching })
  await update('online', false); assert.equal(await hint.isVisible(), false)
  await update('tts_only', true); assert.equal(await hint.isVisible(), false)
  await update('online', true); assert.equal(await hint.isVisible(), true)
  assert.equal(await hint.innerText(), '连接成功，可以试试对我说“你好”。')
  assert.equal(await page.evaluate(()=>window.shown.length),1)
  const box = await hint.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 480)
  assert.equal(await hint.evaluate(e=>e.parentElement===document.body),true)
  assert.equal(await page.locator('#controls').getAttribute('data-compact'),'false')
  await page.evaluate(()=>{document.querySelector('#sidebar').style.width='64px'})
  await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='true')
  assert.equal(await page.locator('[data-voice=mic]').isVisible(),false)
  assert.equal(await page.locator('#dsh-duet-entry').innerText(),'d')
  await page.locator('#dsh-duet-entry').hover()
  const mic=await page.locator('[data-voice=mic]').boundingBox(),speaker=await page.locator('[data-voice=speaker]').boundingBox()
  assert.ok(speaker.x>=mic.x+mic.width);assert.ok(Math.abs(mic.y-speaker.y)<2)
  assert.equal(await page.locator('#dsh-duet-entry').isVisible(),true)
  await page.evaluate(()=>{document.querySelector('#sidebar').style.width='220px'})
  await page.waitForFunction(()=>document.querySelector('#controls').dataset.compact==='false')
  assert.equal(await page.locator('#dsh-duet-entry').isVisible(),true)
  await page.evaluate(()=>{const sidebar=document.querySelector('#sidebar');sidebar.style.left='400px';window.dispatchEvent(new Event('resize'))})
  const edge=await hint.boundingBox();assert.ok(edge.x+edge.width<=480-16)
  await page.clock.fastForward(8001); assert.equal(await hint.isVisible(), false)
  await update('online', true); assert.equal(await hint.isVisible(), false)
  await update('off', false); await update('online', true)
  assert.equal(await hint.isVisible(), true)
  await page.keyboard.press('Escape'); assert.equal(await hint.isVisible(), false)
  await update('off', false); await update('online', true, true)
  assert.equal(await hint.isVisible(), false)
  await update('off', false); await update('online', true)
  await update('tts_only', true); assert.equal(await hint.isVisible(), false)
  const shownBefore=await page.evaluate(()=>window.shown.length)
  await update('off',false)
  await page.evaluate(()=>window.hint.update({mode:'online',ready:true,guidance:{source:'router',text:'可以试试说“输入今天的计划”。',revision:7}}))
  assert.equal(await hint.innerText(),'可以试试说“输入今天的计划”。')
  assert.deepEqual(await page.evaluate(()=>window.shown.at(-1)),{source:'router',text:'可以试试说“输入今天的计划”。',revision:7})
  assert.equal(await hint.locator('span').count(),1)
  await page.evaluate(()=>window.hint.update({mode:'online',ready:true,guidance:{source:'router',text:'不应重复弹出',revision:8}}))
  assert.equal(await page.evaluate(()=>window.shown.length),shownBefore+1)
  await update('off',false)
  await page.evaluate(()=>window.hint.update({mode:'online',ready:true,guidance:{source:'router',text:'<img src=x onerror=alert(1)>',revision:9}}))
  assert.equal(await hint.innerText(),'连接成功，可以试试对我说“你好”。')
  assert.equal(await hint.locator('img').count(),0)
  // Only successful agent interaction entries count; repeated draws do not.
  for(const state of [{mode:'online',ready:false},{mode:'tts_only',ready:true}]){
    await page.evaluate(s=>window.hint.update({...s,workMode:'agent',connectionId:'not-counted'}),state)
  }
  assert.equal(await page.evaluate(()=>localStorage.getItem('dsh.duet.agent-entry-reminders.v1')),null)
  for(let n=1;n<=11;n++){
    await update('off',false)
    const state={mode:'online',ready:true,workMode:'agent',connectionId:'agent-'+n}
    await page.evaluate(s=>window.hint.update(s),state)
    assert.equal(await hint.locator('[data-duet-agent-reminder]').isVisible(),n<=10)
    assert.equal(await hint.getByRole('button',{name:'我知道了',exact:true}).isVisible(),true,'dismiss remains available after the reminder limit')
    assert.equal(await hint.getByRole('button',{name:'打开设置',exact:true}).isVisible(),n<=10)
    if(n<=10){
      assert.equal(await hint.locator('strong').innerText(),'只能')
      assert.match(await hint.innerText(),/全新工作区和会话/)
      await page.evaluate(s=>window.hint.update(s),state)
      assert.equal(await page.evaluate(()=>localStorage.getItem('dsh.duet.agent-entry-reminders.v1')),String(n))
      if(n===1){
        assert.equal(await hint.evaluate(e=>getComputedStyle(e).pointerEvents),'auto')
        assert.equal(await hint.evaluate(e=>getComputedStyle(e).userSelect),'text')
        await hint.locator('strong').dblclick()
        assert.match(await page.evaluate(()=>window.getSelection().toString()),/只|能/)
        assert.equal(await hint.isVisible(),true)
        await hint.getByRole('button',{name:'打开设置',exact:true}).click()
        assert.equal(await page.evaluate(()=>window.settingsOpened),1)
        assert.equal(await hint.isVisible(),false)
      }
      if(n===2){
        await hint.getByRole('button',{name:'我知道了',exact:true}).click()
        assert.equal(await hint.isVisible(),false)
        assert.equal(await page.evaluate(()=>window.settingsOpened),1)
        await page.evaluate(s=>window.hint.update(s),state)
        assert.equal(await hint.isVisible(),false)
      }
    }
  }
  await page.reload();await page.waitForFunction(()=>!!window.hint)
  await page.evaluate(()=>window.hint.update({mode:'online',ready:true,workMode:'agent',connectionId:'after-reload'}))
  assert.equal(await hint.locator('[data-duet-agent-reminder]').isVisible(),false)
  await page.evaluate(() => {window.hint.dispose();window.stopLayout()}); assert.equal(await hint.count(), 0)
  console.log('Connection hint: ready-only, online-only, once per connection, timeout, escape, mode switch, teaching suppression, disposal passed')
} finally { await browser.close() }
