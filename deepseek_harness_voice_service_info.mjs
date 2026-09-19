/** Read-only public model aliases from the configured voice service. */
export class ServiceInfo {
  constructor(getConfig, fetchImpl = fetch) {
    this.getConfig = getConfig; this.fetch = fetchImpl
    this.cached = null; this.inflight = null; this.epoch = 0
  }
  invalidate() { this.epoch++; this.cached = null; this.inflight = null }
  async get() {
    if (this.cached && Date.now() < this.cached.expires) return this.cached.value
    if (this.inflight) return this.inflight
    const epoch = this.epoch, config = this.getConfig()
    const unavailable = { status: 'unavailable', models: null }
    const work = async () => {
      let value = unavailable
      try {
        const url = new URL(config.endpoints.online)
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
        url.pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '') + '/api/service-info'
        url.search = ''
        const response = await this.fetch(url, { headers: config.authorization ? { Authorization: config.authorization } : {}, redirect: 'error', signal: AbortSignal.timeout(3000) })
        if (!response.ok) throw Error('service_info_unavailable')
        const reader = response.body.getReader(), decoder = new TextDecoder()
        let body = '', bytes = 0
        try {
          while (true) {
            const { done, value: chunk } = await reader.read()
            if (done) break
            bytes += chunk.length
            if (bytes > 8192) throw Error('service_info_too_large')
            body += decoder.decode(chunk, { stream: true })
          }
          body += decoder.decode()
        } finally { await reader.cancel().catch(() => {}) }
        const data = JSON.parse(body), models = data.models
        if (data.schema_version !== 1 || !models || !['duplex', 'tts'].every(k => typeof models[k] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(models[k]))) throw Error('invalid_models')
        value = { status: 'ok', models: { duplex: models.duplex, tts: models.tts } }
      } catch { /* An unavailable service must not display invented model names. */ }
      if (epoch !== this.epoch) return unavailable
      this.cached = { expires: Date.now() + 30_000, value }; this.inflight = null
      return value
    }
    this.inflight = work()
    return this.inflight
  }
}
