/** Composer requests belong to one explicit voice/tutorial connection, never all tabs. */
import { focusedSession as currentSession } from './composer.mjs?v=0.1.4'

export function startComposerBridge(ctx, clientId, fetchImpl = fetch) {
  const focusedSession = () => currentSession(ctx)
  const bridgeFetch = async (url, options = {}, timeoutMs = 8000) => {
    const request = new AbortController()
    const abort = () => request.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const timer = setTimeout(abort, timeoutMs)
    try { return await fetchImpl(url, { ...options, signal: request.signal }) }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
  }
  const controller = new AbortController()
  let pollRunning = false
  let retryTimer

  const digest = async (text) => {
    const bytes = new TextEncoder().encode(text)
    const hash = await crypto.subtle.digest("SHA-256", bytes)
    return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("")
  }

  const composerForSession = async (sessionId) => {
    await ctx.sessions.refresh()
    const sessionContext = ctx.sessions.scope(sessionId)
    if (sessionContext === undefined) {
      const error = new Error(`Harness session ${sessionId} is not ready`)
      error.code = "session_not_ready"
      throw error
    }
    return ctx.conversation.input.for(sessionContext)
  }

  const composerState = async (sessionId, input) => {
    const state = input.state.getSnapshot()
    return {
      session_id: sessionId,
      text: state.draft,
      phase: state.phase,
      revision: state.draftRev,
      hash: await digest(state.draft),
    }
  }

  const execute = async (request) => {
    controller.signal.throwIfAborted()
    const input = await composerForSession(request.session_id)
    const before = await composerState(request.session_id, input)
    controller.signal.throwIfAborted()
    const checkFocus = () => {
      if (request.require_focus && focusedSession() !== request.session_id) {
        const error = new Error("Focused session changed; read input_status again")
        error.code = "focus_conflict"
        throw error
      }
    }
    checkFocus()
    if (["set", "clear", "consume"].includes(request.type)) {
      const overwrite = request.type === "set" && request.overwrite === true
      if (before.phase !== "plain") {
        const error = new Error(`Harness input is busy (${before.phase})`)
        error.code = "composer_busy"
        throw error
      }
      if (!overwrite && (
        before.revision !== request.expected_revision
        || before.hash !== request.expected_hash
      )) {
        const error = new Error("Harness input changed before the requested edit")
        error.code = "draft_conflict"
        throw error
      }
      // Hashing yields to the browser. Recheck the live draft immediately before
      // the synchronous write so a keystroke during hashing cannot be overwritten.
      const live = input.state.getSnapshot()
      if (!overwrite && (live.draftRev !== before.revision || live.draft !== before.text || live.phase !== before.phase)) {
        const error = new Error("Harness input changed during snapshot")
        error.code = "draft_conflict"
        throw error
      }
      if (live.phase !== "plain") {
        const error = new Error("Harness input is busy")
        error.code = "composer_busy"
        throw error
      }
      checkFocus()
      // DSH 0.1.5 adds generic attachments. The host submit RPC below is
      // text-only: do not clear/send just the text and silently omit files.
      // Older DSH exposes the same browser-owned items as imageIds.
      if (request.type === "consume" && (live.attachmentIds ?? live.imageIds ?? []).length > 0) {
        const error = new Error("输入框含有附件，请在 Harness 页面发送；语音发送目前只支持纯文本")
        error.code = "composer_attachments_unsupported"
        throw error
      }
      const consumed = request.type === "consume" ? before : null
      input.setDraft(["clear", "consume"].includes(request.type) ? "" : String(request.text ?? ""))
      await new Promise(resolve => setTimeout(resolve, 0))
      const after = await composerState(request.session_id, input)
      if (consumed !== null) {
        return {
          ...after,
          consumed_text: consumed.text,
          consumed_revision: consumed.revision,
          consumed_hash: consumed.hash,
        }
      }
      return after
    } else if (request.type !== "get") {
      const error = new Error(`Unsupported composer request: ${request.type}`)
      error.code = "unsupported_composer_operation"
      throw error
    }
    return before
  }

  const complete = async (requestId, payload) => {
    await bridgeFetch(`/duplex-control/api/composer/requests/${encodeURIComponent(requestId)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, ...payload }),
      cache: "no-store",
      signal: controller.signal,
    })
  }

  const processRequest = async (candidate) => {
    if (controller.signal.aborted || candidate.target_client_id !== clientId) return
    const claimResponse = await bridgeFetch(
      `/duplex-control/api/composer/requests/${encodeURIComponent(candidate.id)}/claim`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
        cache: "no-store",
        signal: controller.signal,
      },
    )
    if (claimResponse.status === 404 || claimResponse.status === 409) return
    if (!claimResponse.ok) throw new Error(`Composer claim failed: HTTP ${claimResponse.status}`)
    const request = (await claimResponse.json()).request
    if (controller.signal.aborted || request.target_client_id !== clientId) return
    try {
      const composer = await execute(request)
      await complete(request.id, { ok: true, composer })
    } catch (error) {
      await complete(request.id, {
        ok: false,
        error_code: error?.code || "composer_operation_failed",
        error: error instanceof Error ? error.message : String(error),
        status: error?.code === "session_not_ready" ? 503 : 409,
      })
    }
  }

  const poll = async () => {
    if (pollRunning || controller.signal.aborted) return
    clearTimeout(retryTimer)
    pollRunning = true
    let succeeded = false
    try {
      const sessionId = focusedSession() || ''
      const visibility = typeof document === 'undefined' ? 'unknown' : document.visibilityState
      const query = `wait=1&client_id=${encodeURIComponent(clientId)}&session_id=${encodeURIComponent(sessionId)}&visibility=${encodeURIComponent(visibility)}`
      const response = await bridgeFetch(`/duplex-control/api/composer/requests?${query}`, {
        cache: "no-store",
        signal: controller.signal,
      }, 30_000)
      if (!response.ok) return
      const payload = await response.json()
      await Promise.all((payload.requests || []).map(processRequest))
      // Old hosts return an immediate empty list: retain a retry delay
      // rather than spinning if a browser/host upgrade is staggered.
      succeeded = payload.long_poll_supported === true
    } catch (error) {
      if (!controller.signal.aborted) console.warn("duet composer RPC failed:", error)
    } finally {
      pollRunning = false
      if (!controller.signal.aborted) {
        // Successful long polls re-arm without a background-tab timer.
        if (succeeded) void poll()
        else retryTimer = setTimeout(() => { void poll() }, 1000)
      }
    }
  }

  void poll()
  const resume = () => { void poll() }
  window.addEventListener?.('online', resume)
  window.addEventListener?.('pageshow', resume)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume)
  return () => {
    controller.abort()
    clearTimeout(retryTimer)
    window.removeEventListener?.('online', resume)
    window.removeEventListener?.('pageshow', resume)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume)
  }

}
