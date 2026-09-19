/** Submit feedback with a stable, locally managed user identity. */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {homedir} from 'node:os'

const COOKIE='duplex_feedback_user'
export class RemoteFeedback {
  constructor(getConfig,{keyPath,fetchImpl=fetch}={}){
    this.getConfig=getConfig;this.fetch=fetchImpl
    this.keyPath=keyPath||join(process.env.DSH_HOME||join(homedir(),'.dsh'),'duplex-control','feedback-identity.key')
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
  userId(req){
    const cookie=String(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)
    if(!cookie||!/^([a-f0-9]{32})\.([a-f0-9]{64})$/.test(cookie))throw Error('feedback_identity_unavailable')
    const [id,mac]=cookie.split('.')
    if(!timingSafeEqual(Buffer.from(this.sign(id)),Buffer.from(mac)))throw Error('feedback_identity_unavailable')
    return 'anon_'+id
  }
  ensureIdentity(req,res){
    try{return this.userId(req)}catch{}
    const id=randomBytes(16).toString('hex'),signed=id+'.'+this.sign(id)
    // Same-origin HttpOnly cookie; identity is pseudonymous browser, not account.
    const secure=req.socket?.encrypted||req.headers['x-forwarded-proto']==='https'
    res.setHeader('Set-Cookie',`${COOKIE}=${signed}; Path=/duplex-control; HttpOnly; SameSite=Strict; Max-Age=31536000${secure?'; Secure':''}`)
    return 'anon_'+id
  }
  async insert(record){
    const config=this.getConfig(),url=new URL(config.endpoints.online)
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
