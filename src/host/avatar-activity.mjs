import {mkdir,readdir,readFile,writeFile,rename,unlink,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {defaultStateFile} from './storage-paths.mjs'
import {avatarActivity} from '../shared/avatar-activity.mjs'
import {PLUGIN_VERSION} from '../shared/state.mjs'
export class AvatarActivityOutbox {
  constructor(getConfig,{root=defaultStateFile('avatar-activity'),fetcher=fetch,now=Date.now}={}){
    Object.assign(this,{getConfig,root,fetcher,now});this.records=new Map();this.closed=false;this.chain=Promise.resolve();this.ready=this.load().catch(error=>{this.loadError=error});this.timer=setInterval(()=>void this.flush(),60000);this.timer.unref?.()
  }
  async load(){await mkdir(this.root,{recursive:true,mode:0o700});if((await lstat(this.root)).isSymbolicLink())throw Error('invalid_activity_store');for(const name of (await readdir(this.root)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).slice(0,512)){try{const path=join(this.root,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)continue;const item=JSON.parse(await readFile(path,'utf8'));avatarActivity(item.record);const url=new URL(item.url);if(!['http:','https:'].includes(url.protocol)||url.pathname!=='/avatar-events'||url.username||url.password||url.search||url.hash)continue;if(!Number.isFinite(item.expires)||item.expires>this.now()+86400000||item.expires<=this.now()){await unlink(path);continue}if(typeof item.authorization!=='string'||item.authorization.length>8192||!/^anon_[a-f0-9]{32}$/.test(item.record.user_id))continue;this.records.set(name,item)}catch{}}}
  enqueue(value,user){const work=this.chain.then(async()=>{
    await this.ready;if(this.loadError)throw this.loadError;const event=avatarActivity(value);if(!/^anon_[a-f0-9]{32}$/.test(user))throw Error('invalid_activity_user')
    const name=createHash('sha256').update(user+':'+event.event_id).digest('hex')+'.json';if(this.records.has(name))return
    if(this.records.size>=512)throw Error('activity_queue_full')
    const config=await this.getConfig(),url=new URL(config.endpoints.online);url.protocol=url.protocol==='wss:'?'https:':'http:';url.pathname='/avatar-events';url.search='';url.hash=''
    const item={url:url.href,authorization:config.authorization||'',expires:this.now()+86400000,record:{...event,user_id:user,plugin_version:PLUGIN_VERSION}}
    const path=join(this.root,name),temp=path+'.tmp';await writeFile(temp,JSON.stringify(item),{mode:0o600});await rename(temp,path);this.records.set(name,item)
  });this.chain=work.catch(()=>{});return work.then(()=>{void this.flush();return{accepted:true}})}
  async flush(){await this.ready;if(this.loadError||this.closed||this.busy)return;this.busy=true;try{for(const [name,item]of this.records){if(this.closed)break;let done=item.expires<=this.now();if(!done){try{const response=await this.fetcher(item.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',...(item.authorization?{Authorization:item.authorization}:{})},body:JSON.stringify(item.record)});if(response.ok){const result=await response.json();done=result.persisted===true&&result.event_id===item.record.event_id}else await response.body?.cancel()}catch{}}
      if(done){await unlink(join(this.root,name)).catch(()=>{});this.records.delete(name)}else break
    }}finally{this.busy=false}}
  close(){this.closed=true;clearInterval(this.timer)}
}
