import { randomUUID } from 'node:crypto'
import { diagnosticPayload, DIAGNOSTICS_PROTOCOL } from '../shared/diagnostics.mjs'

/** Bounded, asynchronous batches. Telemetry failure never closes a voice socket. */
export class ConnectionDiagnostics {
  constructor(metadata, fetcher = fetch) {
    this.metadata = metadata; this.fetcher = fetcher
    this.pending = []; this.seen = new Set(); this.count = 0; this.attempts = 0
  }
  add(value) {
    const row = diagnosticPayload({...value, ...this.metadata, event_id: value.event_id || randomUUID()})
    if (!row || this.seen.has(row.event_id) || this.count >= 96) return
    this.seen.add(row.event_id); row.sequence=this.count++; this.pending.push(row)
    this.schedule()
  }
  offer(offer, config, endpoint) {
    if (this.target || offer?.protocol !== DIAGNOSTICS_PROTOCOL || typeof offer.ticket !== 'string' || offer.ticket.length > 4096) return
    const url = new URL(endpoint); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = '/client-diagnostics'; url.search = ''; url.hash = ''
    this.target = url.href; this.ticket = offer.ticket; this.authorization = config.authorization
    this.schedule()
  }
  schedule(delay = 150) {
    if (!this.target || !this.pending.length || this.timer || this.busy || this.attempts >= 120) return
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, delay); this.timer.unref?.()
  }
  async flush() {
    if (this.busy || !this.target || !this.pending.length) return
    this.busy = true; this.attempts++
    const rows = this.pending.slice(0, 16)
    let failed = false
    try {
      const response = await this.fetcher(this.target, { method: 'POST', redirect: 'error',
        headers: {'Content-Type':'application/json', ...(this.authorization ? {Authorization:this.authorization} : {})},
        body: JSON.stringify({protocol:DIAGNOSTICS_PROTOCOL, ticket:this.ticket, events:rows}),
        signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw Error('diagnostic_upload_failed')
      await response.body?.cancel()
      this.pending.splice(0, rows.length); this.failures = 0
    } catch { failed = true; this.failures = (this.failures || 0) + 1 }
    finally { this.busy = false }
    // At most three retries in a row, even if the server disappeared at close.
    if (!failed || this.failures < 3) this.schedule(failed ? 1000 : 150)
  }
}
