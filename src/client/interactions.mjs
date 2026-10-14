/** Use the same pending objects as DSH's clickable question/approval cards. */
export function nativeInteractions(ctx) {
  const firstSeen = new Map()
  const pending = () => ctx.uiSession.sessionStatus
    ? [...ctx.uiSession.sessionStatus.getSnapshot().values()].map(row => row.pendingInteraction).filter(Boolean)
    : [...ctx.uiSession.pendingInteractions.getSnapshot().values()]
  const publicValue = value => {
    if (!firstSeen.has(value.key)) firstSeen.set(value.key, Date.now() / 1000)
    if (firstSeen.size > 512) firstSeen.delete(firstSeen.keys().next().value)
    return { id: value.key, session_id: value.sessionId, created_at: firstSeen.get(value.key),
      kind: value.kind === 'plan-review' ? 'plan_review' : value.kind,
      ...(value.kind === 'approval' ? { approval_id: value.key, tool_name: value.toolName,
        call_id: value.callId || '', reason: value.reason || '' } : { questions: value.questions }) }
  }
  const snapshot = () => pending().filter(v => ['question', 'plan-review', 'approval'].includes(v.kind)).map(publicValue)
  const execute = async (request, signal) => {
    signal?.throwIfAborted()
    if (request.method === 'GET' && request.path === '/api/interactions') {
      return { interactions: snapshot() }
    }
    const match = request.path.match(/^\/api\/interactions\/([^/]+)\/respond$/)
    if (request.method !== 'POST' || !match) return undefined
    const value = pending().find(v => v.key === decodeURIComponent(match[1]))
    if (!value) throw Object.assign(Error('interaction_already_finished'), { code: 'interaction_already_finished' })
    const payload = request.payload || {}
    if (value.kind === 'approval') {
      if (!['allowed-once', 'rejected'].includes(payload.outcome)) throw Error('invalid_approval_outcome')
      await value.answer(payload.outcome)
    } else if (payload.cancelled === true) {
      if (typeof value.cancel === 'function') await value.cancel()
      else if (value.dismissal === 'cancel' && typeof value.dismiss === 'function') await value.dismiss()
      else throw Object.assign(Error('当前问题不能直接取消，请在 DSH 中处理。'), {code:'question_cancel_unavailable'})
    }
    else {
      if (!Array.isArray(payload.answers)) throw Error('invalid_question_answers')
      await value.answer({ answers: payload.answers })
    }
    return { ok: true, interaction_id: value.key }
  }
  execute.snapshot = snapshot
  const store = ctx.uiSession.sessionStatus ?? ctx.uiSession.pendingInteractions
  execute.supportsSync = typeof store.subscribe === 'function'
  execute.subscribe = fn => store.subscribe?.(fn) ?? (() => {})
  return execute
}
