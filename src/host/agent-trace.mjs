/** Low-priority trace frames share the already authenticated voice WebSocket. */
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

export const TRACE_PROTOCOL='duet_trace_v1'
const compress=promisify(gzip), PART_BYTES=16*1024
export class AgentTraceSender {
  constructor(store,send,{canSend=()=>true,clock=()=>Date.now(),target=()=>null}={}) {
    this.target=target
    this.store=store;this.send=send;this.canSend=canSend;this.clock=clock
    this.closed=false;this.ready=false;this.busy=false;this.part=0;this.row=null;this.inflight=null
    this.timer=setInterval(()=>void this.flush(),250);this.timer.unref?.()
  }
  offer(protocol){
    const target=this.target()
    this.ready=protocol===TRACE_PROTOCOL && (!this.store.bindTarget || !!target && this.store.bindTarget(target))
  }
  handle(event){
    if(!event.type?.startsWith('duet.trace.'))return false
    if(event.protocol!==TRACE_PROTOCOL)return true
    const f=this.inflight
    if(event.type==='duet.trace.ack' && f && event.stream===f.stream && event.seq===f.seq &&
      event.part===f.part && event.sha256===f.sha256 && event.persisted===true){
      if(f.part+1===f.parts){this.store.acknowledge(f.seq);this.row=null;this.part=0}
      else this.part++
      this.inflight=null;this.attempt=0
    }else if(event.type==='duet.trace.retry'){
      this.sentAt=this.clock();this.retryMs=10000
    }
    return true
  }
  async flush(){
    if(this.closed||!this.ready||this.busy||!this.canSend())return
    if(this.inflight){
      if(this.clock()-this.sentAt<(this.retryMs||5000))return
      this.send(this.inflight);this.sentAt=this.clock();return
    }
    this.busy=true
    try{
      if(!this.row){
        const row=this.store.head();if(!row)return
        this.row={...row,bytes:Buffer.from(row.body)};this.part=0
      }
      const row=this.row,chunk=row.bytes.subarray(this.part*PART_BYTES,(this.part+1)*PART_BYTES)
      const data=await compress(chunk)
      if(this.closed||!this.canSend())return
      this.inflight={type:'duet.trace.batch',protocol:TRACE_PROTOCOL,stream:this.store.id,
        seq:row.seq,part:this.part,parts:Math.ceil(row.bytes.length/PART_BYTES),encoding:'gzip+base64',
        sha256:createHash('sha256').update(chunk).digest('hex'),data:data.toString('base64')}
      this.sentAt=this.clock();this.send(this.inflight)
    }catch{this.sentAt=this.clock();this.retryMs=10000}
    finally{this.busy=false}
  }
  close(){this.closed=true;clearInterval(this.timer)}
}
