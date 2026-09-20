/** duet Host entry: session operations, authenticated settings, and client assets. */

import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { registerDuetProxy, duetConfig } from './proxy.mjs'
import { DuetSettings, settingsWriteAllowed } from './settings.mjs'
import { ServiceNotices } from './notices.mjs'
import { ServiceInfo } from './service-info.mjs'
import { DuetTrace } from './trace.mjs'
import { FeedbackService } from './feedback-store.mjs'
import { RemoteFeedback } from './feedback-files.mjs'
import { PLUGIN_VERSION } from '../shared/state.mjs'
import { buildSessionCatalog } from '../shared/catalog.mjs'
import { publicAsset } from './assets.mjs'
import { duetEnv } from './environment.mjs'

const ROUTE = '/duplex-control'
const PAGE_ROUTE = '/duet'
const MAX_BODY_BYTES = 100_000
const MAX_JOBS = 500
const MAX_COMPOSER_REQUESTS = 500
const COMPOSER_RPC_TIMEOUT_MS = 5_000
// Long polling refreshes liveness every <=20s even when background timers slow.
// This remains a finite lease, not a claim that a frozen/closed tab is usable.
const BROWSER_CLIENT_STALE_SECONDS = 45
const DUET_RUNTIME_STALE_SECONDS = 3
const HTML_URL = new URL('../client/settings.html', import.meta.url)

export const name = 'dsh-duet'
export const inject = [
  'webServer',
  'connection',
  'sessionController',
  'workspaceController',
  'workspaceRegistry',
]

function nowSeconds() {
  return Date.now() / 1000
}

function increasedForkTitle(title) {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}

function publicJob(job) {
  const { turn: _turn, rpcId: _rpcId, ...value } = job
  return { ...value }
}

function publicComposerRequest(request) {
  return {
    id: request.id,
    sequence: request.sequence,
    type: request.type,
    session_id: request.session_id,
    expected_revision: request.expected_revision,
    expected_hash: request.expected_hash,
    require_focus: request.require_focus,
    overwrite: request.overwrite,
    text: request.text,
    claimed_by: request.claimed_by || null,
    created_at: request.created_at,
  }
}

function publicInteraction(interaction) {
  const {
    resolve: _resolve,
    reject: _reject,
    signal: _signal,
    on_abort: _onAbort,
    ...value
  } = interaction
  return { ...value }
}

function codedError(code, message, status = 409) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function assistantText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function userText(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res, status, message) {
  sendJson(res, status, { detail: message })
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('request body must be a JSON object')
  }
  return value
}

export function apply(ctx, options = {}) {
  const jobs = new Map()
  const jobOrder = []
  const composerRequests = new Map()
  const composerPollWaiters = new Set()
  const composerRequestOrder = []
  const currentTurn = new Map()
  const jobByTurn = new Map()
  const pendingInteractions = new Map()
  const browserClients = new Map()
  const focusEpoch = randomUUID()
  let activeSessionId
  let activeSessionInitialized = false
  // A wall-clock baseline keeps browser clients from an older host process
  // compatible: their in-memory lastRevision must never shadow a restarted host.
  let focusRevision = Date.now()
  let completionSequence = 0
  let composerRequestSequence = 0
  let lastDuetRuntimeSeenAt = 0
  let lastNativeInteractionsSeenAt = -Infinity
  const hostAbort = new AbortController()

  const voice = duetConfig()
  const settings = new DuetSettings(voice, { path: options.settingsPath, debug: options.debug === true || duetEnv('DEBUG') === '1' })
  Object.assign(voice, settings.effective())
  const audit = new DuetTrace({ kind: 'host', plugin_version: PLUGIN_VERSION, pid: process.pid },
    { ...options.traceOptions, secrets: [voice.authorization] })
  ctx.effect(() => () => { void audit.close({ reason: 'plugin_dispose' }) })
  const notices = new ServiceNotices(() => settings.effective())
  const serviceInfo = new ServiceInfo(() => settings.effective())
  const feedbackStore = options.feedbackStore ?? (options.feedbackDisabled ? null : new RemoteFeedback(()=>settings.effective(),{keyPath:options.feedbackIdentityPath}))
  const feedback = new FeedbackService(feedbackStore)
  let duetProxy
  ctx.effect(() => { duetProxy = registerDuetProxy(ctx, voice, feedback); return duetProxy })

  ctx.effect(() => () => { hostAbort.abort() })

  const duetRuntimeActive = () => (
    nowSeconds() - lastDuetRuntimeSeenAt <= DUET_RUNTIME_STALE_SECONDS
  )
  // A background tab may throttle its heartbeat. Once the native UI capability
  // is known, never steal its requests again during this Host lifetime.
  const nativeInteractionsActive = () => Number.isFinite(lastNativeInteractionsSeenAt)

  const rememberInteraction = (interaction) => {
    audit.event('interaction.created', publicInteraction(interaction))
    pendingInteractions.set(interaction.id, interaction)
  }

  const pendingInteraction = (value, signal) => new Promise((resolve, reject) => {
    const interaction = { ...value, resolve, reject, signal, on_abort: undefined }
    if (signal !== undefined) {
      const onAbort = () => {
        if (!pendingInteractions.delete(interaction.id)) return
        audit.event('interaction.aborted', { id: interaction.id, reason: String(signal.reason) })
        reject(signal.reason || codedError('interaction_cancelled', 'Harness interaction cancelled'))
      }
      interaction.on_abort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
    rememberInteraction(interaction)
  })

  const finishInteraction = (interaction, settle) => {
    pendingInteractions.delete(interaction.id)
    if (interaction.signal !== undefined && interaction.on_abort !== undefined) {
      interaction.signal.removeEventListener('abort', interaction.on_abort)
    }
    settle()
  }

  ctx.on('approval/request', function (request, next) {
    if (!duetRuntimeActive() || nativeInteractionsActive()) return next()
    // IDs are opaque and URL-safe.
    const id = `approval_${randomUUID().replaceAll('-', '')}`
    return pendingInteraction({
      id,
      kind: 'approval',
      session_id: String(request.agent?.session?.id || activeSessionId || ''),
      approval_id: id.slice('approval_'.length),
      tool_name: String(request.toolName || ''),
      call_id: String(request.callId || ''),
      reason: String(request.reason || ''),
      created_at: nowSeconds(),
    }, request.signal)
  }, { prepend: true })

  ctx.on('user-questions/request', function (request, next) {
    if (!duetRuntimeActive() || nativeInteractionsActive()) return next()
    const questions = Array.isArray(request.questions) ? request.questions : []
    const planReview = questions.some(question => question?.intent?.kind === 'plan-review')
    const id = `question_${randomUUID().replaceAll('-', '')}`
    return pendingInteraction({
      id,
      kind: planReview ? 'plan_review' : 'question',
      session_id: String(request.agent?.session?.id || activeSessionId || ''),
      questions,
      created_at: nowSeconds(),
    }, request.signal)
  }, { prepend: true })

  ctx.effect(() => () => {
    for (const interaction of pendingInteractions.values()) {
      finishInteraction(interaction, () => {
        interaction.reject(codedError('plugin_stopped', 'duet plugin stopped'))
      })
    }
  })

  const removeComposerRequest = (request) => {
    clearTimeout(request.timer)
    composerRequests.delete(request.id)
  }

  const requestComposer = (type, payload) => new Promise((resolve, reject) => {
    const id = randomUUID().replaceAll('-', '')
    composerRequestSequence += 1
    const request = {
      id,
      sequence: composerRequestSequence,
      type,
      session_id: String(payload.session_id || ''),
      expected_revision: payload.expected_revision,
      expected_hash: payload.expected_hash,
      require_focus: payload.require_focus === true,
      overwrite: type === 'set' && payload.overwrite === true,
      text: payload.text,
      claimed_by: '',
      created_at: nowSeconds(),
      resolve,
      reject,
      timer: undefined,
    }
    request.timer = setTimeout(() => {
      if (!composerRequests.has(id)) return
      removeComposerRequest(request)
      reject(codedError(
        'composer_client_unavailable',
        '没有可用的 DeepSeek Harness 主页面来执行输入框操作',
        503,
      ))
    }, COMPOSER_RPC_TIMEOUT_MS)
    composerRequests.set(id, request)
    composerRequestOrder.push(id)
    for (const wake of [...composerPollWaiters]) wake()
    while (composerRequestOrder.length > MAX_COMPOSER_REQUESTS) {
      const staleId = composerRequestOrder.shift()
      const stale = composerRequests.get(staleId)
      if (stale === undefined) continue
      removeComposerRequest(stale)
      stale.reject(codedError('composer_request_evicted', '输入框请求队列已满', 503))
    }
  })

  const listSessions = async ({forCatalog = false} = {}) => {
    const { items } = await ctx.sessionController.list({}, hostAbort.signal)
    const catalog = buildSessionCatalog(items, {
      archivedIds: ctx.workspaceRegistry.archivedSessionIds,
      workspaces: ctx.workspaceRegistry.list?.() || [],
      activeId: activeSessionId,
      includeBlank: !forCatalog,
    })
    if (!activeSessionInitialized) {
      activeSessionId = catalog[0]?.session_id
      activeSessionInitialized = true
    }
    return catalog.map(item => ({...item, active:item.session_id === activeSessionId}))
  }

  const rememberJob = (job) => {
    jobs.set(job.id, job)
    jobOrder.push(job.id)
    while (jobOrder.length > MAX_JOBS) jobs.delete(jobOrder.shift())
  }

  const enqueueTask = async (sessionId, task, origin = 'duplex_control') => {
    const normalizedTask = String(task || '')
    if (!normalizedTask.trim()) throw codedError('empty_task', 'Harness task is empty', 400)
    const id = randomUUID().replaceAll('-', '')
    const job = {
      id,
      origin,
      session_id: sessionId,
      task: normalizedTask,
      status: 'queued',
      result: '',
      error: '',
      created_at: nowSeconds(),
      started_at: null,
      completed_at: null,
      completion_seq: null,
      turn: undefined,
      rpcId: `duplex-job-${id}`,
    }
    rememberJob(job)
    try {
      await ctx.sessionController.prompt({
        requestId: job.rpcId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: normalizedTask }],
      }, hostAbort.signal)
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.completed_at = nowSeconds()
      completionSequence += 1
      job.completion_seq = completionSequence
      throw error
    }
    selectSession(sessionId)
    return job
  }

  const selectSession = (sessionId, focus = true) => {
    if (activeSessionInitialized && activeSessionId === sessionId) return false
    activeSessionId = sessionId
    activeSessionInitialized = true
    if (focus) focusRevision += 1
    return true
  }

  const browserClientStatus = () => {
    const now = nowSeconds()
    for (const [clientId, client] of browserClients) {
      if (now - client.last_seen_at > BROWSER_CLIENT_STALE_SECONDS) {
        browserClients.delete(clientId)
      }
    }
    const liveClients = [...browserClients.values()]
      .sort((left, right) => right.last_seen_at - left.last_seen_at)
    const latest = liveClients[0]
    const browserSessionId = latest?.session_id || null
    return {
      browser_client_connected: liveClients.length > 0,
      browser_client_count: liveClients.length,
      browser_focus_session_id: browserSessionId,
      browser_focus_matches: liveClients.length > 0
        && browserSessionId !== null
        && browserSessionId === (activeSessionId || null),
      browser_client_last_seen_at: latest?.last_seen_at || null,
      browser_client_visibility: latest?.visibility || null,
      browser_client_stale_after_seconds: BROWSER_CLIENT_STALE_SECONDS,
    }
  }

  const turnKey = (sessionId, turn) => `${sessionId}:${String(turn)}`

  const completeJob = (job, event) => {
    job.completed_at = nowSeconds()
    if (event.data.reason?.kind === 'aborted') {
      job.status = 'failed'
      job.error = 'Harness turn was aborted, not completed'
    } else if (event.data.reason?.kind === 'error') {
      job.status = 'failed'
      job.error = String(event.data.reason.error || 'Harness turn failed')
    } else if (!job.result) {
      job.status = 'failed'
      job.error = `Harness turn ended without a final text response (${event.data.reason?.kind || 'unknown'})`
    } else {
      job.status = 'succeeded'
    }
    completionSequence += 1
    job.completion_seq = completionSequence
  }

  ctx.on('session/event', (session, event) => {
    if (['turn/start', 'turn/end', 'user/message'].includes(event.type)) {
      audit.event('dsh.session_event', { session_id: session.id, event })
    }
    const sessionId = String(session.id)
    if (event.type === 'turn/start') {
      currentTurn.set(sessionId, event.data.turn)
      return
    }
    if (event.type === 'user/message') {
      const rpcId = event.data?.source?.rpcId
      const turn = currentTurn.get(sessionId)
      if (turn === undefined) return
      let job
      if (typeof rpcId === 'string' && rpcId.startsWith('duplex-job-')) {
        job = jobs.get(rpcId.slice('duplex-job-'.length))
      } else if (event.data?.source?.kind === 'user') {
        const key = turnKey(sessionId, turn)
        const existing = jobByTurn.get(key)
        job = existing === undefined ? undefined : jobs.get(existing)
        if (job === undefined) {
          const id = randomUUID().replaceAll('-', '')
          job = {
            id,
            origin: 'harness_ui',
            session_id: sessionId,
            task: userText(event),
            status: 'running',
            result: '',
            error: '',
            created_at: event.time / 1000,
            started_at: nowSeconds(),
            completed_at: null,
            completion_seq: null,
            turn,
            rpcId: typeof rpcId === 'string' ? rpcId : '',
          }
          rememberJob(job)
        }
      }
      if (job === undefined) return
      job.turn = turn
      job.status = 'running'
      job.started_at ??= nowSeconds()
      jobByTurn.set(turnKey(sessionId, turn), job.id)
      return
    }
    if (event.type === 'assistant/message') {
      const id = jobByTurn.get(turnKey(sessionId, event.data.turn))
      const job = id === undefined ? undefined : jobs.get(id)
      if (job === undefined) return
      const text = assistantText(event)
      if (text) job.result = text
      return
    }
    if (event.type !== 'turn/end') return
    const key = turnKey(sessionId, event.data.turn)
    const id = jobByTurn.get(key)
    const job = id === undefined ? undefined : jobs.get(id)
    currentTurn.delete(sessionId)
    jobByTurn.delete(key)
    if (job === undefined) return
    completeJob(job, event)
  })

  const handleApi = async (req, res, pathname) => {
    if(req.method==='POST' && pathname===`${ROUTE}/api/feedback`){
      if(!settingsWriteAllowed(req)){sendError(res,403,'same-origin feedback request required');return}
      try {sendJson(res,201,await feedback.submit(req,await readJson(req)))}
      catch(error){
        const code=String(error.message||'')
        const invalid=code.startsWith('invalid_feedback')
        sendJson(res,invalid?400:code==='feedback_session_unavailable'?409:503,
          {persisted:false,error_code:invalid?code:code==='feedback_session_unavailable'?code:'feedback_unavailable'})
      }
      return
    }
    if (req.method === 'POST' && pathname === `${ROUTE}/api/voice/diagnostic`) {
      if (!settingsWriteAllowed(req)) { sendError(res, 403, 'same-origin diagnostic request required'); return }
      const body = await readJson(req)
      if (JSON.stringify(body).length > 24000) { sendError(res, 413, 'diagnostic too large'); return }
      audit.event('client.diagnostic', body)
      sendJson(res, 200, { ok: true, logging: audit.snapshot() }); return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/voice/service-info`) {
      sendJson(res, 200, await serviceInfo.get())
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/voice/config`) {
      try{feedbackStore?.ensureIdentity?.(req,res)}catch{sendJson(res,503,{error_code:'feedback_identity_unavailable'});return}
      sendJson(res, 200, { ...settings.public(), plugin_version: PLUGIN_VERSION, feedback_enabled: feedback.enabled, connection: duetProxy?.snapshot?.() || { online: 0, tts_only: 0 } })
      return
    }
    if (req.method === 'PUT' && pathname === `${ROUTE}/api/voice/config`) {
      if (!settingsWriteAllowed(req)) { sendError(res, 403, 'same-origin settings request required'); return }
      try {
        const result = await settings.save(await readJson(req))
        Object.assign(voice, settings.effective())
        feedback.sessions.clear() // Never send an old rating to a newly selected backend.
        audit.secrets.push(voice.authorization)
        notices.invalidate()
        serviceInfo.invalidate()
        duetProxy?.closeConnections?.('voice_settings_changed')
        sendJson(res, 200, result)
      } catch (error) { sendError(res, 400, error.message) }
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/announcements`) {
      sendJson(res, 200, await notices.get())
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/health`) {
      sendJson(res, 200, {
        ok: true,
        service: 'deepseek-harness-duplex-control-plugin',
        active_session_id: activeSessionId || null,
        focus_epoch: focusEpoch,
        focus_revision: focusRevision,
        job_count: jobs.size,
        result_cursor: completionSequence,
        composer_rpc_version: 'harness_browser_composer_rpc_v1',
        plugin_version: PLUGIN_VERSION,
        diagnostic_logging: audit.snapshot(),
        direct_state_version: 'harness_direct_v7_input_status_edit_recovery',
        composer_state_fields: ['session_name', 'text'],
        pending_composer_request_count: composerRequests.size,
        interaction_rpc_version: 'harness_pending_interaction_rpc_v1',
        pending_interaction_count: pendingInteractions.size,
        duplex_runtime_connected: duetRuntimeActive(),
        duplex_runtime_last_seen_at: lastDuetRuntimeSeenAt || null,
        duplex_runtime_stale_after_seconds: DUET_RUNTIME_STALE_SECONDS,
        browser_client_status_version: 'harness_browser_client_status_v1',
        ...browserClientStatus(),
      })
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/interactions`) {
      const interactions = [...pendingInteractions.values()]
        .sort((left, right) => left.created_at - right.created_at)
        .map(publicInteraction)
      sendJson(res, 200, { interactions })
      return
    }
    const respondInteraction = pathname.match(
      new RegExp(`^${ROUTE}/api/interactions/([^/]+)/respond$`),
    )
    if (req.method === 'POST' && respondInteraction !== null) {
      const interactionId = decodeURIComponent(respondInteraction[1])
      const interaction = pendingInteractions.get(interactionId)
      if (interaction === undefined) {
        sendError(res, 404, 'pending interaction not found')
        return
      }
      const body = await readJson(req)
      audit.event('interaction.respond', { interaction_id: interactionId, body })
      let result
      if (interaction.kind === 'approval') {
        const outcome = String(body.outcome || '')
        if (!['allowed-once', 'rejected'].includes(outcome)) {
          sendError(res, 400, 'approval outcome must be allowed-once or rejected')
          return
        }
        result = {
          ok: true,
          value: {
            sessionId: interaction.session_id,
            approvalId: interaction.approval_id,
            outcome,
          },
        }
      } else if (body.cancelled === true) {
        result = {
          ok: false,
          error: { code: 'cancelled', message: 'cancelled by user', details: {} },
        }
      } else {
        if (!Array.isArray(body.answers)) {
          sendError(res, 400, 'question answers must be an array')
          return
        }
        result = {
          ok: true,
          value: {
            sessionId: interaction.session_id,
            answer: { answers: body.answers },
          },
        }
      }
      if (interaction.kind === 'approval') {
        finishInteraction(interaction, () => { interaction.resolve(result.value.outcome) })
      } else if (body.cancelled === true) {
        finishInteraction(interaction, () => {
          interaction.reject(codedError('ASK_CANCELLED', 'cancelled by user'))
        })
      } else {
        finishInteraction(interaction, () => {
          interaction.resolve(result.value.answer)
        })
      }
      sendJson(res, 200, { ok: true, interaction_id: interactionId })
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/focus`) {
      sendJson(res, 200, {
        session_id: activeSessionId || null,
        focus_epoch: focusEpoch,
        revision: focusRevision,
      })
      return
    }
    if (req.method === 'POST' && pathname === `${ROUTE}/api/browser-clients/heartbeat`) {
      const body = await readJson(req)
      const clientId = String(body.client_id || '').trim()
      if (!clientId) {
        sendError(res, 400, 'client_id is required')
        return
      }
      const sessionId = body.session_id === null || body.session_id === undefined
        ? null
        : String(body.session_id)
      browserClients.set(clientId, {
        client_id: clientId,
        session_id: sessionId,
        visibility: String(body.visibility || 'unknown'),
        last_seen_at: nowSeconds(),
      })
      sendJson(res, 200, {
        ok: true,
        focus_epoch: focusEpoch,
        focus_revision: focusRevision,
        active_session_id: activeSessionId || null,
      })
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/composer/requests`) {
      const url = new URL(req.url || '/', 'http://localhost')
      const clientId = url.searchParams.get('client_id')
      const touch = () => {
        if (!clientId) return
        browserClients.set(clientId, {
          client_id: clientId,
          session_id: url.searchParams.get('session_id') || null,
          visibility: url.searchParams.get('visibility') || 'unknown',
          last_seen_at: nowSeconds(),
        })
      }
      touch()
      if (url.searchParams.get('wait') === '1'
          && ![...composerRequests.values()].some(request => !request.claimed_by)) {
        await new Promise(resolve => {
          let timer
          const done = () => {
            clearTimeout(timer)
            composerPollWaiters.delete(done)
            res.off?.('close', done)
            hostAbort.signal.removeEventListener('abort', done)
            resolve()
          }
          composerPollWaiters.add(done)
          res.once?.('close', done)
          hostAbort.signal.addEventListener('abort', done, { once: true })
          timer = setTimeout(done, 20_000)
        })
      }
      if (res.destroyed || hostAbort.signal.aborted) return
      const pending = composerRequestOrder
        .map(id => composerRequests.get(id))
        .filter(request => request !== undefined && !request.claimed_by)
        .slice(0, 20)
        .map(publicComposerRequest)
      sendJson(res, 200, {
        requests: pending,
        next_cursor: composerRequestSequence,
        long_poll_supported: true,
      })
      return
    }
    const claimComposer = pathname.match(
      new RegExp(`^${ROUTE}/api/composer/requests/([^/]+)/claim$`),
    )
    if (req.method === 'POST' && claimComposer !== null) {
      const requestId = decodeURIComponent(claimComposer[1])
      const body = await readJson(req)
      const clientId = String(body.client_id || '').trim()
      if (!clientId) {
        sendError(res, 400, 'client_id is required')
        return
      }
      const request = composerRequests.get(requestId)
      if (request === undefined) {
        sendError(res, 404, 'composer request not found')
        return
      }
      if (request.claimed_by && request.claimed_by !== clientId) {
        sendError(res, 409, 'composer request is already claimed')
        return
      }
      request.claimed_by = clientId
      sendJson(res, 200, { request: publicComposerRequest(request) })
      return
    }
    const completeComposer = pathname.match(
      new RegExp(`^${ROUTE}/api/composer/requests/([^/]+)/complete$`),
    )
    if (req.method === 'POST' && completeComposer !== null) {
      const requestId = decodeURIComponent(completeComposer[1])
      const body = await readJson(req)
      const clientId = String(body.client_id || '').trim()
      const request = composerRequests.get(requestId)
      if (request === undefined) {
        sendError(res, 404, 'composer request not found')
        return
      }
      if (!clientId || request.claimed_by !== clientId) {
        sendError(res, 409, 'composer request is not owned by this client')
        return
      }
      removeComposerRequest(request)
      if (body.ok) {
        request.resolve(body.composer)
      } else {
        request.reject(codedError(
          String(body.error_code || 'composer_operation_failed'),
          String(body.error || 'Harness composer operation failed'),
          Number(body.status || 409),
        ))
      }
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && pathname === `${ROUTE}/api/focus`) {
      const body = await readJson(req)
      const sessionId = body.session_id === null || body.session_id === undefined
        ? undefined
        : String(body.session_id)
      if (sessionId !== undefined) {
        const sessions = await listSessions()
        if (!sessions.some(session => session.session_id === sessionId)) {
          sendError(res, 404, 'Harness session not found')
          return
        }
      }
      selectSession(sessionId)
      sendJson(res, 200, {
        ok: true,
        active_session_id: activeSessionId || null,
        focus_epoch: focusEpoch,
        focus_revision: focusRevision,
      })
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/sessions`) {
      sendJson(res, 200, { sessions: await listSessions({forCatalog:true}) })
      return
    }
    const composer = pathname.match(new RegExp(`^${ROUTE}/api/sessions/([^/]+)/composer$`))
    if (composer !== null && ['GET', 'PUT'].includes(req.method)) {
      const sessionId = decodeURIComponent(composer[1])
      const sessions = await listSessions()
      if (!sessions.some(session => session.session_id === sessionId)) {
        sendError(res, 404, 'Harness session not found')
        return
      }
      if (req.method === 'GET') {
        const requireFocus = new URL(req.url, 'http://localhost').searchParams.get('require_focus') === 'true'
        if (requireFocus && sessionId !== activeSessionId) {
          throw codedError('focus_conflict', '当前聚焦会话已变化，请重新查询输入框')
        }
        const state = await requestComposer('get', { session_id: sessionId, require_focus: requireFocus })
        if (requireFocus && sessionId !== activeSessionId) {
          throw codedError('focus_conflict', '当前聚焦会话已变化，请重新查询输入框')
        }
        sendJson(res, 200, { composer: {
          ...state,
          ...(requireFocus ? { session_name: sessions.find(item => item.session_id === sessionId)?.label || '' } : {}),
        } })
        return
      }
      const body = await readJson(req)
      if (body.overwrite !== true && (!Number.isInteger(body.expected_revision) || body.expected_revision < 0)) {
        sendError(res, 400, 'expected_revision must be a non-negative integer')
        return
      }
      if (body.overwrite !== true && !/^[0-9a-f]{64}$/u.test(String(body.expected_hash || ''))) {
        sendError(res, 400, 'expected_hash must be a lowercase SHA256 digest')
        return
      }
      if (typeof body.text !== 'string') {
        sendError(res, 400, 'composer text must be a string')
        return
      }
      if (body.require_focus === true && sessionId !== activeSessionId) {
        throw codedError('focus_conflict', '当前聚焦会话已变化，请重新查询输入框')
      }
      const state = await requestComposer('set', {
        session_id: sessionId,
        expected_revision: body.expected_revision,
        expected_hash: body.expected_hash,
        text: body.text,
        require_focus: body.require_focus,
        overwrite: body.overwrite === true,
      })
      sendJson(res, 200, { composer: state })
      return
    }
    const submitComposer = pathname.match(
      new RegExp(`^${ROUTE}/api/sessions/([^/]+)/composer/submit$`),
    )
    if (req.method === 'POST' && submitComposer !== null) {
      const sessionId = decodeURIComponent(submitComposer[1])
      const body = await readJson(req)
      const expectedRevision = body.expected_revision
      const expectedHash = String(body.expected_hash || '')
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        sendError(res, 400, 'expected_revision must be a non-negative integer')
        return
      }
      if (!/^[0-9a-f]{64}$/u.test(expectedHash)) {
        sendError(res, 400, 'expected_hash must be a lowercase SHA256 digest')
        return
      }
      const sessions = await listSessions()
      if (!sessions.some(session => session.session_id === sessionId)) {
        sendError(res, 404, 'Harness session not found')
        return
      }
      const consumed = await requestComposer('consume', {
        session_id: sessionId,
        expected_revision: expectedRevision,
        expected_hash: expectedHash,
      })
      if (
        consumed.consumed_revision !== expectedRevision
        || consumed.consumed_hash !== expectedHash
      ) {
        throw codedError('draft_conflict', '输入框已被修改，请确认最新内容后重试')
      }
      const task = String(consumed.consumed_text || '')
      if (!task.trim()) throw codedError('empty_draft', '当前输入框为空，不能发送', 400)
      let job
      try {
        job = await enqueueTask(sessionId, task)
      } catch (error) {
        try {
          await requestComposer('set', {
            session_id: sessionId,
            expected_revision: consumed.revision,
            expected_hash: consumed.hash,
            text: task,
          })
        } catch (restoreError) {
          error.restore_error = {
            code: String(restoreError?.code || 'composer_restore_failed'),
            message: restoreError instanceof Error ? restoreError.message : String(restoreError),
          }
        }
        throw error
      }
      sendJson(res, 202, {
        job: publicJob(job),
        requirement: {
          revision: expectedRevision,
          hash: expectedHash,
          state: 'submitted',
        },
        composer: consumed,
      })
      return
    }
    if (req.method === 'POST' && pathname === `${ROUTE}/api/sessions`) {
      const body = await readJson(req)
      const name = String(body.name || '').trim()
      const cwd = String(body.cwd || process.cwd()).trim()
      // Current DSH only enables the blank-session composer for a session
      // owned by a registered workspace. cwd alone creates an orphan session.
      let workspaceId
      if (typeof ctx.workspaceController.create === 'function') {
        const resolved = await ctx.workspaceController.create({ path: cwd })
        workspaceId = resolved.workspace?.workspaceId
        if (typeof workspaceId !== 'string' || !workspaceId) {
          throw codedError('workspace_resolution_failed', 'DSH did not resolve a workspace', 502)
        }
      }
      const created = await ctx.sessionController.create(workspaceId ? { workspaceId } : { cwd })
      selectSession(created.sessionId)
      if (name) {
        await ctx.sessionController.rename({ sessionId: created.sessionId, title: name })
      }
      sendJson(res, 201, { session: { session_id: created.sessionId, label: name || created.sessionId, active: true } })
      return
    }

    const activate = pathname.match(new RegExp(`^${ROUTE}/api/sessions/([^/]+)/activate$`))
    if (req.method === 'POST' && activate !== null) {
      const sessionId = decodeURIComponent(activate[1])
      const sessions = await listSessions()
      if (!sessions.some(session => session.session_id === sessionId)) {
        sendError(res, 404, 'Harness session not found')
        return
      }
      selectSession(sessionId)
      sendJson(res, 200, {
        ok: true,
        active_session_id: sessionId,
        focus_epoch: focusEpoch,
        focus_revision: focusRevision,
      })
      return
    }

    const rename = pathname.match(new RegExp(`^${ROUTE}/api/sessions/([^/]+)/rename$`))
    if (req.method === 'POST' && rename !== null) {
      const sessionId = decodeURIComponent(rename[1])
      const body = await readJson(req)
      const title = String(body.title || '').trim()
      if (!title) {
        sendError(res, 400, 'Harness session title is empty')
        return
      }
      const sessions = await listSessions()
      if (!sessions.some(session => session.session_id === sessionId)) {
        sendError(res, 404, 'Harness session not found')
        return
      }
      const result = await ctx.sessionController.rename({ sessionId, title })
      sendJson(res, 200, {
        ok: true,
        session: { session_id: sessionId, label: result.title },
      })
      return
    }

    const fork = pathname.match(new RegExp(`^${ROUTE}/api/sessions/([^/]+)/fork$`))
    if (req.method === 'POST' && fork !== null) {
      const sessionId = decodeURIComponent(fork[1])
      const sessions = await listSessions()
      const source = sessions.find(session => session.session_id === sessionId)
      if (source === undefined) {
        sendError(res, 404, 'Harness session not found')
        return
      }
      let created
      try {
        created = await ctx.sessionController.fork({ sessionId })
      } catch (error) {
        if (error?.code === 'session/fork-unavailable') {
          throw codedError(error.code, '当前会话还没有可分叉的完整轮次，请等一轮完成后再分叉')
        }
        throw error
      }
      const title = increasedForkTitle(source.label)
      const renamed = await ctx.sessionController.rename({
        sessionId: created.sessionId,
        title,
      })
      selectSession(created.sessionId)
      sendJson(res, 201, {
        ok: true,
        session: {
          session_id: created.sessionId,
          label: renamed.title,
          active: true,
          parent_session_id: sessionId,
        },
        focus_revision: focusRevision,
      })
      return
    }

    const archive = pathname.match(new RegExp(`^${ROUTE}/api/sessions/([^/]+)/archive$`))
    if (req.method === 'POST' && archive !== null) {
      const sessionId = decodeURIComponent(archive[1])
      const sessions = await listSessions()
      if (!sessions.some(session => session.session_id === sessionId)) {
        sendError(res, 404, 'Harness session not found')
        return
      }
      const wasActive = activeSessionId === sessionId
      const result = await ctx.workspaceController.archiveSession({ sessionId })
      if (wasActive) {
        const remaining = await listSessions()
        selectSession(remaining[0]?.session_id)
      }
      sendJson(res, 200, {
        ok: true,
        archived_session_id: sessionId,
        active_session_id: activeSessionId || null,
        focus_revision: focusRevision,
        archived_session_count: result.archivedSessionIds.length,
      })
      return
    }

    const submit = pathname.match(new RegExp(`^${ROUTE}/api/sessions/([^/]+)/tasks$`))
    if (req.method === 'POST' && submit !== null) {
      const sessionId = decodeURIComponent(submit[1])
      const body = await readJson(req)
      const task = String(body.task || '').trim()
      if (!task) {
        sendError(res, 400, 'Harness task is empty')
        return
      }
      const job = await enqueueTask(sessionId, task)
      sendJson(res, 202, { job: publicJob(job) })
      return
    }

    if (req.method === 'GET' && pathname === `${ROUTE}/api/jobs`) {
      const values = jobOrder.slice().reverse().map(id => publicJob(jobs.get(id))).filter(Boolean)
      sendJson(res, 200, { jobs: values })
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/api/results`) {
      const url = new URL(req.url || '/', 'http://localhost')
      const after = Math.max(0, Number.parseInt(url.searchParams.get('after') || '0', 10) || 0)
      const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100))
      const completed = jobOrder
        .map(id => jobs.get(id))
        .filter(job => job?.completion_seq > after)
        .sort((left, right) => left.completion_seq - right.completion_seq)
      const selected = completed.slice(0, limit)
      const nextCursor = selected.length === 0 ? after : selected[selected.length - 1].completion_seq
      sendJson(res, 200, {
        results: selected.map(publicJob),
        next_cursor: nextCursor,
        current_cursor: completionSequence,
        has_more: completed.length > selected.length,
      })
      return
    }
    const getJob = pathname.match(new RegExp(`^${ROUTE}/api/jobs/([^/]+)$`))
    if (req.method === 'GET' && getJob !== null) {
      const job = jobs.get(decodeURIComponent(getJob[1]))
      if (job === undefined) {
        sendError(res, 404, 'job not found')
        return
      }
      sendJson(res, 200, { job: publicJob(job) })
      return
    }
    sendError(res, 404, 'not found')
  }

  const handler = async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname
    try {
      if ([PAGE_ROUTE, `${PAGE_ROUTE}/`, ROUTE, `${ROUTE}/`, `${ROUTE}/api/voice/config`, `${ROUTE}/api/voice/service-info`, `${ROUTE}/api/voice/diagnostic`, `${ROUTE}/api/announcements`].includes(pathname)) {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection) { sendError(res, rejection, '请先打开并登录 DSH 主页面'); return }
      }
      const tutorialAudio = pathname.match(/^\/duplex-control\/tutorial-audio\/(modes_broadcast|modes_interaction|broadcast|input|edit|clear|reinput|send|switch)\.wav$/)
      if (req.method === 'GET' && tutorialAudio) {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection) { sendError(res, rejection, '请先打开并登录 DSH 主页面'); return }
        const body = await readFile(new URL(`../../assets/tutorial-audio/${tutorialAudio[1]}.wav`, import.meta.url))
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=3600', 'content-length': body.length })
        res.end(body)
        return
      }
      const asset = publicAsset(pathname)
      if (req.method === 'GET' && asset) {
        const body = asset.body ?? await readFile(asset.url)
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
        return
      }
      if (String(req.headers?.['x-duplex-control-client'] || '').trim()) {
        lastDuetRuntimeSeenAt = nowSeconds()
      }
      if (req.headers?.['x-duet-native-interactions'] === '1') lastNativeInteractionsSeenAt = nowSeconds()
      if ((pathname === ROUTE || pathname === `${ROUTE}/`) && req.method === 'GET') {
        res.writeHead(308, {location: `${PAGE_ROUTE}/`, 'cache-control':'no-store'})
        res.end()
        return
      }
      if ((pathname === PAGE_ROUTE || pathname === `${PAGE_ROUTE}/`) && req.method === 'GET') {
        const body = await readFile(HTML_URL)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': body.length,
        })
        res.end(body)
        return
      }
      await handleApi(req, res, pathname)
    } catch (error) {
      audit.event('host.api_error', { method: req.method, path: pathname, message: error.message, stack: error.stack })
      const status = Number.isInteger(error?.status) ? error.status : 500
      sendJson(res, status, {
        detail: error instanceof Error ? error.message : String(error),
        error_code: String(error?.code || 'internal_error'),
      })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PAGE_ROUTE, handler }))
}
