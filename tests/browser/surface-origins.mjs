/** Real mode handlers and asynchronous disconnect; fake media, DSH and voice server. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const browser=await chromium.launch({args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('http://127.0.0.1:19369/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path==='/duet/assets/client/audio.mjs')return route.fulfill({contentType:'text/javascript',body:`export const AUDIO_STOP_PROTOCOL='audio_stop_candidates_v1';export class DuetAudio{constructor(){this.context={state:'running'};window.testAudio=this}prepare(){this.context.state='running';return Promise.resolve()}startMic(){return Promise.resolve()}stop(){}event(){}progress(){}playing(){return false}connectedChime(){}}`})
  if(path==='/duet/assets/client/avatar.mjs')return route.fulfill({contentType:'text/javascript',body:`export function mountAvatar(options){window.avatarOptions=options;window.nativePanels=[];return {presentation:()=>({native:true}),surface:p=>{nativePanels.push(p);return true},event(){},syncToggle(){},dispose(){},cancelInput(){}}}`})
  if(path.endsWith('.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/'+path.replace('/duet/assets/',''),import.meta.url),'utf8')})
  if(path.includes('/api/'))return route.fulfill({json:path.endsWith('/sessions')?{sessions:[]}:path.endsWith('/results')?{current_cursor:0,next_cursor:0,results:[]}:path.endsWith('/health')?{focus_epoch:'fixture'}:{}})
  return route.fulfill({contentType:'text/html',body:`<div style="position:absolute;bottom:20px;left:20px;width:400px"><span id="dsh-duet-entry"></span></div><script type="module">
  localStorage.setItem('dsh-duplex-tutorial-v1','dismissed');localStorage.setItem('dsh-duet.data-upload-consent.v3','accepted');
  class WS extends EventTarget{static OPEN=1;readyState=1;bufferedAmount=0;constructor(){super();setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'session.created',feedback_session_ticket:'fake-feedback'})})},0)}send(){}close(){this.readyState=3;setTimeout(()=>{this.dispatchEvent(new Event('close'));this.onclose?.({code:1000,reason:'',was_clean:true})},25)}}window.WebSocket=WS;
  const ctx={sessions:{list:{getSnapshot:()=>({current:null,byId:{}}),subscribe:()=>()=>{}},scope:()=>null},workspaces:{list:{getSnapshot:()=>({phase:'ready',items:[{id:'test'}]})}},uiSession:{pendingInteractions:{getSnapshot:()=>new Map()}},conversation:{}};
  const {mountDuet}=await import('/duet/assets/client/browser.mjs');window.cleanup=mountDuet(ctx);
  </script>`})
 })
 await page.goto('http://127.0.0.1:19369/')
 await page.waitForFunction(()=>window.avatarOptions)
 for(const [mode,kind] of [['online','mic'],['tts_only','speaker']]){
  for(const origin of ['page','avatar']){
   const button=page.locator('[data-voice='+kind+']')
   // Start from the opposite surface; the stop action, not start, owns the rating.
   if(origin==='page')await page.evaluate(mode=>avatarOptions.requestMode(mode),mode)
   else await button.click()
   await page.waitForFunction(kind=>document.querySelector('[data-voice='+kind+']').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-voice='+kind+']').getAttribute('aria-busy')==='false',kind).catch(async error=>{console.error({mode,origin,errors,text:await page.locator('body').innerText()});throw error})
   if(origin==='page')await button.click();else await page.evaluate(mode=>avatarOptions.requestMode(mode),mode)
   const rating=page.locator('[aria-label="本次语音体验评分"]')
   await rating.waitFor({state:'attached'})
   assert.equal(await rating.getAttribute('data-duet-surface-origin'),origin)
   if(origin==='page'){
    assert.equal(await rating.getAttribute('data-duet-avatar-surface'),null,'page ratings cannot enter any avatar bridge')
    assert.equal(await rating.isVisible(),true)
    assert.equal(await rating.getAttribute('data-duet-surface-native'),null)
    await rating.getByRole('button',{name:'暂不评价'}).click()
   }else{
    await page.waitForFunction(()=>document.querySelector('[aria-label="本次语音体验评分"]').hasAttribute('data-duet-surface-native'))
    await page.evaluate(()=>{const p=nativePanels.at(-1).panel,b=p.nodes.find(n=>n.label==='暂不评价');avatarOptions.onSurfaceAction({type:'surface_action',id:p.id,revision:p.revision,action:b.action})})
   }
   await rating.waitFor({state:'detached'})
  }
 }
 await page.evaluate(()=>cleanup());assert.deepEqual(errors,[])
 console.log('Surface origins: online and broadcast ratings follow the stop origin across asynchronous disconnects')
}finally{await browser.close()}
