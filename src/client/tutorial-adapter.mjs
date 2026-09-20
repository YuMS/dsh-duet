/** DSH browser services plus existing voice connection; never opens a microphone. */
import { PLUGIN_VERSION } from '../shared/state.mjs?v=0.1.1'
import { focusedSession } from './composer.mjs?v=0.1.1'
export function tutorialAdapter(ctx, state, audio, pollReady) {
  let narration
  const completed = new Map()
  const check = signal => signal.throwIfAborted()
  const wait = (ms, signal) => new Promise((resolve,reject) => {
    check(signal)
    const abort=()=>{clearTimeout(timer);reject(signal.reason)}
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},ms)
    signal.addEventListener('abort',abort,{once:true})
  })
  const until = async (fn, signal, seconds=30) => {
    const deadline=Date.now()+seconds*1000
    while(Date.now()<deadline){check(signal);if(await fn())return;await wait(150,signal)}
    throw Error('等待超时，教学已停止；不会自动重新发送')
  }
  const api = async (path, signal, method='GET', body) => {
    check(signal)
    const r=await fetch('/duplex-control/api/'+path,{method,signal,cache:'no-store',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
    const d=await r.json();check(signal)
    if(!r.ok)throw Error(d.detail||d.error_code||'DSH 请求失败')
    return d
  }
  const current=()=>focusedSession(ctx)
  const input=id=>{
    if(current()!==id)throw Error('会话焦点已改变，教学停止')
    const scope=ctx.sessions.scope(id)
    if(!scope)throw Error('教学会话尚未就绪')
    return ctx.conversation.input.for(scope)
  }
  const safeSnapshot=(id,expected)=>{
    const s=input(id).state.getSnapshot()
    if(s.phase!=='plain'||s.draft!==expected||(s.attachmentIds??s.imageIds??[]).length)throw Error('教学输入框已被修改或正忙，已停止，避免覆盖你的内容')
    return s
  }
  return {
    mode:()=>state.mode,current,
    observe(event){if(event.type==='external_message.done'){completed.set(event.message_id,event.status);if(completed.size>128)completed.delete(completed.keys().next().value)}},
    unlock:()=>audio.prepare(),
    async create(name,signal){
      const catalog=await api('sessions',signal), cwd=catalog.sessions.find(s=>s.session_id===current())?.cwd
      const d=await api('sessions',signal,'POST',{name,...(cwd?{cwd}:{})});return d.session.session_id
    },
    async focus(id,signal){
      await api(`sessions/${encodeURIComponent(id)}/activate`,signal,'POST',{})
      await ctx.sessions.refresh();check(signal)
      const navigation=typeof ctx.get==='function'?ctx.get('uiWorkspace'):ctx.uiWorkspace
      if(navigation?.openSession)navigation.openSession(id);else ctx.sessions.open(id)
      await until(()=>current()===id&&ctx.sessions.scope(id),signal)
    },
    async write(id,text,expected,signal){check(signal);safeSnapshot(id,expected);input(id).setDraft(text)},
    async submit(id,expected,signal){
      safeSnapshot(id,expected)
      const {composer}=await api(`sessions/${encodeURIComponent(id)}/composer?require_focus=true`,signal)
      safeSnapshot(id,expected)
      if(composer.text!==expected)throw Error('教学草稿不一致，未发送')
      const {job}=await api(`sessions/${encodeURIComponent(id)}/composer/submit`,signal,'POST',{
        expected_revision:composer.revision,expected_hash:composer.hash,
      });return job
    },
    async enableBroadcast(signal){
      await pollReady(signal);check(signal)
      await state.setMode('tts_only')
      await until(()=>{if(state.mode==='off')throw Error('语音服务器忙或连接不可用');return state.ready},signal,45)
    },
    async waitBroadcast(job,signal){
      await until(async()=>{
        if(state.mode!=='tts_only')throw Error('播报已关闭，教学停止')
        const d=await api(`jobs/${encodeURIComponent(job.id)}`,signal)
        if(d.job.status==='failed')throw Error('教学任务失败：'+(d.job.error||'请查看会话'))
        const status=completed.get(`harness_${job.id}`)
        if(status&&status!=='completed')throw Error('播报未完成，请检查连接')
        return status==='completed'&&!audio.playing()
      },signal,180)
    },
    off:()=>state.setMode('off'),
    stopNarration(){if(narration){try{narration.stop()}catch{};narration=null}},
    async narrate(name,signal){
      check(signal);await audio.prepare();check(signal)
      const response=await fetch(`/duplex-control/tutorial-audio/${name}.wav?v=${PLUGIN_VERSION}`,{signal,credentials:'same-origin'})
      if(!response.ok)throw Error('教学预录音频不可用，请更新插件')
      const buffer=await audio.context.decodeAudioData(await response.arrayBuffer());check(signal)
      await new Promise((resolve,reject)=>{
        const node=audio.context.createBufferSource();node.buffer=buffer;node.connect(audio.context.destination);narration=node
        const abort=()=>{try{node.stop()}catch{};node.disconnect();reject(signal.reason)}
        signal.addEventListener('abort',abort,{once:true})
        node.onended=()=>{signal.removeEventListener('abort',abort);node.disconnect();if(narration===node)narration=null;resolve()}
        node.start()
      });check(signal)
    },
  }
}
