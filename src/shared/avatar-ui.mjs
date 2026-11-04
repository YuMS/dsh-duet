import {avatarSize,AVATAR_SIZES} from './avatar.mjs'
const sizes=Object.keys(AVATAR_SIZES),names={large:'大（100%）',medium:'中（75%）',small:'小（50%）'}
export const nextAvatarSize=value=>sizes[(sizes.indexOf(avatarSize(value))+1)%sizes.length]
export function sizeButton(button,value,{label=false}={}) {
  const size=avatarSize(value),title=`形象大小：${names[size]}，点击切换为${names[nextAvatarSize(size)]}`
  button.type='button';button.dataset.size=size;button.setAttribute('aria-label',title);button.title=title
  const squares=sizes.filter(s=>s!==size).concat(size).map(s=>{
    const side={large:18,medium:12,small:6}[s]
    return `<rect data-size-square="${s}" x="3" y="${21-side}" width="${side}" height="${side}" stroke-width="${s===size?'2.8':'1'}"/>`
  }).join('')
  button.innerHTML=`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${squares}</svg>${label?`<span>${names[size]}</span>`:''}`
}

/** Same local confirmation in settings, web and the native companion. */
export function avatarCloseConfirmation({onChange=()=>{},floating=false,origin='page',anchor=()=>null,viewport=()=>[0,0,innerWidth,innerHeight]}={}) {
  let pending=null,resolve,node,previous,dead=false
  const position=()=>{
    if(!floating||!node)return
    const r=anchor()?.getBoundingClientRect();if(!r)return
    const b=node.getBoundingClientRect()
    const [x,y,w,h]=viewport()
    const top=r.top-b.height-16>=y+12?r.top-b.height-16:r.bottom+12
    node.style.left=Math.max(x+12,Math.min(r.left+r.width/2-b.width/2,x+w-b.width-12))+'px'
    node.style.top=Math.max(y+12,Math.min(top,y+h-b.height-12))+'px'
    node.style.bottom='auto'
  }
  const finish=accepted=>{
    if(!pending)return
    const done=resolve;pending=null;resolve=null
    document.removeEventListener('keydown',keys,true);window.removeEventListener('resize',position);node?.remove();node=null
    if(previous?.isConnected)previous.focus({preventScroll:true})
    onChange();done(accepted)
  }
  const keys=e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();finish(false)}
    else if(e.key==='Tab'&&!floating){
      e.preventDefault();const buttons=[...node.querySelectorAll('button')],index=buttons.indexOf(document.activeElement)
      buttons[(index+(e.shiftKey?-1:1)+buttons.length)%buttons.length].focus()
    }
  }
  return {
    ask(){
      if(dead)return Promise.resolve(false)
      if(pending)return pending
      previous=document.activeElement
      pending=new Promise(r=>resolve=r)
      node=document.createElement('div');node.dataset.avatarCloseOverlay=''
      node.style.cssText='position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;background:#0003;pointer-events:auto'
      if(floating){node.dataset.duetAvatarSurface='110';node.dataset.duetSurfaceOrigin=origin;node.style.cssText='position:fixed;left:12px;bottom:100px;width:260px;max-width:calc(100vw - 24px);z-index:2147483600;pointer-events:auto'}
      const panel=document.createElement('div');panel.dataset.avatarCloseConfirm=''
      panel.setAttribute('role','alertdialog');panel.setAttribute('aria-modal',String(!floating));panel.setAttribute('aria-label','隐藏拟人角色？')
      panel.style.cssText='box-sizing:border-box;width:260px;max-width:100%;padding:16px;border:1px solid #8dc5ed55;border-radius:16px;background:#142638;color:#e9f4ff;font:13px/1.6 system-ui;box-shadow:0 8px 28px #0005'
      const title=document.createElement('div');title.textContent='隐藏拟人角色？';title.style.cssText='font-size:14px;font-weight:600;margin-bottom:14px'
      const row=document.createElement('div');row.style.cssText='display:flex;justify-content:flex-end;gap:8px'
      for(const [text,accept] of [['取消',false],['隐藏拟人角色',true]]){
        const button=document.createElement('button');button.type='button';button.textContent=text;button.dataset.avatarCloseChoice=accept?'confirm':'cancel'
        button.style.cssText=`font:13px system-ui;display:block;width:auto;min-width:56px;min-height:32px;padding:6px 10px;border:0;border-radius:8px;cursor:pointer;background:${accept?'#dcefff':'#294154'};color:${accept?'#185a89':'#e9f4ff'}`
        button.onclick=()=>finish(accept);row.append(button)
      }
      panel.append(title,row);node.append(panel);document.body.append(node)
      document.addEventListener('keydown',keys,true);window.addEventListener('resize',position);position();row.firstChild.focus();onChange()
      return pending
    },
    cancel(){finish(false)},
    dispose(){dead=true;finish(false)},
    get element(){return node},
  }
}

/** The real playback-page click stays here; native projection cannot grant activation. */
export function audioUnlockPanel({onEnable,onCancel}) {
  const panel=document.createElement('section')
  panel.dataset.duetAvatarSurface='95';panel.dataset.duetSurfaceOrigin='avatar';panel.dataset.duetAudioUnlock=''
  panel.setAttribute('role','region');panel.setAttribute('aria-label','启用 duet 声音')
  panel.style.cssText='position:fixed;z-index:100030;right:12px;bottom:88px;box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);max-height:calc(100vh - 100px);overflow:auto;padding:22px;border-radius:20px;background:linear-gradient(145deg,#20364b,#142333);color:#edf6ff;border:1px solid #8dc5ed55;font:14px/1.65 system-ui,sans-serif;box-shadow:0 16px 48px #07152240;isolation:isolate;text-align:left'
  const style=document.createElement('style')
  style.textContent='[data-duet-audio-unlock] button:hover{filter:brightness(1.12)}[data-duet-audio-unlock] button:focus-visible{outline:2px solid #a4dcff;outline-offset:3px}[data-duet-audio-unlock] button:active{transform:translateY(1px)}'
  const brand=document.createElement('div');brand.setAttribute('aria-hidden','true');brand.textContent='duet';brand.style.cssText='font:750 25px/1.2 system-ui;letter-spacing:-1px;margin:0 0 17px;color:#edf6ff'
  const dot=document.createElement('span');dot.textContent='.';dot.style.color='#ed9b35';brand.append(dot)
  const title=document.createElement('h3');title.textContent='音频播放权限';title.style.cssText='font:650 18px/1.4 system-ui;margin:0 0 8px;color:#edf6ff'
  const text=document.createElement('p');text.textContent='点击启动音频播放权限。';text.style.cssText='font:14px/1.75 system-ui;margin:0;color:#bdcedf;white-space:normal;overflow-wrap:anywhere'
  const actions=document.createElement('div');actions.style.cssText='display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px;margin-top:22px'
  for(const [label,primary,callback] of [['暂不开启',false,onCancel],['启动音频播放',true,onEnable]]){
    const button=document.createElement('button');button.type='button';button.textContent=label
    button.style.cssText='appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:9px 16px;border-radius:11px;font:600 14px/1.4 system-ui;cursor:pointer;white-space:nowrap;'+(primary?'background:#dcefff;color:#185a89;border:1px solid #dcefff;box-shadow:0 3px 10px #0002':'background:#ffffff08;color:#c2d3e3;border:1px solid #8dc5ed40')
    if(primary)button.dataset.duetUserGesture=''
    button.onclick=callback;actions.append(button)
  }
  panel.append(style,brand,title,text,actions)
  return panel
}
