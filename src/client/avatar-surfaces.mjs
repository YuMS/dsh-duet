import {avatarSurface,avatarSurfaceAction} from '../shared/avatar-surface.mjs'

/** Only opt-in duet panels are projected. The original page remains the state owner. */
export function mountAvatarSurfaces({avatar,canActivate=()=>false}) {
  let current=null,serial=0,actionSerial=0,last='',semantic='',disposed=false,nativeBefore=false
  const ids=new WeakMap(),actionIds=new WeakMap(),actions=new Map(),moved=new Map()
  const style=document.createElement('style')
  style.textContent='[data-duet-surface-native]{visibility:hidden!important;pointer-events:none!important}[data-duet-surface-positioned]{position:fixed!important;left:var(--duet-surface-x)!important;top:var(--duet-surface-y)!important;margin:0!important;max-height:calc(100vh - 24px)!important;overflow:auto!important;box-sizing:border-box!important}'
  document.head.append(style)
  const restore=node=>{node.removeAttribute('data-duet-surface-native');node.removeAttribute('data-duet-surface-positioned');node.style.removeProperty('--duet-surface-x');node.style.removeProperty('--duet-surface-y');moved.delete(node)}
  function snapshot(panel) {
    const nodes=[];actions.clear()
    const walk=node=>{
      if(nodes.length>=160)return
      if(node.nodeType===3){if(node.textContent.trim())nodes.push({kind:'text',text:node.textContent.slice(0,4000)});return}
      if(node.nodeType!==1||node.hidden||node.getAttribute('aria-hidden')==='true'||['SVG','SCRIPT','STYLE'].includes(node.tagName))return
      if(node.matches('button,input[type=checkbox],summary')) {
        let action=actionIds.get(node);if(!action){action=`a${++actionSerial}`;actionIds.set(node,action)}
        const gesture=node.hasAttribute('data-duet-user-gesture')&&!canActivate()
        actions.set(action,node)
        nodes.push({kind:node.matches('input')?'checkbox':'button',text:node.matches('input')?'':node.textContent.slice(0,4000),action,disabled:node.disabled===true,checked:node.checked===true,gesture,label:node.getAttribute('aria-label')||node.closest('label')?.textContent.slice(0,100)||''})
        return
      }
      if(/^H[1-6]$/.test(node.tagName)){nodes.push({kind:'heading',text:node.textContent.slice(0,4000)});return}
      if(node.tagName==='BR'){nodes.push({kind:'break',text:''});return}
      for(const child of node.childNodes)walk(child)
      if(['P','DIV','LABEL','FOOTER'].includes(node.tagName))nodes.push({kind:'break',text:''})
    }
    walk(panel)
    return nodes.slice(0,160)
  }
  function sync() {
    if(disposed)return
    const view=avatar()?.presentation?.()||{},native=view.native===true
    // Sidebar branding uses data-duet-surface too; only explicit numeric panels are eligible.
    const candidates=[...document.querySelectorAll('[data-duet-avatar-surface]')].filter(n=>/^\d{1,3}$/.test(n.dataset.duetAvatarSurface)&&n.dataset.duetSurfaceOrigin!=='page'&&!n.hidden&&n.isConnected&&(n.tagName!=='DIALOG'||n.open))
    const panel=candidates.sort((a,b)=>Number(b.dataset.duetAvatarSurface)-Number(a.dataset.duetAvatarSurface))[0]
    for(const node of moved.keys())if(!candidates.includes(node))restore(node)
    for(const node of candidates)if(node!==panel){restore(node);if(native){node.setAttribute('data-duet-surface-native','');moved.set(node,true)}}
    if(!panel){if(current||last||native!==nativeBefore)avatar()?.surface?.({type:'surface',panel:null});last='';semantic='';current=null;actions.clear();nativeBefore=native;return}
    let id=ids.get(panel);if(!id){id=`s${++serial}`;ids.set(panel,id)}
    const nodes=snapshot(panel),target=panel.dataset.duetSurfaceTarget||null
    const key=JSON.stringify({id,nodes,target}),changed=key!==last
    // Cosmetic countdown text does not invalidate an in-flight click. All other
    // content and action state still fence stale confirmations.
    const actionKey=JSON.stringify({id,target,nodes:nodes.map(n=>n.action&&actions.get(n.action)?.hasAttribute('data-duet-live-text')?{...n,text:''}:n)})
    if(changed)current={id,revision:(current?.revision||0)+(actionKey!==semantic?1:0),nodes,target}
    semantic=actionKey
    // A real click must happen in the playback document. Keep that counterpart visible.
    const audioUnlock=panel.hasAttribute('data-duet-audio-unlock')
    panel.toggleAttribute('data-duet-surface-native',native&&!audioUnlock&&!nodes.some(n=>n.gesture))
    const anchor=view.anchor
    if(!audioUnlock&&anchor?.isConnected&&!anchor.hidden) {
      const r=anchor.getBoundingClientRect(),b=panel.getBoundingClientRect()
      const right=r.right+12,side=right+b.width<innerWidth-12
      panel.style.setProperty('--duet-surface-x',`${Math.max(12,Math.min(side?right:r.left,innerWidth-b.width-12))}px`)
      panel.style.setProperty('--duet-surface-y',`${Math.max(12,Math.min(side?r.top:r.top-b.height-12,innerHeight-b.height-12))}px`)
      panel.setAttribute('data-duet-surface-positioned','')
    }else panel.removeAttribute('data-duet-surface-positioned')
    moved.set(panel,true)
    if(native&&(changed||!nativeBefore)) {
      try{
        const projected=audioUnlock
          ? {...current,nodes:[{kind:'text',text:'请回到 DSH，点击“启动音频播放”。'}]}
          : current
        if(avatar()?.surface?.(avatarSurface({type:'surface',panel:projected}))===false){nativeBefore=false;return}}catch{restore(panel);current=null;last='';return}
    }
    last=key;nativeBefore=native
  }
  function action(value) {
    let v;try{v=avatarSurfaceAction(value)}catch{return}
    if(!current||v.id!==current.id||v.revision!==current.revision)return
    const node=actions.get(v.action)
    if(!node?.isConnected||node.disabled||(node.hasAttribute('data-duet-user-gesture')&&!canActivate()))return
    // Invalidate before invoking: a double-click cannot send twice or replay a stale step.
    current.revision++;last=''
    if(node.matches('input[type=checkbox]')){node.checked=v.checked;node.dispatchEvent(new Event('change',{bubbles:true}))}
    else node.click()
    sync()
  }
  const timer=setInterval(sync,100)
  return {sync,action,dispose(){disposed=true;clearInterval(timer);for(const n of moved.keys())restore(n);style.remove();avatar()?.surface?.({type:'surface',panel:null});actions.clear()}}
}
