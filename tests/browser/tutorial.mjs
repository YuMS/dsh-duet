/** Browser fixture only: no real Harness/model actions. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
  const context=await browser.newContext({viewport:{width:1280,height:850}})
  await context.route('http://127.0.0.1:19198/**',async route=>{
    const path=new URL(route.request().url()).pathname
    if(/^\/tutorial-audio\/(modes_broadcast|modes_interaction|broadcast|input|edit|clear|reinput|send|switch)\.wav$/.test(path))return route.fulfill({contentType:'audio/wav',body:await readFile(new URL('../../assets'+path,import.meta.url))})
    if(path.endsWith('.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/'+path.replace('/duet/assets/',''),import.meta.url),'utf8')})
    return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head></head><body style="margin:0;background:#111923;color:white;font-family:system-ui"><aside style="width:220px;height:100vh;border-right:1px solid #445"><h2>DeepSeek Harness</h2><div data-slot="sidebar.sessions">教学会话</div><div id="dsh-duet-controls" style="position:fixed;bottom:30px;left:20px;width:170px;height:35px">duet <button data-voice="speaker">喇叭</button></div></aside><main style="position:absolute;left:270px;top:40px"><h2>对话</h2></main><div data-composer-input style="position:fixed;bottom:40px;left:270px;width:750px;min-height:55px;border:1px solid #678;padding:12px"></div><script type="module">
      import {mountTutorial} from '/duet/assets/client/tutorial.mjs';
      window.calls=[];let current='original',mode='off';const drafts=new Map();
      const adapter={mode:()=>mode,current:()=>current,unlock:async()=>{},
        create:async name=>{calls.push(['create',name]);const id='s'+drafts.size;drafts.set(id,'');return id},
        focus:async id=>{current=id;calls.push(['focus',id])},
        write:async(id,text,expected)=>{if(drafts.get(id)!==expected)throw Error('draft conflict');drafts.set(id,text);document.querySelector('[data-composer-input]').textContent=text;calls.push(['write',text])},
        submit:async(id,text)=>{drafts.set(id,'');calls.push(['submit',text]);return{id:'job'}},
        enableBroadcast:async()=>{mode='tts_only';calls.push(['mode',mode])},waitBroadcast:async()=>{},off:async()=>{mode='off';calls.push(['mode',mode])},
        narrate:async name=>{calls.push(['narrate',name]);await new Promise(r=>setTimeout(r,name.startsWith('modes_')?1000:80))},stopNarration:()=>calls.push(['stop_audio'])};
      window.tutorial=mountTutorial({controls:document.querySelector('#dsh-duet-controls'),adapter});
    </script></body></html>`})
  })
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:19198/')
  await page.evaluate(()=>{
    const controls=document.querySelector('#dsh-duet-controls')
    const mic=document.createElement('button');mic.dataset.voice='mic';controls.append(mic)
    const paths={mic:'M7.5 3.75 3 8.25m0 0 4.5 4.5M3 8.25h18m-4.5 3L21 15.75m0 0-4.5 4.5M21 15.75H3',speaker:'M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z'}
    for(const kind of ['mic','speaker'])controls.querySelector(`[data-voice="${kind}"]`).innerHTML=`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="${paths[kind]}"/></svg>`
  })
  const click=text=>page.getByRole('button',{name:text,exact:true}).click()
  await page.getByRole('heading',{name:'来试试用声音操作吧'}).waitFor()
  assert.deepEqual(await page.evaluate(()=>calls),[])
  assert.equal(await page.getByRole('dialog').count(),0)
  assert.equal(await page.getByRole('button',{name:'duet 使用教学'}).count(),0)
  assert.equal(await page.getByRole('button',{name:'开始教学'}).isDisabled(),true)
  await page.getByRole('checkbox').nth(0).check()
  assert.equal(await page.getByRole('button',{name:'开始教学'}).isDisabled(),true)
  assert.deepEqual(await page.evaluate(()=>calls),[])
  await page.getByRole('checkbox').nth(1).check();await click('开始教学')
  await page.getByRole('heading',{name:'喇叭 · 播报模式'}).waitFor()
  assert.equal(await page.locator('.duet-tutorial-highlight').getAttribute('data-target'),'[data-voice="speaker"]')
  assert.equal(await page.locator('.duet-tutorial-pointer').isVisible(),true)
  await page.screenshot({path:'/tmp/dsh-tutorial-speaker-intro.png'})
  await page.getByRole('heading',{name:'双向箭头 · 交互模式'}).waitFor()
  assert.equal(await page.locator('.duet-tutorial-highlight').getAttribute('data-target'),'[data-voice="mic"]')
  assert.equal(await page.locator('.duet-tutorial-pointer').isVisible(),true)
  // Broadcast -> input -> edit -> clear -> reinput -> send needs no extra clicks.
  await page.getByRole('heading',{name:'准备好了，就发出去吧'}).waitFor()
  assert.equal(await page.getByText('播报完成了吗？',{exact:true}).count(),0)
  assert.equal(await page.evaluate(()=>calls.filter(c=>c[0]==='submit').length),1)
  await click('确认发送');await page.getByRole('heading',{name:'现在您可以自己试试了'}).waitFor()
  assert.equal(await page.locator('.duet-tutorial button').count(),1)
  assert.equal(await page.locator('.duet-tutorial-mode svg').count(),2)
  const result=await page.evaluate(()=>calls)
  const edits=result.filter(c=>c[0]==='write').map(c=>c[1])
  assert.deepEqual(edits.slice(-3),['用一句简短的话介绍语音助手。','','用一句简短的话介绍语音助手。'])
  assert.equal(result.filter(c=>c[0]==='submit').length,2);assert.equal(result.some(c=>c[1]==='online'),false)
  await page.screenshot({path:'/tmp/dsh-tutorial-complete.png'})
  await click('完成');await page.reload();assert.equal(await page.locator('.duet-tutorial').count(),0)
  await page.goto('http://127.0.0.1:19198/?live_tutorial=1');await click('不再提醒');await page.reload()
  assert.equal(await page.locator('.duet-tutorial').count(),0)
  await page.goto('http://127.0.0.1:19198/?live_tutorial=1')
  await page.getByRole('checkbox').nth(0).check();await page.getByRole('checkbox').nth(1).check();await click('开始教学')
  await page.getByRole('heading',{name:'喇叭 · 播报模式'}).waitFor()
  await click('退出教学');assert.equal(await page.evaluate(()=>calls.filter(c=>c[0]==='submit').length),0)
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,tests:'consent, two modes, local narration, dismiss, reentry, cancel',page_errors:errors}))
  const decoded=await page.evaluate(async()=>{
    const ctx=new AudioContext(),durations={}
    try{for(const name of ['modes_broadcast','modes_interaction','broadcast','input','edit','clear','reinput','send','switch']){
      const response=await fetch('/tutorial-audio/'+name+'.wav')
      const audio=await ctx.decodeAudioData(await response.arrayBuffer());durations[name]=audio.duration
    }}finally{await ctx.close()}
    return durations
  })
  // decodeAudioData resamples to the browser device rate, rounding by one frame.
  const manifest=JSON.parse(await readFile(new URL('../../assets/tutorial-audio/manifest.json',import.meta.url),'utf8'))
  for(const [name,clip] of Object.entries(manifest.clips))assert(Math.abs(decoded[name]-clip.seconds)<0.0001)
  console.log(JSON.stringify({recorded_audio_decoded:decoded}))
  // Exiting during an automatic transition must not continue editing later.
  await page.evaluate(()=>tutorial.open())
  await page.getByRole('checkbox').nth(0).check();await page.getByRole('checkbox').nth(1).check();await click('开始教学')
  await page.getByRole('heading',{name:'想改哪里，直接告诉我'}).waitFor().catch(async e=>{console.log(await page.locator('.duet-tutorial').innerText());console.log(await page.evaluate(()=>calls));throw e})
  await click('退出教学')
  const stopped=await page.evaluate(()=>calls.length);await page.waitForTimeout(1600)
  assert.equal(await page.evaluate(()=>calls.length),stopped)
  console.log(JSON.stringify({cancel_auto_transition:true}))
}finally{await browser.close()}
