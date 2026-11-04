import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {chromium} from 'playwright'
const root=new URL('../../',import.meta.url),out=new URL('artifacts/eye-aa/',root)
await mkdir(out,{recursive:true})
const source=await readFile(new URL('src/avatar/renderer.mjs',root),'utf8')
const hook=`scene.add(model);root.testScene={renderer,scene,camera,model,eyes,rests,render:()=>renderer.render(scene,camera)};onReady()`
const bundles={}
for(const mode of ['before','after','fallback']){
 let text=source.replace('scene.add(model);onReady()',hook).replace('const animate=now=>{','const animate=now=>{return;')
 if(mode==='before')text=text.replace(/else if\(name\?\.startsWith\('Eye \|'\)\)\{[\s\S]*?\n        \}/,'')
 if(mode==='fallback')text=text.replace('antialias:true','antialias:false')
 bundles[mode]=(await build({stdin:{contents:text,resolveDir:fileURLToPath(new URL('src/avatar/',root)),sourcefile:'renderer.mjs'},bundle:true,format:'esm',write:false})).outputFiles[0].contents
}
const html=`<!doctype html><style>body{margin:0;background:#223047;color:white;font:14px sans-serif}#avatar{width:195px;height:210px}#comparison{display:flex;gap:12px}figure{margin:12px}figure img{display:block;image-rendering:pixelated;width:585px}h3{font-size:14px}</style><div id="avatar"></div><div id="comparison"></div><script type="module">import{mountAvatarRenderer}from'./'+MODE;</script>`
const server=createServer(async(req,res)=>{
 const u=new URL(req.url,'http://local')
 if(u.pathname==='/')return res.end(html.replace("import{mountAvatarRenderer}from'./'+MODE;",`import{mountAvatarRenderer}from'/${u.searchParams.get('mode')}.mjs';window.avatar=mountAvatarRenderer(document.querySelector('#avatar'),{modelURL:'/character.glb',onReady:()=>window.ready=true,onError:e=>window.error=e});`))
 if(u.pathname==='/character.glb')return res.end(await readFile(new URL('assets/avatar/character.glb',root)))
 const mode=u.pathname.slice(1,-4)
 if(bundles[mode]){res.setHeader('content-type','text/javascript');return res.end(bundles[mode])}
 res.writeHead(404);res.end()
}).listen(0,'127.0.0.1');await once(server,'listening')
const browser=await chromium.launch({args:['--no-sandbox','--enable-unsafe-swiftshader']}),results=[],images={}
try{
 for(const dpr of [1,2])for(const mode of ['before','after','fallback']){
  const page=await browser.newPage({viewport:{width:1200,height:850},deviceScaleFactor:dpr}),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`)
  await page.waitForFunction(()=>window.ready||window.error,null,{timeout:60000})
  const info=await page.evaluate(()=>{
   const t=document.querySelector('#avatar').testScene;const gl=t.renderer.getContext()
   const mats=[];t.model.traverse(o=>{if(o.isMesh)for(const m of [o.material].flat())mats.push({object:o.name,material:m.name,order:o.renderOrder,coverage:m.alphaToCoverage,transparent:m.transparent,depthWrite:m.depthWrite,cutoff:m.alphaTest})})
   return{samples:gl.getParameter(gl.SAMPLES),pixelRatio:t.renderer.getPixelRatio(),materials:mats}
  })
  const eyes=info.materials.filter(m=>m.material==='V1 | painted sapphire eyes')
  assert.equal(eyes.length,2)
  for(const eye of eyes){
   assert.equal(eye.coverage,false)
   assert.equal(eye.transparent,mode!=='before')
   assert.equal(eye.order,mode==='before'?0:-1)
  }
  const fringe=info.materials.find(m=>m.material==='V1 | V14 | coherent fringe')
  assert.equal(fringe.transparent,true);assert.equal(fringe.depthWrite,false);assert.equal(fringe.cutoff,.015)
  for(const [pose,yaw,blink] of [['front',0,0],['turn-left',-.28,0],['turn-right',.28,0],['blink',0,1]]){
   await page.evaluate(({yaw,blink})=>{
    const t=document.querySelector('#avatar').testScene
    for(const r of t.rests){r.o.quaternion.copy(r.q);r.o.rotateY(yaw)}
    for(const eye of t.eyes){const i=eye.morphTargetDictionary.V1_Blink;if(i!==undefined)eye.morphTargetInfluences[i]=blink}
    t.render()
   },{yaw,blink})
   await page.locator('#avatar').screenshot({path:fileURLToPath(new URL(`${mode}-${dpr}-${pose}.png`,out))})
   if(dpr===1&&pose==='front')images[mode]=await page.evaluate(()=>{const t=document.querySelector('#avatar').testScene;t.render();return t.renderer.domElement.toDataURL()})
  }
  assert.deepEqual(errors,[]);results.push({mode,dpr,...info})
  await page.evaluate(()=>avatar.dispose());assert.equal(await page.locator('#avatar canvas').count(),0);await page.close()
 }
 const page=await browser.newPage({viewport:{width:1200,height:720},deviceScaleFactor:1})
 await page.setContent('<body style="margin:0;background:#223047;color:white;font:18px sans-serif;display:flex"></body>')
 await page.evaluate(images=>{for(const [label,src] of Object.entries(images).filter(([k])=>k!=='fallback')){const figure=document.createElement('figure');figure.style.cssText='margin:10px';const title=document.createElement('p');title.textContent=label==='before'?'Before / hard alpha cutout':'After / soft eye edges';const img=new Image();img.src=src;img.style.cssText='width:570px;height:auto;image-rendering:pixelated';figure.append(title,img);document.body.append(figure)}},images)
 await page.screenshot({path:fileURLToPath(new URL('comparison.png',out))})

 const alpha=await page.evaluate(async images=>{
  const reads={};for(const [k,src] of Object.entries(images)){const im=new Image();im.src=src;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const x=c.getContext('2d');x.drawImage(im,0,0);reads[k]=x.getImageData(0,0,c.width,c.height).data}
  const loss={};for(const k of ['after','fallback']){let count=0,min=255;for(let i=3;i<reads.before.length;i+=4)if(reads.before[i]===255&&reads[k][i]<254){count++;min=Math.min(min,reads[k][i])}loss[k]={count,min}}return loss
 },images)
 assert.equal(alpha.after.count,0,'eye smoothing must not make opaque face pixels transparent')
 assert.equal(alpha.fallback.count,0,'non-MSAA rendering must retain opaque skin')
 results.push({opaqueFaceAlphaLoss:alpha})
 await writeFile(new URL('results.json',out),JSON.stringify(results,null,2))
 console.log('Eye AA: real GLB at DPR 1/2, soft edges with/without MSAA, opaque face alpha, fringe unchanged, front/turn/blink and cleanup passed')
}finally{await browser.close();await new Promise(r=>server.close(r))}
