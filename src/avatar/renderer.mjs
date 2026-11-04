import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { IdleDirector, Spring } from './idle.mjs'
import { LipSyncFilter } from './lipsync.mjs'
import { MotionDirector, gesturePose } from './motion.mjs'

/** Shared real-time GLB renderer. Never opens a microphone or replays audio. */
export function mountAvatarRenderer(root, { modelURL, onError = () => {}, onReady = () => {} }) {
  const renderer = new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'})
  renderer.setPixelRatio(Math.min(1.75, devicePixelRatio || 1)); renderer.setClearColor(0,0)
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.AgXToneMapping
  renderer.domElement.style.cssText='display:block;width:100%;height:100%';root.append(renderer.domElement)
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1.28,1.28,1.28,-1.28,.1,100)
  camera.position.set(1,5.85,18);camera.lookAt(0,5.39,-.02)
  const resize=()=>{const w=Math.max(1,root.clientWidth),h=Math.max(1,root.clientHeight),a=w/h,v=Math.max(2.56,2.35/a);renderer.setSize(w,h,false);Object.assign(camera,{left:-v*a/2,right:v*a/2,top:v/2,bottom:-v/2});camera.updateProjectionMatrix()}
  const observer=new ResizeObserver(resize);observer.observe(root);resize()
  const idle=new IdleDirector(),lips=new LipSyncFilter(),mouths=[],eyes=[],hair=[],rests=[]
  const springs=Object.fromEntries(['L','C','R'].map(c=>[c,[9,5.5,3.4,2.3].map(w=>({n:new Spring(w,.66),r:new Spring(w,.62),y:new Spring(w,.67)}))]))
  let model,dead=false,frame,last=performance.now(),start=last,lastInput=0
  let input={rms:0,viseme:'A',text:'',utterance:''}
  const motion=new MotionDirector()
  const morph=(o,key,value)=>{const i=o.morphTargetDictionary?.[key];if(i!==undefined)o.morphTargetInfluences[i]=value}
  const release=tree=>{const textures=new Set(),materials=new Set(),geometries=new Set();tree?.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of [o.material].flat().filter(Boolean)){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v)}});for(const v of [...textures,...materials,...geometries])v.dispose()}
  new GLTFLoader().load(modelURL,gltf=>{
    if(dead){release(gltf.scene);return}
    model=gltf.scene;model.updateMatrixWorld(true);const names=new Map()
    model.traverse(o=>{
      const a=gltf.parser.associations.get(o),name=a?.nodes!==undefined?gltf.parser.json.nodes[a.nodes].name:o.name
      names.set(name,o);if(!o.isMesh)return;o.frustumCulled=false
      for(const m of [o.material].flat()){
        m.toneMapped=false
        if(name?.startsWith('Hair V7')){m.transparent=true;m.alphaTest=.015;m.depthWrite=false;m.forceSinglePass=true}
        else if(name?.startsWith('Eye |')){
          // Keep the painted lash texture's soft edge. Alpha-to-coverage can
          // reduce face opacity on a transparent canvas; blending preserves it.
          m.transparent=true;m.alphaTest=.015;m.depthWrite=false;m.forceSinglePass=true
          // Paint eyes over opaque skin, then let the transparent fringe cover
          // them. Do not let transparent-object sorting flip this on head turns.
          o.renderOrder=-1
        }
        else if(m.transparent){m.alphaTest=.28;m.depthWrite=true;m.transparent=false}
        m.needsUpdate=true
      }
      if(name?.startsWith('Mouth |'))mouths.push(o)
      if(name?.startsWith('Eye |'))eyes.push(o)
    })
    for(const name of ['RIG | 颈部转动支点','V1_NeckHead']){const o=names.get(name);if(o)rests.push({o,q:o.quaternion.clone(),parent:o.parent.getWorldQuaternion(new THREE.Quaternion())})}
    for(const col of ['L','C','R'])for(let i=0;i<4;i++){const o=names.get(`Flow ${col} ${i}`);if(o)hair.push({o,col,i,q:o.quaternion.clone()})}
    scene.add(model);onReady()
  },undefined,()=>{if(!dead)onError('3D 形象加载失败')})
  const animate=now=>{
    if(dead)return
    frame=requestAnimationFrame(animate)
    if(document.hidden){last=now;return}
    if(now-last<1000/(input.rms>.01?40:24))return
    const dt=Math.min(.1,(now-last)/1000);last=now
    if(now-lastInput>500)input={...input,rms:0}
    const weights=lips.step(input.rms,input.viseme,dt,input.rms>0),t=(now-start)/1000,p=idle.sample(t)
    const action=motion.sample(input,now),gesture=action.kind,e=action.envelope
    root.dataset.duetGesture=gesture;root.dataset.duetGestureSequence=String(action.sequence)
    const pose=gesturePose(action)
    root.dataset.duetMotionPolicy='independent'
    root.dataset.duetGesturePose=JSON.stringify(pose)
    // Head gestures share one scheduler; do not layer a second independent
    // random head track over semantic gestures or bypass repetition cooldown.
    const nod=pose.nod,yaw=pose.yaw,roll=pose.roll
    const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(nod,yaw,-roll,'XYZ'))
    for(const r of rests)r.o.quaternion.copy(r.parent).invert().multiply(q).multiply(r.parent).multiply(r.q)
    if(model)model.position.y=p.breath*.003
    for(const o of eyes){morph(o,'V1_Blink',p.blink);morph(o,'Gaze slightly right',p.gaze)}
    for(const o of mouths){for(const k of ['A','I','U','E','O'])morph(o,k,weights[k]);morph(o,'Open',0);const smile=p.smile*(1-lips.envelope*.8);morph(o,'Smile',gesture==='laugh'?smile+(.65-smile)*e:smile)}
    const values={}
    for(const col of ['L','C','R']){let prev={n:nod,r:roll,y:yaw};values[col]=springs[col].map(s=>{const v={n:s.n.step(nod,dt),r:s.r.step(roll,dt),y:s.y.step(yaw,dt)};const d={n:v.n-prev.n,r:v.r-prev.r,y:v.y-prev.y};prev=v;return d})}
    for(const h of hair){const d=values[h.col][h.i];h.o.quaternion.copy(h.q).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.clamp(d.n,-.045,.045)*.45,THREE.MathUtils.clamp(d.y,-.06,.06)*.3,THREE.MathUtils.clamp(d.r,-.045,.045)*.75)))}
    renderer.render(scene,camera)
  }
  frame=requestAnimationFrame(animate)
  const hitCanvas=document.createElement('canvas');hitCanvas.width=48;hitCanvas.height=64
  const hitContext=hitCanvas.getContext('2d',{willReadFrequently:true})
  return {
    update(value){input=value;lastInput=performance.now()},
    hitMask(){
      // Redraw immediately: preserveDrawingBuffer is intentionally disabled.
      renderer.render(scene,camera);hitContext.clearRect(0,0,48,64);hitContext.drawImage(renderer.domElement,0,0,48,64)
      const rgba=hitContext.getImageData(0,0,48,64).data
      return Array.from({length:48*64},(_,i)=>rgba[i*4+3]>24?1:0)
    },
    dispose(){dead=true;cancelAnimationFrame(frame);observer.disconnect();release(model);renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove()},
  }
}
