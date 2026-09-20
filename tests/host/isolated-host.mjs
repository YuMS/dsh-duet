/** Real isolated DSH + installed tarball, local fake voice backend. No model/tasks. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { chromium } from 'playwright'
import { PLUGIN_VERSION } from '../../src/shared/state.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cli = process.env.DSH_CLI
assert.ok(cli, 'Set DSH_CLI to the built dsh CLI JS entry')
const tarball = resolve(process.env.DUET_TARBALL || join(root, `dsh-duet-${PLUGIN_VERSION}.tgz`))
const home = await mkdtemp(join(tmpdir(), 'duet-real-host-'))
const output = join(root, 'artifacts')
await mkdir(output, { recursive: true })
const delay = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await delay(100) }
  throw Error(`timeout: ${label}`)
}
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ items: [], status: 'ok' }))
})
const wss = new WebSocketServer({ server: upstream })
const sessions = []
let rejectBusy = false
let rejectUpgrade = false
wss.on('connection', ws => {
  const session = { ws, mode: null, binary: 0, events: [] }; sessions.push(session)
  ws.on('message', (raw, binary) => {
    if (binary) { session.binary++; return }
    const msg = JSON.parse(raw); session.events.push(msg)
    if (msg.type === 'session.update') {
      session.mode = msg.session.io_mode
      ws.send(JSON.stringify(rejectUpgrade
        ? { type: 'error', error: { code: 'plugin_upgrade_required', compatibility: {
          modes: { online: { available: false, min_client_version: '0.9.99' }, tts_only: { available: true } }
        } } }
        : rejectBusy
        ? { type: 'error', error: { code: 'capacity_exhausted' } }
        : { type: 'session.created', session: { id: `fixture-${sessions.length}`, config: {
          harness_control_transport: 'client_rpc_v1', external_message_protocol: 'harness_result_v2',
        } } }))
    }
  })
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
  DSH_HOME: home, DUPLEX_VOICE_URL: `ws://127.0.0.1:${upstream.address().port}/ws`,
  DUPLEX_VOICE_AUTHORIZATION: 'fixture-only', DUPLEX_VOICE_TRACE_DIR: join(home, 'traces') }
const report = { passed: false, plugin: `dsh-duet@${PLUGIN_VERSION}`, checks: [],
  scope: 'real_isolated_DSH_and_browser_local_fixture_voice_no_model_no_task_submission' }
const mark = (...checks) => { report.checks.push(...checks); console.log(`PASS ${checks.join(', ')}`) }
let child, browser, page, log = ''
try {
  for (const args of [
    ['--profile', 'duet-check', '--from-default-profile', 'web', '--dump-config'],
    ['plugin', '--profile', 'duet-check', 'add', tarball],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: home, env, encoding: 'utf8', timeout: 120000 })
    assert.equal(result.status, 0, `DSH setup failed (${args[0]}), ${result.error?.code || 'see CLI setup'}`)
  }
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = reservation.address().port; await new Promise(r => reservation.close(r))
  child = spawn(process.execPath, [cli, '--profile', 'duet-check', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: home, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', b => { log += b.toString() })
  child.stderr.on('data', b => { log += b.toString() })
  await until(() => {
    assert.equal(child.exitCode, null, `DSH exited (${child.exitCode})`)
    return /^dsh web: (http[^\r\n]+)/m.test(log)
  }, 'DSH ready', 90000)
  const url = log.match(/^dsh web: (http[^\r\n]+)/m)[1]
  assert.equal(new URL(url).port, String(port))
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  const context = await browser.newContext({ permissions: ['microphone'] })
  await context.addInitScript(() => {
    globalThis.__micRequests = 0
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = (...args) => { globalThis.__micRequests++; return original(...args) }
  })
  page = await context.newPage(); const errors = []
  page.setDefaultTimeout(15000)
  const dismissHostOnboarding = async () => {
    const welcome = page.getByRole('dialog', { name: 'Internal Testing Notice', exact: true })
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Continue', exact: true }).click()
    const later = page.getByRole('button', { name: 'Configure later', exact: true })
    await later.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await later.isVisible()) await later.click()
  }
  page.on('pageerror', e => errors.push(e.message))
  // Test-only instrumentation of the real native UI carrier; no DSH sources
  // are changed and no real task/model request is made.
  await page.route('**/*', async route => {
    if (route.request().resourceType() !== 'script' || !route.request().url().includes('ui-user-questions')) return route.continue()
    const response = await route.fetch()
    let body = await response.text()
    if (body.includes('var PendingQuestion = class')) body = body.replace('var PendingQuestion = class', 'var PendingQuestion = globalThis.__nativeQuestion = class')
    await route.fulfill({ response, body })
  })
  await page.route('**/duet/assets/client/browser.mjs*', async route => {
    const response = await route.fetch()
    const body = (await response.text())
      .replace('export function mountDuet(ctx) {', 'export function mountDuet(ctx) { globalThis.__duetAccess = composerAccess(ctx); globalThis.__duetCtx = ctx;')
      .replace('const state = new DuetState(', 'const state = globalThis.__duetState = new DuetState(')
      .replace('return () => {\n    disposed = true', 'return globalThis.__duetDispose = () => {\n    disposed = true')
    await route.fulfill({ response, body })
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.__duetAccess), {}, { timeout: 60000 })
  const api = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const r = await fetch('/duplex-control' + path, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: r.status, body: await r.json() }
  }, { path, method, body })
  assert.equal((await api('/api/health')).body.plugin_version, PLUGIN_VERSION)
  assert.equal(await page.locator('#dsh-duet-controls').count(), 1)
  await delay(1500); assert.equal(sessions.length, 0)
  mark('installed_tarball_real_DSH_web_boot', 'single_toolbar', 'default_off_no_backend_connection')
  await dismissHostOnboarding()
  const dismiss = page.getByRole('button', { name: '不再提醒', exact: true })
  if (await dismiss.isVisible()) await dismiss.click()
  assert.equal(await page.locator('#dsh-duet-entry').innerText(), 'duet.')
  assert.equal(await page.locator('[data-connection-light]').count(), 0)
  assert.equal(await page.locator('a[aria-label="duet 设置"]').getAttribute('href'), '/duet/')
  const legacySettings = await context.request.get(`http://127.0.0.1:${port}/duplex-control/`, {maxRedirects:0})
  assert.equal(legacySettings.status(),308)
  assert.equal(legacySettings.headers().location,'/duet/')
  assert.equal((await context.request.get(`http://127.0.0.1:${port}/duet/`)).status(),200)
  mark('canonical_duet_page_legacy_redirect')
  assert.equal(await page.locator('[data-duet-mark]').evaluate(e=>e.style.color),'rgb(237, 155, 53)')
  await page.evaluate(() => localStorage.setItem('dsh-duet.audio-upload-consent.v1', 'accepted'))
  await page.locator('[data-voice="mic"]').click()
  await page.getByRole('dialog', { name: '开启 duet', exact: true }).waitFor()
  const consentText = await page.locator('#duet-audio-consent-description').innerText()
  for (const term of ['交互音频', '会话标识', '输入框内容', '任务结果', '传至服务器']) assert.ok(consentText.includes(term))
  assert.match(consentText, /仅在交互模式下会采集和上传麦克风音频/)
  assert.doesNotMatch(consentText, /同意一次即可|您可以选择暂不开启/)
  mark('expanded_consent_rechecks_audio_only_acceptance')
  assert.equal(sessions.length, 0)
  assert.equal(await page.evaluate(() => globalThis.__micRequests), 0)
  await page.getByRole('button', { name: '暂不开启', exact: true }).click()
  assert.equal(await page.evaluate(() => globalThis.__duetState.mode), 'off')
  mark('consent_cancel_no_connection_no_microphone')
  const create = await api('/api/sessions', 'POST', { name: 'Duet 输入框自检', cwd: home })
  assert.ok(create.status < 300); const sid = create.body.session.session_id
  const other = await api('/api/sessions', 'POST', { name: 'Duet 切换自检', cwd: home })
  assert.ok(other.status < 300); const sid2 = other.body.session.session_id
  assert.ok((await api(`/api/sessions/${sid}/activate`, 'POST')).status < 300)
  await page.waitForFunction(id => globalThis.__duetAccess.focused() === id, sid)
  assert.ok((await api(`/api/sessions/${sid}/rename`, 'POST', { title: 'Duet 重命名自检' })).status < 300)
  const result = await page.evaluate(async id => {
    const access = globalThis.__duetAccess, before = await access.read()
    access.inputFor(id).setDraft('后续手动编辑')
    const request = { method: 'PUT', path: `/api/sessions/${id}/composer`, payload: {
      text: '独立插件写入成功', require_focus: true, overwrite: true,
      expected_revision: before.revision, expected_hash: before.hash,
    } }
    const written = await access.execute(request)
    const { observeComposer } = await import('/duet/assets/client/composer.mjs')
    const observations = []
    const stop = observeComposer(globalThis.__duetCtx, access, e => observations.push({ t: performance.now(), e }))
    await new Promise(r => setTimeout(r, 100))
    for (let i = 0; i < 10; i++) { access.inputFor(id).setDraft(`连续输入${i}`); await new Promise(r => setTimeout(r, 50)) }
    await new Promise(r => setTimeout(r, 2200)); stop()
    request.payload.text = ''; const cleared = await access.execute(request)
    return { written: written.composer.text, cleared: cleared.composer.text, observations }
  }, sid)
  assert.equal(result.written, '独立插件写入成功'); assert.equal(result.cleared, '')
  assert.equal(result.observations.length, 2)
  assert.ok(result.observations[1].t - result.observations[0].t >= 1990)
  assert.equal(result.observations[1].e.composer.text, '连续输入9')
  mark('real_session_create_switch_rename', 'native_draft_overwrite_clear', 'composer_2s_throttle_trailing')
  await page.keyboard.press('Escape')
  await page.locator('[data-voice="speaker"]').click()
  await page.getByRole('dialog', { name: '开启 duet', exact: true }).waitFor()
  const broadcastText = await page.locator('#duet-audio-consent-description').innerText()
  assert.equal(broadcastText, consentText)
  assert.ok(broadcastText.includes('麦克风'))
  assert.equal(sessions.length, 0)
  await page.getByRole('button', { name: '暂不开启', exact: true }).click()
  assert.equal(await page.evaluate(() => globalThis.__duetState.mode), 'off')
  assert.equal(sessions.length, 0)
  await page.locator('[data-voice="speaker"]').click()
  await page.getByRole('button', { name: '同意并开启', exact: true }).click()
  mark('broadcast_consent_required_cancel_no_connection')
  await page.waitForFunction(() => globalThis.__duetState.ready)
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.evaluate(async () => {
    const state=globalThis.__duetState
    const ready=state.ready;state.ready=false;state.changed(state)
    const button=document.querySelector('[data-voice="speaker"]')
    if(button.getAttribute('aria-busy')!=='true'||button.querySelector('[data-connecting-ring]').hidden)throw Error('pending ring absent')
    if(button.style.background!=='transparent')throw Error('pending mode must not be blue')
    const ring=button.querySelector('[data-connecting-ring]')
    const outline=ring.querySelector('rect')
    if(!outline||outline.getAttribute('rx')!=='5'||outline.getAttribute('pathLength')!=='100')throw Error('must follow original rounded rectangle')
    if(getComputedStyle(outline).animationName!=='duet-connecting-snake')throw Error('outline not animated')
    if(getComputedStyle(ring).transform!=='none'||getComputedStyle(outline).transform!=='none')throw Error('outline must not rotate')
    const bounds=outline.getBoundingClientRect().toJSON()
    const before=getComputedStyle(outline).strokeDashoffset
    await new Promise(r=>setTimeout(r,230))
    if(getComputedStyle(outline).strokeDashoffset===before)throw Error('connecting stroke is stationary')
    if(JSON.stringify(outline.getBoundingClientRect().toJSON())!==JSON.stringify(bounds))throw Error('outline geometry moved')
    state.ready=ready;state.changed(state)
  })
  await page.waitForFunction(() => globalThis.__duetState.ready)
  assert.equal(await page.locator('[data-voice="speaker"]').getAttribute('aria-busy'), 'false')
  assert.equal(await page.locator('[data-voice="speaker"] [data-connecting-ring]').isVisible(), false)
  assert.equal(await page.locator('[data-voice="speaker"]').evaluate(b=>b.style.background), 'rgb(220, 239, 255)')
  assert.equal(await page.locator('[data-duet-mark]').evaluate(e=>e.style.color),'rgb(127, 214, 166)')
  mark('orange_connecting_ring_then_blue_active_mode')
  assert.equal(sessions.at(-1).mode, 'external_only'); assert.equal(sessions.at(-1).binary, 0)
  assert.equal(await page.locator('#duet-audio-consent').count(), 0)
  assert.equal(await page.evaluate(() => globalThis.__micRequests), 0)
  const old = sessions.at(-1)
  await page.locator('[data-voice="mic"]').click()
  assert.equal(await page.locator('#duet-audio-consent').count(), 0)
  mark('shared_consent_no_prompt_on_mode_switch')
  await page.waitForFunction(() => globalThis.__duetState.ready && globalThis.__duetState.mode === 'online')
  await until(() => old.ws.readyState === 3 && sessions.at(-1).binary > 0, 'mode reconnect and fake microphone')
  await until(() => sessions.at(-1).events.some(e => e.type === 'harness.composer.update'), 'composer push via actual host proxy')
  const online = sessions.at(-1), requestId = 'a'.repeat(32), connectionId = 'b'.repeat(32)
  online.ws.send(JSON.stringify({ type: 'harness.rpc.request', request_id: requestId, connection_id: connectionId,
    method: 'PUT', path: `/api/sessions/${sid}/composer`, payload: { text: '真实代理 RPC 写入', overwrite: true, require_focus: true } }))
  await until(() => online.events.some(e => e.type === 'harness.rpc.response' && e.request_id === requestId), 'RPC response')
  assert.equal(online.events.find(e => e.type === 'harness.rpc.response' && e.request_id === requestId).status, 200)
  assert.equal(await page.evaluate(async () => (await globalThis.__duetAccess.read()).text), '真实代理 RPC 写入')
  mark('tts_only_no_microphone', 'online_new_connection_fake_mic', 'composer_push_host_proxy', 'backend_RPC_native_write')
  await page.waitForFunction(() => Boolean(globalThis.__nativeQuestion))
  const question = async () => page.evaluate(({ sid }) => {
    const ctx = globalThis.__duetCtx
    const value = new globalThis.__nativeQuestion(sid, [{ id: 'fixture-color', question: '请选择测试颜色', options: [{ label: '测试蓝色' }, { label: '测试绿色' }] }])
    const publish = ctx.uiSession.registerPendingInteraction(() => 1)
    const remove = publish(value, async () => value.cancel())
    globalThis.__nativeAnswer = null
    value.result.then(answer => { globalThis.__nativeAnswer = answer; remove() })
    return value.key
  }, { sid })
  await question()
  await page.getByText('请选择测试颜色', { exact: true }).waitFor()
  await page.getByText('测试蓝色', { exact: true }).click()
  await page.getByRole('button', { name: /^(Confirm|确认|Submit|提交)$/ }).click()
  await page.waitForFunction(() => globalThis.__nativeAnswer !== null)
  assert.deepEqual((await page.evaluate(() => globalThis.__nativeAnswer)).answers[0].selected, ['测试蓝色'])
  const key = await question()
  await page.getByText('请选择测试颜色', { exact: true }).waitFor()
  const voiceAnswerId = 'c'.repeat(32)
  online.ws.send(JSON.stringify({ type: 'harness.rpc.request', request_id: voiceAnswerId, connection_id: connectionId,
    method: 'POST', path: `/api/interactions/${encodeURIComponent(key)}/respond`, payload: { answers: [{ id: 'fixture-color', selected: ['测试绿色'] }] } }))
  await until(() => online.events.some(e => e.type === 'harness.rpc.response' && e.request_id === voiceAnswerId), 'native voice answer')
  assert.equal(online.events.find(e => e.request_id === voiceAnswerId).status, 200)
  await page.waitForFunction(() => globalThis.__nativeAnswer !== null)
  assert.deepEqual((await page.evaluate(() => globalThis.__nativeAnswer)).answers[0].selected, ['测试绿色'])
  await page.getByText('请选择测试颜色', { exact: true }).waitFor({ state: 'hidden' })
  mark('native_question_visible_during_online', 'native_question_click_answer', 'native_question_voice_rpc_answer')
  await page.evaluate(() => globalThis.__duetDispose())
  await until(() => wss.clients.size === 0, 'voice disposed sockets closed')
  assert.equal(await page.locator('#dsh-duet-controls').count(), 0)
  mark('browser_dispose_closes_voice_and_removes_controls')
  await page.reload(); await page.waitForFunction(() => Boolean(globalThis.__duetAccess))
  await dismissHostOnboarding()
  assert.equal(await page.locator('#dsh-duet-controls').count(), 1)
  await page.locator('[data-voice="mic"]').click()
  await page.waitForFunction(() => globalThis.__duetState.ready)
  assert.equal(await page.locator('#duet-audio-consent').count(), 0)
  await page.evaluate(() => globalThis.__duetState.setMode('off'))
  await page.evaluate(async()=>{
    const {saveShortcut}=await import('/duet/assets/client/shortcuts.mjs')
    saveShortcut('speaker',{code:'KeyB',ctrl:true,alt:false,meta:false,shift:true})
  })
  await page.keyboard.press('Control+Shift+B')
  await page.waitForFunction(()=>globalThis.__duetState.ready&&globalThis.__duetState.mode==='tts_only')
  await page.keyboard.press('Control+Shift+B')
  await page.waitForFunction(()=>globalThis.__duetState.mode==='off')
  assert.equal(await page.locator('[data-duet-mark]').evaluate(e=>e.style.color),'rgb(237, 155, 53)')
  mark('configured_shortcut_toggles_mode', 'status_dot_tracks_connection')
  mark('consent_persisted_after_reload', 'shared_consent_for_both_modes')
  rejectBusy = true
  await page.locator('[data-voice="speaker"]').click()
  await page.waitForFunction(() => globalThis.__duetState.mode === 'off')
  await page.getByText('服务器忙，请稍后再试', { exact: true }).waitFor({ state: 'visible' })
  mark('reload_single_toolbar', 'busy_returns_off')
  rejectBusy = false; rejectUpgrade = true
  await page.locator('[data-voice="mic"]').click()
  const notice = page.locator('#dsh-duet-controls [role="status"]')
  await notice.getByText('如何升级', { exact: true }).waitFor()
  assert.ok((await notice.innerText()).includes('0.9.99'))
  assert.ok((await notice.innerText()).includes(PLUGIN_VERSION))
  assert.ok((await notice.innerText()).includes('手动开启播报模式'))
  await notice.locator('summary').click()
  await notice.getByText('dsh plugin --profile web add dsh-duet@latest', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => globalThis.__duetState.mode), 'off')
  await notice.getByRole('button', { name: '知道了' }).click()
  assert.equal(await notice.isVisible(), false)
  mark('upgrade_metadata_through_host_to_browser', 'upgrade_help_nonmodal', 'no_automatic_mode_fallback')
  for (const id of [sid, sid2]) assert.ok((await api(`/api/sessions/${id}/archive`, 'POST')).status < 300)
  assert.deepEqual(errors, []); mark('archive_test_sessions', 'no_browser_page_errors')
  report.passed = true
} catch (e) {
  report.error = String(e); process.exitCode = 1
  if (page && !page.isClosed()) {
    report.visible_dialogs = await page.getByRole('dialog').allTextContents().catch(() => [])
    await page.screenshot({ path: join(output, 'host-smoke-failure.png') }).catch(() => {})
  }
} finally {
  await browser?.close()
  if (child && child.exitCode === null) {
    process.kill(-child.pid, 'SIGTERM')
    await Promise.race([once(child, 'exit'), delay(8000)])
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL')
  }
  for (const ws of wss.clients) ws.terminate()
  await new Promise(r => wss.close(r)); await new Promise(r => upstream.close(r))
  report.host_stopped = !child || child.exitCode !== null || child.signalCode !== null
  await writeFile(join(output, 'host-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
