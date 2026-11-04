/** Bounded presentation-only IPC: never transfer DOM, HTML, tickets or callbacks. */
export const AVATAR_UI_PROTOCOL = 2
export function avatarSurface(value) {
  if(value?.type!=='surface')throw Error('invalid_surface')
  if(value.panel===null)return {type:'surface',panel:null}
  const p=value.panel
  if(!p||!/^s\d+$/.test(p.id)||!Number.isSafeInteger(p.revision)||p.revision<1||!Array.isArray(p.nodes)||p.nodes.length>160)throw Error('invalid_surface')
  let length=0
  const nodes=p.nodes.map(n=>{
    if(!n||!['text','heading','button','checkbox','break'].includes(n.kind)||typeof n.text!=='string'||n.text.length>4000)throw Error('invalid_surface')
    length+=n.text.length;if(length>10000)throw Error('invalid_surface')
    const node={kind:n.kind,text:n.text}
    if(n.kind==='button'||n.kind==='checkbox') {
      if(!/^a\d+$/.test(n.action))throw Error('invalid_surface')
      Object.assign(node,{action:n.action,disabled:n.disabled===true,checked:n.checked===true,gesture:n.gesture===true,label:String(n.label||'').slice(0,100)})
    }
    return node
  })
  return {type:'surface',panel:{id:p.id,revision:p.revision,nodes,target:['online','tts_only'].includes(p.target)?p.target:null}}
}
export function avatarSurfaceAction(v) {
  if(v?.type!=='surface_action'||!/^s\d+$/.test(v.id)||!/^a\d+$/.test(v.action)||!Number.isSafeInteger(v.revision)||v.revision<1)throw Error('invalid_surface_action')
  return {type:'surface_action',id:v.id,revision:v.revision,action:v.action,checked:v.checked===true}
}
