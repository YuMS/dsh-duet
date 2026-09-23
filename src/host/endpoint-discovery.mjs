/** Fixed bootstrap, bounded discovery, and connection-scoped endpoint selection. */
import {isIP} from 'node:net'
import {lookup} from 'node:dns/promises'
import {readFileSync, statSync} from 'node:fs'
import {mkdir, writeFile, rename, unlink} from 'node:fs/promises'
import {dirname} from 'node:path'
import {defaultStateFile} from './storage-paths.mjs'
import {randomUUID} from 'node:crypto'
import {connectionGuidance,normalizeGuidance} from '../shared/connection-guidance.mjs'
import {DEFAULT_DUET_URL, PUBLIC_TRIAL_AUTHORIZATION, isPublicTrialEndpoint} from './service-defaults.mjs'

export function endpointHTTP(endpoint, path) {
  const url=new URL(endpoint)
  url.protocol=url.protocol==='wss:'?'https:':'http:'
  url.pathname=url.pathname.replace(/\/ws\/?$/,'').replace(/\/$/,'')+path
  url.search=''
  return url.toString()
}
export const DISCOVERY_INTERVAL_MS=24*60*60*1000
function recommendationURL(value) {
  if(typeof value!=='string'||!value||value.length>2048) throw Error('invalid_recommended_endpoint')
  const url=new URL(value.includes('://')?value:'ws://'+value)
  if(url.protocol==='http:')url.protocol='ws:'
  if(url.protocol==='https:')url.protocol='wss:'
  const host=url.hostname.replace(/^\[|\]$/g,'')
  if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.hash
    ||!['','/','/ws'].includes(url.pathname)||!['','80','443'].includes(url.port)
    ||[...url.searchParams].some(([k,v])=>k!=='protocol'||v!=='realtime_v2')
    ||(!isIP(host)&&(!host.includes('.')||/\.(local|localhost|internal|test|invalid)\.?$/i.test(host)))) throw Error('invalid_recommended_endpoint')
  url.pathname='/ws';url.search='?protocol=realtime_v2'
  return url
}
function pinnedCandidate(url, addresses) {
  const host=url.hostname.replace(/^\[|\]$/g,'')
  if(!Array.isArray(addresses)||!addresses.length||addresses.length>32
    ||addresses.some(row=>![4,6].includes(row.family)||isIP(row.address)!==row.family
      ||(isIP(host)&&host!==row.address))) throw Error('invalid_endpoint_address')
  // Freeze DNS for the WS connection, not just for validation.
  const pinnedLookup=(_host, options, callback)=>{
    if(typeof options==='function'){callback=options;options={}}
    if(options?.all)callback(null,addresses)
    else callback(null,addresses[0].address,addresses[0].family)
  }
  return {url:url.toString(),addresses,lookup:pinnedLookup}
}
export async function recommendedEndpoint(value, resolve=lookup) {
  const url=recommendationURL(value),host=url.hostname.replace(/^\[|\]$/g,'')
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolve(host,{all:true})
  return pinnedCandidate(url,addresses)
}

export class EndpointDiscovery {
  constructor(getConfig,{fetchImpl=fetch,resolve=lookup,now=Date.now,changed=()=>{},
    cachePath=defaultStateFile('endpoint-discovery.json')}={}) {
    this.getConfig=getConfig;this.fetchImpl=(...args)=>fetchImpl(...args);this.resolve=resolve;this.now=now;this.changed=changed
    this.cache={candidate:null,reason:'discovery_unavailable',hint:connectionGuidance(null)};this.lastAttemptAt=null;this.cachePath=cachePath
    this.inflight=null;this.selected=new Map();this.active=null;this.failedUntil=0
    try {
      if(cachePath&&statSync(cachePath).size<=8192){
        const data=JSON.parse(readFileSync(cachePath,'utf8'))
        if(data.schema_version!==1||data.bootstrap_endpoint!==DEFAULT_DUET_URL
          ||!Number.isFinite(data.last_attempt_at)||data.last_attempt_at<0)throw Error('invalid_cache')
        const candidate=data.candidate?pinnedCandidate(recommendationURL(data.candidate.url),data.candidate.addresses):null
        this.cache={candidate,reason:candidate?'recommended':'no_recommendation',hint:normalizeGuidance(data.connection_hint)}
        this.lastAttemptAt=data.last_attempt_at
      }
    }catch{ /* A missing/corrupt cache must not prevent startup. */ }
  }
  invalidate(){this.selected.clear();this.active=null;this.failedUntil=0}
  async persist(){
    if(!this.cachePath)return
    const temp=`${this.cachePath}.${randomUUID()}.tmp`
    const candidate=this.cache.candidate
    const data={schema_version:1,bootstrap_endpoint:DEFAULT_DUET_URL,last_attempt_at:this.lastAttemptAt,
      candidate:candidate?{url:candidate.url,addresses:candidate.addresses}:null,connection_hint:this.cache.hint}
    try {
      await mkdir(dirname(this.cachePath),{recursive:true,mode:0o700})
      await writeFile(temp,JSON.stringify(data)+'\n',{mode:0o600,flag:'wx'})
      await rename(temp,this.cachePath)
    }catch{ /* Read-only/full disks must not block connecting. */ }
    finally{await unlink(temp).catch(()=>{})}
  }
  refreshIfDue(){
    if(!Object.values(this.getConfig().endpoints).some(isPublicTrialEndpoint))return null
    if(this.inflight)return this.inflight
    const now=this.now()
    if(this.lastAttemptAt!==null&&now>=this.lastAttemptAt&&now-this.lastAttemptAt<DISCOVERY_INTERVAL_MS)return null
    this.lastAttemptAt=now
    const work=(async()=>{
      // Persist attempts as well as successes: an outage must not cause a request on every restart.
      await this.persist()
      try {
        const response=await this.fetchImpl(endpointHTTP(DEFAULT_DUET_URL,'/api/connection-info'),{
          headers:{Authorization:PUBLIC_TRIAL_AUTHORIZATION},redirect:'error',signal:AbortSignal.timeout(2500)})
        if(!response.ok)throw Error('discovery_unavailable')
        const reader=response.body.getReader();let bytes=0,body='';const decoder=new TextDecoder()
        try{while(true){const {done,value:chunk}=await reader.read();if(done)break;bytes+=chunk.length;if(bytes>4096)throw Error('discovery_too_large');body+=decoder.decode(chunk,{stream:true})}body+=decoder.decode()}
        finally{await reader.cancel().catch(()=>{})}
        const data=JSON.parse(body)
        if(data.schema_version!==1||typeof data.recommended_endpoint!=='string')throw Error('invalid_discovery')
        let timer,candidate
        try {
          candidate=data.recommended_endpoint?await Promise.race([
            recommendedEndpoint(data.recommended_endpoint,this.resolve),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('dns_timeout')),1500);timer.unref?.()}),
          ]):null
        }finally{clearTimeout(timer)}
        this.cache={candidate,reason:candidate?'recommended':'no_recommendation',hint:connectionGuidance(data.connection_hint,data.revision)}
        await this.persist()
      }catch{ /* Keep the last known recommendation, even when it is older than a day. */ }
      return this.cache
    })()
    this.inflight=work
    void work.finally(()=>{if(this.inflight===work)this.inflight=null})
    return work
  }
  async plan(mode){
    const config=this.getConfig(), target=config.endpoints[mode]
    if(!isPublicTrialEndpoint(target))return [{url:target,config,selection:'custom',reason:''}]
    this.refreshIfDue()
    const fallback={url:DEFAULT_DUET_URL,config:{...config,authorization:PUBLIC_TRIAL_AUTHORIZATION},selection:'default',reason:''}
    if(this.failedUntil>this.now())return [{...fallback,selection:'fallback',reason:'recommended_cooldown'}]
    const recommendation=this.cache
    if(!recommendation.candidate||recommendation.candidate.url===DEFAULT_DUET_URL)return [{...fallback,reason:recommendation.reason}]
    return [{...recommendation.candidate,config:fallback.config,selection:'recommended',reason:''},fallback]
  }
  used(mode,route,notify=true){this.selected.set(mode,route);this.active=route;if(notify)this.changed()}
  failed(){this.failedUntil=this.now()+60000}
  metadata(route,reason=''){
    return {bootstrap_endpoint:route.selection==='custom'?'':DEFAULT_DUET_URL,
      selected_endpoint:route.url,selection:reason?'fallback':route.selection,fallback_reason:reason||route.reason||'',
      connection_hint:route.selection==='custom'?connectionGuidance(null):normalizeGuidance(this.cache.hint)}
  }
  async effective(mode=null){
    const route=(mode?this.selected.get(mode):this.active)||(await this.plan(mode||'online'))[0]
    return {...route.config,endpoints:{online:route.url,tts_only:route.url}}
  }
  async fetch(url,options={}){
    // These callers are read-only metadata endpoints. Never replay a feedback POST.
    try {
      const response=await this.fetchImpl(url,options)
      if(response.status<500||options.method&&options.method!=='GET')return response
      throw Error('endpoint_http_unavailable')
    }catch(error){
      if(options.method&&options.method!=='GET')throw error
      const configured=this.getConfig()
      if(!isPublicTrialEndpoint(configured.endpoints.online)||new URL(url).origin===new URL(endpointHTTP(DEFAULT_DUET_URL,'/')).origin)throw error
      this.failed()
      const target=new URL(url),fallback=new URL(endpointHTTP(DEFAULT_DUET_URL,'/'))
      target.protocol=fallback.protocol;target.host=fallback.host
      const route={url:DEFAULT_DUET_URL,config:{...configured,authorization:PUBLIC_TRIAL_AUTHORIZATION},selection:'fallback',reason:'metadata_network_failed'}
      this.used('online',route,false)
      return this.fetchImpl(target,options)
    }
  }
}

/** Retry only transport/handshake failures, before any session/audio/task is sent. */
export async function connectEndpoint(WebSocket, routes, {signal, trace, timeout=6000}={}) {
  let fallbackReason=''
  for(let i=0;i<routes.length;i++){
    signal?.throwIfAborted()
    const route=routes[i]
    try {
      const socket=await new Promise((resolve,reject)=>{
        const socket=new WebSocket(route.url,{handshakeTimeout:timeout,maxPayload:16000000,
          ...(route.lookup?{lookup:route.lookup}:{}),...(route.config.authorization?{headers:{Authorization:route.config.authorization}}:{})})
        const abort=()=>{socket.terminate();reject(Error('connection_cancelled'))}
        signal?.addEventListener('abort',abort,{once:true})
        let settled=false
        const finish=(error)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);if(error){socket.terminate();reject(error)}else resolve(socket)}
        socket.once('open',()=>finish())
        socket.on('error',()=>finish(Error('network_error')))
        socket.once('close',()=>finish(Error('handshake_closed')))
        socket.once('unexpected-response',(_request,response)=>{response.resume();finish(Object.assign(Error('http_'+response.statusCode),{status:response.statusCode}))})
      })
      return {socket,route,fallbackReason}
    }catch(error){
      trace?.event('endpoint.attempt_failed',{endpoint:route.url,reason:error.message})
      if(signal?.aborted||[401,403,426,429,503].includes(error.status)||i===routes.length-1)throw error
      fallbackReason=error.message
    }
  }
  throw Error('no_endpoint_available')
}
