import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const settings=await readFile(new URL('../../src/client/settings.html',import.meta.url),'utf8')
const section=settings.match(/<section[^>]*>\s*<h2>音色[\s\S]*?<\/section>/)[0]
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
  const page=await browser.newPage(),errors=[],calls=[]
  let state={selected:'default',voices:[]},uploadStatus='queued',refreshStatus='ready',failRefresh=false,serial=0
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('http://localhost:19201/**',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname
    if(p==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8">'+section+'<script type="module">import {mountVoices} from "/client/voices.mjs";window.dispose=mountVoices(document.getElementById("duetVoices"));</script>'})
    if(p.endsWith('.mjs'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src'+p,import.meta.url),'utf8')})
    if(p.endsWith('/api/voices')){
      if(req.method()==='POST'){
        assert.equal(req.headers()['x-duplex-settings'],'1')
        const b=req.postDataJSON();calls.push(b)
        if(b.op==='upload')state.voices.push({voice_id:'voice_'+String(++serial).padStart(32,'0'),name:b.name,status:uploadStatus,ref_text:uploadStatus==='ready'?'识别文字':''})
        if(b.op==='select')state.selected=b.voice_id
        const v=state.voices.find(v=>v.voice_id===b.voice_id)
        if(b.op==='restore'){delete v.issue;state.selected=v.voice_id}
        if(b.op==='text'){v.voice_id='voice_'+String(++serial).padStart(32,'0');v.ref_text=b.ref_text;v.status='ready'}
        if(b.op==='refresh'){
          if(failRefresh)return route.fulfill({status:503,json:{detail:'voice_service_unavailable'}})
          v.ref_text=refreshStatus==='ready'?'服务器识别文字':'';v.status=refreshStatus
        }
        if(b.op==='remove'){state.voices=state.voices.filter(v=>v.voice_id!==b.voice_id);if(state.selected===b.voice_id)state.selected='default'}
      }
      return route.fulfill({json:state})
    }
    return route.fulfill({status:404})
  })
  await page.goto('http://localhost:19201/')
  const choice=page.locator('[data-choice]'),editor=page.locator('[data-editor]'),text=page.locator('[data-text]'),retry=page.locator('[data-refresh]')
  const idle=()=>page.waitForFunction(()=>!document.querySelector('[data-choice]').disabled)
  await idle()
  assert.equal(await choice.inputValue(),'default')
  assert.equal(await page.locator('[data-create]').isVisible(),false)
  assert.deepEqual(calls,[])
  const upload=async()=>{
    await choice.selectOption('__add__')
    await page.locator('[data-consent]').check()
    await page.locator('[data-name]').fill('测试音色')
    await page.locator('[data-file]').setInputFiles({name:'test.wav',mimeType:'audio/wav',buffer:Buffer.from('test fixture')})
    await page.locator('[data-upload]').click()
    await editor.waitFor();await idle()
  }
  await choice.selectOption('__add__')
  await page.locator('[data-upload]').click();await idle()
  assert.match(await page.locator('[data-status]').innerText(),/有权使用/)
  assert.equal(calls.length,0)
  await page.locator('[data-cancel]').click();await idle()
  await upload()
  assert.equal(await retry.isVisible(),false)
  assert.match(await page.locator('#duetVoiceTextHelp').innerText(),/上传的音频中说了什么文本.*影响合成效果/)
  await text.fill('手动修正文字')
  await page.waitForFunction(()=>document.querySelector('[data-recognition]').textContent.includes('请核对'))
  assert.equal(await text.inputValue(),'手动修正文字')
  assert.equal(await retry.isVisible(),false)
  assert.equal(calls.filter(c=>c.op==='upload').length,1)
  assert.equal(calls.filter(c=>c.op==='refresh').length,1)
  await page.locator('[data-save]').click();await idle()
  assert.equal(await editor.isVisible(),false)
  assert.equal(state.voices[0].ref_text,'手动修正文字')
  assert.equal(state.selected,state.voices[0].voice_id)
  await choice.selectOption('default');await idle()
  await choice.selectOption(state.voices[0].voice_id);await idle()
  assert.equal(await page.locator('[data-create]').isVisible(),false)
  await page.locator('[data-remove]').click();await idle()
  assert.equal(state.selected,'default')
  // ASR failure exposes refresh; retrieving the result preserves manually edited text.
  uploadStatus='text_required'
  await upload();assert.equal(await retry.isVisible(),true)
  await text.fill('失败后手动填写')
  await retry.click();await idle()
  assert.equal(await text.inputValue(),'失败后手动填写')
  assert.equal(await retry.isVisible(),false)
  await page.locator('[data-cancel]').click();await idle()
  assert.equal(state.voices.length,1) // Closing the editor never deletes audio or links.
  await choice.selectOption(state.voices[0].voice_id);await idle()
  await page.locator('[data-remove]').click();await idle()
  // Pending jobs resume after reopening, even when an earlier result request failed.
  uploadStatus='queued';failRefresh=true
  await upload();await retry.waitFor()
  failRefresh=false
  await page.reload();await idle()
  assert.equal(await page.locator('[data-create]').isVisible(),false)
  await page.waitForFunction(()=>[...document.querySelector('[data-choice]').options].some(o=>o.text==='测试音色'))
  assert.equal(state.voices[0].status,'ready')
  assert.equal(calls.filter(c=>c.op==='upload').length,3)
  const count=calls.length;await page.waitForTimeout(3200);assert.equal(calls.length,count)
  state.voices=Array.from({length:5},(_,i)=>({voice_id:'voice_'+String(i+10).padStart(32,'0'),name:'音色'+i,status:'ready',ref_text:'文字'}))
  await page.reload();await idle()
  assert.equal(await choice.locator('option[value="__add__"]').isDisabled(),true)
  state.voices[0].status='text_required';state.voices[0].ref_text=''
  await page.reload();await idle()
  await choice.selectOption(state.voices[0].voice_id)
  assert.equal(await editor.isVisible(),true)
  await page.locator('[data-remove-draft]').click();await idle()
  assert.equal(state.voices.length,4)
  assert.equal(await choice.locator('option[value="__add__"]').isDisabled(),false)
  state.custom_voice_enabled=false;state.selected='default'
  await page.reload();await idle()
  assert.match(await page.locator('[data-availability]').innerText(),/自定义音色暂不可用/)
  assert.equal(await choice.inputValue(),'default')
  assert.equal(await choice.locator('option[value="__add__"]').isDisabled(),true)
  assert.equal(await choice.locator('option').nth(1).isDisabled(),true)
  assert.equal(state.voices.length,4)
  state.custom_voice_enabled=true
  await page.reload();await idle()
  assert.equal(await page.locator('[data-availability]').isVisible(),false)
  assert.equal(await choice.inputValue(),'default')
  assert.equal(await choice.locator('option[value="__add__"]').isDisabled(),false)
  // Missing audio recovery is explicit, keeps the same link, and never reruns ASR.
  const recoveryId=state.voices[0].voice_id
  state.voices[0].issue='voice_audio_missing';state.selected='default'
  await page.reload();await idle()
  const before=calls.length
  await choice.selectOption(recoveryId)
  assert.equal(await page.locator('[data-recovery]').isVisible(),true)
  assert.match(await page.locator('[data-voice-issue]').innerText(),/参考音频已丢失/)
  assert.equal(calls.length,before)
  await page.locator('[data-reupload]').click();await idle()
  assert.equal(calls.at(-1).op,'restore')
  assert.equal(calls.at(-1).audio,undefined)
  assert.equal(state.selected,recoveryId)
  assert.equal(await page.locator('[data-recovery]').isVisible(),false)
  state.voices[0].issue='voice_audio_missing';state.selected='default'
  await page.reload();await idle();await choice.selectOption(recoveryId)
  await page.locator('[data-reupload-file]').setInputFiles({name:'original.wav',mimeType:'audio/wav',buffer:Buffer.from('original')})
  await page.locator('[data-reupload]').click();await idle()
  assert.equal(calls.at(-1).audio,Buffer.from('original').toString('base64'))
  state.voices[0].issue='voice_disabled';state.selected='default'
  await page.reload();await idle();await choice.selectOption(recoveryId)
  assert.match(await page.locator('[data-voice-issue]').innerText(),/停用/)
  assert.equal(await page.locator('[data-reupload]').isVisible(),false)
  assert.equal(state.custom_voice_enabled,true)
  await page.evaluate(()=>dispose())
  assert.deepEqual(errors,[])
  console.log('Voice picker: add-only editor, automatic recognition, failure-only refresh, immutable save, drafts, non-destructive close, reload recovery and five-link cap passed')
}finally{await browser.close()}
