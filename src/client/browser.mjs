import { DuetState, PLUGIN_VERSION } from '../shared/state.mjs?v=0.1.3'
import { DuetAudio } from './audio.mjs?v=0.1.3'
import { HarnessRPCExecutor } from './rpc.mjs?v=0.1.3'
import { composerAccess, observeComposer, focusedSession } from './composer.mjs?v=0.1.3'
import { mountTutorial } from './tutorial.mjs?v=0.1.3'
import { tutorialAdapter } from './tutorial-adapter.mjs?v=0.1.3'
import { mountRating } from './feedback.mjs?v=0.1.3'
import { createAudioUploadConsent } from './consent.mjs?v=0.1.3'
import { bindDuetShortcuts } from './shortcuts.mjs?v=0.1.3'
import { nativeInteractions } from './interactions.mjs?v=0.1.3'
import { mountConnectionHint } from './connection-hint.mjs?v=0.1.3'
import { mountControlsLayout } from './controls-layout.mjs?v=0.1.3'
import { mountNotice } from './notice.mjs?v=0.1.3'
import { workspaceIssue, requireWorkspace, browserSessionCatalog } from './workspaces.mjs?v=0.1.3'

export function mountDuet(ctx) {
  const audio = new DuetAudio()
  const audioConsent = createAudioUploadConsent()
  let disposed = false, controls, pollRunning = false, cursor = null, resultEpoch = null
  let nextPollAt = 0, pollController, pollWakePending = false, pollFailureSince = null, pollFailures = 0, pollGeneration = -1
  const notices = mountNotice(() => controls)
  const labels = new Map()
  let clientTraceId = null, diagnosticCount = 0
  let tutorial, teaching, ratingPanel, connectionHint, stopControlsLayout
  const diagnostic = data => {
    if (++diagnosticCount > 100) return
    const bounded = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 4000) : v]))
    const body = JSON.stringify({ client_trace_id: clientTraceId, plugin_version: PLUGIN_VERSION,
      utc: new Date().toISOString(), visibility: document.visibilityState, ...bounded })
    if (body.length > 24000) return
    void fetch('/duplex-control/api/voice/diagnostic', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Duplex-Settings': '1' }, body, keepalive: true }).catch(() => {})
  }
  const pageError = event => diagnostic({ event: 'browser.error', message: String(event.message || event.reason?.message || event.reason), stack: event.error?.stack || event.reason?.stack })
  window.addEventListener('error', pageError)
  window.addEventListener('unhandledrejection', pageError)
  const notice = (text, { upgrade = false } = {}) => {
    connectionHint?.dismiss()
    if (upgrade) { ratingPanel?.dispose(); ratingPanel = null }
    notices.show(text, { upgrade })
  }
  const draw = state => {
    if (pollGeneration !== state.generation) {
      pollGeneration = state.generation; nextPollAt = 0; pollFailureSince = null; pollFailures = 0
    }
    if (!controls) return
    for (const [kind, active] of [['mic', state.mode === 'online'], ['speaker', state.mode === 'tts_only']]) {
      const button = controls.querySelector(`[data-voice=${kind}]`)
      button.setAttribute('aria-pressed', String(active))
      button.setAttribute('aria-label', `${active ? '关闭' : '打开'}${kind === 'mic' ? '交互模式' : '播报模式'}`)
      button.title = button.getAttribute('aria-label')
      const pending = active && !state.ready && !state.suspended
      button.style.background = active && !pending ? '#dcefff' : 'transparent'
      button.style.color = active && !pending ? '#185a89' : 'currentColor'
      button.dataset.pending = String(pending)
      button.setAttribute('aria-busy', String(pending))
      button.querySelector('[data-connecting-ring]').hidden = !pending
      if (pending) button.title = `正在开启${kind === 'mic' ? '交互模式' : '播报模式'}`
    }
    // Suspended/idle-countdown is intentionally not exposed as a fourth UI mode.
    controls.dataset.mode = state.mode
    const mark = controls.querySelector('[data-duet-mark]')
    mark.style.color = state.ready ? '#7fd6a6' : '#ed9b35'
    mark.title = state.ready ? '语音已连接' : '语音未连接'
    connectionHint?.update({ mode: state.mode, ready: state.ready, teaching: Boolean(tutorial?.active) })
  }
  const connect = (mode, receive) => {
    requireWorkspace(ctx)
    if (!audioConsent.granted()) throw Error('data_upload_consent_required')
    clientTraceId = crypto.randomUUID(); diagnosticCount = 0
    const connectionTraceId = clientTraceId
    const report = data => diagnostic({ ...data, client_trace_id: connectionTraceId, mode })
    let ws, closed = false, release, ready = false, stopComposer
    const opening = new AbortController()
    const startupTimer = setTimeout(() => {
      if (!closed) receive({ type: 'error', code: 'voice_start_timeout' })
    }, 45000)
    const send = message => {
      if (ws?.readyState !== WebSocket.OPEN || closed) return
      if (ws.bufferedAmount > 1_000_000) { receive({ type: 'error', code: 'voice_backpressure' }); return }
      ws.send(message instanceof ArrayBuffer ? message : JSON.stringify(message))
    }
    const composer = composerAccess(ctx, id => labels.get(id) || id)
    const interactions = nativeInteractions(ctx)
    const rpc = new HarnessRPCExecutor(send, fetch, report, async (request, signal) =>
      (await interactions(request, signal)) ?? composer.execute(request, signal), rows => browserSessionCatalog(ctx, rows))
    const connection = {
      feedbackTicket: null,
      send,
      sendState: state => { if (state) send({ type: 'harness.state', state }) },
      playing: () => audio.playing(),
      async close() {
        report({ event: 'browser.connection_close', buffered_bytes: ws?.bufferedAmount })
        closed = true
        clearTimeout(startupTimer)
        opening.abort()
        stopComposer?.()
        rpc.close()
        audio.stop()
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          await new Promise(resolve => {
            const timer = setTimeout(resolve, 1200)
            ws.addEventListener('close', () => { clearTimeout(timer); resolve() }, { once: true })
            if (ws.readyState < WebSocket.CLOSING) ws.close(1000)
          })
        }
        release?.()
      },
    }
    const open = async () => {
      if (closed) return
      // Establish/renew the host-signed anonymous cookie before the WS handshake.
      const configTimer = setTimeout(() => opening.abort(Error('voice_start_timeout')), 10000)
      let identity
      try { identity = await fetch('/duplex-control/api/voice/config', {credentials:'same-origin',cache:'no-store',signal:opening.signal}) }
      finally { clearTimeout(configTimer) }
      if(!identity.ok)throw Error('voice_config_unavailable')
      requireWorkspace(ctx)
      if(closed)return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${protocol}//${location.host}/duplex-control/voice/ws?mode=${mode}&plugin_version=${PLUGIN_VERSION}&client_trace_id=${connectionTraceId}`)
      ws.onopen = () => {
        send({ type: 'session.update' })
        if (mode === 'online') stopComposer = observeComposer(ctx, composer, send)
      }
      ws.onmessage = async event => {
        if (closed) return
        let message
        try {
          message = JSON.parse(event.data)
          if (message.type === 'harness.rpc.request') {
            if (mode !== 'online') throw new Error('harness_rpc_requires_online')
            await rpc.execute(message)
            return
          }
          if (message.type === 'error') {
            report({ event: 'browser.server_error', code: message.error?.code || message.code,
              message: message.error?.message || message.message })
            receive({ type: 'error', code: message.error?.code || message.code,
              compatibility: message.error?.compatibility, policy: message.error?.policy }); return
          }
          if (message.type === 'session.created' && !ready) {
            if (message.compatibility) receive({ type: 'compatibility', compatibility: message.compatibility })
            connection.feedbackTicket = message.feedback_session_ticket || null
            ready = true
            await audio.prepare()
            if (closed) return
            if (mode === 'online') {
              try { await audio.startMic(send, code => {
                if (!closed) { report({event:'browser.capture_failed',code}); receive({type:'error',code}) }
              }) }
              catch (error) {
                report({ event: 'browser.microphone_failed', name: error?.name })
                if (!closed) receive({ type: 'error', code: 'microphone_unavailable' })
                return
              }
            }
            report({ event: 'browser.audio_ready', context_sample_rate: audio.context?.sampleRate,
              context_state: audio.context?.state, base_latency: audio.context?.baseLatency,
              user_agent: navigator.userAgent })
            if (!closed) {
              clearTimeout(startupTimer)
              receive({ type: 'ready' })
              try { audio.connectedChime() } catch { /* A notification must not break voice. */ }
            }
          }
          audio.event(message, send)
          teaching?.observe(message)
          receive(message)
        } catch (error) {
          report({ event: 'browser.message_failed', event_type: message?.type, request_id: message?.request_id,
            path: message?.path, message: String(error?.message || error), stack: error?.stack })
          if (!closed) receive({ type: 'error', code: 'voice_stream_failed' })
        }
      }
      ws.onclose = event => {
        stopComposer?.()
        report({ event: 'browser.ws_closed', code: event.code, reason: event.reason, was_clean: event.wasClean })
        rpc.close()
        release?.()
        if (!closed) receive({ type: 'error', code: event.code === 1013 ? 'capacity_exhausted' : 'voice_disconnected' })
      }
      ws.onerror = () => { report({ event: 'browser.ws_error' }); if (!closed) receive({ type: 'error', code: 'voice_connection_failed' }) }
    }
    if (navigator.locks) {
      void navigator.locks.request('dsh-duplex-voice-owner', { ifAvailable: true }, async lock => {
        if (closed) return
        if (!lock) { receive({ type: 'error', code: 'voice_tab_in_use' }); return }
        const held = new Promise(resolve => { release = resolve })
        // Opening may hang; ownership ends when close() releases it, not when
        // a fetch or browser permission request eventually resolves.
        void open().catch(error => { if (!closed) receive({type:'error',code:opening.signal.aborted?'voice_start_timeout':error.message||'voice_connection_failed'}) })
        await held
      }).catch(() => { if (!closed) receive({ type: 'error', code: 'voice_connection_failed' }) })
    } else queueMicrotask(() => receive({ type: 'error', code: 'voice_lock_unavailable' }))
    return connection
  }
  const state = new DuetState({ connect, changed: draw, notice })
  const mount = () => {
    const entry = document.getElementById('dsh-duet-entry')
    if (!entry || document.getElementById('dsh-duet-controls')) return
    controls = document.createElement('div')
    controls.id = 'dsh-duet-controls'
    controls.style.cssText = 'display:flex;gap:4px;position:relative;padding:6px 8px;align-items:center;margin:4px 8px;max-width:100%'
    const style = document.createElement('style')
    style.textContent = '@keyframes duet-connecting-snake{from{stroke-dashoffset:0}to{stroke-dashoffset:-100}} #dsh-duet-controls [data-connecting-ring]{position:absolute;inset:0;pointer-events:none} #dsh-duet-controls [data-connecting-ring] svg{display:block;width:100%;height:100%;overflow:visible} #dsh-duet-controls [data-connecting-ring] rect{fill:none;stroke:#ed9b35;stroke-width:2;stroke-linecap:round;stroke-dasharray:28 72;animation:duet-connecting-snake 1.6s linear infinite!important} #dsh-duet-controls [data-connecting-ring][hidden]{display:none}'
    controls.append(style)
    const parent = entry.parentElement
    parent.insertBefore(controls, entry)
    entry.style.cssText = 'font-family:Inter,"PingFang SC",sans-serif;font-size:28px;font-weight:700;letter-spacing:-1.1px;line-height:1.1;color:inherit;margin-right:auto;padding:4px;cursor:default;user-select:none'
    entry.textContent = 'duet'
    const dot = document.createElement('span')
    dot.textContent = '.'; dot.dataset.duetMark = ''; dot.style.color = '#ed9b35'
    entry.append(dot)
    controls.append(entry)
    // Heroicons 24/outline (MIT); all controls share the same optical box/stroke.
    for (const [kind, path] of [['mic', '<path d="M7.5 3.75 3 8.25m0 0 4.5 4.5M3 8.25h18m-4.5 3L21 15.75m0 0-4.5 4.5M21 15.75H3"/>'], ['speaker', '<path d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"/>']]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.voice = kind
      button.style.cssText = 'position:relative;border:0;border-radius:6px;background:transparent;cursor:pointer;padding:5px;display:flex'
      button.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
      const ring = document.createElement('span')
      ring.dataset.connectingRing = ''; ring.hidden = true; ring.setAttribute('aria-hidden', 'true')
      // The rectangle stays fixed; only the short stroke advances around its
      // perimeter. Outer radius 6 matches the original button, not a circle.
      ring.innerHTML = '<svg viewBox="0 0 30 30" preserveAspectRatio="none" aria-hidden="true"><rect x="1" y="1" width="28" height="28" rx="5" pathLength="100"/></svg>'
      button.append(ring)
      button.onclick = () => {
        if (tutorial?.active) { notice('请先结束教学，再切换模式。'); return }
        const requestedMode = kind === 'mic' ? 'online' : 'tts_only'
        const checkWorkspace = () => {
          if (state.mode === requestedMode) return true // Closing is always allowed.
          const issue = workspaceIssue(ctx)
          if (issue) { state.fail(issue); return false }
          return true
        }
        if (!checkWorkspace()) return
        const activate = () => {
          if (disposed || tutorial?.active) return
          if (!checkWorkspace()) return
          // Unlock playback inside user activation, before any network await.
          const enabling = kind === 'mic' ? state.mode !== 'online' : state.mode !== 'tts_only'
          if (enabling) void audio.prepare().catch(() => state.fail('audio_permission_denied'))
          const ticket = !enabling && state.ready ? state.connection?.feedbackTicket : null
          // Capture the ended connection, never consult the next session after await.
          void (async()=>{
            await (kind === 'mic' ? state.toggleMic() : state.toggleSpeaker())
            if(ticket && !disposed){ratingPanel?.dispose();ratingPanel=mountRating(controls,ticket)}
          })()
        }
        audioConsent.cancel()
        const mode = kind === 'mic' ? 'online' : 'tts_only'
        if (state.mode !== mode) audioConsent.request(activate)
        else activate()
      }
      controls.append(button)
    }
    const settings = document.createElement('a')
    settings.href = '/duet/'
    settings.target = '_blank'
    settings.rel = 'noopener noreferrer'
    settings.title = 'duet 设置'
    settings.setAttribute('aria-label', 'duet 设置')
    settings.style.cssText = 'display:flex;color:inherit;padding:5px;border-radius:6px'
    settings.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>'
    controls.append(settings)
    stopControlsLayout?.()
    stopControlsLayout = mountControlsLayout(controls)
    connectionHint?.dispose()
    connectionHint = mountConnectionHint(controls)
    draw(state)
  }
  mount()
  const stopShortcuts = bindDuetShortcuts(kind => controls?.querySelector(`[data-voice=${kind}]`)?.click())
  const observer = new MutationObserver(mount)
  observer.observe(document.body, { subtree: true, childList: true })

  const api = async (path, signal) => {
    const response = await fetch(`/duplex-control/api/${path}`, { cache: 'no-store',
      signal, headers: { 'X-Duet-Native-Interactions': '1' } })
    if (!response.ok) throw Object.assign(new Error('harness_unavailable'), {status:response.status})
    return response.json()
  }
  const poll = async () => {
    if (disposed || pollRunning) return
    pollRunning = true
    pollWakePending = false
    const generation = state.generation, controller = new AbortController(), startedAt = Date.now()
    pollController = controller
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const [catalog, completed, health] = await Promise.all([api('sessions',controller.signal), api(`results?after=${cursor ?? 0}&limit=100`,controller.signal), api('health',controller.signal)])
      if (disposed) return
      catalog.sessions = browserSessionCatalog(ctx, catalog.sessions)
      const issue = workspaceIssue(ctx)
      if (issue === 'workspace_required' && state.mode !== 'off') state.fail(issue)
      for (const s of catalog.sessions) labels.set(s.session_id, s.label)
      const bootstrap = cursor === null || resultEpoch !== health.focus_epoch
      let composer
      const id = focusedSession(ctx)
      const scope = id ? ctx.sessions.scope(id) : undefined
      if (scope) {
        try { composer = { session_name: labels.get(id) || id, text: ctx.conversation.input.for(scope).state.getSnapshot().draft } } catch { /* Session input is still mounting; do not invent an empty draft. */ }
      }
      state.update({
        hidden: document.visibilityState !== 'visible',
        running: catalog.sessions.some(s => s.running),
        state: { focused_session_id: id || null, ...(composer ? { composer_state: composer } : {}), sessions: catalog.sessions.map(s => ({ session_id: s.session_id, session_name: s.label, running: s.running })) },
        results: bootstrap ? [] : completed.results.map(job => ({
          type: 'external_message', message_id: `harness_${job.id}`,
          source: { session_id: job.session_id, session_name: labels.get(job.session_id) || job.session_id,
            job_id: job.id, status: job.status === 'succeeded' ? 'completed' : 'failed' },
          text: (job.status === 'succeeded' ? job.result : (job.error || job.result)) || '未返回结果。',
        })),
      })
      resultEpoch = health.focus_epoch
      cursor = bootstrap ? completed.current_cursor : completed.next_cursor
      if (pollFailures >= 3 && state.mode !== 'off') notice('会话同步已恢复。')
      pollFailureSince = null; pollFailures = 0
    } catch (error) {
      if (!disposed && generation === state.generation && state.mode !== 'off') {
        diagnostic({ event: 'browser.poll_failed', message: String(error?.message || error), stack: error?.stack })
        pollFailureSince ??= Date.now(); pollFailures++
        if ([401,403].includes(error.status) || (pollFailures >= 3 && Date.now()-pollFailureSince >= 15000)) state.fail('harness_sync_failed')
        else if (pollFailures === 3) notice('会话同步暂时中断，正在重试。')
      }
    }
    finally {
      clearTimeout(timeout); controller.abort(); pollController = null; pollRunning = false
      nextPollAt = pollWakePending ? 0 : startedAt + (state.mode !== 'off' || tutorial?.active ? 1000 : document.hidden ? 15000 : 5000)
    }
  }
  const timer = setInterval(() => { if (Date.now() >= nextPollAt) void poll(); state.tick() }, 1000)
  const wakePoll = () => { pollWakePending = true; nextPollAt = 0 }
  const unwatchSessions = ctx.sessions.list.subscribe?.(wakePoll)
  const unwatchWorkspaces = ctx.workspaces?.list?.subscribe?.(wakePoll)
  const progress = setInterval(() => { if (state.connection) audio.progress(state.connection.send) }, 200)
  const visibility = () => { state.hidden = document.visibilityState !== 'visible'; state.tick(); void poll() }
  document.addEventListener('visibilitychange', visibility)
  void poll()
  teaching = tutorialAdapter(ctx, state, audio, async signal => {
    await audioConsent.ensure(signal)
    const deadline = Date.now() + 15000
    while (cursor === null) {
      signal.throwIfAborted()
      if (Date.now() > deadline) throw Error('会话结果同步尚未就绪，请稍后重试教学')
      await poll(); await new Promise(resolve => setTimeout(resolve, 150))
    }
  })
  const mountTeaching = () => {
    if (!tutorial && controls) tutorial = mountTutorial({ controls, adapter: teaching })
  }
  mountTeaching()
  const teachingObserver = new MutationObserver(mountTeaching)
  teachingObserver.observe(document.body, { subtree: true, childList: true })
  return () => {
    disposed = true
    pollController?.abort()
    unwatchSessions?.(); unwatchWorkspaces?.()
    notices.dispose()
    stopShortcuts()
    observer.disconnect()
    teachingObserver.disconnect()
    tutorial?.dispose()
    audioConsent.cancel()
    ratingPanel?.dispose()
    connectionHint?.dispose()
    clearInterval(timer); clearInterval(progress)
    stopControlsLayout?.()
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('error', pageError)
    window.removeEventListener('unhandledrejection', pageError)
    controls?.remove()
    void state.dispose().finally(() => audio.context?.close())
  }
}
