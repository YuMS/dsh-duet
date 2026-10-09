import { voiceSocketUrl } from './transport.mjs'

/** One page-local feed; Desktop uses the same stream base as voice. */
export class LocalSync {
  constructor({ WebSocketImpl = WebSocket, onChange = () => {} } = {}) {
    this.WebSocketImpl = WebSocketImpl; this.onChange = onChange
    this.listeners = new Set(); this.commands = new Set(); this.results = new Map()
    this.active = false; this.closed = false; this.cursor = null; this.epoch = null
    this.owner = null; this.lastSeen = 0
    this.failures = 0
  }
  start() {
    if (this.closed) return
    let ws
    try { ws = this.ws = new this.WebSocketImpl(voiceSocketUrl({}, globalThis, 'duplex-control/sync/ws')) }
    catch { this.disconnected(); return }
    ws.onopen = () => {
      this.send({ type: 'harness.sync.subscribe', protocol: 'harness_sync_v1', cursor: this.cursor, epoch: this.epoch })
      this.beat()
      clearInterval(this.heartbeat)
      this.lastSeen = Date.now()
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastSeen > 45000) { ws.close(); return }
        this.beat()
      }, 15000)
    }
    ws.onmessage = event => {
      try {
        const value = JSON.parse(event.data); this.lastSeen = Date.now()
        if (value.type === 'harness.sync.command') { for (const fn of this.commands) fn(value.request); return }
        if (value.type !== 'harness.sync.snapshot' || value.protocol !== 'harness_sync_v1') return
        if (!Array.isArray(value.sessions) || !Array.isArray(value.results) || !Number.isSafeInteger(value.cursor)) throw Error('invalid_snapshot')
        if (this.epoch !== value.epoch) this.results.clear()
        this.epoch = value.epoch; this.cursor = value.cursor; this.snapshot = value
        for (const job of value.results) this.results.set(job.completion_seq, job)
        while (this.results.size > 500) this.results.delete(this.results.keys().next().value)
        this.active = true; this.failures = 0
        for (const fn of this.listeners) fn(value)
        this.onChange()
        this.send({ type: 'harness.sync.received', cursor: this.cursor, epoch: this.epoch, more: value.has_more === true })
      } catch { ws.close(1008, 'invalid_sync_snapshot') }
    }
    ws.onerror = () => {}
    ws.onclose = () => {
      this.disconnected()
    }
  }
  disconnected() {
    clearInterval(this.heartbeat); this.active = false
    if (this.closed) return
    for (const fn of this.listeners) fn(null)
    this.onChange()
    this.retry = setTimeout(() => this.start(), Math.min(30000, 3000 * 2 ** this.failures++))
  }
  send(value) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(value)) }
  beat() { this.send({ type: 'harness.sync.heartbeat', owner: this.owner?.() ?? null }) }
  bindOwner(read) { this.owner = read; this.beat(); return () => { if (this.owner === read) { this.owner = null; this.beat() } } }
  refresh() { this.send({ type: 'harness.sync.refresh' }) }
  replay(cursor, epoch) { this.send({ type: 'harness.sync.subscribe', protocol: 'harness_sync_v1', cursor, epoch }) }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  onCommand(fn) { this.commands.add(fn); return () => this.commands.delete(fn) }
  close() { this.closed = true; clearTimeout(this.retry); clearInterval(this.heartbeat); this.ws?.close(); this.listeners.clear(); this.commands.clear() }
}
