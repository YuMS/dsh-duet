import {avatarLocalState,avatarMenuAction,avatarMenuResult} from './avatar-menu.mjs'
import {sizeButton,nextAvatarSize} from './avatar-ui.mjs'
const labels={completed:'本轮已完成',failed:'执行失败',stopped:'已停止',approval:'等待授权',question:'等待回答',plan_review:'等待方案确认'}
const names={small:'紧凑',medium:'标准',large:'宽松'}
const paths={open:'M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',pending:'M8 4h8m-9 0H5v17h14V4h-2M8 3h8v4H8zM8 12h8m-8 4h5',bubble:'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2zM7 9h10m-10 4h6',tutorial:'m9 5 10 7-10 7z',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',hide:'m4 4 16 16M9 5a11 11 0 0 1 12 7l-3 4M6 6a13 13 0 0 0-5 6s4 7 11 7l3-1M10 10a3 3 0 0 0 4 4',back:'m14 5-7 7 7 7'}
const icon=name=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('aria-hidden','true');s.innerHTML=`<path d="${paths[name]||paths.pending}"/>`;return s}
export function mountAvatarMenu({anchor,viewport=()=>[0,0,innerWidth,innerHeight],send,changed=()=>{}}){
  let state={items:[],running:0,enabled:true,size:'large',bubble:'medium'},root,toast,badge,section='main',timer,dead=false,point,previous,toastId,ackTimer
  const style=document.createElement('style');style.textContent=`
  .duet-pet-menu{position:fixed;z-index:2147483601;box-sizing:border-box;width:264px;max-width:calc(100vw - 24px);padding:9px;border:1px solid #a7c5dc30;border-radius:18px;background:#142330f7;color:#eaf2f8;font:13px/1.5 Inter,"PingFang SC",sans-serif;box-shadow:0 16px 48px #0004,0 2px 8px #0002;backdrop-filter:blur(20px);pointer-events:auto;overflow:auto}
  .duet-pet-menu button{position:relative;display:flex;align-items:center;justify-content:flex-start;gap:10px;box-sizing:border-box;width:100%;min-height:39px;margin:0;border:0;border-radius:10px;padding:8px 11px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;height:auto;flex-shrink:0;letter-spacing:normal}
  .duet-pet-menu button>[data-label]{min-width:0;flex:1;overflow-wrap:anywhere}
  .duet-pet-menu button>svg,.duet-pet-menu [data-size-icon]{display:flex;align-items:center;justify-content:center;width:20px;height:20px;flex:0 0 20px}
  [data-duet-notice-badge][hidden]{display:none!important}
  .duet-pet-menu button:hover,.duet-pet-menu button:focus-visible{background:#b3daff16;outline:none}
  .duet-pet-menu svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;color:#a7bdd0}
  .duet-pet-menu [data-wordmark]{font:700 28px/1.1 Inter,"PingFang SC",sans-serif;letter-spacing:-1.1px;padding:11px 12px 15px}
  .duet-pet-menu [data-wordmark] span{color:#ed9b35}.duet-pet-menu hr{border:0;border-top:1px solid #a7c5dc1c;margin:6px 9px}
  .duet-pet-menu [data-value]{margin-left:auto;color:#9eb1c0;font-size:12px}.duet-pet-menu [data-switch]{position:relative;display:block;width:28px;height:16px;border-radius:10px;background:#53616e;flex-shrink:0;transition:background .15s}
  .duet-pet-menu [data-switch]:after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:white;transition:transform .15s}.duet-pet-menu [aria-checked=true] [data-switch]{background:#6eabc9}.duet-pet-menu [aria-checked=true] [data-switch]:after{transform:translateX(12px)}
  .duet-pet-menu [data-bubble-preview]{margin:12px 9px;padding:12px 14px;border-radius:15px 15px 15px 4px;border:1px solid #8dc5ed45;background:#213b4c;white-space:pre-wrap;overflow:auto;line-height:1.7;scrollbar-width:thin}
  .duet-pet-menu p{margin:10px 12px;color:#a7bdd0}.duet-pet-menu [data-notice-title]{padding:8px 11px;font-weight:600}
  `;document.head.append(style)
  const place=node=>{
    const [x,y,w,h]=viewport();node.style.maxHeight=Math.max(40,h-24)+'px';node.style.maxWidth=Math.max(40,w-24)+'px'
    const a=anchor().getBoundingClientRect(),b=node.getBoundingClientRect(),top=point?.y??(a.top-b.height-12>=y?a.top-b.height-12:a.bottom+12)
    node.style.left=Math.max(x+12,Math.min(point?.x??a.left,x+w-b.width-12))+'px';node.style.top=Math.max(y+12,Math.min(top,y+h-b.height-12))+'px'
  }
  const close=()=>{root?.remove();root=null;point=null;if(previous?.isConnected)previous.focus({preventScroll:true});changed()}
  const command=(action,value,id)=>send(avatarMenuAction({type:'menu_action',request_id:crypto.randomUUID(),action,value,id}))
  const row=(label,action,iconName=action,id)=>{
    const b=document.createElement('button');b.type='button';b.setAttribute('role','menuitem');b.dataset.menuAction=action
    if(paths[iconName])b.append(icon(iconName));const t=document.createElement('span');t.dataset.label='';t.textContent=label;b.append(t)
    b.onclick=()=>{if(['pending','bubble_panel','back'].includes(action)){section=action==='back'?'main':action;render();return}close();command(action,undefined,id)};return b
  }
  const countLabel=()=>{const n=state.items.filter(i=>i.pending||i.unread).length;return '待处理事项与通知'+(n?`（${n}）`:'')}
  const valueSpan=b=>{const v=document.createElement('span');v.dataset.value='';b.append(v);return v}
  const refreshControls=()=>{
    if(!root)return
    const size=root.querySelector('[data-menu-action=size]');if(size){const glyph=size.querySelector('[data-size-icon]');sizeButton(glyph,state.size);size.querySelector('[data-value]').textContent={large:'大',medium:'中',small:'小'}[state.size];size.setAttribute('aria-label',glyph.getAttribute('aria-label'))}
    const notify=root.querySelector('[data-menu-action=notifications]');notify?.setAttribute('aria-checked',String(state.enabled))
    const bubble=root.querySelector('[data-menu-action=bubble]');if(bubble){bubble.querySelector('[data-value]').textContent=names[state.bubble];bubble.setAttribute('aria-label',`气泡大小：${names[state.bubble]}，点击切换`)}
    const preview=root.querySelector('[data-bubble-preview]');if(preview){preview.style.maxHeight={small:60,medium:110,large:180}[state.bubble]+'px';preview.dataset.size=state.bubble}
    const pending=root.querySelector('[data-menu-action=pending] span');if(pending)pending.textContent=countLabel()
    place(root);changed()
  }
  const render=()=>{
    if(!root)return;root.replaceChildren()
    const title=document.createElement('div');title.dataset.wordmark='';title.append('duet');const dot=document.createElement('span');dot.textContent='.';title.append(dot);root.append(title)
    const divider=()=>root.append(document.createElement('hr'))
    if(section==='main'){
      root.append(row('打开 DSH','open_dsh','open'),row(countLabel(),'pending'))
      const notify=row('任务通知','notifications','pending');notify.setAttribute('role','menuitemcheckbox');const toggle=document.createElement('span');toggle.dataset.switch='';notify.append(toggle);notify.onclick=()=>{state.enabled=!state.enabled;refreshControls();command('notifications',state.enabled)};root.append(notify);divider()
      const size=row('形象大小','size'),glyph=document.createElement('span');glyph.dataset.sizeIcon='';size.prepend(glyph);valueSpan(size);size.onclick=()=>{state.size=nextAvatarSize(state.size);refreshControls();command('size',state.size)}
      root.append(size,row('气泡大小','bubble_panel','bubble'));divider()
      root.append(row('使用教学','tutorial'),row('duet 设置','settings'),row('隐藏形象','hide'))
    }else if(section==='bubble_panel'){
      const cycle=row('气泡大小','bubble','bubble');valueSpan(cycle);cycle.onclick=()=>{state.bubble={small:'medium',medium:'large',large:'small'}[state.bubble];refreshControls();command('bubble',state.bubble)};root.append(cycle)
      const sample=document.createElement('div');sample.dataset.bubblePreview='';sample.setAttribute('aria-label','示例气泡');sample.textContent='好的，我来帮你。\n任务完成后，我会在这里告诉你结果。\n也可以随时打断我，继续聊聊你的新想法。\n这是一段较长的文字，你可以看看当前气泡能显示多少内容。';root.append(sample,row('返回','back'))
    }else{
      if(!state.available){const p=document.createElement('p');p.textContent='正在连接 DSH';root.append(p)}
      if(!state.items.length){const p=document.createElement('p');p.textContent='暂时没有待处理事项或新通知';root.append(p)}
      for(const item of state.items){const b=row(`${item.unread?'● ':''}${item.name||'未命名会话'} · ${labels[item.status]}`,'view','pending',item.id);b.title=item.summary;root.append(b)}root.append(row('返回','back'))
    }
    refreshControls();root.querySelector('button')?.focus({preventScroll:true})
  }
  const open=(event,tab='main')=>{
    if(dead)return;event?.preventDefault();event?.stopPropagation();close();previous=document.activeElement;section=tab;point=event&&Number.isFinite(event.clientX)&&event.clientX>0?{x:event.clientX,y:event.clientY}:null
    root=document.createElement('div');root.className='duet-pet-menu';root.dataset.duetContextMenu='';root.setAttribute('role','menu');root.setAttribute('aria-label','duet 形象菜单');document.body.append(root);render()
  }
  const outside=e=>{if(root&&!root.contains(e.target)){e.preventDefault();e.stopPropagation();close()}}
  const keys=e=>{if(!root)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();return}const buttons=[...root.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End','Tab'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowUp'||e.key==='Tab'&&e.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus()}}
  const decorate=(node,label)=>{node.className='duet-pet-menu';node.setAttribute('aria-label',label)}
  const update=value=>{
    state=avatarLocalState(value);badge??=document.createElement('button');badge.type='button';badge.dataset.duetNoticeBadge='';badge.style.cssText='position:fixed;z-index:2147483600;border:0;border-radius:12px;background:#dcefff;color:#185a89;font:12px system-ui;padding:4px 7px;cursor:pointer;pointer-events:auto'
    const count=state.items.filter(i=>i.pending||i.unread).length;badge.textContent=count?String(count):'';badge.setAttribute('aria-label',countLabel());badge.hidden=!count||!state.enabled;badge.onclick=e=>open(e,'pending');if(!badge.isConnected)document.body.append(badge)
    const a=anchor().getBoundingClientRect(),[x,y,w,h]=viewport();badge.style.left=Math.max(x+12,Math.min((a.right??a.left+a.width)-24,x+w-36))+'px';badge.style.top=Math.max(y+12,Math.min(a.top,y+h-30))+'px'
    if(toastId!==state.toast){clearTimeout(timer);clearTimeout(ackTimer);toast?.remove();toast=null;toastId=state.toast;const item=state.items.find(i=>i.id===state.toast);if(item){toast=document.createElement('section');toast.dataset.duetLocalNotice='';decorate(toast,'DSH 任务通知');const p=document.createElement('div');p.dataset.noticeTitle='';p.textContent=`${item.name||'未命名会话'} · ${labels[item.status]}`;toast.append(p,row(item.pending?'去处理':'查看','view','open',item.id),row('收起','dismiss','hide',item.id));document.body.append(toast);place(toast);if(!item.pending)timer=setTimeout(()=>{toast?.remove();toast=null;changed()},8000)}}
    refreshControls();changed()
  }
  const result=value=>{const r=avatarMenuResult(value);if(!r.message)return;clearTimeout(ackTimer);toast?.remove();toast=document.createElement('section');decorate(toast,'操作提示');toast.textContent=r.message;document.body.append(toast);place(toast);changed();ackTimer=setTimeout(()=>{toast?.remove();toast=null;changed()},4000)}
  const reposition=()=>{if(root)place(root);if(toast)place(toast)}
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',keys,true);window.addEventListener('resize',reposition);window.addEventListener('blur',close)
  return{open,close,update,result,get active(){return Boolean(root)},regions(){return[root,toast,badge].filter(n=>n?.isConnected&&!n.hidden).map(n=>{const r=n.getBoundingClientRect();return[r.x,r.y,r.width,r.height]})},dispose(){dead=true;close();style.remove();clearTimeout(timer);clearTimeout(ackTimer);toast?.remove();badge?.remove();document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',keys,true);window.removeEventListener('resize',reposition);window.removeEventListener('blur',close)}}
}
