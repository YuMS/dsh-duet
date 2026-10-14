/** Reverse RPC executes on this authenticated DSH origin, never a supplied URL. */
import { orderSessionCatalog, readWorkspaceView } from '../shared/catalog.mjs'
const MAX_BYTES = 2_000_000
// Only colons may be escaped in a session segment: never decode arbitrary paths.
const SESSION = '(?:[A-Za-z0-9_:-]|%3[Aa]){1,256}'
const READ = new RegExp(`^/api/(?:health|sessions|jobs|results|interactions|composer/focused|sessions/${SESSION}/(?:composer|execution))$`)
const WRITE = new RegExp(`^/api/(?:sessions|sessions/${SESSION}/(?:composer/submit|activate|rename|fork|cancel)|interactions/(?:(?:question|approval)(?::|%3[Aa])(?:[A-Za-z0-9_:-]|%3[Aa]){1,1024}|[A-Za-z0-9_-]{1,256})/respond)$`)
const sessionRoute = (path, suffix) => new RegExp(`^/api/sessions/${SESSION}/${suffix}$`).test(path)

// Navigate only the connection-owning page after a successful mutation.
export function rpcNavigationSession(request, body) {
  if (request.method !== 'POST') return null
  if (sessionRoute(request.path, 'activate')) return body.active_session_id
  if (request.path === '/api/sessions' || sessionRoute(request.path, 'fork')) return body.session?.session_id
  return null
}

export function validateRPC(request) {
  if (request.type !== 'harness.rpc.request' || !/^[a-f0-9]{32}$/.test(request.request_id || '')
    || !/^[a-f0-9]{32}$/.test(request.connection_id || '')) throw new Error('invalid_harness_rpc')
  if (!((request.method === 'GET' && READ.test(request.path))
    || (request.method === 'POST' && WRITE.test(request.path))
    || (request.method === 'PUT' && sessionRoute(request.path, 'composer')))) throw new Error('harness_rpc_route_not_allowed')
  if (new TextEncoder().encode(JSON.stringify(request)).length > MAX_BYTES) throw new Error('harness_rpc_too_large')
  if (sessionRoute(request.path, 'cancel') && (typeof request.payload?.execution_id !== 'string'
    || !/^[a-f0-9-]{36}$/.test(request.payload.execution_id)
    || typeof request.payload.require_focus !== 'boolean'
    || Object.keys(request.payload).some(k => !['execution_id','require_focus'].includes(k)))) throw new Error('invalid_stop_request')
  if (request.params != null) {
    const focus = /\/composer$/.test(request.path) && JSON.stringify(request.params) === '{"require_focus":"true"}'
    const results = request.path === '/api/results' && typeof request.params === 'object'
      && Object.entries(request.params).every(([k, v]) => ['after', 'limit'].includes(k) && Number.isSafeInteger(v) && v >= 0)
    if (!focus && !results) throw new Error('invalid_harness_rpc_params')
  }
}

export class HarnessRPCExecutor {
  constructor(send, fetchImpl = fetch, diagnostic = () => {}, localComposer = null, catalogOrder = rows => orderSessionCatalog(rows, readWorkspaceView()), binding = {}) {
    // Native Window.fetch rejects an RPCExecutor receiver (Illegal invocation).
    // Call the captured function plainly, not as an instance method.
    this.send = send; this.fetch = (...args) => fetchImpl(...args); this.closed = false
    this.maxBytes = 256_000
    this.diagnostic = diagnostic
    this.localComposer = localComposer
    this.catalogOrder = catalogOrder
    this.binding = binding
    this.connectionId = null; this.seen = new Map(); this.retired = new Set(); this.controllers = new Set()
  }

  async execute(request) {
    if (this.closed) return
    validateRPC(request)
    this.connectionId ??= request.connection_id
    if (request.connection_id !== this.connectionId) throw new Error('harness_rpc_wrong_connection')
    if (this.retired.has(request.request_id)) throw new Error('harness_rpc_reply_expired')
    const fingerprint = JSON.stringify(request)
    const previous = this.seen.get(request.request_id)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('harness_rpc_id_reused')
      const response = await previous.promise
      if (!this.closed) this.send(response)
      return
    }
    if (this.retired.size >= 10_000 || this.controllers.size >= 8) throw new Error('harness_rpc_capacity_exhausted')
    const promise = this.call(request)
    // Reads are safe to repeat; keep bounded mutation replies and ID tombstones.
    if (request.method !== 'GET') this.seen.set(request.request_id, { fingerprint, promise })
    const response = await promise
    if (!this.closed) this.send(response)
    while (this.seen.size > 128) {
      const id = this.seen.keys().next().value
      this.seen.delete(id); this.retired.add(id)
    }
  }

  async call(request) {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 12_000)
    const envelope = { type: 'harness.rpc.response', connection_id: request.connection_id, request_id: request.request_id }
    try {
      let payload = request.payload ?? {}
      if (sessionRoute(request.path, '(?:execution|cancel)')) {
        if (!this.stopSupported || !this.binding.id) return { ...envelope, status:409,
          body:{error_code:'harness_stop_task_upgrade_required'} }
        const id = decodeURIComponent(request.path.split('/')[3])
        if (payload.require_focus && this.binding.focused?.() !== id) return { ...envelope, status:409,
          body:{error_code:'focus_conflict'} }
      }
      if (request.method === 'POST' && request.path === '/api/sessions' && this.binding.creationPayload) {
        try { payload = this.binding.creationPayload(payload) }
        catch (error) { return { ...envelope, status: 409, body: { error_code: error.code || error.message || 'workspace_selection_required' } } }
      }
      if (this.localComposer) {
        try {
          const body = await this.localComposer(request, controller.signal)
          if (body !== undefined) return { ...envelope, status: 200, body }
        } catch (error) {
          return { ...envelope, status: 409, body: { error_code: error.code || 'composer_operation_failed', detail: 'Draft changed or unavailable; read input_status again' } }
        }
      }
      const params = request.path === '/api/results' ? {...request.params, limit:Math.min(20, request.params?.limit || 20)} : request.params
      const query = params ? '?' + new URLSearchParams(params) : ''
      const response = await this.fetch('/duplex-control' + request.path + query, {
        method: request.method, credentials: 'same-origin', redirect: 'error',
        cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Duplex-Control-Client': 'realtime-client-rpc-v1',
          'X-Duet-Native-Interactions': '1',
          ...(this.binding.id ? { 'X-Duet-Browser-Client': this.binding.id } : {}) },
        ...(request.method !== 'GET' ? { body: JSON.stringify(payload) } : {}),
      })
      const text = await response.text()
      // Older peers count Python's ASCII-escaped JSON, not its UTF-8 wire form.
      const measured = this.maxBytes > 256_000 ? text : text.replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0'))
      if (new TextEncoder().encode(measured).length > this.maxBytes - 4096) throw new Error('harness_rpc_response_too_large')
      const body = JSON.parse(text)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_harness_rpc_body')
      controller.signal.throwIfAborted()
      if (response.ok && this.binding.completed) await this.binding.completed(request, body, controller.signal)
      if (response.status === 200 && request.method === 'GET' && request.path === '/api/sessions' && Array.isArray(body.sessions)) {
        this.stopSupported = body.duet_rpc_capabilities?.includes('stop_task_v1') === true
          && typeof this.binding.focused === 'function'
        body.duet_rpc_capabilities = ['create_session_v1',
          ...(this.stopSupported ? ['stop_task_v1'] : []),
          ...(this.binding.syncSupported?.() === false ? [] : ['harness_sync_v1'])]
        // Both startup prompt and nth_N resolution read this same browser-local
        // order, including manual drag order; archived rows cannot consume ranks.
        body.sessions = this.catalogOrder(body.sessions)
      }
      return { ...envelope, status: response.status, body }
    } catch (error) {
      this.diagnostic({ event: 'rpc_fetch_failed', request_id: request.request_id, path: request.path,
        message: String(error?.message || error), stack: error?.stack })
      return { ...envelope, status: 502, body: { error_code: 'dsh_rpc_failed_outcome_unknown', detail: 'DSH request failed; do not automatically retry mutations' } }
    } finally {
      clearTimeout(timer); this.controllers.delete(controller)
    }
  }

  close() {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear(); this.seen.clear(); this.retired.clear()
  }
}
