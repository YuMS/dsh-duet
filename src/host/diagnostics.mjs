import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { duetHome } from './storage-paths.mjs'
import { diagnosticPayload, DIAGNOSTICS_PROTOCOL } from '../shared/diagnostics.mjs'

const TTL = 6 * 60 * 60 * 1000
const ownerAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
/** Private, bounded outbox. Tickets/authorization never enter trace or public assets. */
export class DiagnosticOutbox {
  constructor({root = join(duetHome(), 'diagnostic-outbox'), fetcher = fetch, now = Date.now,
    isOwnerAlive = ownerAlive} = {}) {
    this.root = root; this.fetcher = fetcher; this.now = now; this.active = new Set(); this.inflight = 0
    this.closed = false
    try {
      mkdirSync(root, {recursive:true, mode:0o700})
      if (lstatSync(root).isSymbolicLink()) throw Error('unsafe_outbox')
      let index = 0
      for (const name of readdirSync(root).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
        const path = join(root, name)
        try {
          const stat = lstatSync(path)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue
          const value = JSON.parse(readFileSync(path, 'utf8'))
          if (!(value.expires > now() && value.expires <= now() + TTL) || index >= 128) {
            unlinkSync(path); continue
          }
          // Another DSH profile/process may still append to this connection.
          if (isOwnerAlive(value.owner_pid)) continue
          const url = new URL(value.target)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
              url.pathname !== '/client-diagnostics' || url.search || url.hash ||
              typeof value.ticket !== 'string' || value.ticket.length > 4096 ||
              typeof value.authorization !== 'string' || value.authorization.length > 8192 ||
              !Array.isArray(value.pending) || value.pending.length > 96) throw Error('invalid_outbox')
          const d = new ConnectionDiagnostics({}, fetcher, this)
          d.id = name.slice(0, -5); d.target = value.target; d.ticket = value.ticket
          d.authorization = value.authorization; d.expires = value.expires
          // Reapply the whitelist while retaining the original idempotency ID and sequence.
          d.pending = value.pending.map(r => ({...diagnosticPayload(r), sequence:r.sequence}))
            .filter(r => r.event && r.event_id && Number.isInteger(r.sequence) && r.sequence >= 0 && r.sequence < 96)
          d.count = 96 // Recovered instances only replay; never manufacture new events.
          this.save(d); d.schedule(index++ * 2000)
        } catch { /* Corrupt evidence must not prevent plugin startup. */ }
      }
    } catch { this.unavailable = true }
  }
  save(d) {
    // Socket close callbacks can arrive during plugin disposal: still persist them.
    if (!d.target) return
    const path = join(this.root, d.id + '.json')
    if (!d.pending.length || d.expires <= this.now()) {
      this.active.delete(d)
      try { unlinkSync(path) } catch { /* already delivered or unavailable */ }
      return
    }
    this.active.add(d)
    if (this.unavailable) return
    let temp
    try {
      if (readdirSync(this.root).filter(n => n.endsWith('.json')).length >= 128) {
        try { lstatSync(path) } catch { return }
      }
      const body = JSON.stringify({target:d.target, ticket:d.ticket, authorization:d.authorization || '',
        expires:d.expires, pending:d.pending, owner_pid:process.pid})
      if (Buffer.byteLength(body) > 65536) return
      temp = path + '.' + randomUUID() + '.tmp'
      writeFileSync(temp, body, {mode:0o600, flag:'wx'}); renameSync(temp, path)
    } catch {
      if (!this.warned) { this.warned = true; console.warn('[duet] Diagnostic outbox unavailable; retrying in memory.') }
    } finally { if (temp) try { unlinkSync(temp) } catch { /* renamed */ } }
  }
  dispose() {
    this.closed = true
    for (const d of this.active) { clearTimeout(d.timer); d.controller?.abort() }
    this.active.clear()
  }
}

/** Bounded, asynchronous batches. Telemetry failure never closes a voice socket. */
export class ConnectionDiagnostics {
  constructor(metadata, fetcher = fetch, outbox = null) {
    this.metadata = metadata; this.fetcher = fetcher
    this.pending = []; this.seen = new Set(); this.count = 0; this.attempts = 0
    this.outbox = outbox; this.id = randomUUID(); this.expires = (outbox?.now() ?? Date.now()) + TTL
  }
  add(value) {
    const row = diagnosticPayload({...value, ...this.metadata, event_id: value.event_id || randomUUID()})
    if (!row || this.seen.has(row.event_id) || this.count >= 96) return
    const terminal = /close|failed|error|pagehide/.test(row.event)
    if (!terminal && this.count >= 80) return // Reserve room for the actual ending.
    const now = this.outbox?.now() ?? Date.now()
    if (this.expires <= now) this.pending = []
    if (!this.pending.length) this.expires = now + TTL // Retain queued events, not session age.
    this.seen.add(row.event_id); row.sequence=this.count++; this.pending.push(row)
    this.outbox?.save(this)
    this.schedule()
  }
  offer(offer, config, endpoint) {
    if (this.target || offer?.protocol !== DIAGNOSTICS_PROTOCOL || typeof offer.ticket !== 'string' || offer.ticket.length > 4096) return
    const url = new URL(endpoint); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = '/client-diagnostics'; url.search = ''; url.hash = ''
    this.target = url.href; this.ticket = offer.ticket; this.authorization = config.authorization
    this.outbox?.save(this)
    this.schedule()
  }
  schedule(delay = 150) {
    if (this.outbox?.closed || !this.target || !this.pending.length || this.timer || this.busy) return
    if ((this.outbox?.now() ?? Date.now()) >= this.expires) {
      this.pending = []; this.outbox?.save(this); return
    }
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, delay); this.timer.unref?.()
  }
  async flush() {
    if (this.outbox?.closed || this.busy || !this.target || !this.pending.length) return
    if ((this.outbox?.now() ?? Date.now()) >= this.expires) {
      this.pending = []; this.outbox?.save(this); return
    }
    if (this.outbox && this.outbox.inflight >= 2) { this.schedule(1000); return }
    this.busy = true; this.attempts++
    if (this.outbox) this.outbox.inflight++
    this.controller = new AbortController()
    const timeout = setTimeout(() => this.controller.abort(), 3000); timeout.unref?.()
    const rows = this.pending.slice(0, 16)
    let failed = false
    try {
      const response = await this.fetcher(this.target, { method: 'POST', redirect: 'error',
        headers: {'Content-Type':'application/json', ...(this.authorization ? {Authorization:this.authorization} : {})},
        body: JSON.stringify({protocol:DIAGNOSTICS_PROTOCOL, ticket:this.ticket, events:rows}),
        signal: this.controller.signal })
      if ([400, 401, 403, 413].includes(response.status)) {
        await response.body?.cancel(); this.pending = []; return
      }
      if (!response.ok) throw Error('diagnostic_upload_failed')
      await response.body?.cancel()
      this.pending.splice(0, rows.length); this.failures = 0
    } catch { failed = true; this.failures = (this.failures || 0) + 1 }
    finally {
      clearTimeout(timeout); this.busy = false
      if (this.outbox) this.outbox.inflight--
      this.outbox?.save(this)
    }
    // Backoff through transient outages; bound lifetime, rate, storage and concurrency.
    this.schedule(failed ? Math.min(60000, 1000 * 2 ** Math.min(this.failures - 1, 6)) : 150)
  }
}
