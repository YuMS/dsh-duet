import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile,mkdir} from 'node:fs/promises'
import {chromium} from 'playwright'
import {publicAsset} from '../../src/host/assets.mjs'
import {registerAvatarHost} from '../../src/host/avatar.mjs'

let upgrade,command,helperClosed=0,frames=[],activities=[]
const manager=registerAvatarHost({connection:{requestRejection:()=>null},webServer:{registerUpgrade(value){upgrade=value.handler;return()=>{}}}},
  {launch:async ({onCommand})=>{command=onCommand;return{send:value=>frames.push(value),close:()=>helperClosed++}}})
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://local').pathname,asset=publicAsset(path)
  if(path==='/duplex-control/api/avatar/activity'){
    let body='';for await(const chunk of req)body+=chunk;activities.push(JSON.parse(body));res.writeHead(202,{'Content-Type':'application/json'}).end('{"accepted":true}');return
  }
  if(asset){res.setHeader('content-type',asset.contentType||'text/javascript');res.end(asset.body??await readFile(asset.url));return}
  if(path!=='/'){res.writeHead(404);res.end();return}
  res.setHeader('content-type','text/html; charset=utf-8')
  res.end(`<!doctype html><html><style>body{background:#111b23;color:#e2edf3;font:15px system-ui}#controls{position:fixed;bottom:32px;left:24px;width:250px;padding:12px;display:flex;gap:12px;border-radius:14px;background:#233440}#controls strong{font-size:28px;margin-right:auto}#controls button{border:0;background:#cdeaff;border-radius:8px;padding:8px}h1{margin:50px 320px;font-size:24px}p{margin:20px 320px;line-height:1.8;color:#9eafba}</style>
  <h1>duet · 3D 形象</h1><p>真实 GLB 角色 / 音频驱动嘴型<br>网页侧栏预览</p><button id="play">播放测试音频</button><div id="controls"><strong>duet<span style="color:#7fd6a6">.</span></strong><button>⇄</button><button>🔊</button></div>
  <script type="module">
  import {mountAvatar} from '/duet/assets/client/avatar.mjs';import {DuetAudio} from '/duet/assets/client/audio.mjs';
  window.audio=new DuetAudio();window.notices=[];window.requested=[];window.current={mode:'online',ready:true};window.sent=[];
  localStorage.setItem('dsh.duet.avatar.v1',JSON.stringify({enabled:true,webOnly:true}));
  const toggle=document.createElement('button');toggle.dataset.duetAvatarToggle='';document.querySelector('#controls').prepend(toggle);
  window.avatar=mountAvatar({controls:()=>document.querySelector('#controls'),audio,state:()=>current,notice:x=>notices.push(x),requestMode:x=>requested.push(x),focusedSession:()=> 'fixture-session'});
  toggle.onclick=()=>avatar.toggle();
  // Deterministic sample clock; real DuetAudio caption/interrupt logic and real GLB.
  // Actual WebAudio stop/fade behavior is covered by audio-interruption.mjs.
  document.querySelector('#play').onclick=()=>{const rate=48000;
  audio.context={state:'running',currentTime:0,sampleRate:rate,close:async()=>{}};
  audio.avatarWave=new Float32Array(1024);audio.avatarFrequency=new Uint8Array(512);
  audio.avatarAnalyser={getFloatTimeDomainData:a=>a.fill(audio.context.currentTime<1?.1:0),getByteFrequencyData:a=>a.fill(10)};
  const chunk={start:0,samples:rate*10,rate,sampleStart:0,ended:false,caption:{from:'',add:'好的，收到！'},
   gain:{gain:{setValueAtTime(){},linearRampToValueAtTime(){}},disconnect(){}},node:{stop(){chunk.ended=true}}};
  audio.responses.set('fixture:7',{response_id:'fixture',generation:7,played:0,basePlayed:0,received:rate*10,chunks:[chunk]});
  avatar.event({type:'response.output_text.delta',response_id:'fixture',delta:'好的，收到！'});
  for(const [audio_sample_end,delta] of [[rate*.4,'好的'],[rate*9.5,'，收到！']])
    audio.event({type:'response.output_text.delta',response_id:'fixture',generation:7,audio_sample_end,delta},e=>sent.push(e));
  };
  window.prefs=value=>{localStorage.setItem('dsh.duet.avatar.v1',JSON.stringify(value));window.dispatchEvent(new StorageEvent('storage',{key:'dsh.duet.avatar.v1'}))};
  </script></html>`)
})
server.on('upgrade',(req,socket,head)=>upgrade(req,socket,head));server.listen(0,'127.0.0.1');await once(server,'listening')
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']})
try{
  const page=await browser.newPage({viewport:{width:1000,height:700}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.clock.install({time:new Date('2026-11-03T00:00:00Z')})
  await page.clock.pauseAt(new Date('2026-11-03T00:00:01Z'))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForSelector('[data-duet-avatar][data-ready=true]',{timeout:60000})
  assert.equal(await page.locator('[data-duet-avatar] canvas').count(),1)
  await page.waitForTimeout(50)
  assert.equal(activities[0]?.event,'avatar.started')
  assert.equal(activities[0].position.space,'viewport_css')
  assert.ok(activities[0].position.total_resolution.width>0)
  assert.equal(activities[0].position.viewport_resolution.width,1000)
  assert.equal(await page.locator('#controls').evaluate(el=>getComputedStyle(el).opacity),'1','DSH main controls must not inherit avatar toolbar hiding')
  assert.equal(await page.locator('#controls').evaluate(el=>getComputedStyle(el).pointerEvents),'auto')
  const toggle=page.locator('[data-duet-avatar-toggle]')
  assert.equal(await toggle.getAttribute('aria-label'),'隐藏拟人角色')
  assert.equal(await toggle.getAttribute('aria-pressed'),'true')
  await toggle.click();assert.equal(await page.locator('[data-avatar-close-confirm]').count(),1)
  assert.equal(await page.locator('[data-avatar-close-overlay]').getAttribute('data-duet-surface-origin'),'page')
  await page.keyboard.press('Escape')
  assert.equal(await toggle.getAttribute('aria-pressed'),'true')
  assert.equal(await page.locator('[data-duet-avatar] canvas').count(),1)
  await toggle.click();await page.locator('[data-avatar-close-choice=cancel]').click()
  assert.equal(await toggle.getAttribute('aria-pressed'),'true')
  await toggle.click();await page.locator('[data-avatar-close-choice=confirm]').click();await page.locator('[data-duet-avatar]').waitFor({state:'detached'})
  assert.equal(await toggle.getAttribute('aria-pressed'),'false')
  await toggle.click();await page.waitForSelector('[data-duet-avatar][data-ready=true]',{timeout:60000})
  assert.equal(await toggle.getAttribute('aria-pressed'),'true')
  await page.evaluate(()=>avatar.inputWritten('测试写入文字','fixture-session'))
  assert.equal(await page.locator('[data-duet-input-text]').textContent(),'测试写入文字')
  await page.evaluate(()=>avatar.cancelInput())
  assert.equal(await page.locator('[data-duet-input-effect]').count(),0)
  assert.equal(await page.evaluate(()=>audio.context),null,'avatar must not create an audio context')
  const originalCanvas=await page.locator('[data-duet-avatar] canvas').elementHandle()
  const full=await page.locator('[data-duet-avatar]').boundingBox()
  for(const [size,scale] of [['medium',.75],['small',.5],['large',1]]){
    await page.evaluate(size=>prefs({enabled:true,webOnly:true,size}),size)
    const box=await page.locator('[data-duet-avatar]').boundingBox()
    assert.equal(box.width,full.width*scale);assert.equal(box.height,full.height*scale)
    assert.ok(await originalCanvas.evaluate(node=>node===document.querySelector('[data-duet-avatar] canvas')))
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh.duet.avatar.v1')).size),size)
  }
  await mkdir(new URL('../../artifacts/avatar/',import.meta.url),{recursive:true})
  await page.screenshot({path:new URL('../../artifacts/avatar/sidebar.png',import.meta.url).pathname})
  await page.locator('#play').click()
  // The character's own motion policy is independent of the OS preference.
  // Check applied angles, not only its label.
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.evaluate(()=>audio.context.currentTime=.2);await page.clock.runFor(100)
  assert.ok(await page.evaluate(()=>audio.avatarSample().rms>.02))
  assert.notEqual(await page.locator('[data-duet-caption]').textContent(),'好的，收到！','LLM text must not race ahead')
  await page.evaluate(()=>audio.context.currentTime=.5);await page.clock.runFor(600)
  assert.equal(await page.locator('[data-duet-caption]').textContent(),'好的')
  assert.ok(await page.evaluate(()=>{
    const node=document.querySelector('[data-duet-gesture="nod"]')
    return node?.dataset.duetMotionPolicy==='independent' && Math.abs(JSON.parse(node.dataset.duetGesturePose).nod)>.05
  }))
  const motionSequence=await page.locator('[data-duet-gesture="nod"]').getAttribute('data-duet-gesture-sequence')
  const bubble=await page.locator('[data-duet-caption]').boundingBox(),character=await page.locator('[data-duet-avatar]').boundingBox()
  assert.ok(bubble.y>=0&&bubble.y+bubble.height<character.y,'bubble must be above the character')
  await page.evaluate(()=>audio.context.currentTime=1.4);await page.clock.runFor(50)
  assert.equal(await page.evaluate(()=>audio.avatarSample().rms),0)
  const captionState=await page.evaluate(()=>({time:audio.context.currentTime,sample:audio.avatarSample(),
    timeline:[...audio.captionTimeline.responses.values()]}))
  assert.equal(await page.locator('[data-duet-caption]').textContent(),'好的',`attention captions must follow the played sample clock: ${JSON.stringify(captionState)}`)
  assert.equal(await page.locator('[data-duet-caption]').isVisible(),true,'pauses must not hide the caption')
  const captionWidth=(await page.locator('[data-duet-caption]').boundingBox()).width
  await page.evaluate(()=>{window.actualSample=audio.avatarSample;audio.avatarSample=()=>({...actualSample.call(audio),text:'这是一段用于验证换行与宽度的长字幕。'.repeat(20)})})
  for(const size of ['small','medium','large']){
    await page.evaluate(size=>prefs({enabled:true,webOnly:true,size}),size);await page.clock.runFor(50)
    assert.equal((await page.locator('[data-duet-caption]').boundingBox()).width,captionWidth)
    assert.equal(await page.locator('[data-duet-caption]').evaluate(el=>getComputedStyle(el).fontSize),'13px')
    const r=await page.locator('[data-duet-caption]').boundingBox()
    assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=1000)
    const scroll=await page.locator('[data-duet-caption]').evaluate(el=>({top:el.scrollTop,height:el.clientHeight,total:el.scrollHeight}))
    assert.ok(scroll.total>scroll.height,'long caption fixture must overflow')
    assert.ok(scroll.total-scroll.height-scroll.top<=1.5,`web caption must reveal newest line after resize: ${JSON.stringify(scroll)}`)
  }
  await page.evaluate(()=>{window.streamingText='';audio.avatarSample=()=>({...actualSample.call(audio),text:streamingText})});await page.clock.runFor(50)
  assert.equal(await page.locator('[data-duet-caption]').isHidden(),true)
  for(let i=0;i<5;i++){
    await page.evaluate(i=>{streamingText='长字幕继续逐字显示，最新一行应始终可见。'.repeat(14)+`结尾${i}`},i);await page.clock.runFor(50)
    const scroll=await page.locator('[data-duet-caption]').evaluate(el=>({top:el.scrollTop,height:el.clientHeight,total:el.scrollHeight}))
    assert.ok(scroll.total>scroll.height)
    assert.ok(scroll.total-scroll.height-scroll.top<=1.5,`web caption must follow streamed text: ${JSON.stringify(scroll)}`)
  }
  await page.evaluate(()=>audio.avatarSample=actualSample);await page.clock.runFor(50)
  await page.screenshot({path:new URL('../../artifacts/avatar/speaking.png',import.meta.url).pathname})
  await page.evaluate(()=>audio.event({type:'output_audio_buffer.clear',response_id:'fixture',generation:7},e=>sent.push(e)))
  await page.clock.runFor(50);assert.equal(await page.evaluate(()=>audio.avatarSample().rms),0)
  const frozen=await page.locator('[data-duet-caption]').textContent()
  await page.clock.runFor(250)
  assert.equal(await page.locator('[data-duet-gesture]').getAttribute('data-duet-gesture-sequence'),motionSequence,'interrupt and caption changes must not restart the motion')
  assert.equal(await page.locator('[data-duet-caption]').textContent(),frozen,'interrupt must freeze rather than reveal remaining words')
  await page.clock.fastForward(2200);await page.clock.runFor(100)
  assert.equal(await page.locator('[data-duet-caption]').isHidden(),true)
  assert.notEqual(await page.locator('[data-duet-gesture]').getAttribute('data-duet-gesture'),'nod','the semantic motion must finish after speech stopped; independent idle gestures may follow')
  await page.clock.fastForward(8100);await page.clock.runFor(600)
  assert.ok(await page.evaluate(()=>{
    const node=document.querySelector('[data-duet-gesture]'),pose=JSON.parse(node?.dataset.duetGesturePose||'{}')
    return ['glance_left','glance_right','tilt'].includes(node?.dataset.duetGesture) && Math.max(Math.abs(pose.yaw),Math.abs(pose.roll))>.03
  }))
  await page.clock.resume()
  await page.evaluate(()=>{current.mode='off';avatar.localState({type:'local_state',protocol:'avatar_local_v1',revision:1,items:[{id:'q1',pending:true,status:'question'},{id:'j1',pending:false,status:'completed'}],available:true,enabled:false,bubble:'small',size:'large'})})
  await page.clock.pauseAt(new Date(Date.now()+7200000))
  await page.clock.fastForward(3600000)
  await page.waitForTimeout(50)
  const hourly=activities.filter(v=>v.event==='avatar.hourly').at(-1)
  assert.ok(hourly);assert.equal(hourly.pending_count,1);assert.equal(hourly.notification_count,1)
  await page.clock.resume()
  await page.evaluate(()=>prefs({enabled:false,webOnly:true}))
  assert.equal(await page.locator('[data-duet-avatar]').count(),0)
  await page.waitForTimeout(50);assert.equal(activities.at(-1).event,'avatar.stopped');assert.equal(activities.at(-1).reason,'disabled')
  await page.evaluate(()=>prefs({enabled:true,webOnly:false}))
  for(let i=0;i<100&&!frames.length;i++)await page.waitForTimeout(50)
  assert.ok(frames.length>0)
  assert.ok(frames.every(f=>!('delta' in f)&&!('response_id' in f)&&!('session_id' in f)))
  command({type:'size',size:'small'})
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('dsh.duet.avatar.v1')).size==='small')
  for(let i=0;i<50&&!frames.some(f=>f.size==='small');i++)await page.waitForTimeout(20)
  assert.ok(frames.some(f=>f.size==='small'));assert.equal(helperClosed,0)
  command({type:'mode',mode:'tts_only'})
  await page.waitForFunction(()=>requested.includes('tts_only'))
  command({type:'hide'})
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('dsh.duet.avatar.v1')).enabled===false)
  for(let i=0;i<50&&!helperClosed;i++)await page.waitForTimeout(20)
  assert.equal(helperClosed,1)
  await page.evaluate(()=>{avatar.dispose();audio.stop();return audio.context.close()})
  assert.deepEqual(errors,[])
  console.log('Avatar: real GLB, deterministic sample-clock captions/mouth/interrupt, shared sizes, native ownership and mode bridge passed (WebAudio clock fixture)')
}finally{await browser.close();manager.close();await new Promise(resolve=>server.close(resolve))}
