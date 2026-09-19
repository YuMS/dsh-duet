/** Chromium UI smoke using intercepted HTTP only; no DSH mutations or model calls. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const html = await readFile(new URL('./deepseek_harness_duplex_control_plugin.html', import.meta.url), 'utf8')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  for (const debug of [false, true]) {
    const page = await browser.newPage()
    const errors = [], calls = []
    const config = { debug, feedback_enabled:true, revision: 0, backend_url: 'ws://127.0.0.1:28925/ws?protocol=realtime_v2', auth_configured: false, insecure_transport:true, token_placeholder: '请输入访问密钥', connection: { online: 0, tts_only: 0 } }
    const feedback=[]
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
      if (path === '/duet/') { await route.fulfill({ contentType: 'text/html', body: html }); return }
      if (path.endsWith('deepseek_harness_voice_tutorial_request.mjs')) {await route.fulfill({contentType:'text/javascript',body:await readFile(new URL('./deepseek_harness_voice_tutorial_request.mjs',import.meta.url),'utf8')});return}
      if (path.endsWith('deepseek_harness_voice_microphone.mjs')) {await route.fulfill({contentType:'text/javascript',body:await readFile(new URL('./deepseek_harness_voice_microphone.mjs',import.meta.url),'utf8')});return}
      if (path.endsWith('deepseek_harness_voice_shortcuts.mjs')) {await route.fulfill({contentType:'text/javascript',body:await readFile(new URL('./deepseek_harness_voice_shortcuts.mjs',import.meta.url),'utf8')});return}
      let json = {}
      if(path.endsWith('/feedback')){
        assert.equal(req.headers()['x-duplex-settings'],'1');feedback.push(req.postDataJSON())
        if(feedback.length===1){await route.fulfill({status:503,json:{persisted:false}});return}
        json={persisted:true}
      } else if (path.endsWith('/voice/service-info')) {
        json = {status:'ok',models:{duplex:'duet-duplex-v0.1',tts:'duet-tts-v0.1'}}
      } else if (path.endsWith('/voice/config')) {
        if (req.method() === 'PUT') {
          assert.equal(req.headers()['x-duplex-settings'], '1')
          const input = req.postDataJSON()
          assert.equal(input.auth_token, '')
          config.backend_url = input.backend_url; config.revision++
        }
        json = config
      } else if (path.endsWith('/announcements')) {
        json = { status: 'ok', items: [{ title: '服务通知', body: '<script>window.pwned=true</script>', level: 'info', published_at: '2026-09-14T00:00:00Z' }] }
      } else if (path.endsWith('/health')) json = { browser_client_connected: false, browser_client_last_seen_at: null }
      else if (path.endsWith('/sessions')) json = { sessions: [] }
      else if (path.endsWith('/jobs')) json = { jobs: [] }
      await route.fulfill({ json })
    })
    await page.goto('http://localhost:19200/duet/')
    await page.waitForFunction(() => !document.getElementById('saveVoice').disabled)
    assert.equal(await page.locator('#debugTools').isVisible(), debug)
    assert.equal(await page.locator('#authToken').inputValue(), '')
    assert.equal(await page.locator('#advancedConnection').isVisible(), true)
    assert.equal(await page.locator('#authState').textContent(), '已配置')
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
      await page.locator('#saveVoice').click()
      await page.waitForFunction(() => document.getElementById('settingsMessage').textContent.includes('已保存'))
      assert.equal(config.backend_url, 'wss://voice.example.test/ws?protocol=realtime_v2')
    }
    assert.deepEqual(errors, [])
    console.log(`debug=${debug}: visibility, polling, URL save, token placeholder, plain-text announcements passed`)
    await page.close()
  }
} finally { await browser.close() }
