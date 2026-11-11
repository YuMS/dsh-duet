/** User-authorized reference upload and original-file proof. */
import {mkdir,readFile,writeFile,rename,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID,createHash,createHmac} from 'node:crypto'
import {Agent as HTTPAgent,request as httpRequest} from 'node:http'
import {Agent as HTTPSAgent,request as httpsRequest} from 'node:https'
import {duetHome} from './storage-paths.mjs'

const VID=/^voice_[a-f0-9]{32}$/
const MAX=10*1024*1024
const VOICE_ISSUES=new Set(['voice_disabled','voice_audio_missing','voice_not_found'])
function voiceHTTP(){
  const agents={'http:':new HTTPAgent({keepAlive:true,maxSockets:1,maxTotalSockets:4}),
    'https:':new HTTPSAgent({keepAlive:true,maxSockets:1,maxTotalSockets:4})}
  return {close(){for(const agent of Object.values(agents))agent.destroy()},
    fetch(url,options){return new Promise((resolve,reject)=>{
      const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'POST',
        agent:agents[url.protocol],headers:options.headers,signal:options.signal},response=>{
        const chunks=[];let size=0
        response.on('error',reject)
        response.on('data',chunk=>{size+=chunk.length;if(size>16384){response.destroy();reject(Error('voice_response_too_large'))}else chunks.push(chunk)})
        response.on('end',()=>{try{resolve(new Response([204,205,304].includes(response.statusCode)?null:Buffer.concat(chunks),{status:response.statusCode}))}catch(error){reject(error)}})
      });request.on('error',reject);request.end(options.body)
    })}}
}
export class DuetVoices {
  constructor(getConfig,{root=join(duetHome(),'voices'),fetchImpl,scope}={}){
    this.transport=fetchImpl?null:voiceHTTP()
    this.getConfig=getConfig;this.root=root;this.fetch=fetchImpl||this.transport.fetch;this.scope=scope||(async()=>(await this.getConfig()).endpoints.online);this.tail=Promise.resolve()
    this.feature={enabled:true,revision:-1};this.featureAt=0;this.featureEpoch=0
  }
  close(){this.transport?.close()}
  async state(){
    try{return JSON.parse(await readFile(join(this.root,'links.json'),'utf8'))}
    catch(e){if(e.code==='ENOENT')return {selected:'default',voices:[]};throw Error('voice_links_unavailable')}
  }
  async save(state){
    await mkdir(this.root,{recursive:true,mode:0o700})
    const path=join(this.root,'links.json'),temp=path+'.'+randomUUID()+'.tmp'
    await writeFile(temp,JSON.stringify(state),{mode:0o600,flag:'wx'});await rename(temp,path)
  }
  async public(){const s=await this.state();return {selected:this.feature.enabled?s.selected:'default',custom_voice_enabled:this.feature.enabled,voices:s.voices.map(({file,...v})=>v)}}
  queue(work){const next=this.tail.then(work,work);this.tail=next.catch(()=>{});return next}
  async resetDefault(){const s=await this.state();if(s.selected!=='default'){s.selected='default';await this.save(s)}}
  async checkAvailability(force=false){
    if(!force&&Date.now()-this.featureAt<15000)return
    const epoch=this.featureEpoch
    try{
      const value=await this.remote('status',{})
      if(epoch===this.featureEpoch&&typeof value.enabled==='boolean'&&Number.isInteger(value.revision)&&value.revision>=this.feature.revision){
        this.feature=value;this.featureAt=Date.now()
      }
    }catch{/* A temporary outage does not reverse a known disabled policy. */}
    if(!this.feature.enabled)await this.resetDefault()
  }
  refreshAvailability(){return this.queue(async()=>{
    await this.checkAvailability()
    if(this.feature.enabled){
      const s=await this.state();let changed=false
      for(const row of s.voices.filter(v=>v.issue)){
        try{await this.remote('check',{voice_id:row.voice_id});delete row.issue;changed=true}
        catch(e){if(VOICE_ISSUES.has(e.message)&&row.issue!==e.message){row.issue=e.message;changed=true}}
      }
      if(changed)await this.save(s)
    }
    return this.public()
  })}
  applyPolicy(value){
    if(value?.enabled!==false||value?.selected!=='default')return Promise.resolve()
    ++this.featureEpoch;this.feature={...this.feature,enabled:false};this.featureAt=0
    return this.queue(()=>this.resetDefault())
  }
  applyIssue(value){
    if(!VOICE_ISSUES.has(value?.code)||!VID.test(value?.voice_id))return Promise.resolve()
    return this.queue(async()=>{
      const s=await this.state(),row=s.voices.find(v=>v.voice_id===value.voice_id)
      if(row){row.issue=value.code;if(s.selected===row.voice_id)s.selected='default';await this.save(s)}
    })
  }
  async original(row){
    if(!/^[a-f0-9]{64}\.audio$/.test(row.file))throw Error('voice_original_unavailable')
    try{
      const p=join(this.root,row.file),st=await lstat(p)
      if(!st.isFile()||st.isSymbolicLink()||st.size>MAX)throw Error('voice_original_unavailable')
      return await readFile(p)
    }catch{throw Error('voice_original_unavailable')}
  }
  async remote(operation,body,raw,uploadId,voiceId){
    const c=await this.getConfig(),url=new URL(c.endpoints.online)
    url.protocol=url.protocol==='wss:'?'https:':'http:';url.pathname='/voices/'+operation;url.search='';url.hash=''
    const r=await this.fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(operation==='status'?3000:45000),
      headers:{...(c.authorization?{Authorization:c.authorization}:{}),'Content-Type':raw?'application/octet-stream':'application/json',...(uploadId?{'X-Upload-Id':uploadId}:{}),...(voiceId?{'X-Voice-Id':voiceId}:{})},body:raw||JSON.stringify(body)})
    const reader=r.body.getReader();let data=Buffer.alloc(0)
    try{while(true){const {done,value}=await reader.read();if(done)break;data=Buffer.concat([data,value]);if(data.length>16384)throw Error('voice_response_too_large')}}finally{await reader.cancel().catch(()=>{})}
    let result;try{result=JSON.parse(data)}catch{throw Error('voice_service_unavailable')}
    if(!r.ok)throw Error(result.error?.code||result.detail||'voice_service_unavailable')
    return result
  }
  update(body){return this.queue(async()=>{
    try{return await this.mutate(body)}catch(error){
      if(error.message==='custom_voice_disabled'){++this.featureEpoch;this.feature.enabled=false;this.featureAt=0;await this.resetDefault()}
      if(VOICE_ISSUES.has(error.message)&&VID.test(body.voice_id)){
        const s=await this.state(),row=s.voices.find(v=>v.voice_id===body.voice_id)
        if(row){row.issue=error.message;if(s.selected===row.voice_id)s.selected='default';await this.save(s)}
      }
      throw error
    }
  })}
  async mutate(body){
    if(body.op!=='remove'&&!(body.op==='select'&&body.voice_id==='default')){
      await this.checkAvailability()
      if(!this.feature.enabled)throw Error('custom_voice_disabled')
    }
    const s=await this.state()
    if(body.op==='select'){
      if(body.voice_id!=='default'&&!s.voices.some(v=>v.voice_id===body.voice_id))throw Error('voice_not_found')
      const row=s.voices.find(v=>v.voice_id===body.voice_id)
      if(row?.issue){await this.remote('check',{voice_id:row.voice_id});delete row.issue}
      s.selected=body.voice_id;await this.save(s);return this.public()
    }
    if(body.op==='upload'){
      if(s.voices.length>=5)throw Error('local_voice_limit')
      if(typeof body.audio!=='string'||body.audio.length>Math.ceil(MAX/3)*4)throw Error('invalid_audio_size')
      const raw=Buffer.from(body.audio,'base64');if(!raw.length||raw.length>MAX||raw.toString('base64')!==body.audio)throw Error('invalid_audio_size')
      const label=typeof body.name==='string'?body.name.trim():''
      if(!label||label.length>40||/[\x00-\x1f]/.test(label))throw Error('invalid_voice_name')
      const file=createHash('sha256').update(raw).digest('hex')+'.audio'
      await mkdir(this.root,{recursive:true,mode:0o700})
      await writeFile(join(this.root,file),raw,{mode:0o600})
      const scope=await this.scope()
      const value=await this.remote('upload',null,raw,randomUUID())
      if(!VID.test(value.voice_id))throw Error('invalid_voice_response')
      s.voices.push({voice_id:value.voice_id,name:label,file,scope,ref_text:value.ref_text||'',status:value.status})
      await this.save(s);return this.public()
    }
    const row=s.voices.find(v=>v.voice_id===body.voice_id)
    if(!row)throw Error('voice_not_found')
    const sameService=row.scope===await this.scope()
    if(!sameService&&body.op!=='remove')throw Error('voice_service_changed')
    if(body.op==='restore'){
      if(row.issue==='voice_disabled')throw Error('voice_disabled')
      let raw
      if(body.audio!==undefined){
        if(typeof body.audio!=='string'||body.audio.length>Math.ceil(MAX/3)*4)throw Error('invalid_audio_size')
        raw=Buffer.from(body.audio,'base64')
        if(!raw.length||raw.length>MAX||raw.toString('base64')!==body.audio)throw Error('invalid_audio_size')
      }else raw=await this.original(row)
      const v=await this.remote('restore',null,raw,undefined,row.voice_id)
      if(v.voice_id!==row.voice_id)throw Error('invalid_voice_response')
      const file=createHash('sha256').update(raw).digest('hex')+'.audio'
      await writeFile(join(this.root,file),raw,{mode:0o600})
      Object.assign(row,{file,ref_text:v.ref_text,status:v.status});delete row.issue;s.selected=row.voice_id
    }else if(body.op==='refresh'){
      const v=await this.withProof(row,'info',{voice_id:row.voice_id});row.ref_text=v.ref_text;row.status=v.status
    }else if(body.op==='text'){
      if(typeof body.ref_text!=='string'||!body.ref_text.trim()||body.ref_text.length>400)throw Error('invalid_ref_text')
      const v=await this.withProof(row,'text',{voice_id:row.voice_id,ref_text:body.ref_text})
      if(!VID.test(v.voice_id))throw Error('invalid_voice_response')
      if(s.selected===row.voice_id)s.selected=v.voice_id
      Object.assign(row,{voice_id:v.voice_id,ref_text:v.ref_text,status:v.status})
    }else if(body.op==='remove'){
      if(sameService)await this.remote('release',{voice_id:row.voice_id})
      s.voices=s.voices.filter(v=>v!==row);if(s.selected===row.voice_id)s.selected='default'
    }else throw Error('invalid_voice_operation')
    await this.save(s);return this.public()
  }
  async prepare(){
    return this.queue(async()=>{
      if((await this.state()).selected==='default')return 'default'
      await this.checkAvailability(true)
      const s=await this.state();if(s.selected==='default'||!this.feature.enabled)return 'default'
      const row=s.voices.find(v=>v.voice_id===s.selected);if(!row)throw Error('voice_not_found')
      if(row.scope!==await this.scope())throw Error('voice_service_changed')
      return row.voice_id
    })
  }
  async withProof(row,op,body){
    try{return await this.remote(op,body)}catch(error){
      if(error.message!=='voice_proof_required')throw error
      await this.authorize(row)
      return this.remote(op,body)
    }
  }
  async authorize(row){
    const c=await this.remote('challenge',{voice_id:row.voice_id})
    if(c.authorized===true)return
    const result=await this.remote('verify',await this.proof(c,row))
    if(result.authorized!==true)throw Error('voice_proof_invalid')
  }
  async respondChallenge(c){
    await this.tail
    const s=await this.state(),row=s.voices.find(v=>v.voice_id===s.selected)
    if(!row||row.voice_id!==c?.voice_id||row.scope!==await this.scope())throw Error('voice_proof_invalid')
    return this.proof(c,row)
  }
  async proof(c,row){
    if(c.protocol!=='voice_possession_v1'||c.voice_id!==row.voice_id||!/^\w{32}$/.test(c.challenge_id)||
       !/^[a-f0-9]{64}$/.test(c.nonce)||!/^[a-f0-9]{64}$/.test(c.binding)||!Number.isInteger(c.expires_at)||
       c.expires_at<=Date.now()/1000||c.expires_at>Date.now()/1000+300)throw Error('invalid_voice_challenge')
    const raw=await this.original(row),context={}
    for(const k of ['binding','challenge_id','expires_at','protocol','voice_id'])context[k]=c[k]
    const proof=createHmac('sha256',Buffer.from(c.nonce,'hex')).update(JSON.stringify(context)).update(Buffer.from([0])).update(raw).digest('hex')
    return {challenge_id:c.challenge_id,proof}
  }
}
