import { randomUUID } from 'node:crypto'

const fail = code => { const error = new Error(code); error.code = code; error.status = 409; throw error }

/** Bind cancellation to one observed execution, never a later turn in the session. */
export class StopTasks {
  constructor(cancel) { this.cancel = cancel; this.live = new Map(); this.receipts = new Map() }
  start(sessionId, turn) {
    if (this.live.get(sessionId)?.turn === turn) return
    this.live.set(sessionId, { execution_id: randomUUID(), turn })
  }
  end(sessionId, turn) {
    if (this.live.get(sessionId)?.turn === turn) this.live.delete(sessionId)
  }
  snapshot(sessionId) {
    const execution = this.live.get(sessionId)
    if (!execution) fail('no_running_task')
    return { session_id: sessionId, execution_id: execution.execution_id }
  }
  request(sessionId, executionId, owner) {
    if (!owner) fail('stop_task_owner_required')
    if (typeof executionId !== 'string' || !/^[a-f0-9-]{36}$/.test(executionId)) fail('invalid_execution_id')
    const key = `${owner}:${sessionId}:${executionId}`
    if (this.receipts.has(key)) return this.receipts.get(key)
    if (this.live.get(sessionId)?.execution_id !== executionId) fail('execution_changed')
    // DSH's public Host cancel is synchronous: no await between identity check
    // and cancellation. Do not retry rejected/unknown outcomes automatically.
    const result = this.cancel({ sessionId })
    const pending = Promise.resolve(result).then(value => {
      if (value?.accepted !== true) fail('stop_not_accepted')
      return { accepted: true, session_id: sessionId, execution_id: executionId }
    })
    this.receipts.set(key, pending)
    while (this.receipts.size > 500) this.receipts.delete(this.receipts.keys().next().value)
    return pending
  }
}
