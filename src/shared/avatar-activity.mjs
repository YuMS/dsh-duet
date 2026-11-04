export const AVATAR_ACTIVITY_PROTOCOL='avatar_activity_v1'
export const AVATAR_ACTIVITY_HOUR=3600000
const sizes=['small','medium','large']
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v)
const finite=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max
const resolution=v=>v&&finite(v.width,1,1000000)&&finite(v.height,1,1000000)?{width:v.width,height:v.height}:null
export function avatarGeometry(v){
  if(!v||!['desktop_physical','viewport_css'].includes(v.space))return null
  const total=resolution(v.total_resolution),p=v.avatar_position
  if(!total||!p||!finite(p.x,-1000000,1000000)||!finite(p.y,-1000000,1000000)||!resolution(p))return null
  const out={space:v.space,total_resolution:total,avatar_position:{x:p.x,y:p.y,width:p.width,height:p.height}}
  if(v.space==='desktop_physical'){
    if(!v.desktop_origin||!finite(v.desktop_origin.x,-1000000,1000000)||!finite(v.desktop_origin.y,-1000000,1000000)||!finite(v.scale,0.25,16))return null
    out.desktop_origin={x:v.desktop_origin.x,y:v.desktop_origin.y};out.scale=v.scale
  }else{const viewport=resolution(v.viewport_resolution);if(!viewport)return null;out.viewport_resolution=viewport}
  return out
}
export function avatarActivity(v){
  if(!v||v.protocol!==AVATAR_ACTIVITY_PROTOCOL||!['avatar.started','avatar.stopped','avatar.hourly'].includes(v.event)||!id(v.event_id)||!id(v.instance_id)||!Number.isSafeInteger(v.sequence)||v.sequence<0||v.sequence>1000000)throw Error('invalid_avatar_activity')
  if(!['web','desktop'].includes(v.presentation)||!sizes.includes(v.size)||!sizes.includes(v.bubble_size)||typeof v.notifications_enabled!=='boolean'||!finite(v.timestamp_ms,0,1e15)||!finite(v.uptime_ms,0,1e12))throw Error('invalid_avatar_activity')
  for(const key of ['pending_count','notification_count'])if(v[key]!==null&&(!Number.isSafeInteger(v[key])||v[key]<0||v[key]>100000))throw Error('invalid_avatar_activity')
  const position=v.position===null?null:avatarGeometry(v.position);if(v.position!==null&&!position)throw Error('invalid_avatar_position')
  const out={protocol:AVATAR_ACTIVITY_PROTOCOL,event:v.event,event_id:v.event_id,instance_id:v.instance_id,sequence:v.sequence,timestamp_ms:v.timestamp_ms,uptime_ms:v.uptime_ms,presentation:v.presentation,size:v.size,bubble_size:v.bubble_size,notifications_enabled:v.notifications_enabled,pending_count:v.pending_count,notification_count:v.notification_count,position}
  if(v.event==='avatar.stopped')out.reason=['disabled','pagehide','unmount','restart','unavailable'].includes(v.reason)?v.reason:'unavailable'
  return out
}
export class AvatarActivityClock {
  constructor({snapshot,send,now=Date.now,uuid=()=>crypto.randomUUID()}){Object.assign(this,{snapshot,send,now,uuid});this.active=null}
  start(presentation){if(this.active?.presentation===presentation)return;if(this.active)this.stop('restart');const now=this.now();this.active={id:this.uuid(),presentation,start:now,next:now+AVATAR_ACTIVITY_HOUR,sequence:0};this.emit('avatar.started')}
  emit(event,reason){const a=this.active;if(!a)return;const now=this.now();try{this.send(avatarActivity({...this.snapshot(),protocol:AVATAR_ACTIVITY_PROTOCOL,event,event_id:this.uuid(),instance_id:a.id,sequence:a.sequence++,timestamp_ms:now,uptime_ms:Math.max(0,now-a.start),presentation:a.presentation,reason}))}catch{}}
  tick(){if(this.active&&this.now()>=this.active.next){this.active.next=this.now()+AVATAR_ACTIVITY_HOUR;this.emit('avatar.hourly')}}
  stop(reason){if(!this.active)return;this.emit('avatar.stopped',reason);this.active=null}
}
