import {avatarSurface} from '../shared/avatar-surface.mjs'
/** No innerHTML, URLs, eval or native side effects from projected content. */
export function mountCompanionSurface(root,{send,changed}) {
  let current=null,key='',elements=new Map()
  return {update(value){
    const panel=avatarSurface(value).panel,next=JSON.stringify(panel)
    if(next===key)return
    const focused=root.contains(document.activeElement)?document.activeElement.dataset.surfaceAction:null,scroll=root.scrollTop
    const samePanel=current?.id===panel?.id
    key=next;current=panel;root.hidden=!panel
    const desired=[],nextElements=new Map()
    const element=(id,tag)=>{
      const old=samePanel?elements.get(id):null
      const e=old?.tagName.toLowerCase()===tag?old:document.createElement(tag)
      nextElements.set(id,e);desired.push(e);return e
    }
    if(panel) {
      if(panel.nodes.some(n=>n.gesture)){
        const action=panel.nodes.find(n=>n.gesture&&n.kind==='button')
        const note=element('gesture','p');note.className='gesture-note';note.textContent=action?.text==='开始教学'?'请回到 DSH，点击“开始教学”。':'请回到 DSH，点击“启动音频播放”。'
      }
      for(const [index,n] of panel.nodes.entries()){
        const tag=n.kind==='break'?'br':n.kind==='heading'?'h3':n.kind==='button'?'button':n.kind==='checkbox'?'input':'span'
        const e=element(n.action||'node'+index,tag)
        if(e.textContent!==n.text)e.textContent=n.text
        if(n.kind==='checkbox'){e.type='checkbox';e.checked=n.checked}
        if(n.kind==='button'||n.kind==='checkbox'){
          e.dataset.surfaceAction=n.action
          if(n.kind==='button')e.type='button'
          e.disabled=n.disabled||n.gesture
          if(n.label)e.setAttribute('aria-label',n.label);else e.removeAttribute('aria-label')
          const callback=()=>{if(current!==panel||e.disabled)return;send({type:'surface_action',id:panel.id,revision:panel.revision,action:n.action,checked:e.checked===true})}
          if(n.kind==='checkbox')e.onchange=callback;else e.onclick=callback
        }
      }
    }
    // Do not detach unchanged buttons between pointerdown and pointerup.
    desired.forEach((e,i)=>{if(root.children[i]!==e)root.insertBefore(e,root.children[i]||null)})
    while(root.children.length>desired.length)root.lastElementChild.remove()
    elements=nextElements
    if(focused){const node=elements.get(focused);if(node&&!node.disabled&&document.activeElement!==node)node.focus({preventScroll:true})}
    root.scrollTop=scroll
    changed(Boolean(panel),panel?.target)
  }}
}
