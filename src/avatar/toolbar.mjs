/** Presentation state only. Native mouse passthrough uses the same current regions. */
export function maskContains(mask,rect,x,y){
 const [ax,ay,w,h]=rect
 if(!w||!h||x<ax||y<ay||x>=ax+w||y>=ay+h||mask?.length!==48*64)return false
 return mask[Math.floor((y-ay)/h*64)*48+Math.floor((x-ax)/w*48)]===1
}
export function mountAvatarToolbar({tools,avatar,hitTest=()=>false,onChange=()=>{}}){
 let dead=false,revealed=false,interactive=false,confirming=false,pointer={x:-1,y:-1,overAvatar:false},leaveTimer,finishTimer
 const bounds=node=>{const r=node.getBoundingClientRect();return[r.x,r.y,r.width,r.height]}
 const inside=([x,y,w,h])=>pointer.x>=x&&pointer.y>=y&&pointer.x<x+w&&pointer.y<y+h
 const bridge=()=>{const a=avatar.getBoundingClientRect(),t=tools.getBoundingClientRect();return[Math.min(a.left,t.left),a.bottom-2,Math.max(a.right,t.right)-Math.min(a.left,t.left),Math.max(0,t.top-a.bottom)+4]}
 const publish=()=>{tools.dataset.revealed=String(revealed);tools.dataset.interactive=String(interactive);tools.dataset.confirming=String(confirming);onChange()}
 const wants=()=>confirming||(tools.dataset.keyboard==='true'&&Boolean(tools.querySelector(':focus-visible')))||pointer.overAvatar||
   (interactive&&(inside(bounds(tools))||inside(bridge())))
 const sync=()=>{
  if(dead)return
  if(wants()){
   clearTimeout(leaveTimer);leaveTimer=null;clearTimeout(finishTimer);finishTimer=null
   if(!revealed||!interactive){revealed=true;interactive=true;publish()}
  }else if(revealed&&!leaveTimer){
   leaveTimer=setTimeout(()=>{
    leaveTimer=null;if(dead||wants())return sync()
    revealed=false;publish()
    finishTimer=setTimeout(()=>{finishTimer=null;if(dead)return;if(wants())return sync();interactive=false;publish()},500)
   },180)
  }
 }
 const update=value=>{if(dead)return;pointer={x:Number.isFinite(value.x)?value.x:-1,y:Number.isFinite(value.y)?value.y:-1,overAvatar:value.overAvatar===true};avatar.style.pointerEvents=pointer.overAvatar?'auto':'none';sync()}
 const move=e=>update({x:e.clientX,y:e.clientY,overAvatar:hitTest(e.clientX,e.clientY)})
 const leave=()=>update({x:-1,y:-1,overAvatar:false})
 const focus=()=>queueMicrotask(sync)
 const keyboard=e=>{if(!['Shift','Control','Alt','Meta'].includes(e.key))tools.dataset.keyboard='true';focus()}
 const mouse=()=>{tools.dataset.keyboard='false';focus()}
 const blur=()=>{tools.dataset.keyboard='false';leave()}
 const listen=(node,type,fn)=>{node.addEventListener(type,fn);return()=>node.removeEventListener(type,fn)}
 const remove=[listen(document,'pointermove',move),listen(document,'pointerleave',leave),
   listen(document,'focusin',focus),listen(document,'focusout',focus),listen(document,'keydown',keyboard),
   listen(document,'pointerdown',mouse),listen(window,'blur',blur)]
 // opacity (not visibility/display) preserves keyboard tab access while hidden.
 tools.dataset.keyboard='false';tools.dataset.revealed='false';tools.dataset.interactive='false';tools.dataset.confirming='false';avatar.style.pointerEvents='none'
 return{
  pointer:update,
  refresh(){sync()},
  setConfirmation(value){confirming=Boolean(value);publish();sync()},
  get interactive(){return interactive},
  regions(){return interactive?[bounds(tools),bridge()]:[]},
  dispose(){dead=true;clearTimeout(leaveTimer);clearTimeout(finishTimer);remove.forEach(fn=>fn())},
 }
}
