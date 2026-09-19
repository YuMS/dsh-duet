/** Use the same pending objects as DSH's clickable question/approval cards. */
export function nativeInteractions(ctx) {
  const firstSeen = new WeakMap()
  const pending = () => [...ctx.uiSession.pendingInteractions.getSnapshot().values()]
  const publicValue = value => {
    if (!firstSeen.has(value)) firstSeen.set(value, Date.now() / 1000)
    return { id: value.key, session_id: value.sessionId, created_at: firstSeen.get(value),
      kind: value.kind === 'plan-review' ? 'plan_review' : value.kind,
      ...(value.kind === 'approval' ? { approval_id: value.key, tool_name: value.toolName,
        call_id: value.callId || '', reason: value.reason || '' } : { questions: value.questions }) }
  }
  return async (request, signal) => {
    signal?.throwIfAborted()
    if (request.method === 'GET' && request.path === '/api/interactions') {
      return { interactions: pending().filter(v => ['question', 'plan-review', 'approval'].includes(v.kind)).map(publicValue) }
    }
    const match = request.path.match(/^\/api\/interactions\/([^/]+)\/respond$/)
    if (request.method !== 'POST' || !match) return undefined
    const value = pending().find(v => v.key === decodeURIComponent(match[1]))
    if (!value) throw Object.assign(Error('interaction_already_finished'), { code: 'interaction_already_finished' })
    const payload = request.payload || {}
    if (value.kind === 'approval') {
      if (!['allowed-once', 'rejected'].includes(payload.outcome)) throw Error('invalid_approval_outcome')
      await value.answer(payload.outcome)
    } else if (payload.cancelled === true) await value.cancel()
    else {
      if (!Array.isArray(payload.answers)) throw Error('invalid_question_answers')
      await value.answer({ answers: payload.answers })
    }
    return { ok: true, interaction_id: value.key }
  }
}
