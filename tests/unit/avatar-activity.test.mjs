import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {AvatarActivityClock,avatarActivity,avatarGeometry,AVATAR_ACTIVITY_HOUR} from '../../src/shared/avatar-activity.mjs'
import {AvatarActivityOutbox} from '../../src/host/avatar-activity.mjs'
const snapshot=()=>({size:'large',bubble_size:'medium',notifications_enabled:true,pending_count:2,notification_count:3,position:{space:'desktop_physical',total_resolution:{width:6400,height:2160},desktop_origin:{x:-2560,y:0},scale:2,avatar_position:{x:-1200,y:500,width:520,height:560}}})
const row=()=>({...snapshot(),protocol:'avatar_activity_v1',event:'avatar.hourly',event_id:'event-1',instance_id:'instance-1',sequence:1,timestamp_ms:1000,uptime_ms:1000,presentation:'desktop'})
test('avatar lifecycle emits once, uses current hourly state and never backfills sleep',()=>{
  let time=0,id=0,current=snapshot();const sent=[]
  const clock=new AvatarActivityClock({snapshot:()=>current,send:r=>sent.push(r),now:()=>time,uuid:()=>String(++id)})
  clock.tick();assert.equal(sent.length,0);clock.start('desktop');clock.start('desktop');assert.equal(sent.length,1)
  time=AVATAR_ACTIVITY_HOUR-1;clock.tick();assert.equal(sent.length,1)
  current={...current,notifications_enabled:false,bubble_size:'small',pending_count:0,notification_count:7}
  time++;clock.tick();assert.equal(sent[1].event,'avatar.hourly');assert.equal(sent[1].notification_count,7);assert.equal(sent[1].notifications_enabled,false)
  time+=10*AVATAR_ACTIVITY_HOUR;clock.tick();assert.equal(sent.length,3)
  clock.stop('disabled');clock.stop('unmount');time+=AVATAR_ACTIVITY_HOUR;clock.tick();assert.equal(sent.length,4);assert.equal(sent[3].reason,'disabled')
  clock.start('web');assert.notEqual(sent[4].instance_id,sent[0].instance_id)
})
test('avatar payload keeps geometry and counts but strips text, names and credentials',()=>{
  const clean=avatarActivity({...row(),text:'private',session_name:'private',token:'private',position:{...row().position,monitor_name:'private'}})
  assert.ok(!JSON.stringify(clean).includes('private'));assert.equal(clean.position.avatar_position.x,-1200);assert.equal(clean.position.total_resolution.width,6400)
  assert.equal(avatarGeometry({...row().position,avatar_position:{...row().position.avatar_position,x:NaN}}),null)
  assert.throws(()=>avatarActivity({...row(),notification_count:-1}));assert.throws(()=>avatarActivity({...row(),event_id:'../x'}))
  assert.equal(avatarActivity({...row(),position:null}).position,null)
  const web=avatarGeometry({space:'viewport_css',total_resolution:{width:1920,height:1080},viewport_resolution:{width:1000,height:700},avatar_position:{x:20,y:400,width:260,height:210}})
  assert.equal(web.space,'viewport_css');assert.equal(web.viewport_resolution.height,700)
})
test('avatar uploads work without voice tickets and resume with the original endpoint and ID',async()=>{
  const root=await mkdtemp(join(tmpdir(),'duet-avatar-events-'));let first,second
  const config=()=>({endpoints:{online:'wss://fixture.invalid/ws'},authorization:'test'})
  try{
    first=new AvatarActivityOutbox(config,{root,fetcher:async()=>{throw Error('offline')}})
    await first.enqueue({...row(),user_id:'forged'},'anon_'+'a'.repeat(32));while(first.busy)await new Promise(r=>setTimeout(r,5));first.close()
    const files=await readdir(root);assert.equal(files.length,1)
    const stored=JSON.parse(await readFile(join(root,files[0]),'utf8'));assert.equal(stored.record.user_id,'anon_'+'a'.repeat(32))
    const sent=[];second=new AvatarActivityOutbox(()=>assert.fail('must retain destination'),{root,fetcher:async(url,options)=>{sent.push({url,record:JSON.parse(options.body)});return new Response(JSON.stringify({persisted:true,event_id:'event-1'}))}})
    await second.flush();assert.equal(sent.length,1);assert.equal(sent[0].url,'https://fixture.invalid/avatar-events');assert.equal(sent[0].record.event_id,'event-1');assert.deepEqual(await readdir(root),[])
  }finally{first?.close();second?.close();await rm(root,{recursive:true,force:true})}
})
test('failed acknowledgement retains events and expiry removes them',async()=>{
  const root=await mkdtemp(join(tmpdir(),'duet-avatar-events-'));let time=0
  const box=new AvatarActivityOutbox(()=>({endpoints:{online:'wss://fixture.invalid/ws'}}),{root,now:()=>time,fetcher:async()=>new Response(JSON.stringify({persisted:false}))})
  try{await box.enqueue(row(),'anon_'+'a'.repeat(32));while(box.busy)await new Promise(r=>setTimeout(r,5));assert.equal(box.records.size,1);time=86400001;await box.flush();assert.equal(box.records.size,0)}finally{box.close();await rm(root,{recursive:true,force:true})}
})
