/** Local, post-commit feedback only. Never delays a write or submits a draft. */
export function mountInputEffect({anchor, isCurrent, target = composerTarget}) {
  let current, disposed=false
  const clear=()=>{
    const item=current;current=null
    if(!item)return
    clearTimeout(item.timer);clearInterval(item.watch);item.animation?.cancel();item.node.remove()
  }
  const show=(text,sessionId)=>{
    clear()
    if(disposed || !text || !isCurrent(sessionId) || document.hidden)return
    const source=anchor()?.getBoundingClientRect()
    if(!source || !source.width || !source.height)return
    const node=document.createElement('div');node.dataset.duetInputEffect='';node.dataset.phase='preview'
    node.setAttribute('role','status');node.setAttribute('aria-label','已写入输入框')
    node.style.cssText='position:fixed;z-index:100020;pointer-events:none;box-sizing:border-box;width:260px;max-width:calc(100vw - 16px);padding:11px 13px;border:1px solid #7cb8e566;border-radius:15px;background:light-dark(#eef8ff,#172d40);color:light-dark(#194a6a,#e0f2ff);color-scheme:light dark;box-shadow:0 8px 26px #0002;display:flex;gap:9px;align-items:flex-start;font:13px/1.6 system-ui;transform-origin:center'
    const icon=document.createElement('span')
    icon.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/></svg>'
    const words=document.createElement('span');words.dataset.duetInputText=''
    words.style.cssText='min-width:0;max-height:126px;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere'
    words.textContent=text.length>600?text.slice(0,600)+'…':text
    node.append(icon,words);document.body.append(node)
    node.style.left=`${Math.max(8,Math.min(source.left,innerWidth-node.offsetWidth-8))}px`
    node.style.top=`${Math.max(8,Math.min(source.top-node.offsetHeight-10,innerHeight-node.offsetHeight-8))}px`
    const item=current={node,animation:null}
    item.watch=setInterval(()=>{if(!isCurrent(sessionId)||document.hidden)clear()},100)
    item.timer=setTimeout(()=>{
      if(current!==item || !isCurrent(sessionId)){clear();return}
      const destination=target(),to=destination?.getBoundingClientRect(),from=node.getBoundingClientRect()
      const visible=to&&to.width>0&&to.height>0&&to.bottom>0&&to.top<innerHeight&&to.right>0&&to.left<innerWidth
      const dx=visible?to.left+to.width/2-from.left-from.width/2:0
      const dy=visible?to.top+to.height/2-from.top-from.height/2:-10
      node.dataset.phase=visible?'flying':'fading'
      item.animation=node.animate([
        {transform:'translate(0,0) scale(1)',opacity:1},
        {transform:`translate(${dx}px,${dy}px) scale(${visible?.12:.98})`,opacity:0},
      ],{duration:visible?520:220,easing:'cubic-bezier(.4,0,.3,1)',fill:'forwards'})
      item.animation.finished.then(()=>{if(current===item)clear()},()=>{})
    },900)
  }
  return {show,clear,dispose(){disposed=true;clear()}}
}

/** Only known DSH composer surfaces; never select a search/settings field. */
export function composerTarget() {
  const nodes=[...document.querySelectorAll('[data-composer-input]')].filter(node=>{
    const r=node.getBoundingClientRect(),s=getComputedStyle(node)
    return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&s.visibility!=='hidden'&&s.display!=='none'
  })
  return nodes.find(node=>node===document.activeElement||node.contains(document.activeElement)) || (nodes.length===1?nodes[0]:null)
}
