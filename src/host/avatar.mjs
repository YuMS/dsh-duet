import { WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AVATAR_SIZES, avatarSize, avatarFrame, avatarInputEffect, AvatarHeartbeat } from '../shared/avatar.mjs'
import { AVATAR_UI_PROTOCOL, avatarSurface, avatarSurfaceAction } from '../shared/avatar-surface.mjs'
import {verifyDesktopAssets,desktopAssetsPath} from './avatar-assets.mjs'
import {avatarMenuAction,avatarLocalState,avatarMenuResult} from '../shared/avatar-menu.mjs'
import {avatarGeometry} from '../shared/avatar-activity.mjs'

export function avatarBinary(platform = process.platform, arch = process.arch) {
  if (!['darwin-arm64','win32-x64'].includes(`${platform}-${arch}`)) return null
  const file=platform==='darwin'?'duet-avatar.app/Contents/MacOS/duet-avatar':`duet-avatar${platform==='win32'?'.exe':''}`
  return fileURLToPath(new URL(`../../desktop/bin/${platform}-${arch}/${file}`,import.meta.url))
}
export function sameSecret(a, b) {
  const x=Buffer.from(String(a)),y=Buffer.from(String(b))
  return x.length===y.length && timingSafeEqual(x,y)
}

/** Private, loopback-only IPC. The companion never receives DSH/server credentials. */
export async function launchAvatar({onCommand,onExit,signal,size,ownerKind='browser'}, {spawnImpl=spawn, binary=avatarBinary(), env=process.env, assets=desktopAssetsPath}={}) {
  if(!binary)throw Error('desktop_platform_unsupported')
  if(process.platform==='linux'&&!env.DISPLAY&&!env.WAYLAND_DISPLAY)throw Error('desktop_display_unavailable')
  try{accessSync(binary,constants.X_OK)}catch{throw Error('desktop_helper_missing')}
  const assetsPath=verifyDesktopAssets(assets)
  const token=randomBytes(32).toString('hex')
  const ipc=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:2048,
    verifyClient:({req})=>sameSecret(req.headers['sec-websocket-protocol'],`duet-avatar-${token}`)})
  await new Promise((resolve,reject)=>{ipc.once('listening',resolve);ipc.once('error',reject)})
  let child,peer,closed=false,ready=false,timeout,killTimer,abort
  const stop=()=>{
    if(closed)return
    closed=true;clearTimeout(timeout)
    signal?.removeEventListener('abort',abort)
    for(const ws of ipc.clients)ws.terminate()
    ipc.close()
    if(child&&child.exitCode===null){child.kill();killTimer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL')},2000);killTimer.unref()}
  }
  const initialized=new Promise((resolve,reject)=>{
    const fail=code=>{if(closed)return;stop();if(!ready)reject(Error(code));else onExit(code)}
    abort=()=>fail('desktop_cancelled')
    signal?.addEventListener('abort',abort,{once:true})
    if(signal?.aborted){abort();return}
    ipc.on('connection',ws=>{
      if(peer){ws.close(1008);return}peer=ws
      ws.on('error',()=>{})
      ws.on('message',raw=>{
        try{
          const msg=JSON.parse(raw)
          if(msg.type==='ready'&&!ready){if(msg.protocol!==AVATAR_UI_PROTOCOL){fail('desktop_helper_upgrade_required');return}ready=true;clearTimeout(timeout);resolve()}
          else if(ready&&msg.type==='surface_action')onCommand(avatarSurfaceAction(msg))
          else if(ready&&msg.type==='menu_action')onCommand(avatarMenuAction(msg))
          else if(ready&&msg.type==='avatar_geometry')onCommand({type:'avatar_geometry',position:avatarGeometry(msg.position)})
          else if(ready&&msg.type==='mode'&&['online','tts_only'].includes(msg.mode))onCommand(msg)
          else if(ready&&msg.type==='size'&&Object.hasOwn(AVATAR_SIZES,msg.size))onCommand({type:'size',size:msg.size})
          else if(msg.type==='hide')onCommand({type:'hide'})
          else if(msg.type==='failed')fail('desktop_renderer_failed')
          else if(msg.type!=='alive')ws.close(1008)
        }catch{ws.close(1008)}
      })
      ws.on('close',()=>fail('desktop_closed'))
    })
    ipc.on('error',()=>fail('desktop_ipc_failed'))
    try{
      // No shell, user-supplied executable, detached daemon, inherited credentials, or CLI token.
      const safeEnv=Object.fromEntries(['PATH','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG','LC_ALL'].filter(k=>env[k]).map(k=>[k,env[k]]))
      child=spawnImpl(binary,[],{stdio:'ignore',windowsHide:true,env:{...safeEnv,
        DUET_AVATAR_ASSETS:assetsPath,DUET_AVATAR_IPC:`ws://127.0.0.1:${ipc.address().port}`,DUET_AVATAR_TOKEN:token,DUET_AVATAR_SIZE:avatarSize(size),
        DUET_AVATAR_OWNER_KIND:['desktop','chrome','edge','firefox','safari','browser'].includes(ownerKind)?ownerKind:'browser'}})
      child.once('error',()=>fail('desktop_launch_failed'))
      child.once('exit',code=>{clearTimeout(killTimer);fail(code===78?'desktop_webview2_missing':'desktop_closed')})
      timeout=setTimeout(()=>fail('desktop_start_timeout'),20000);timeout.unref()
    }catch{fail('desktop_launch_failed')}
  })
  await initialized
  return {close:stop,send(frame){if(peer?.readyState===1&&peer.bufferedAmount<16000)peer.send(JSON.stringify(frame))}}
}

/** Exactly one owning DSH page per Host; other pages cannot drive its companion. */
export function registerAvatarHost(ctx, {launch=launchAvatar}={}) {
  const server=new WebSocketServer({noServer:true,maxPayload:65536}),clients=new Set()
  let owner=null,closed=false
  const unregister=ctx.webServer.registerUpgrade({path:'/duet/avatar/ws',handler(req,socket,head){
    let allowed=!req.headers.origin
    try{if(req.headers.origin)allowed=new URL(req.headers.origin).host===req.headers.host}catch{}
    if(closed||!allowed||ctx.connection.requestRejection(req)||clients.size>=8){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return}
    server.handleUpgrade(req,socket,head,ws=>{
      clients.add(ws);let helper,starting=false,ended=false,frames=0,second=Date.now(),alive=Date.now()
      const lifetime=new AbortController()
      const send=value=>{if(ws.readyState===1&&ws.bufferedAmount<16000)ws.send(JSON.stringify(value))}
      const cleanup=()=>{ended=true;lifetime.abort();helper?.close();helper=null;if(owner===ws)owner=null}
      // Background pages may be scheduled only once a minute. The Host keeps
      // its native child alive independently while the owning page is present.
      const liveness=new AvatarHeartbeat(15000,Date.now(),120000)
      const heartbeat=setInterval(()=>{
        if(liveness.expired())ws.terminate()
        else helper?.send({type:'alive'})
      },15000);heartbeat.unref()
      ws.on('error',()=>{})
      ws.on('message',async raw=>{
        try{
          alive=Date.now();liveness.touch(alive);if(alive-second>1000){second=alive;frames=0}if(++frames>40)throw Error('rate')
          const msg=JSON.parse(raw)
          if(msg.type==='start'&&!starting&&!helper){
            if(owner&&owner!==ws){send({type:'fallback',reason:'desktop_in_use'});return}
            owner=ws;starting=true
            try{
              const created=await launch({signal:lifetime.signal,size:avatarSize(msg.size),ownerKind:msg.owner_kind,onCommand:send,onExit:reason=>{helper=null;if(owner===ws)owner=null;send({type:'fallback',reason})}})
              if(ended||closed||owner!==ws){created.close();return}
              helper=created;send({type:'desktop_ready'})
            }catch(error){if(owner===ws)owner=null;send({type:'fallback',reason:error.message})}
            finally{starting=false}
          }else if(msg.type==='frame'&&owner===ws){helper?.send(avatarFrame(msg))}
          else if(msg.type==='surface'&&owner===ws){helper?.send(avatarSurface(msg))}
          else if(msg.type==='owner_focus'&&owner===ws){helper?.send({type:'owner_focus'})}
          else if(msg.type==='local_state'&&owner===ws){helper?.send(avatarLocalState(msg))}
          else if(msg.type==='menu_result'&&owner===ws){helper?.send(avatarMenuResult(msg))}
          else if(msg.type==='input_effect'&&owner===ws){helper?.send(avatarInputEffect(msg))}
          else if(msg.type==='clear_input_effect'&&owner===ws){helper?.send({type:'clear_input_effect'})}
          else if(msg.type==='alive')send({type:'alive'})
          else throw Error('message')
        }catch{ws.close(1008,'invalid_avatar_message')}
      })
      ws.on('close',()=>{clearInterval(heartbeat);clients.delete(ws);cleanup()})
    })
  }})
  return {close(){closed=true;unregister();for(const ws of clients)ws.terminate();server.close()}}
}
