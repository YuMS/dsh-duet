import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter,once} from 'node:events'
import {createServer} from 'node:http'
import {WebSocket} from 'ws'
import {AVATAR_DEFAULTS,AVATAR_SIZES,avatarScale,avatarPreferences,saveAvatarPreferences,expressionFor,avatarFrame,avatarInputEffect,captionCue,captionAt,AudioCaptionTimeline} from '../../src/shared/avatar.mjs'

test('desktop input effects are bounded and contain no session data',()=>{
 assert.deepEqual(avatarInputEffect({type:'input_effect',text:'输入内容',session_id:'private',token:'private'}),{type:'input_effect',text:'输入内容'})
 for(const text of ['',null,'字'.repeat(601)])assert.throws(()=>avatarInputEffect({type:'input_effect',text}))
 assert.throws(()=>avatarInputEffect({type:'other',text:'hello'}))
})
import {avatarBinary,sameSecret,launchAvatar,registerAvatarHost} from '../../src/host/avatar.mjs'
import {publicAsset} from '../../src/host/assets.mjs'
import {DuetAudio} from '../../src/client/audio.mjs'
import {nextAvatarSize,sizeButton} from '../../src/shared/avatar-ui.mjs'
import {maskContains} from '../../src/avatar/toolbar.mjs'
test('character hover excludes transparent canvas and uses scaled alpha pixels',()=>{
 const mask=new Array(48*64).fill(0);mask[32*48+24]=1
 for(const s of [1,.75,.5]){
  const r=[70,140,260*s,280*s]
  assert.equal(maskContains(mask,r,70+24.5*r[2]/48,140+32.5*r[3]/64),true)
  assert.equal(maskContains(mask,r,71,141),false)
  assert.equal(maskContains(mask,r,0,0),false)
 }
 assert.equal(maskContains([], [0,0,260,280],100,100),false)
})
test('size button cycles and draws three squares sharing the bottom-left corner',()=>{
  const button={dataset:{},attrs:{},setAttribute(k,v){this.attrs[k]=v}}
  let value='large'
  for(const next of ['medium','small','large']){
    sizeButton(button,value)
    assert.equal(button.dataset.size,value);assert.match(button.attrs['aria-label'],/形象大小/)
    assert.equal((button.innerHTML.match(/stroke-width="2.8"/g)||[]).length,1)
    assert.equal((button.innerHTML.match(/stroke-width="1"/g)||[]).length,2)
    assert.doesNotMatch(button.innerHTML,/stroke-dasharray/)
    for(const [,x,y,w,h] of button.innerHTML.matchAll(/x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)){
      assert.equal(Number(x),3);assert.equal(Number(y)+Number(h),21);assert.equal(w,h)
    }
    value=nextAvatarSize(value);assert.equal(value,next)
  }
})

test('timed text deltas and done wait for played PCM and discard interrupted suffix',()=>{
  const a=new DuetAudio(),shown=[]
  a.context={currentTime:1}
  a.responses.set('r:1',{response_id:'r',generation:1,basePlayed:0,played:0,
    chunks:[{start:1,samples:1000,rate:1000}],received:1000})
  const event=(type,end,delta)=>({type,response_id:'r',generation:1,audio_sample_end:end,delta})
  assert.equal(a.event(event('response.output_text.delta',100,'你'),()=>{},e=>shown.push(e)),true)
  a.event(event('response.output_text.delta',700,'好'),()=>{},e=>shown.push(e))
  a.event({...event('response.output_text.done',1000,''),text:'不得提前显示'},()=>{},e=>shown.push(e))
  assert.equal(shown.length,0)
  a.context.currentTime=1.2;a.progress(()=>{})
  assert.deepEqual(shown.map(e=>e.delta),['你'])
  a.captionTimeline.discardPending('r:1');a.cleared.add('r:1')
  a.context.currentTime=2;a.progress(()=>{})
  assert.deepEqual(shown.map(e=>e.delta),['你'])
  a.event(event('response.output_text.delta',800,'迟到'),()=>{},e=>shown.push(e))
  assert.equal(shown.length,1)
})

test('avatar defaults to local presentation; preferences and gestures are bounded',()=>{
  let value=null;const storage={getItem:()=>value,setItem:(_,v)=>{value=v}}
  assert.deepEqual(avatarPreferences(storage),AVATAR_DEFAULTS)
  saveAvatarPreferences({enabled:false,webOnly:true},storage)
  assert.deepEqual(avatarPreferences(storage),{enabled:false,webOnly:true,size:'large'})
  for(const [size,scale] of Object.entries(AVATAR_SIZES)){
    saveAvatarPreferences({...avatarPreferences(storage),size},storage)
    assert.deepEqual(avatarPreferences(storage),{enabled:false,webOnly:true,size})
    assert.equal(avatarScale(size),scale)
    assert.equal(avatarFrame({mode:'off',rms:0,size}).size,size)
  }
  value=JSON.stringify({enabled:true,webOnly:false,size:'x'})
  assert.equal(avatarPreferences(storage).size,'large');assert.equal(avatarScale(null),1)
  value='broken';assert.deepEqual(avatarPreferences(storage),AVATAR_DEFAULTS)
  for(const text of ['不','不行','不是这样','不能这样做'])assert.equal(expressionFor(text),'shake')
  for(const text of ['好','好的','收到','没问题'])assert.equal(expressionFor(text),'nod')
  assert.equal(expressionFor('哈哈，好开心'),'laugh')
  assert.equal(expressionFor('接下来看看',()=>.5),'glance_right')
  const f=avatarFrame({mode:'online',rms:.2,text:'好'.repeat(500),viseme:'oops',secret:'no'})
  assert.equal(f.text.length,240);assert.equal(f.viseme,'A');assert.ok(!('secret' in f))
  assert.throws(()=>avatarFrame({mode:'online',rms:Infinity}))
})
test('asset and executable paths are an explicit allowlist',()=>{
  assert.match(avatarBinary('win32','x64').replaceAll('\\','/'),/win32-x64\/duet-avatar.exe$/)
  assert.match(avatarBinary('darwin','arm64').replaceAll('\\','/'),/darwin-arm64\/duet-avatar.app\/Contents\/MacOS\/duet-avatar$/)
  assert.equal(avatarBinary('other','x64'),null)
  assert.equal(avatarBinary('darwin','x64'),null)
  assert.equal(avatarBinary('linux','x64'),null)
  assert.equal(avatarBinary('darwin','../../secret'),null)
  assert.equal(sameSecret('a','aa'),false);assert.equal(sameSecret('abc','abc'),true)
  assert.equal(publicAsset('/duet/avatar/character.glb').contentType,'model/gltf-binary')
  assert.equal(publicAsset('/duet/avatar/renderer.mjs').cacheControl,'no-store')
  assert.equal(publicAsset('/duet/avatar/../../host/avatar.mjs'),null)
})
test('captions follow played PCM suffixes, never future text or repeated prefixes',()=>{
  const response={}
  const first=captionCue(response,{segment_id:1,text:'好的，收到！'})
  assert.equal(captionAt(first,0),'')
  assert.equal(captionAt(first,.5),'好的，')
  assert.equal(captionAt(first,1),'好的，收到！')
  const next=captionCue(response,{segment_id:1,text:'好的，收到！我来看看。'})
  assert.equal(captionAt(next,0),'好的，收到！')
  assert.equal(captionAt(next,1),'好的，收到！我来看看。')
  assert.equal(captionAt(captionCue(response,{segment_id:1,text:'好的，收到！我来看看。'}),.3),'好的，收到！我来看看。')
  assert.equal(captionAt(captionCue(response,{segment_id:2,text:'完成。'}),1),'好的，收到！我来看看。完成。')
  assert.equal(captionAt(captionCue(response,{segment_id:2}),1),'好的，收到！我来看看。完成。')
})
test('server attention captions use sample clock and reject late rewinds',()=>{
  const t=new AudioCaptionTimeline()
  t.ingest('r:1',[{sample_end:160,text_prefix:'你好'},{sample_end:320,text_prefix:'你好，我在'}])
  assert.equal(t.text('r:1',100),'')
  assert.equal(t.text('r:1',160),'你好')
  assert.equal(t.text('r:1',300),'你好')
  assert.equal(t.text('r:1',320),'你好，我在')
  t.ingest('r:1',[{sample_end:200,text_prefix:'你'},{sample_end:400,text_prefix:'你好'}])
  assert.equal(t.text('r:1',500),'你好，我在')
  assert.equal(t.text('r:2',500),null)
  t.clear();assert.equal(t.text('r:1',500),null)
})
test('silent PCM keeps captions; interrupted playback does not reveal queued text',()=>{
  const audio=new DuetAudio()
  audio.context={state:'running',currentTime:2.5,sampleRate:48000}
  audio.avatarWave=new Float32Array(1024);audio.avatarFrequency=new Uint8Array(512)
  audio.avatarAnalyser={getFloatTimeDomainData(a){a.fill(0)},getByteFrequencyData(a){a.fill(0)}}
  audio.responses.set('r:1',{response_id:'r',chunks:[{start:2,samples:48000,rate:48000,caption:{from:'',add:'一二三四'},ended:false},{start:3,samples:48000,rate:48000,caption:{from:'一二三四',add:'不要显示'},ended:false}]})
  assert.equal(audio.avatarSample().text,'一二')
  assert.equal(audio.avatarSample().rms,0)
  audio.responses.get('r:1').stopAt=2.5;audio.context.currentTime=3.5
  assert.equal(audio.avatarSample().text,'一二')
  audio.avatarCaption.at=performance.now()-2001
  assert.equal(audio.avatarSample().text,'')
})
test('audio meter uses active playback only, not future chunks or stopped audio',()=>{
  const audio=new DuetAudio()
  audio.context={state:'running',currentTime:1,sampleRate:48000}
  audio.avatarWave=new Float32Array(1024);audio.avatarFrequency=new Uint8Array(512)
  audio.avatarAnalyser={getFloatTimeDomainData(a){a.fill(.1)},getByteFrequencyData(a){a.fill(10)}}
  audio.responses.set('r:1',{response_id:'r',chunks:[{start:2,samples:48000,rate:48000,ended:false}]})
  assert.equal(audio.avatarSample().rms,0)
  audio.context.currentTime=2.1;assert.ok(audio.avatarSample().rms>.09)
  assert.equal(audio.avatarSample().response_id,'r')
  audio.responses.get('r:1').stopAt=2.2;audio.context.currentTime=2.3
  assert.equal(audio.avatarSample().rms,0)
  audio.context.state='suspended';assert.equal(audio.avatarSample().rms,0)
})
test('missing WebView2 reports a recoverable dependency error',async()=>{
  await assert.rejects(launchAvatar({onCommand(){},onExit(){}},{binary:process.execPath,env:{DISPLAY:':fixture'},spawnImpl:()=>{
    const child=new EventEmitter();child.exitCode=null;child.kill=()=>{}
    queueMicrotask(()=>{child.exitCode=78;child.emit('exit',78)})
    return child
  }}),/desktop_webview2_missing/)
})
test('native helper uses private IPC and is killed on dispose',async()=>{
  let peer,child,env,commands=[]
  const helper=await launchAvatar({size:'medium',onCommand:m=>commands.push(m),onExit(){}},{binary:process.execPath,env:{DISPLAY:':test',PRIVATE_TOKEN:'not inherited'},spawnImpl:(path,args,opts)=>{
    assert.equal(path,process.execPath);assert.deepEqual(args,[]);env=opts.env
    assert.equal(env.PRIVATE_TOKEN,undefined)
    assert.equal(env.DUET_AVATAR_SIZE,'medium')
    assert.equal(env.DUET_AVATAR_OWNER_KIND,'browser')
    child=new EventEmitter();child.exitCode=null;child.kill=()=>{child.exitCode=0;peer?.close();child.emit('exit',0)}
    peer=new WebSocket(env.DUET_AVATAR_IPC,[`duet-avatar-${env.DUET_AVATAR_TOKEN}`])
    peer.on('open',()=>peer.send(JSON.stringify({type:'ready',protocol:2})))
    return child
  }})
  try{
    const bad=new WebSocket(env.DUET_AVATAR_IPC,['wrong']);await new Promise(resolve=>bad.on('error',resolve))
    peer.send(JSON.stringify({type:'mode',mode:'online'}));await new Promise(r=>setTimeout(r,20))
    assert.deepEqual(commands,[{type:'mode',mode:'online'}])
    peer.send(JSON.stringify({type:'size',size:'small',secret:'discard'}));await new Promise(r=>setTimeout(r,20))
    assert.deepEqual(commands.at(-1),{type:'size',size:'small'})
    peer.send(JSON.stringify({type:'menu_action',request_id:'menu-1',action:'open_dsh',url:'https://invalid.example'}));await new Promise(r=>setTimeout(r,20))
    assert.deepEqual(commands.at(-1),{type:'menu_action',request_id:'menu-1',action:'open_dsh'})
    peer.send(JSON.stringify({type:'surface_action',id:'s1',revision:2,action:'a3',secret:'discard'}));await new Promise(r=>setTimeout(r,20))
    assert.deepEqual(commands.at(-1),{type:'surface_action',id:'s1',revision:2,action:'a3',checked:false})
    const received=once(peer,'message');helper.send({type:'frame',mode:'off',rms:0})
    assert.equal(JSON.parse((await received)[0]).type,'frame')
  }finally{helper.close()}
  assert.equal(child.exitCode,0)
})
test('native ownership cannot be hijacked by a second DSH page; auth and cleanup',async()=>{
  const http=createServer();let upgrade,stop=0,launches=0,frames=[]
  const ctx={connection:{requestRejection:req=>req.headers.authorization==='fixture'?null:401},webServer:{registerUpgrade(x){upgrade=x.handler;return()=>{}}}}
  const manager=registerAvatarHost(ctx,{launch:async()=>{launches++;return{send:f=>frames.push(f),close(){stop++}}}})
  http.on('upgrade',(req,socket,head)=>upgrade(req,socket,head));http.listen(0,'127.0.0.1');await once(http,'listening')
  const url=`ws://127.0.0.1:${http.address().port}/duet/avatar/ws`,peers=[]
  const connect=async()=>{const ws=new WebSocket(url,{headers:{Authorization:'fixture'}});peers.push(ws);await once(ws,'open');return ws}
  const start=async ws=>{const message=once(ws,'message');ws.send(JSON.stringify({type:'start'}));return JSON.parse((await message)[0])}
  try{
    const denied=new WebSocket(url);await new Promise(resolve=>denied.on('error',resolve))
    const a=await connect(),b=await connect()
    assert.equal((await start(a)).type,'desktop_ready')
    a.send(JSON.stringify({type:'input_effect',text:'已输入',secret:'never'}))
    await new Promise(r=>setTimeout(r,20));assert.deepEqual(frames,[{type:'input_effect',text:'已输入'}])
    a.send(JSON.stringify({type:'surface',panel:{id:'s1',revision:1,nodes:[{kind:'text',text:'教学提示'}],secret:'discard'}}))
    await new Promise(r=>setTimeout(r,20));assert.deepEqual(frames.at(-1),{type:'surface',panel:{id:'s1',revision:1,target:null,nodes:[{kind:'text',text:'教学提示'}]}})
    assert.equal((await start(b)).reason,'desktop_in_use');assert.equal(launches,1)
    a.send(JSON.stringify({type:'local_state',protocol:'avatar_local_v1',revision:1,items:[],secret:'discard'}))
    await new Promise(r=>setTimeout(r,20));assert.equal(frames.at(-1).type,'local_state');assert.equal(frames.at(-1).secret,undefined)
    const count=frames.length
    a.send(JSON.stringify({type:'owner_focus',pid:123,url:'https://invalid.example'}))
    await new Promise(r=>setTimeout(r,20));assert.deepEqual(frames.at(-1),{type:'owner_focus'})
    b.send(JSON.stringify({type:'local_state',protocol:'avatar_local_v1',revision:2,items:[]}));await once(b,'close')
    assert.equal(frames.length,count+1)
    a.close();await once(a,'close');await new Promise(r=>setTimeout(r,20));assert.equal(stop,1)
  }finally{manager.close();for(const ws of peers)ws.terminate();await new Promise(r=>http.close(r))}
})

test('closing a page during native startup cancels its unfinished process',async()=>{
  // Abort paths must also close a helper before it finishes loading external assets.
  const controller=new AbortController();let killed=false
  await assert.rejects(launchAvatar({onCommand(){},onExit(){},signal:controller.signal},{binary:process.execPath,env:{DISPLAY:':fixture'},spawnImpl:()=>{
    const child=new EventEmitter();child.exitCode=null;child.kill=()=>{killed=true;child.exitCode=0;child.emit('exit',0)}
    queueMicrotask(()=>controller.abort())
    return child
  }}),/desktop_cancelled/)
  assert.equal(killed,true)
})
