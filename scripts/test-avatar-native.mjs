// Isolated native smoke test. No real DSH server, credentials, audio, or input automation.
import {spawn} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
import {launchAvatar} from '../src/host/avatar.mjs'
let child,helper,exitResult
let resolveExit
const exited=new Promise(resolve=>{resolveExit=resolve})
const abort=new AbortController()
const deadline=setTimeout(()=>abort.abort(),30000)
try {
  helper=await launchAvatar({signal:abort.signal,size:'small',onCommand(){},onExit(reason){exitResult=reason}}, {
    spawnImpl(command,args,options) {
      child=spawn(command,args,options)
      child.once('exit',(code,signal)=>resolveExit({code,signal}))
      return child
    },
  })
  helper.send({type:'frame',mode:'off',rms:0,text:''})
  await delay(1000)
  helper.send({type:'surface',panel:{id:'s1',revision:1,target:'online',nodes:[{kind:'heading',text:'桌面提示验收'},{kind:'text',text:'这里只验证本地窗口，没有连接语音服务。'}]}})
  await delay(1500)
  if(exitResult)throw Error(`Native helper exited during surface resize: ${exitResult}`)
  helper.send({type:'surface',panel:null})
  await delay(500)
  if(exitResult)throw Error(`Native helper exited unexpectedly: ${exitResult}`)
  helper.close()
  const result=await Promise.race([exited,delay(5000,'timeout')])
  if(result==='timeout')throw Error('Native helper did not exit after close')
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,rendererReady:true,exit:result,visualInteractionVerified:false}))
}finally {
  clearTimeout(deadline)
  helper?.close()
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
}
