import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
import {registerAvatarHost} from '../../src/host/avatar.mjs'
import {publicAsset} from '../../src/host/assets.mjs'
let upgrade,exit,command,launches=0,failNext=false
const peers=new Set(),frames=[]
const host=registerAvatarHost({connection:{requestRejection:()=>null},webServer:{registerUpgrade(v){upgrade=v.handler;return()=>{}}}}, {
 launch:async args=>{launches++;if(failNext)throw Error('desktop_helper_missing');exit=args.onExit;command=args.onCommand;return{send:f=>frames.push(f),close(){}}},
})
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname
 res.setHeader('content-type','text/html; charset=utf-8')
 if(path==='/duplex-control/api/voice/config'){res.setHeader('content-type','application/json');res.end('{}');return}
 if(path==='/duet/avatar/renderer.mjs'){res.setHeader('content-type','text/javascript');res.end(`export function mountAvatarRenderer(node,{onReady}){window.webMounts++;node.append(document.createElement('canvas'));queueMicrotask(onReady);return{update(){},dispose(){node.replaceChildren()}}}`);return}
 const asset=publicAsset(path)
 if(asset){res.setHeader('content-type',asset.contentType||'text/javascript');res.end(asset.body??await readFile(asset.url));return}
 res.end(`<div id="controls" style="position:fixed;bottom:10px;width:250px"><button data-duet-avatar-toggle>形象</button></div><script type="module">
 import {mountAvatar} from '/duet/assets/client/avatar.mjs';
 window.webMounts=0;window.notices=[];window.statuses=[];
 if(!localStorage.getItem('dsh.duet.avatar.v1'))localStorage.setItem('dsh.duet.avatar.v1',JSON.stringify({enabled:true,webOnly:false,size:'small'}));
 window.observer=new BroadcastChannel('dsh.duet.avatar.v1');observer.onmessage=e=>{if(e.data?.type==='presentation')statuses.push(e.data.mode)};
 window.avatar=mountAvatar({controls:()=>document.querySelector('#controls'),audio:{avatarSample:()=>({rms:0,viseme:'A',text:'',utterance:''})},state:()=>({mode:'off',ready:false}),notice:m=>notices.push(m),requestMode(){}});
 window.prefs=v=>{localStorage.setItem('dsh.duet.avatar.v1',JSON.stringify(v));dispatchEvent(new StorageEvent('storage',{key:'dsh.duet.avatar.v1'}))};
 </script>`)
})
server.on('upgrade',(req,socket,head)=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));upgrade(req,socket,head)})
server.listen(0,'127.0.0.1');await once(server,'listening')
const browser=await chromium.launch({args:['--no-sandbox']})
try{
 const page=await browser.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message))
 await page.clock.install()
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 await page.waitForFunction(()=>avatar.presentation().native)
 const original=await page.evaluate(()=>localStorage.getItem('dsh.duet.avatar.v1'))
 // Browser resumes after hours without spuriously losing a healthy desktop.
 await page.clock.setSystemTime(new Date(Date.now()+8*3600000));await page.clock.runFor(100)
 assert.equal(await page.evaluate(()=>avatar.presentation().native),true)
 assert.equal(launches,1)
 // Background throttling: one callback per second still sends timed pings.
 for(let i=0;i<25;i++){
  await page.clock.fastForward(1000)
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))
 }
 assert.equal(launches,1);assert.equal(await page.evaluate(()=>avatar.presentation().native),true)
 // Abrupt Host transport loss: no webpage fallback, then automatic recovery.
 for(const peer of peers)peer.destroy()
 await page.waitForFunction(()=>avatar.presentation().mode==='recovering')
 assert.equal(await page.evaluate(()=>webMounts),0)
 await page.clock.runFor(1100);await page.waitForFunction(()=>avatar.presentation().native)
 assert.equal(launches,2)
 assert.equal(await page.evaluate(()=>localStorage.getItem('dsh.duet.avatar.v1')),original)
 // A helper crash is not a user hide; foregrounding can retry immediately.
 exit('desktop_closed');await page.waitForFunction(()=>avatar.presentation().mode==='recovering')
 await page.evaluate(()=>dispatchEvent(new Event('focus')))
 await page.waitForFunction(()=>avatar.presentation().native)
 assert.equal(launches,3);assert.equal(await page.evaluate(()=>webMounts),0)
 // Settings that open later receive the actual current runtime state.
 await page.evaluate(()=>{statuses=[];observer.postMessage({type:'presentation_request'})})
 await page.waitForFunction(()=>statuses.includes('desktop'))
 // Missing components are an explicit, reported web fallback, keeping preference.
 failNext=true;exit('desktop_closed');await page.waitForFunction(()=>avatar.presentation().mode==='recovering')
 await page.clock.runFor(1100);await page.waitForFunction(()=>avatar.presentation().mode==='fallback'&&webMounts===1)
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dsh.duet.avatar.v1')).webOnly),false)
 failNext=false
 await page.evaluate(()=>observer.postMessage({type:'retry_desktop'}));await page.waitForFunction(()=>avatar.presentation().native)
 assert.equal(await page.locator('[data-duet-avatar]').count(),0)
 // Explicit hide cancels recovery rather than re-opening a hidden avatar.
 command({type:'hide'});await page.waitForFunction(()=>avatar.presentation().mode==='off')
 const before=launches;await page.clock.runFor(31000);assert.equal(launches,before)
 await page.evaluate(()=>prefs({enabled:true,webOnly:true,size:'small'}))
 await page.waitForFunction(()=>avatar.presentation().mode==='web')
 await page.clock.runFor(5000);assert.equal(launches,before)
 await page.evaluate(()=>{avatar.dispose();observer.close()});assert.deepEqual(errors,[])
 console.log('Recovery: suspended clock, transport loss, helper exit, foreground retry, settings status, explicit web-only/hide and fallback retry passed')
}finally{await browser.close();host.close();await new Promise(resolve=>server.close(resolve))}
