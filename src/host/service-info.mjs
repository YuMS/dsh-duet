/** Read-only public model aliases from the configured voice service. */
export class WorkModePolicy {
  constructor(getConfig,fetcher=fetch){this.getConfig=getConfig;this.fetcher=fetcher;this.invalidate()}
  invalidate(){this.entry=null}
  get current(){return this.entry?.value||'default_direct'}
  async get(){
    const config=await this.getConfig(),url=new URL(config.endpoints.online)
    url.protocol=url.protocol==='wss:'?'https:':'http:'
    url.pathname=url.pathname.replace(/\/ws\/?$/,'').replace(/\/$/,'')+'/api/work-mode-policy';url.search='';url.hash=''
    if(this.entry?.url!==url.href)this.entry={url:url.href,value:'default_direct',expires:0}
    const entry=this.entry
    if(Date.now()<entry.expires)return entry.value
    return entry.pending??=(async()=>{
      let ttl=5000
      try{
        const r=await this.fetcher(url,{redirect:'error',signal:AbortSignal.timeout(2000),
          headers:config.authorization?{Authorization:config.authorization}:{}})
        if(r.status===404){await r.body?.cancel();entry.value='recommend_agent';ttl=30000}
        else if(r.ok){
          const reader=r.body.getReader(),chunks=[];let size=0
          try{for(;;){const v=await reader.read();if(v.done)break
            size+=v.value.byteLength;if(size>1024)throw Error('invalid_policy');chunks.push(v.value)}}
          finally{await reader.cancel().catch(()=>{})}
          const p=JSON.parse(Buffer.concat(chunks).toString()).work_mode_policy
          if(['recommend_agent','default_direct','direct_only'].includes(p)){entry.value=p;ttl=30000}
        }else await r.body?.cancel()
      }catch{/* Keep the last policy for this endpoint. */}
      entry.expires=Date.now()+ttl;entry.pending=null;return entry.value
    })()
  }
}
export class ServiceInfo {
  constructor(getConfig, fetchImpl = fetch) {
    this.getConfig = getConfig; this.fetch = fetchImpl
    this.cached = null; this.inflight = null; this.epoch = 0
  }
  invalidate() { this.epoch++; this.cached = null; this.inflight = null }
  async get() {
    if (this.cached && Date.now() < this.cached.expires) return this.cached.value
    if (this.inflight) return this.inflight
    const epoch = this.epoch
    const unavailable = { status: 'unavailable', models: null }
    const work = async () => {
      let value = unavailable
      try {
        const config = await this.getConfig()
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
