/** Read-only service notices; no model calls and no client-controlled proxy target. */
export class ServiceNotices {
  constructor(getConfig, fetchImpl = fetch) {
    this.getConfig = getConfig
    this.fetch = (...args) => fetchImpl(...args)
    this.cached = null
    this.inflight = null
    this.epoch = 0
  }
  invalidate() { this.epoch++; this.cached = null; this.inflight = null }
  async get() {
    if (this.cached && Date.now() < this.cached.expires) return this.cached.value
    if (this.inflight) return this.inflight
    const epoch = this.epoch
    const config = this.getConfig()
    const work = async () => {
      let value
      try {
        const url = new URL(config.endpoints.online)
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
        url.pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '') + '/announcements'
        url.search = ''
        const response = await this.fetch(url, { headers: config.authorization ? { Authorization: config.authorization } : {}, redirect: 'error', signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('notices_unavailable')
        let body = '', bytes = 0
        const reader = response.body.getReader(), decoder = new TextDecoder()
        try {
          while (true) {
            const { done, value: chunk } = await reader.read()
            if (done) break
            bytes += chunk.length
            if (bytes > 128_000) throw new Error('notices_too_large')
            body += decoder.decode(chunk, { stream: true })
          }
          body += decoder.decode()
        } finally { await reader.cancel().catch(() => {}) }
        const payload = JSON.parse(body)
        if (payload.version !== 1 || !Array.isArray(payload.items) || payload.items.length > 50) throw new Error('invalid_notices')
        const items = payload.items.map(item => {
          if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.body !== 'string'
            || item.id.length > 128 || item.title.length > 200 || item.body.length > 4000
            || typeof item.published_at !== 'string' || !Number.isFinite(Date.parse(item.published_at))
            || !['info', 'update', 'warning'].includes(item.level)) throw new Error('invalid_notice')
          return { id: item.id, title: item.title, body: item.body, published_at: item.published_at, level: item.level }
        })
        value = { status: 'ok', version: 1, items }
      } catch { value = { status: 'unavailable', version: 1, items: [] } }
      if (epoch === this.epoch) { this.cached = { expires: Date.now() + 60_000, value }; this.inflight = null }
      return value
    }
    this.inflight = work()
    return this.inflight
  }
}
