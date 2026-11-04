/** Chromium UI smoke using intercepted HTTP only; no DSH mutations or model calls. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const html = await readFile(new URL('../../src/client/settings.html', import.meta.url), 'utf8')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  for (const debug of [false, true]) {
    const page = await browser.newPage()
    const errors = [], calls = []
    const config = { debug, feedback_enabled:true, revision: 0, backend_url: 'ws://127.0.0.1:28925/ws?protocol=realtime_v2', auth_configured: false, insecure_transport:true, token_placeholder: '请输入访问密钥', connection: { online: 0, tts_only: 0 } }
    const feedback=[]
    let configUnavailable = false
    await page.addInitScript(() => {
      window.micRequests = 0
      window.micDevices = [{kind:'audioinput',deviceId:'default',label:'默认'}, {kind:'audioinput',deviceId:'usb',label:'USB 麦克风'}, {kind:'audioinput',deviceId:'built-in',label:'内置麦克风'}]
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {value:async()=>window.micDevices})
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {value:async()=>{window.micRequests++;throw Error('settings must never capture')}})
    })
    page.on('pageerror', e => errors.push(e.message))
    await page.route('http://localhost:19200/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname
      calls.push([req.method(), path])
      if(path==='/duet/assets/shared/avatar.mjs')return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/shared/avatar.mjs',import.meta.url),'utf8')})
      if(path==='/duet/assets/shared/avatar-ui.mjs')return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/shared/avatar-ui.mjs',import.meta.url),'utf8')})
      if (path === '/duet/') { await route.fulfill({ contentType: 'text/html', body: html }); return }
      if (path.startsWith('/duet/assets/') && path.endsWith('/identity.mjs')) return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/'+path.slice('/duet/assets/'.length),import.meta.url),'utf8')})
      if (path.endsWith('tutorial-request.mjs')) {await route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/client/tutorial-request.mjs',import.meta.url),'utf8')});return}
      if (path.endsWith('microphone.mjs')) {await route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/client/microphone.mjs',import.meta.url),'utf8')});return}
      if (path.endsWith('shortcuts.mjs')) {await route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../src/client/shortcuts.mjs',import.meta.url),'utf8')});return}
      let json = {}
      if(path.endsWith('/feedback')){
        assert.equal(req.headers()['x-duplex-settings'],'1');feedback.push(req.postDataJSON())
        if(feedback.length===1){await route.fulfill({status:503,json:{persisted:false}});return}
        json={persisted:true}
      } else if (path.endsWith('/duet/nickname')) {
        const input=req.postDataJSON()
        assert.equal(req.headers()['x-duplex-settings'],'1')
        assert.equal(input.revision,config.revision)
        if(input.nickname==='每天陪我看星星')json={ok:false,reason:'昵称最多5个汉字或2个英文单词；中英混用最多5个字符'}
        else {config.nickname=input.nickname;config.revision++;json={ok:true,nickname:config.nickname,revision:config.revision}}
      } else if (path.endsWith('/voice/service-info')) {
        json = {status:'ok',models:{duplex:'duet-duplex-v0.1',tts:'duet-tts-v0.1'}}
      } else if (path.endsWith('/voice/config')) {
        if (configUnavailable) return route.fulfill({status:503,json:{detail:'fixture unavailable'}})
        if (req.method() === 'PUT') {
          assert.equal(req.headers()['x-duplex-settings'], '1')
          const input = req.postDataJSON()
          assert.equal(Object.hasOwn(input, 'auth_token'), false)
          config.backend_url = input.backend_url; config.revision++
        }
        json = config
      } else if (path.endsWith('/announcements')) {
        json = { status: 'ok', items: [{ title: '服务通知', body: '<script>window.pwned=true</script>', level: 'info', published_at: '2026-09-14T00:00:00Z' }] }
      } else if (path.endsWith('/health')) json = { browser_client_connected: true, browser_focus_matches:false, browser_client_last_seen_at:Date.now()/1000 }
      else if (path.endsWith('/sessions')) json = { sessions: [] }
      else if (path.endsWith('/jobs')) json = { jobs: [] }
      await route.fulfill({ json })
    })
    await page.goto('http://localhost:19200/duet/')
    await page.locator('#avatarWebOnly').waitFor()
    await page.evaluate(()=>{window.runtimeChannel=new BroadcastChannel('dsh.duet.avatar.v1');runtimeChannel.postMessage({type:'presentation',mode:'recovering'})})
    await page.waitForFunction(()=>document.querySelector('#avatarPresentationStatus').textContent.includes('恢复中'))
    assert.equal(await page.locator('#avatarWebOnly').isChecked(),false)
    assert.equal(await page.locator('#avatarRetryDesktop').isVisible(),true)
    await page.evaluate(()=>runtimeChannel.postMessage({type:'presentation',mode:'desktop'}))
    await page.waitForFunction(()=>document.querySelector('#avatarPresentationStatus').textContent.includes('桌面浮动窗口'))
    assert.equal(await page.locator('#avatarRetryDesktop').isVisible(),false)
    await page.evaluate(()=>runtimeChannel.close())
    await page.waitForFunction(() => !document.getElementById('saveDuet').disabled)
    assert.equal(await page.locator('#debugTools').isVisible(), debug)
    assert.equal(await page.locator('#authToken').count(), 0)
    assert.equal(await page.locator('#advancedConnection').isVisible(), true)
    assert.equal(await page.locator('#authState').textContent(), '已配置')
    assert.equal(await page.locator('#avatarSize').getAttribute('data-size'),'large')
    for(const size of ['medium','small','large']){
      await page.locator('#avatarSize').focus();await page.keyboard.press(size==='small'?'Space':'Enter')
      assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh.duet.avatar.v1')).size),size)
      assert.equal(await page.locator(`#avatarSize [data-size-square=${size}]`).getAttribute('stroke-width'),'2.8')
      assert.equal(await page.locator('#avatarSize rect[stroke-width="1"]').count(),2)
      assert.equal(await page.locator('#avatarSize [stroke-dasharray]').count(),0)
    }
    await page.evaluate(()=>{localStorage.setItem('dsh.duet.avatar.v1',JSON.stringify({enabled:true,webOnly:true,size:'small'}));window.dispatchEvent(new StorageEvent('storage',{key:'dsh.duet.avatar.v1'}))})
    assert.equal(await page.locator('#avatarSize').getAttribute('data-size'),'small')
    assert.equal(await page.locator('#avatarWebOnly').isChecked(),true)
    await page.locator('#avatarEnabled').click();await page.keyboard.press('Escape')
    assert.equal(await page.locator('#avatarEnabled').isChecked(),true)
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh.duet.avatar.v1')).enabled),true)
    await page.locator('#avatarEnabled').click();await page.locator('[data-avatar-close-choice=confirm]').click()
    assert.equal(await page.locator('#avatarEnabled').isChecked(),false)
    await page.locator('#avatarEnabled').check()
    await page.locator('#assistantNickname').fill('每天陪我看星星')
    await page.locator('#saveNickname').click()
    await page.getByText('昵称最多5个汉字或2个英文单词；中英混用最多5个字符',{exact:true}).waitFor()
    await page.locator('#assistantNickname').fill('沐沐')
    await page.locator('#saveNickname').click()
    await page.getByText('已保存，下次开启语音时使用这个昵称。',{exact:true}).waitFor()
    assert.equal(config.nickname,'沐沐')
    assert.equal(await page.locator('#duplexModel').textContent(), 'duet-duplex-v0.1')
    assert.equal(await page.locator('#ttsModel').textContent(), 'duet-tts-v0.1')
    assert.doesNotMatch(await page.locator('body').innerText(), /VOICE WORKSPACE|主模型|默认不占用模型|不会自动语音播放|开始前不会自动发送/)
    assert.equal(await page.locator('.connection-dot').count(), 0)
    await page.waitForFunction(() => !document.getElementById('microphoneDevice').disabled)
    assert.equal(await page.locator('#microphoneDevice option').count(), 3)
    await page.locator('#microphoneDevice').selectOption('usb')
    assert.equal(await page.evaluate(()=>localStorage.getItem('dsh-duet.microphone.v1')), 'usb')
    await page.locator('#refreshMicrophones').click()
    await page.waitForFunction(() => !document.getElementById('refreshMicrophones').disabled)
    assert.equal(await page.locator('#microphoneDevice').inputValue(), 'usb')
    await page.evaluate(()=>{window.micDevices=[];navigator.mediaDevices.dispatchEvent(new Event('devicechange'))})
    await page.getByText('已选麦克风（暂不可用）', {exact:true}).waitFor({state:'attached'})
    assert.equal(await page.locator('#microphoneDevice').inputValue(), 'usb')
    await page.locator('#microphoneDevice').selectOption('')
    assert.equal(await page.evaluate(()=>localStorage.getItem('dsh-duet.microphone.v1')), '')
    assert.equal(await page.evaluate(()=>window.micRequests), 0)
    assert.equal(await page.locator('.sub').innerText(),'用声音控制dsh，让工作变得更自由。')
    assert.doesNotMatch(await page.locator('body').innerText(),/你的麦克风，由你控制|选择交互模式用语音操作/)
    await page.waitForFunction(()=>document.getElementById('speakerShortcut').onkeydown!==null)
    assert.equal(await page.locator('#speakerShortcut').inputValue(),'')
    assert.equal(await page.locator('#micShortcut').inputValue(),'')
    await page.locator('#speakerShortcut').focus();await page.keyboard.press('Control+Shift+B')
    assert.equal(await page.locator('#speakerShortcut').inputValue(),'Ctrl + Shift + B')
    await page.locator('#micShortcut').focus();await page.keyboard.press('Control+Shift+B')
    await page.getByText('两个模式请使用不同快捷键。',{exact:true}).waitFor()
    assert.equal(await page.locator('#micShortcut').inputValue(),'')
    await page.keyboard.press('Control+Shift+M')
    assert.equal(await page.locator('#micShortcut').inputValue(),'Ctrl + Shift + M')
    await page.locator('#clearSpeakerShortcut').click()
    assert.equal(await page.locator('#speakerShortcut').inputValue(),'')
    assert.equal(await page.locator('#duetMark').evaluate(e=>e.style.color),'rgb(237, 155, 53)')
    assert.equal(await page.locator('#connectionTitle').textContent(), '语音未开启')
    // Old global-focus health must never override a live voice connection.
    for (const [connection, title, mode] of [
      [{connecting:1}, '语音正在连接', '正在连接'],
      [{online:1,connecting:1}, '语音已连接', '交互模式'],
      [{tts_only:1}, '语音已连接', '播报模式'],
      [{online:0,tts_only:0,connecting:0}, '语音未开启', '未开启'],
    ]) {
      config.connection = connection
      await page.waitForFunction(({title,mode}) => document.getElementById('connectionTitle').textContent === title
        && document.getElementById('duetConnection').textContent === mode, {title,mode})
    }
    configUnavailable = true
    await page.getByText('语音连接信息不可用', {exact:true}).first().waitFor()
    assert.equal(await page.locator('#connectionTitle').textContent(), '语音连接信息不可用')
    configUnavailable = false
    await page.waitForFunction(() => document.getElementById('connectionTitle').textContent === '语音未开启')
    assert.equal(calls.some(([,path]) => path.endsWith('/health')), false)
    assert.doesNotMatch(await page.locator('body').innerText(), /未加密连接/)
    const originalURL=page.url()
    await page.locator('#openTutorial').click()
    await page.getByText('请回到 DSH 页面继续教学。',{exact:true}).waitFor()
    assert.equal(page.url(),originalURL)
    assert.ok(await page.evaluate(()=>localStorage.getItem('dsh-duplex-tutorial-request-v1')))
    assert.doesNotMatch(await page.locator('body').innerText(), /测试可填|browser client|公网明文测试|Token/)
    await page.locator('#feedbackText').fill('测试建议，不含隐私')
    await page.locator('#submitFeedback').click()
    await page.waitForFunction(()=>document.getElementById('feedbackStatus').textContent.includes('提交失败'))
    assert.equal(await page.locator('#feedbackText').inputValue(),'测试建议，不含隐私')
    await page.locator('#submitFeedback').click()
    await page.waitForFunction(()=>document.getElementById('feedbackStatus').textContent.includes('已保存'))
    assert.equal(feedback[0].request_id,feedback[1].request_id)
    assert.equal(await page.locator('#feedbackText').inputValue(),'')
    await page.waitForTimeout(2200)
    assert.equal(calls.some(([, p]) => p.endsWith('/sessions')), debug)
    assert.equal(calls.some(([, p]) => p.endsWith('/jobs')), debug)
    assert.match(await page.locator('#announcements').textContent(), /<script>/)
    assert.equal(await page.evaluate(() => window.pwned), undefined)
    assert.equal(await page.locator('#backendUrl').isVisible(), false)
    {
      await page.locator('#advancedConnection summary').click()
      await page.locator('#backendUrl').fill('wss://voice.example.test/ws?protocol=realtime_v2')
      await page.locator('#saveDuet').click()
      await page.waitForFunction(() => document.getElementById('settingsMessage').textContent.includes('已保存'))
      assert.equal(config.backend_url, 'wss://voice.example.test/ws?protocol=realtime_v2')
    }
    assert.deepEqual(errors, [])
    console.log(`debug=${debug}: visibility, polling, URL-only save, no token input, plain-text announcements passed`)
    await page.close()
  }
} finally { await browser.close() }
