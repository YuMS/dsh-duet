/** Resolve the sidebar without depending on DSH's generated CSS class names. */
export function sidebarElement(controls) {
  if (!controls?.isConnected) return null
  let fallback=null
  for(let node=controls;node&&node!==document.body;node=node.parentElement){
    const r=node.getBoundingClientRect()
    if(!r.width||!r.height||r.width>Math.min(600,innerWidth*.75))continue
    fallback=node
    if(node.matches('aside,[role="complementary"]')||node.querySelector('[data-slot="sidebar.workspaces"]'))return node
  }
  return fallback
}
export const sidebarBounds=controls=>sidebarElement(controls)?.getBoundingClientRect()??null

/** A mask fades pixels; clipping also prevents the hidden area from taking clicks. */
export function clipToSidebar(node,bounds){
  node.style.clipPath='';node.style.maskImage='';node.style.webkitMaskImage=''
  if(!bounds)return
  const r=node.getBoundingClientRect(),right=Math.max(0,r.right-bounds.right),left=Math.max(0,bounds.left-r.left)
  node.style.clipPath=`inset(-4px ${right}px -4px ${left}px)`
  if(right>0){
    const end=Math.max(0,r.width-right),start=Math.max(left,end-24)
    const mask=`linear-gradient(to right,#000 ${start}px,transparent ${end}px)`
    node.style.maskImage=mask;node.style.webkitMaskImage=mask
  }
}
