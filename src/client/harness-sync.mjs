import { broadcastText } from '../shared/result-notification.mjs'
export const SYNC_CAPABILITIES = ['session_state', 'pending_interactions', 'task_results']

/** Coalesced state and acknowledged results on the negotiated voice connection. */
export class HarnessSync {
  constructor(send, feed, readState, report = () => {}, resume = {}) {
    Object.assign(this, { send, feed, readState, report, resume })
    this.active = false; this.closed = false; this.sequence = 0; this.abort = new AbortController()
  }
  offer(value) {
    if (this.offerValue || this.closed || !this.feed?.active || value?.protocol !== 'harness_sync_v1' ||
        JSON.stringify(value.capabilities) !== JSON.stringify(SYNC_CAPABILITIES) ||
        !/^[a-f0-9]{32}$/.test(value.connection_id) || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || typeof value.epoch !== 'string') return
    this.offerValue = value; this.cursor = value.cursor; this.epoch = value.epoch
    if (this.resume.epoch === value.epoch && Number.isSafeInteger(this.resume.cursor)) this.cursor = Math.min(this.resume.cursor, value.cursor)
    Object.assign(this.resume, {epoch:this.epoch,cursor:this.cursor})
    this.send({type:'harness.sync.subscribe', connection_id:value.connection_id, protocol:value.protocol,
      capabilities:SYNC_CAPABILITIES, cursor:this.cursor, epoch:this.epoch, sequence:0, state:this.readState()})
    this.timer = setTimeout(() => this.fallback('negotiation_timeout'), 5000)
  }
  event(event) {
    if (!event.type?.startsWith('harness.sync.')) return false
    if (this.closed || event.connection_id !== this.offerValue?.connection_id) return true
    if (event.type === 'harness.sync.ready' && !this.active) {
      if (JSON.stringify(event.capabilities) !== JSON.stringify(SYNC_CAPABILITIES)) { this.fallback('capability_mismatch'); return true }
      clearTimeout(this.timer); this.active = true
      this.report({event:'browser.harness_transport', transport:'harness_sync_v1'})
      this.stopFeed = this.feed.subscribe(() => {
        if (!this.feed.active) { this.fallback('local_sync_unavailable'); return }
        this.changed(); void this.drain()
      })
      this.feed.replay(this.cursor, this.epoch)
      this.heartbeat = setInterval(() => {
        if (!this.feed.active) { this.fallback('local_sync_unavailable'); return }
        this.send({type:'harness.sync.heartbeat', connection_id:this.offerValue.connection_id})
      }, 15000)
      this.changed(); void this.drain()
    } else if (event.type === 'harness.sync.rejected') this.fallback('negotiation_rejected')
    else if (event.type === 'harness.sync.state_ack' && event.sequence === this.statePending?.sequence) {
      clearInterval(this.stateTimer); this.statePending = null
      if (!event.accepted) this.fallback('state_rejected')
      else if (this.stateDirty) this.changed()
    } else if (event.type === 'harness.sync.ack' && this.pending?.id === event.event_id) {
      event.accepted === true ? this.pending.resolve() : this.pending.reject(Error('result_not_accepted'))
    }
    return true
  }
  async deliver(job) {
    const id = `${this.epoch}:${job.completion_seq}:${job.id}`
    const event = {type:'harness.sync.push', connection_id:this.offerValue.connection_id,
      event_id:id, epoch:this.epoch, result:{id:job.id, session_id:job.session_id,
        status:job.status, completion_seq:job.completion_seq, completed_at:job.completed_at,
        result:broadcastText(job.result || ''), error:broadcastText(job.error || ''), origin:job.origin || ''}}
    await new Promise((resolve, reject) => {
      let attempts = 0
      const retry = () => {
        if (++attempts > 5) { finish(); reject(Error('result_ack_timeout')); return }
        this.send(event)
      }
      const timer = setInterval(retry, 2000)
      const onAbort = () => { finish(); reject(Error('sync_closed')) }
      const finish = () => { clearInterval(timer); this.abort.signal.removeEventListener('abort', onAbort); this.pending = null }
      this.pending = {id, resolve:()=>{finish();resolve()}, reject:error=>{finish();reject(error)}}
      this.abort.signal.addEventListener('abort', onAbort, {once:true}); retry()
    })
    this.cursor = job.completion_seq; this.resume.cursor = this.cursor
  }
  changed() {
    if (!this.active || this.closed) return
    this.stateDirty = true
    if (this.statePending) return
    const state = this.readState(), fingerprint = JSON.stringify(state)
    this.stateDirty = false
    if (fingerprint === this.lastState) return
    this.lastState = fingerprint
    const event = this.statePending = {type:'harness.sync.state', connection_id:this.offerValue.connection_id,
      epoch:this.epoch, sequence:++this.sequence, state}
    let attempts = 0
    this.stateTimer = setInterval(() => { if (++attempts > 4) this.fallback('state_ack_timeout'); else this.send(event) }, 2000)
    this.send(event)
  }
  async drain() {
    if (this.draining || this.closed || !this.active) return
    this.draining = true
    try {
      if (this.feed.epoch !== this.epoch) throw Error('result_source_restarted')
      while (!this.closed && this.active) {
        const job = [...this.feed.results.values()].filter(j => j.completion_seq > this.cursor)
          .sort((a,b) => a.completion_seq - b.completion_seq)[0]
        if (!job) break
        await this.deliver(job)
      }
    } catch (error) { if (!this.closed) this.fallback(error.message) }
    finally { this.draining = false }
  }
  fallback(reason) {
    if (this.closed) return
    if (this.offerValue) this.send({type:'harness.sync.fallback',connection_id:this.offerValue.connection_id})
    this.report({event:'browser.harness_transport',transport:'polling',reason}); this.close()
  }
  close() {
    this.closed = true; this.active = false; clearTimeout(this.timer)
    clearInterval(this.heartbeat); clearInterval(this.stateTimer); this.stopFeed?.(); this.abort.abort()
  }
}
