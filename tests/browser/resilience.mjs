/** Integration fixture: every request and audio device is fake; no user sessions. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  const context=await browser.newContext({viewport:{width:800,height:600}})
  let configHang=false,pollFail=false,configRequests=0,pollRequests=0
  await context.route('http://127.0.0.1:19361/**',async route=>{
    const path=new URL(route.request().url()).pathname
    if(path==='/duet/assets/client/audio.mjs')return route.fulfill({contentType:'text/javascript',body:'export class DuetAudio {prepare(){return Promise.resolve()}startMic(send,failed){window.captureFailed=failed;return Promise.resolve()}stop(){}event(){}progress(){}playing(){return false}connectedChime(){}}'})
    if(path.endsWith('.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/'+path.replace('/duet/assets/',''),import.meta.url),'utf8')})
    if(path.includes('/api/')){
      if(path.endsWith('/voice/config')){configRequests++;if(configHang)return}
      if(path.endsWith('/sessions')){pollRequests++;if(pollFail)return route.fulfill({status:503,json:{}})}
      const body=path.endsWith('/sessions')?{sessions:[]}:path.endsWith('/results')?{current_cursor:0,next_cursor:0,results:[]}:path.endsWith('/health')?{focus_epoch:'fixture'}:{}
      return route.fulfill({json:body})
    }
    return route.fulfill({contentType:'text/html',body:`<div id="sidebar" style="position:absolute;bottom:20px;left:0;width:80px;overflow:hidden;transform:translateZ(0)"><span id="dsh-duet-entry"></span></div><script type="module">
      localStorage.setItem('dsh-duplex-tutorial-v1','dismissed');localStorage.setItem('dsh-duet.data-upload-consent.v3','accepted');
      window.hasWorkspace=true;window.ws=[];window.listeners=[];
      class WS extends EventTarget {static OPEN=1;static CLOSED=3;static CLOSING=2;readyState=1;bufferedAmount=0;constructor(){super();ws.push(this);setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'session.created'})})},0)}send(){}close(){this.readyState=3;this.dispatchEvent(new Event('close'));this.onclose?.({code:1000,reason:'',was_clean:true})}};window.WebSocket=WS;
      const ctx={sessions:{list:{getSnapshot:()=>({current:null,byId:{}}),subscribe:f=>{listeners.push(f);return()=>listeners.splice(listeners.indexOf(f),1)}},scope:()=>null},workspaces:{list:{getSnapshot:()=>({phase:'ready',items:hasWorkspace?[{id:'fixture'}]:[]})}},uiSession:{pendingInteractions:{getSnapshot:()=>new Map()}},conversation:{}};
      const {mountDuet}=await import('/duet/assets/client/browser.mjs');window.dispose=mountDuet(ctx);
    </script>`})
  })
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.clock.install();await page.goto('http://127.0.0.1:19361/');await page.locator('[data-voice=speaker]').waitFor()
  const mode=()=>page.locator('#dsh-duet-controls').getAttribute('data-mode')
  const step=async ms=>{await page.clock.runFor(ms);await page.waitForTimeout(30)}
  await page.evaluate(()=>{hasWorkspace=false});await page.locator('[data-voice=speaker]').click()
  const notice=page.locator('[data-duet-notice]');assert.match(await notice.innerText(),/创建 workspace/)
  assert.equal(await notice.evaluate(e=>e.parentElement===document.body),true)
  const box=await notice.boundingBox();assert.ok(box.x>=12&&box.x+box.width<=788&&box.y>=12&&box.y+box.height<=588)
  await page.evaluate(()=>{hasWorkspace=true})
  const beforeIdle=pollRequests;for(let i=0;i<10;i++)await step(1000)
  assert.ok(pollRequests-beforeIdle<=3,'off mode should poll at most every 5 seconds')
  const beforeEvent=pollRequests;await page.evaluate(()=>listeners.forEach(f=>f()));await step(1000);await step(1000)
  assert.ok(pollRequests>beforeEvent,'DSH state change should wake polling')
  configHang=true;await page.locator('[data-voice=speaker]').click()
  while(configRequests<1)await page.waitForTimeout(10)
  await page.locator('[data-voice=speaker]').click();configHang=false
  await page.locator('[data-voice=speaker]').click();await step(100)
  await page.waitForFunction(()=>document.querySelector('[data-voice=speaker]').getAttribute('aria-busy')==='false')
  assert.equal(await mode(),'tts_only','cancelled fetch must not keep the voice lock')
  pollFail=true;await step(1100);assert.equal(await mode(),'tts_only','one 503 must not close voice')
  pollFail=false;await step(1100);assert.equal(await mode(),'tts_only')
  pollFail=true;for(let i=0;i<18;i++)await step(1000)
  assert.equal(await mode(),'off','sustained sync failure must terminate safely');pollFail=false
  configHang=true;await page.locator('[data-voice=speaker]').click();await step(11000)
  await page.waitForFunction(()=>document.querySelector('#dsh-duet-controls').dataset.mode==='off')
  assert.match(await notice.innerText(),/连接超时/);configHang=false
  await page.locator('[data-voice=mic]').click();await step(100)
  await page.waitForFunction(()=>Boolean(window.captureFailed))
  assert.equal(await mode(),'online')
  await page.evaluate(()=>captureFailed('microphone_disconnected'))
  assert.equal(await mode(),'off');assert.match(await notice.innerText(),/麦克风已断开/)
  await page.evaluate(()=>dispose());assert.equal(await notice.count(),0)
  assert.deepEqual(errors,[])
  console.log('Resilience: cancelled startup, timeout, poll retry/recovery/failure, idle polling, event wake, capture fault, unclipped notices passed')
}finally{await browser.close()}
