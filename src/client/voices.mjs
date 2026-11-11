import {identityFetch} from './identity.mjs'
const messages={local_voice_limit:'最多保留 5 个自定义音色。',ip_voice_limit:'当前网络已授权 5 个音色，请先移除一个。',
  challenge_daily_limit:'今天的音色验证次数已用完，请明天再试。',upload_daily_limit:'今天的音频上传次数已用完。',
  voice_proof_invalid:'原音频验证未通过，请检查本地原文件。',voice_original_unavailable:'找不到本地原音频。',
  audio_duration_must_be_3_to_15_seconds:'请选择 3–15 秒的音频。',voice_service_unavailable:'音色服务暂不可用，请稍后重试。'}
const pending=v=>['queued','recognizing'].includes(v.status)
messages.custom_voice_disabled='自定义音色暂不可用，已切换为默认音色。'
Object.assign(messages,{voice_disabled:'此音色已被服务端停用，不能使用或通过重新上传恢复。请选择其他音色。',
  voice_audio_missing:'服务端的参考音频已丢失，请重新上传原音频恢复。',
  voice_not_found:'服务端已没有这份音色记录，请移除后重新新增音色。',
  voice_original_mismatch:'请选择最初上传的同一份音频文件，不能用其他音频替换。'})
const ADD='__add__'
export function mountVoices(root){
  let state={selected:'default',voices:[]},busy=false,loaded=false,stopped=false,timer,featureTimer,adding=false,editing=null,draft=null,recovering=null
  const attempts=new Map(),failed=new Set(),get=s=>root.querySelector(s)
  const choice=get('[data-choice]'),status=get('[data-status]'),text=get('[data-text]')
  const api=async body=>{
    const r=await identityFetch('/duplex-control/api/voices',body?{method:'POST',headers:{'Content-Type':'application/json','X-Duplex-Settings':'1'},body:JSON.stringify(body)}:{})
    const v=await r.json();if(!r.ok)throw Error(v.detail||'voice_service_unavailable');return v
  }
  const fail=e=>{status.textContent=messages[e.message]||'音色操作未成功，请稍后重试。'}
  const close=()=>{adding=false;editing=null;draft=null;recovering=null;get('[data-name]').value='';get('[data-file]').value='';get('[data-consent]').checked=false;get('[data-reupload-file]').value=''}
  const draw=()=>{
    if(stopped)return
    const disabled=state.custom_voice_enabled===false
    if(disabled){close();state.selected='default'}
    if(recovering&&!state.voices.some(v=>v.voice_id===recovering&&v.issue))recovering=null
    get('[data-availability]').hidden=!disabled
    get('[data-availability]').textContent=disabled?messages.custom_voice_disabled:''
    choice.replaceChildren(new Option('默认音色','default'))
    for(const v of state.voices){const option=new Option(v.name+(v.issue==='voice_disabled'?'（已停用）':v.issue?'（需恢复）':v.status==='ready'?'':'（待完成）'),v.voice_id);option.disabled=disabled;choice.add(option)}
    const add=new Option('＋ 新增音色',ADD);add.disabled=disabled||state.voices.length>=5;choice.add(add)
    choice.value=recovering||(adding?(editing||ADD):state.selected);choice.disabled=busy||!loaded
    const recovery=state.voices.find(v=>v.voice_id===recovering)
    get('[data-recovery]').hidden=!recovery
    get('[data-voice-issue]').textContent=recovery?(messages[recovery.issue]||'') : ''
    get('[data-reupload-fields]').hidden=recovery?.issue!=='voice_audio_missing'
    for(const el of root.querySelectorAll('[data-recovery] input,[data-recovery] button'))el.disabled=busy||!loaded
    get('[data-create]').hidden=!adding;get('[data-upload-fields]').hidden=!!editing;get('[data-editor]').hidden=!editing
    get('[data-remove]').hidden=state.selected==='default'||adding||!!recovering
    get('[data-cancel]').textContent=editing?'返回选择音色':'取消'
    for(const el of root.querySelectorAll('[data-create] input,[data-create] button,[data-remove]'))el.disabled=busy||!loaded
    text.disabled=busy
    const voice=state.voices.find(v=>v.voice_id===editing)
    if(voice){
      get('[data-uploaded-name]').textContent=voice.name
      const value=draft??voice.ref_text??'';if(text.value!==value)text.value=value
      get('[data-refresh]').hidden=!(failed.has(editing)||(!pending(voice)&&voice.status!=='ready'))
      get('[data-recognition]').textContent=failed.has(editing)?'暂时未获取到识别结果，可以刷新结果，也可以直接填写音频中的原话。':
        pending(voice)?'正在自动识别，请稍候…':voice.status==='ready'?'请核对上方文字与音频一致。':'未能自动识别，请填写音频中的原话。'
      get('[data-save]').disabled=busy||!text.value.trim()
    }
  }
  const schedule=()=>{clearTimeout(timer);if(!stopped&&state.custom_voice_enabled!==false&&state.voices.some(v=>pending(v)&&!failed.has(v.voice_id)))timer=setTimeout(poll,3000)}
  async function run(work){
    if(busy||stopped||!loaded)return false
    busy=true;draw()
    try{await work();return true}catch(e){if(!stopped)fail(e);return false}
    finally{busy=false;draw();schedule()}
  }
  // Refresh reads the existing ASR result; it never starts another recognition.
  async function refresh(id){
    try{state=await api({op:'refresh',voice_id:id});failed.delete(id)}
    catch(e){failed.add(id);throw e}
  }
  async function poll(){
    if(stopped)return
    if(busy){schedule();return}
    await run(async()=>{
      for(const v of state.voices.filter(v=>pending(v)&&!failed.has(v.voice_id))){
        if(stopped)return
        const count=attempts.get(v.voice_id)||0
        if(count>=30){failed.add(v.voice_id);continue}
        attempts.set(v.voice_id,count+1)
        try{await refresh(v.voice_id)}catch{/* Keep retry scoped to this draft. */}
      }
    })
  }
  choice.onchange=()=>{
    const id=choice.value
    if(id===ADD){close();adding=true;status.textContent='';draw();get('[data-name]').focus();return}
    const voice=state.voices.find(v=>v.voice_id===id)
    if(voice?.issue){close();recovering=id;status.textContent='';draw();return}
    if(voice&&voice.status!=='ready'){close();adding=true;editing=id;status.textContent='';draw();schedule();return}
    void run(async()=>{state=await api({op:'select',voice_id:id});close();status.textContent='已选择，下次语音连接生效。'})
  }
  text.oninput=()=>{draft=text.value;get('[data-save]').disabled=busy||!text.value.trim()}
  get('[data-cancel]').onclick=()=>{if(busy)return;close();status.textContent='';draw()}
  get('[data-recovery-back]').onclick=()=>{if(busy)return;close();status.textContent='';draw()}
  get('[data-recovery-remove]').onclick=()=>void run(async()=>{state=await api({op:'remove',voice_id:recovering});close()})
  get('[data-reupload]').onclick=()=>void run(async()=>{
    const file=get('[data-reupload-file]').files[0];let audio
    if(file){
      if(file.size>10*1024*1024)throw Error('invalid_audio_size')
      const bytes=new Uint8Array(await file.arrayBuffer());let raw=''
      for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192))
      audio=btoa(raw)
    }
    const id=recovering
    try{state=await api({op:'restore',voice_id:id,...(audio?{audio}:{})});close();status.textContent='音色已恢复，下次语音连接生效。'}
    catch(e){state=await api();recovering=id;throw e}
  })
  get('[data-remove]').onclick=()=>void run(async()=>{state=await api({op:'remove',voice_id:state.selected});status.textContent='已移除，恢复默认音色。'})
  get('[data-remove-draft]').onclick=()=>void run(async()=>{
    state=await api({op:'remove',voice_id:editing});close();status.textContent='已移除此音色。'
  })
  get('[data-refresh]').onclick=()=>void run(async()=>{attempts.delete(editing);await refresh(editing)})
  get('[data-save]').onclick=()=>void run(async()=>{
    const index=state.voices.findIndex(v=>v.voice_id===editing),value=text.value.trim()
    if(index<0||!value)return
    if(value!==state.voices[index].ref_text){state=await api({op:'text',voice_id:editing,ref_text:value});editing=state.voices[index].voice_id;draft=value}
    state=await api({op:'select',voice_id:editing});close();status.textContent='音色已保存并选择，下次语音连接生效。'
  })
  get('[data-upload]').onclick=()=>void run(async()=>{
    const file=get('[data-file]').files[0],name=get('[data-name]').value.trim()
    if(!get('[data-consent]').checked){status.textContent='请先确认你有权使用这段参考音频。';return}
    if(!file||file.size>10*1024*1024||!name){status.textContent='请填写音色名称，并选择不超过 10 MB 的参考音频。';return}
    status.textContent='正在上传…'
    const bytes=new Uint8Array(await file.arrayBuffer());let raw=''
    for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192))
    if(stopped)return
    const count=state.voices.length;state=await api({op:'upload',name,audio:btoa(raw)})
    editing=state.voices[count].voice_id;draft=null;status.textContent=''
  })
  api().then(v=>{if(stopped)return;state=v;loaded=true;draw();schedule()}).catch(e=>{if(!stopped)fail(e)})
  async function refreshFeature(){
    if(stopped)return
    if(!busy&&loaded){
      busy=true
      try{state=await api();draw();schedule()}catch{/* Keep the last known policy. */}
      finally{busy=false;draw()}
    }
    if(!stopped)featureTimer=setTimeout(refreshFeature,15000)
  }
  featureTimer=setTimeout(refreshFeature,15000)
  return()=>{stopped=true;clearTimeout(timer);clearTimeout(featureTimer)}
}
