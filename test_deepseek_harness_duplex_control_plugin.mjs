import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from './deepseek_harness_duplex_control_plugin.mjs'
import { HarnessRPCExecutor } from './deepseek_harness_voice_rpc.mjs'

function makeHarness({ forkError, modernWorkspaces = false, options = {}, authRejection } = {}) {
  let handler
  const prompted = []
  const creations = [], workspacePaths = []
  const listeners = new Map()
  const ctx = {
    connection: { requestRejection: () => authRejection },
    sessionController: {
      list: () => Promise.resolve({
        items: [
          { sessionId: 's1', running: false, projections: { values: { title: '测试' } } },
        ],
      }),
      prompt: payload => {
        prompted.push(payload)
        return Promise.resolve({ accepted: true })
      },
      create: input => { creations.push(input); return Promise.resolve({ sessionId: 'created' }) },
      rename: ({ title }) => Promise.resolve({ title, seq: 1 }),
      fork: () => forkError ? Promise.reject(forkError) : Promise.resolve({ sessionId: 'forked' }),
    },
    workspaceController: {
      ...(modernWorkspaces ? { create: ({ path }) => { workspacePaths.push(path); return Promise.resolve({ workspace: { workspaceId: 'ws1' } }) } } : {}),
      archiveSession: () => Promise.resolve({ archivedSessionIds: ['s1'] }),
    },
    workspaceRegistry: { archivedSessionIds: [] },
    effect: callback => callback(),
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    webServer: {
      registerUpgrade: () => () => {},
      register: registration => {
        handler = registration.handler
        return () => {}
      },
    },
  }
  apply(ctx, {feedbackDisabled:!options.feedbackStore,...options})

  const request = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = {
      method,
      url,
      headers: { 'x-duplex-control-client': 'node-test', ...headers },
      async *[Symbol.asyncIterator]() {
        if (encoded !== null) yield encoded
      },
    }
    let status = 0, responseHeaders = {}
    const res = {
      writeHead(value, headers = {}) {
        status = value
        responseHeaders = headers
      },
      end(value = '') {
        const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
        resolve({ status, headers:responseHeaders, body: text ? (responseHeaders['content-type']?.includes('text/html') ? text : JSON.parse(text)) : null })
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })

  const emitWaterfall = (event, payload, delegated = 'delegated') => {
    const listener = listeners.get(event)
    if (listener === undefined) throw new Error(`missing listener for ${event}`)
    return listener(payload, () => Promise.resolve(delegated))
  }

  const emitSession = (type, data, sessionId = 's1') => listeners.get('session/event')(
    { id: sessionId }, { type, data, time: Date.now() },
  )
  return { prompted, request, emitWaterfall, emitSession, creations, workspacePaths }
}

test('duet settings page is canonical and authenticated; legacy entry redirects without changing API routes',async()=>{
  const {request}=makeHarness()
  assert.equal((await request('GET','/duet/')).status,200)
  const redirect=await request('GET','/duplex-control/')
  assert.equal(redirect.status,308);assert.equal(redirect.headers.location,'/duet/')
  assert.equal((await request('GET','/duplex-control/api/sessions')).status,200)
  const locked=makeHarness({authRejection:401})
  assert.equal((await locked.request('GET','/duet/')).status,401)
})

test('voice settings API requires DSH auth and same-origin write, persists without exposing token', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-host-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const options = { settingsPath: join(dir, 'settings.json') }
  const denied = makeHarness({ options, authRejection: 401 })
  assert.equal((await denied.request('GET', '/duplex-control/api/voice/config')).status, 401)
  const h = makeHarness({ options })
  const before = await h.request('GET', '/duplex-control/api/voice/config')
  assert.equal(before.body.debug, false)
  const input = { revision: before.body.revision, backend_url: 'wss://example.test/ws', auth_token: 'secret-token' }
  assert.equal((await h.request('PUT', '/duplex-control/api/voice/config', input)).status, 403)
  const saved = await h.request('PUT', '/duplex-control/api/voice/config', input, { origin: 'http://localhost:3080', host: 'localhost:3080', 'x-duplex-settings': '1', 'content-type': 'application/json' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.backend_url, input.backend_url)
  assert.equal(saved.body.auth_configured, true)
  assert.ok(!JSON.stringify(saved.body).includes('secret-token'))
  const reload = makeHarness({ options: { ...options, debug: true } })
  const read = await reload.request('GET', '/duplex-control/api/voice/config')
  assert.equal(read.body.backend_url, input.backend_url)
  assert.equal(read.body.debug, true)
})

test('feedback API authenticates writes and acknowledges only durable commit',async()=>{
  const rows=[];const feedbackStore={userId:()=> 'host-user',insert:async row=>rows.push(row)}
  const h=makeHarness({options:{feedbackStore}})
  const data={kind:'text',request_id:'12345678-1234-4123-8123-123456789abc',text:'体验建议'}
  const headers={origin:'http://localhost:3080',host:'localhost:3080','x-duplex-settings':'1','content-type':'application/json'}
  assert.equal((await h.request('POST','/duplex-control/api/feedback',data)).status,403)
  const saved=await h.request('POST','/duplex-control/api/feedback',data,headers)
  assert.equal(saved.status,201);assert.equal(saved.body.persisted,true);assert.equal(rows[0].user_id,'host-user')
  feedbackStore.insert=async()=>{throw Error('private database failure')}
  const failed=await h.request('POST','/duplex-control/api/feedback',data,headers)
  assert.equal(failed.status,503);assert.equal(failed.body.persisted,false);assert(!JSON.stringify(failed).includes('private database'))
  const off=makeHarness();assert.equal((await off.request('GET','/duplex-control/api/voice/config')).body.feedback_enabled,false)
  assert.equal((await off.request('POST','/duplex-control/api/feedback',data,headers)).status,503)
})

for (const modernWorkspaces of [true, false]) {
  test(`new session belongs to a visible workspace (${modernWorkspaces ? 'current DSH' : 'legacy cwd'})`, async () => {
    const { request, creations, workspacePaths } = makeHarness({ modernWorkspaces })
    const result = await request('POST', '/duplex-control/api/sessions', { cwd: '/work/test', name: 'test' })
    assert.equal(result.status, 201)
    assert.deepEqual(creations, [modernWorkspaces ? { workspaceId: 'ws1' } : { cwd: '/work/test' }])
    assert.deepEqual(workspacePaths, modernWorkspaces ? ['/work/test'] : [])
  })
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

test('DSH empty-session fork refusal is a business conflict, not an internal error', async () => {
  const forkError = Object.assign(new Error('no completed turn to fork from'), { code: 'session/fork-unavailable' })
  const { request } = makeHarness({ forkError })
  const result = await request('POST', '/duplex-control/api/sessions/s1/fork', {})
  assert.equal(result.status, 409)
  assert.equal(result.body.error_code, 'session/fork-unavailable')
  assert.match(result.body.detail, /完整轮次/)
})

for (const origin of ['harness_ui', 'duplex_control']) {
  test(`DSH settled assistant message reaches results for ${origin}`, async () => {
    const { prompted, request, emitSession } = makeHarness()
    if (origin === 'duplex_control') {
      await request('POST', '/duplex-control/api/sessions/s1/tasks', { task: '仅回答测试完成' })
    }
    emitSession('turn/start', { turn: 3 })
    emitSession('user/message', {
      source: { kind: 'user', rpcId: prompted[0]?.requestId || 'web-request-1' },
      content: [{ type: 'text', text: '仅回答测试完成' }],
    })
    emitSession('assistant/message', {
      turn: 3, step: 1, stream: [],
      message: { content: [{ type: 'text', text: '测试完成' }] },
    })
    emitSession('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const { body } = await request('GET', '/duplex-control/api/results?after=0')
    assert.equal(body.results.length, 1)
    assert.equal(body.results[0].origin, origin)
    assert.equal(body.results[0].session_id, 's1')
    assert.equal(body.results[0].result, '测试完成')
    assert.equal(body.results[0].status, 'succeeded')
    assert.equal((await request('GET', `/duplex-control/api/results?after=${body.next_cursor}`)).body.results.length, 0)
  })
}

test('v7 focused read returns compact-state source and rejects a changed focus', async () => {
  const { request } = makeHarness()
  const read = request('GET', '/duplex-control/api/sessions/s1/composer?require_focus=true')
  const candidate = await nextComposerRequest(request)
  assert.equal(candidate.require_focus, true)
  const snapshot = { session_id: 's1', text: '真实草稿', revision: 1, hash: sha256('真实草稿'), phase: 'plain' }
  await completeComposerRequest(request, candidate, snapshot)
  const result = await read
  assert.equal(result.status, 200)
  assert.equal(result.body.composer.session_name, '测试')
  assert.equal(result.body.composer.text, '真实草稿')

  const racingRead = request('GET', '/duplex-control/api/sessions/s1/composer?require_focus=true')
  const racingCandidate = await nextComposerRequest(request)
  await request('POST', '/duplex-control/api/focus', { session_id: null })
  await completeComposerRequest(request, racingCandidate, snapshot)
  assert.equal((await racingRead).body.error_code, 'focus_conflict')
  const write = await request('PUT', '/duplex-control/api/sessions/s1/composer', {
    expected_revision: 1, expected_hash: snapshot.hash, text: '不可写入', require_focus: true,
  })
  assert.equal(write.status, 409)
  assert.equal(write.body.error_code, 'focus_conflict')
})

async function nextComposerRequest(request) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request('GET', '/duplex-control/api/composer/requests')
    if (response.body.requests.length > 0) return response.body.requests[0]
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('composer request did not appear')
}

async function completeComposerRequest(request, candidate, composer) {
  const claimed = await request(
    'POST',
    `/duplex-control/api/composer/requests/${candidate.id}/claim`,
    { client_id: 'browser-test' },
  )
  assert.equal(claimed.status, 200)
  const completed = await request(
    'POST',
    `/duplex-control/api/composer/requests/${candidate.id}/complete`,
    { client_id: 'browser-test', ok: true, composer },
  )
  assert.equal(completed.status, 200)
}

test('background browser long poll is live and wakes for composer RPC without interval polling', async () => {
  const { request } = makeHarness()
  const waiting = request('GET', '/duplex-control/api/composer/requests?wait=1&client_id=background&session_id=s1&visibility=hidden')
  const health = await request('GET', '/duplex-control/api/health')
  assert.equal(health.body.browser_client_connected, true)
  assert.equal(health.body.browser_client_visibility, 'hidden')
  assert.equal(health.body.browser_client_stale_after_seconds, 45)
  const read = request('GET', '/duplex-control/api/sessions/s1/composer')
  const response = await waiting
  assert.equal(response.body.requests.length, 1)
  const composer = { session_id: 's1', text: '真实草稿', revision: 1, hash: 'h', phase: 'plain' }
  await completeComposerRequest(request, response.body.requests[0], composer)
  assert.equal((await read).status, 200)
})

test('explicit overwrite reaches browser queue without requiring a draft version', async () => {
  const { request } = makeHarness()
  const pending = request('PUT', '/duplex-control/api/sessions/s1/composer', {
    text: '覆盖输入', overwrite: true,
  })
  const candidate = await nextComposerRequest(request)
  assert.equal(candidate.type, 'set')
  assert.equal(candidate.overwrite, true)
  await completeComposerRequest(request, candidate, {
    session_id: 's1', text: '覆盖输入', revision: 2, hash: sha256('覆盖输入'), phase: 'plain',
  })
  assert.equal((await pending).status, 200)
})

test('composer RPC edits without submitting and submits the exact browser draft', async () => {
  const { prompted, request } = makeHarness()
  const initial = {
    session_id: 's1',
    text: '实现登录页',
    phase: 'plain',
    revision: 1,
    hash: sha256('实现登录页'),
  }

  const getPromise = request('GET', '/duplex-control/api/sessions/s1/composer')
  const getCandidate = await nextComposerRequest(request)
  assert.equal(getCandidate.type, 'get')
  await completeComposerRequest(request, getCandidate, initial)
  assert.deepEqual((await getPromise).body.composer, initial)

  const editedText = '实现注册页，并补测试'
  const putPromise = request('PUT', '/duplex-control/api/sessions/s1/composer', {
    expected_revision: initial.revision,
    expected_hash: initial.hash,
    text: editedText,
  })
  const setCandidate = await nextComposerRequest(request)
  assert.equal(setCandidate.type, 'set')
  assert.equal(setCandidate.text, editedText)
  const edited = { ...initial, text: editedText, revision: 2, hash: sha256(editedText) }
  await completeComposerRequest(request, setCandidate, edited)
  assert.deepEqual((await putPromise).body.composer, edited)
  assert.deepEqual(prompted, [])

  const submitPromise = request('POST', '/duplex-control/api/sessions/s1/composer/submit', {
    expected_revision: edited.revision,
    expected_hash: edited.hash,
  })
  const consumeCandidate = await nextComposerRequest(request)
  assert.equal(consumeCandidate.type, 'consume')
  await completeComposerRequest(request, consumeCandidate, {
    ...edited,
    text: '',
    revision: 3,
    hash: sha256(''),
    consumed_text: edited.text,
    consumed_revision: edited.revision,
    consumed_hash: edited.hash,
  })

  const submitted = await submitPromise
  assert.equal(submitted.status, 202)
  assert.equal(submitted.body.requirement.hash, edited.hash)
  assert.equal(prompted.length, 1)
  assert.deepEqual(prompted[0].content, [{ type: 'text', text: editedText }])
})

test('pending approvals and questions can be answered through the plugin', async () => {
  const { request, emitWaterfall } = makeHarness()
  await request('GET', '/duplex-control/api/health')
  const agent = { session: { id: 's1' } }
  const approvalResult = emitWaterfall('approval/request', {
    agent,
    toolName: 'bash',
    reason: '需要读取系统信息',
  })
  const planResult = emitWaterfall('user-questions/request', {
    agent,
    questions: [{
      id: 'plan', question: '是否按这个计划执行？', detail: '# Plan',
      options: [{ label: '批准' }, { label: '继续规划' }],
      intent: { kind: 'plan-review', approve: '批准' },
    }],
  })

  const listed = await request('GET', '/duplex-control/api/interactions')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.interactions.map(item => item.kind), ['approval', 'plan_review'])
  assert.equal(listed.body.interactions[0].resolve, undefined)
  const [approval, planReview] = listed.body.interactions
  for (const interaction of [approval, planReview]) assert.match(interaction.id, /^[A-Za-z0-9_-]+$/)

  const approved = await request(
    'POST',
    `/duplex-control/api/interactions/${encodeURIComponent(approval.id)}/respond`,
    { outcome: 'allowed-once' },
  )
  assert.equal(approved.status, 200)
  assert.equal(await approvalResult, 'allowed-once')

  const replies = []
  const rpc = new HarnessRPCExecutor(reply => replies.push(reply), async (url, options) => {
    const response = await request(options.method, url, JSON.parse(options.body))
    return new Response(JSON.stringify(response.body), { status: response.status })
  })
  await rpc.execute({ type: 'harness.rpc.request', request_id: 'a'.repeat(32), connection_id: 'b'.repeat(32),
    method: 'POST', path: `/api/interactions/${encodeURIComponent(planReview.id)}/respond`,
    payload: { answers: [{ id: 'plan', selected: ['批准'] }] } })
  assert.equal(replies[0].status, 200)
  assert.equal(rpc.closed, false)
  rpc.close()
  assert.deepEqual((await planResult).answers, [
    { id: 'plan', selected: ['批准'] },
  ])
})

test('inactive duplex runtime delegates interactions to the official WebUI', async () => {
  const { emitWaterfall } = makeHarness()
  const result = await emitWaterfall(
    'approval/request',
    { agent: { session: { id: 's1' } }, toolName: 'bash' },
    'official-webui',
  )
  assert.equal(result, 'official-webui')
})

test('native-capable browser keeps questions and approvals in DSH while voice is active', async () => {
  const { request, emitWaterfall } = makeHarness()
  await request('GET', '/duplex-control/api/health', undefined, { 'x-duet-native-interactions': '1' })
  for (const event of ['approval/request', 'user-questions/request']) {
    assert.equal(await emitWaterfall(event, { agent: { session: { id: 's1' } }, questions: [] }, 'native-clickable'), 'native-clickable')
  }
  assert.equal((await request('GET', '/duplex-control/api/interactions')).body.interactions.length, 0)
})

test('browser heartbeat reports connection and actual focus agreement', async () => {
  const { request } = makeHarness()
  await request('GET', '/duplex-control/api/sessions')

  const disconnected = await request('GET', '/duplex-control/api/health')
  assert.equal(disconnected.body.browser_client_connected, false)
  assert.equal(disconnected.body.browser_focus_matches, false)
  assert.equal(disconnected.body.browser_client_status_version, 'harness_browser_client_status_v1')
  assert.equal(disconnected.body.duplex_runtime_connected, true)
  assert.equal(disconnected.body.duplex_runtime_stale_after_seconds, 3)

  const heartbeat = await request(
    'POST',
    '/duplex-control/api/browser-clients/heartbeat',
    { client_id: 'browser-1', session_id: 's1', visibility: 'visible' },
  )
  assert.equal(heartbeat.status, 200)
  assert.equal(typeof heartbeat.body.focus_epoch, 'string')

  const connected = await request('GET', '/duplex-control/api/health')
  assert.equal(connected.body.browser_client_connected, true)
  assert.equal(connected.body.browser_client_count, 1)
  assert.equal(connected.body.browser_focus_session_id, 's1')
  assert.equal(connected.body.browser_focus_matches, true)
  assert.equal(connected.body.browser_client_visibility, 'visible')
})

test('focus epoch changes across host restarts and revision has a legacy-safe baseline', async () => {
  const first = makeHarness()
  const second = makeHarness()
  const firstFocus = (await first.request('GET', '/duplex-control/api/focus')).body
  const secondFocus = (await second.request('GET', '/duplex-control/api/focus')).body

  assert.notEqual(firstFocus.focus_epoch, secondFocus.focus_epoch)
  assert.ok(firstFocus.revision > 1_000_000_000_000)
  assert.ok(secondFocus.revision > 1_000_000_000_000)
})
