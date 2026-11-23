// Isolated native integration test: only launches/kills its own helper fixtures.
import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {setTimeout as delay} from 'node:timers/promises'
import {launchAvatar} from '../src/host/avatar.mjs'

if(process.platform!=='win32')throw Error('Run on an interactive Windows desktop')
const running=[]
function processes(){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
    {encoding:'utf8',windowsHide:true,timeout:15000})
  assert.equal(result.status,0,'Could not inspect fixture process lifetime')
  const value=JSON.parse(result.stdout);return Array.isArray(value)?value:[value]
}
function descendants(rows,pid){
  const ids=new Set([pid]),found=[]
  let changed=true
  while(changed){changed=false;for(const row of rows)if(ids.has(row.ParentProcessId)&&!ids.has(row.ProcessId)){
    ids.add(row.ProcessId);found.push(row);changed=true
  }}
  return found
}
async function start(){
  let child,directory
  const helper=await launchAvatar({size:'small',onCommand(){},onExit(){}},{spawnImpl(command,args,options){
    directory=options.env.DUET_AVATAR_USER_DATA
    child=spawn(command,args,options);return child
  }})
  const value={helper,child,directory};running.push(value)
  assert.equal(helper.visibility?.visible,true,'Run without a foreground fullscreen application')
  return value
}
async function waitGone(owned){
  for(let i=0;i<15;i++){
    const rows=processes()
    if(!owned.some(old=>rows.some(row=>row.ProcessId===old.ProcessId&&row.CreationDate===old.CreationDate)))return
    await delay(200)
  }
  throw Error('Fixture WebView2 descendants survived helper exit')
}
try{
  const a=await start(),b=await start()
  assert.notEqual(a.directory,b.directory,'Concurrent DSH hosts must not share a locked WebView2 profile')
  const children=descendants(processes(),a.child.pid)
  assert.ok(children.length>0,'Expected WebView2 descendants to validate forced cleanup')
  const exited=once(a.child,'exit');a.child.kill('SIGKILL');await exited
  await waitGone(children)
  assert.equal(b.child.exitCode,null,'Closing one helper must not stop another host')
  const c=await start()
  for(const item of [b,c]){
    const done=once(item.child,'exit');item.helper.close()
    const result=await Promise.race([done,delay(5000,'timeout')])
    assert.notEqual(result,'timeout');assert.equal(result[0],0,'Expected graceful native exit')
  }
  console.log('Windows native lifecycle: visible, concurrent profiles, forced tree cleanup and restart passed')
}finally{
  for(const {helper,child}of running){helper.close();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
}
