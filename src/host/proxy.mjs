/** Same-origin voice relay; endpoint and compatibility policy belong to the DSH host. */
import { createRequire } from 'node:module'
import { DuetTrace } from './trace.mjs'
import { PLUGIN_VERSION } from '../shared/state.mjs'
import { duetEnv } from './environment.mjs'
import { EndpointDiscovery, connectEndpoint } from './endpoint-discovery.mjs'
import {sessionMetadata} from './session-metadata.mjs'
import { DEFAULT_DUET_URL, publicServiceAuthorization } from './service-defaults.mjs'
export { DEFAULT_DUET_URL } from './service-defaults.mjs'
const require = createRequire(import.meta.url)

export function compatibleVersion(version, min = '0.1.0', maxExclusive = '0.2.0') {
  const parse = v => /^\d+\.\d+\.\d+$/.test(v || '') ? v.split('.').map(Number) : null
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const v = parse(version), low = parse(min), high = parse(maxExclusive)
  return Boolean(v && low && high && compare(v, low) >= 0 && compare(v, high) < 0)
}

export function duetConfig(env = process.env) {
  const endpoints = {
    online: duetEnv('ONLINE_URL', env) || duetEnv('URL', env) || DEFAULT_DUET_URL,
    tts_only: duetEnv('TTS_ONLY_URL', env) || duetEnv('URL', env) || DEFAULT_DUET_URL,
  }
  return {
    min_version: duetEnv('MIN_VERSION', env) || '0.1.0',
    max_version_exclusive: duetEnv('MAX_VERSION_EXCLUSIVE', env) || '0.2.0',
    control_transport: duetEnv('CONTROL_TRANSPORT', env) || 'client_rpc_v1',
    authorization: publicServiceAuthorization(endpoints),
    endpoints,
  }
}

export function externalWithState(message, _state) {
  if (message.type !== 'external_message' || typeof message.text !== 'string') throw new Error('invalid_external_message')
  // Keep authoritative result metadata separate from result text and UI state.
  const text = message.text
  if (text.length > 8000) throw new Error('external_message_too_large')
  const source = message.source
  if (source !== undefined) {
    const limits = { session_id: 256, session_name: 512, job_id: 256, status: 16 }
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        Object.keys(source).length !== 4 || Object.entries(limits).some(([key, limit]) =>
          typeof source[key] !== 'string' || !source[key].trim() || source[key].length > limit || source[key].includes('\0')) ||
        !['completed', 'failed'].includes(source.status)) throw new Error('invalid_external_message_source')
  }
  return { type: 'external_message', message_id: message.message_id, text,
    ...(source === undefined ? {} : { source: { ...source } }) }
}

export function registerDuetProxy(ctx, config = duetConfig(), feedback = null, canUseVoice = () => true, discovery = new EndpointDiscovery(() => config)) {
  if (!['http', 'client_rpc_v1'].includes(config.control_transport || 'http')) throw new Error('invalid_harness_transport')
  if (!compatibleVersion(config.min_version, config.min_version, config.max_version_exclusive)) throw new Error('invalid_plugin_version_policy')
  for (const target of Object.values(config.endpoints)) {
    const url = new URL(target)
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid_voice_endpoint')
  }
  const { WebSocket, WebSocketServer } = require('ws')
  const server = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 })
  const connections = new Map()
  const stop = ctx.webServer.registerUpgrade({
    path: '/duplex-control/voice/ws',
    handler(req, socket, head) {
      const rejection = ctx.connection?.requestRejection(req)
      if (rejection) { socket.end(`HTTP/1.1 ${rejection} Forbidden\r\nConnection: close\r\n\r\n`); return }
      // No browser-selected target URLs and no cross-origin drive-by microphone sessions.
      const origin = req.headers.origin
      let sameOrigin = !origin
      try { if (origin) sameOrigin = new URL(origin).host === req.headers.host } catch { sameOrigin = false }
      if (!sameOrigin) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      server.handleUpgrade(req, socket, head, front => {
        front.on('error', () => {})
        const params = new URL(req.url, 'http://localhost').searchParams
        const trace = new DuetTrace({ mode: params.get('mode'), plugin_version: params.get('plugin_version'),
          host_plugin_version: PLUGIN_VERSION, page_id: (params.get('page_id') || '').slice(0, 64),
          client_trace_id: (params.get('client_trace_id') || '').slice(0, 64),
          backend_origin: new URL(config.endpoints[params.get('mode')] || config.endpoints.online).origin,
          control_transport: config.control_transport }, { ...config.traceOptions, secrets: [config.authorization] })
        front.once('close', (code, reason) => {
          trace.event('browser.closed', { code, reason: reason.toString() })
          const timer = setTimeout(() => { void trace.close() }, 1500); timer.unref()
        })
        let back, feedbackTicket = null, connectionRoute, selectedConfig
        const opening = new AbortController()
        front.once('close', () => feedback?.close(feedbackTicket))
        let state = null
        let initialized = false
        let terminal = false
        const fail = code => {
          if (terminal) return
          terminal = true
          opening.abort()
          trace.event('proxy.failed', { code })
          if (front.readyState === WebSocket.OPEN) front.send(JSON.stringify({ type: 'error', error: { code } }))
          front.close(code === 'capacity_exhausted' ? 1013 : 1008)
          back?.close()
        }
        const mode = params.get('mode')
        if (!compatibleVersion(params.get('plugin_version'), config.min_version, config.max_version_exclusive)) { fail('plugin_upgrade_required'); return }
        if (!['online', 'tts_only'].includes(mode)) { fail('invalid_voice_mode'); return }
        let anonymousUserId
        try{anonymousUserId=feedback?.user(req)}catch{ /* Identity is optional, not admission. */ }
        const clientMetadata=sessionMetadata(params,mode,anonymousUserId)
        trace.event('session.metadata',clientMetadata)
        if (!canUseVoice()) { fail('workspace_required'); return }
        connections.set(front, { mode, ready: false, trace })
        front.on('close', () => connections.delete(front))
        const target = config.endpoints[mode]
        if (!target) { fail('voice_mode_unavailable'); return }
        const clientRPC = mode === 'online' && config.control_transport === 'client_rpc_v1'
        const rpcRequests = new Map()
        const pending = []
        const startup = setTimeout(() => fail('voice_start_timeout'), 20000)
        let hintReporting=false,hintReported=false
        const sendUpstream = (data, binary) => {
          if (!binary) {
            const message = JSON.parse(data.toString())
            if (message.type === 'session.update') data = JSON.stringify({...message,
              client: {...message.client, connection_route: connectionRoute}})
          }
          trace.frame('upstream.send', data, binary)
          back.send(data, {binary})
        }
        const forward = (data, binary = false) => {
          if (back?.readyState === WebSocket.OPEN) sendUpstream(data, binary)
          else if (pending.length < 8) pending.push([data, binary])
          else fail('voice_not_ready')
        }
        front.on('message', (raw, binary) => {
          if (terminal) return
          trace.frame('browser.receive', raw, binary)
          try {
            if (binary) {
              if (mode !== 'online' || !initialized) throw new Error('input_audio_disabled')
              forward(raw, true)
              return
            }
            const message = JSON.parse(raw.toString())
            if (message.type === 'client.diagnostic') return // captured locally, never fed to model
            if (message.type === 'client.connection_hint') {
              if(hintReporting&&!hintReported&&mode==='online'&&connections.get(front)?.ready){
                hintReported=true
                forward(JSON.stringify({type:'client.connection_hint',connection_hint:connectionRoute.connection_hint}))
              }
              return
            }
            if (message.type === 'harness.state') {
              if (!message.state || typeof message.state !== 'object' || JSON.stringify(message.state).length > 100_000) throw new Error('invalid_harness_state')
              state = message.state
              // Keep state available to host diagnostics, separate from speech.
              // State-only updates never invoke a model or become a notification.
              return
            }
            if (message.type === 'session.update') {
              if (initialized) throw new Error('voice_mode_requires_reconnect')
              initialized = true
              forward(JSON.stringify({ type: 'session.update',
                client: clientMetadata,
                session: {
                type: 'realtime', preset_id: 'server_default',
                io_mode:mode === 'tts_only'?'external_only':'online',
                ...(clientRPC ? { harness: { transport: 'client_rpc_v1' } } : {}),
                audio: { input: { format: { type: 'audio/pcm', rate: 16000 } } },
                debug: { enabled: false, slot_grid: false },
              } }))
              return
            }
            if (!initialized) throw new Error('session_not_started')
            if (message.type === 'harness.composer.update') {
              if (!clientRPC || raw.length > 100_000) throw new Error('invalid_composer_push')
              forward(raw.toString())
              return
            }
            if (message.type === 'harness.rpc.response') {
              if (!clientRPC || rpcRequests.get(message.request_id) !== message.connection_id) throw new Error('harness_rpc_unmatched_response')
              rpcRequests.delete(message.request_id)
              forward(raw.toString())
              return
            }
            if (message.type === 'external_message') {
              if (mode !== 'tts_only') throw new Error('external_only_session_required')
              forward(JSON.stringify(externalWithState(message, state)))
            } else if (['output_audio_buffer.playback_progress', 'output_audio_buffer.cleared', 'session.close'].includes(message.type)) {
              forward(raw.toString())
            } else throw new Error('unsupported_voice_event')
          } catch (error) { fail(error.message || 'invalid_voice_event') }
        })
        void (async () => {
        const routes = await discovery.plan(mode)
        const selected = await connectEndpoint(WebSocket, routes, {signal: opening.signal, trace})
        if (opening.signal.aborted || front.readyState !== WebSocket.OPEN) { selected.socket.close(); return }
        back = selected.socket
        if (selected.fallbackReason) discovery.failed()
        discovery.used(mode, selected.route)
        connectionRoute = {...discovery.metadata(selected.route, selected.fallbackReason), attempted_endpoint:routes[0].url}
        selectedConfig = {...selected.route.config, endpoints: {online:selected.route.url,tts_only:selected.route.url}}
        trace.event('endpoint.selected', connectionRoute)
        back.on('message', (data, binary) => {
          trace.frame('upstream.receive', data, binary)
          if (!binary) {
            try {
              const event = JSON.parse(data.toString())
              if (event.type === 'harness.rpc.request') {
                if (!clientRPC || rpcRequests.size >= 8) { fail('invalid_harness_rpc'); return }
                rpcRequests.set(event.request_id, event.connection_id)
              }
              if (event.type === 'session.created') {
                hintReporting=event.connection_hint_reporting===true
                if (clientRPC && event.session?.config?.harness_control_transport !== 'client_rpc_v1') { fail('harness_rpc_backend_upgrade_required'); return }
                if (mode === 'tts_only' && event.session?.config?.external_message_protocol !== 'harness_result_v2') { fail('harness_result_backend_upgrade_required'); return }
                const connection = connections.get(front)
                if (connection) connection.ready = true
                clearTimeout(startup)
                if(!feedbackTicket)feedbackTicket=feedback?.open(req,event.session?.id,mode,selectedConfig)
                data=JSON.stringify({...event, connection_route: connectionRoute,
                  ...(feedbackTicket?{feedback_session_ticket:feedbackTicket}:{})})
              }
            } catch { /* Upstream framing is passed through. */ }
          }
          if (front.readyState === WebSocket.OPEN) front.send(data, { binary })
        })
        back.on('error', error => { trace.event('upstream.error', { message: error.message, stack: error.stack }); fail('voice_upstream_unavailable') })
        back.on('unexpected-response', (_request, response) => {
          response.resume()
          trace.event('upstream.handshake_failed', { status: response.statusCode })
          fail([429, 503].includes(response.statusCode) ? 'capacity_exhausted' : response.statusCode === 426 ? 'plugin_upgrade_required' : 'voice_upstream_unavailable')
        })
        back.on('close', (code, reason) => {
          trace.event('upstream.closed', { code, reason: reason.toString() })
          clearTimeout(startup)
          if (code === 1013) fail('capacity_exhausted')
          else front.close(code === 1000 ? 1000 : 1011)
        })
        for (const [data, binary] of pending.splice(0)) sendUpstream(data, binary)
        })().catch(error => {
          if (!opening.signal.aborted) fail([429,503].includes(error.status)?'capacity_exhausted':error.status===426?'plugin_upgrade_required':'voice_upstream_unavailable')
        })
        front.on('error', error => { trace.event('browser.error', { message: error.message }); opening.abort(); back?.close() })
        front.on('close', (code, reason) => {
          trace.event('rpc.pending_at_close', { request_ids: [...rpcRequests.keys()] })
          opening.abort(); clearTimeout(startup); back?.close()
          const timer = setTimeout(() => back?.terminate(), 1000)
          timer.unref()
        })
      })
    },
  })
  const dispose = () => { stop(); for (const socket of server.clients) socket.close(1001); server.close() }
  dispose.snapshot = () => ({
    online: [...connections.values()].filter(c => c.mode === 'online' && c.ready).length,
    tts_only: [...connections.values()].filter(c => c.mode === 'tts_only' && c.ready).length,
    connecting: [...connections.values()].filter(c => !c.ready).length,
    traces: [...connections.values()].map(c => c.trace.snapshot()),
  })
  dispose.closeConnections = code => {
    for (const socket of connections.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', error: { code } }))
      socket.close(1000)
    }
  }
  return dispose
}
