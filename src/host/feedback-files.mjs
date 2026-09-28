/** Submit feedback with a stable, locally managed user identity. */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs'
import {dirname} from 'node:path'
import {defaultStateFile} from './storage-paths.mjs'
import {IDENTITY_HEADER, IDENTITY_PROTOCOL_PREFIX, validIdentityToken} from '../shared/identity.mjs'

const COOKIE='duplex_feedback_user'
export class RemoteFeedback {
  constructor(getConfig,{keyPath,fetchImpl=fetch}={}){
    this.getConfig=getConfig;this.fetch=fetchImpl
    this.keyPath=keyPath||defaultStateFile('feedback-identity.key')
    this.key=null
  }
  identityKey(){
    if(this.key)return this.key
    mkdirSync(dirname(this.keyPath),{recursive:true,mode:0o700})
    if(!existsSync(this.keyPath)){
      const tmp=this.keyPath+'.'+randomBytes(8).toString('hex')+'.tmp'
      const fd=openSync(tmp,'wx',0o600)
      try{writeFileSync(fd,randomBytes(32));fsyncSync(fd)}finally{closeSync(fd)}
      try{linkSync(tmp,this.keyPath)}catch(e){if(e.code!=='EEXIST')throw e}finally{unlinkSync(tmp)}
      const d=openSync(dirname(this.keyPath),'r');try{fsyncSync(d)}finally{closeSync(d)}
    }
    const key=readFileSync(this.keyPath);if(key.length!==32)throw Error('feedback_identity_key_invalid')
    this.key=key;return key
  }
  sign(id){return createHmac('sha256',this.identityKey()).update(id).digest('hex')}
  identityToken(req){
    const header=req.headers?.[IDENTITY_HEADER.toLowerCase()]
    const protocols=String(req.headers?.['sec-websocket-protocol']||'').split(',').map(x=>x.trim()).filter(x=>x.startsWith(IDENTITY_PROTOCOL_PREFIX))
    if(protocols.length>1)throw Error('feedback_identity_unavailable')
    const cookie=String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)
    const token=header??(protocols.length?protocols[0].slice(IDENTITY_PROTOCOL_PREFIX.length):cookie)
    if(!validIdentityToken(token))throw Error('feedback_identity_unavailable')
    const [id,mac]=token.split('.')
    if(!timingSafeEqual(Buffer.from(this.sign(id)),Buffer.from(mac)))throw Error('feedback_identity_unavailable')
    return token
  }
  userId(req){return 'anon_'+this.identityToken(req).split('.')[0]}
  ensureCredential(req,res){
    try{return this.identityToken(req)}catch{}
    const id=randomBytes(16).toString('hex'),signed=id+'.'+this.sign(id)
    // Same-origin HttpOnly cookie; identity is pseudonymous browser, not account.
    const secure=req.socket?.encrypted||req.headers['x-forwarded-proto']==='https'
    res.setHeader('Set-Cookie',`${COOKIE}=${signed}; Path=/duplex-control; HttpOnly; SameSite=Strict; Max-Age=31536000${secure?'; Secure':''}`)
    return signed
  }
  ensureIdentity(req,res){return 'anon_'+this.ensureCredential(req,res).split('.')[0]}
  async insert(record,{config:connectionConfig}={}){
    const config=connectionConfig||await this.getConfig(),url=new URL(config.endpoints.online)
    url.protocol=url.protocol==='wss:'?'https:':'http:'
    url.pathname=url.pathname.replace(/\/ws\/?$/,'').replace(/\/$/,'')+'/feedback';url.search=''
    const response=await this.fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',...(config.authorization?{Authorization:config.authorization}:{})},body:JSON.stringify(record)})
    if(!response.ok)throw Error(response.status===409?'feedback_conflict':'feedback_unavailable')
    const body=await response.text();if(body.length>4096)throw Error('feedback_invalid_receipt')
    const result=JSON.parse(body)
    if(result.persisted!==true||typeof result.archive_id!=='string')throw Error('feedback_invalid_receipt')
    return result
  }
}
