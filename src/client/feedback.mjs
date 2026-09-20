/** Optional, explicit rating; never opens voice or submits without a user click. */
export function mountRating(anchor, sessionTicket) {
  if(!sessionTicket)return null
  const panel=document.createElement('section')
  panel.setAttribute('role','region');panel.setAttribute('aria-label','本次语音体验评分')
  panel.style.cssText='position:fixed;z-index:100020;width:min(300px,calc(100vw - 24px));box-sizing:border-box;background:#17212f;color:#edf3ff;border:1px solid #52647d;border-radius:16px;padding:16px;box-shadow:0 12px 40px #0006;font:14px/1.6 system-ui'
  const title=document.createElement('h3');title.textContent='这次语音体验怎么样？';title.style.margin='0 0 10px';panel.append(title)
  const stars=document.createElement('div');stars.setAttribute('role','group');stars.setAttribute('aria-label','1 到 5 星');panel.append(stars)
  let rating=0,busy=false,requestId=crypto.randomUUID()
  const buttons=[]
  for(let value=1;value<=5;value++){
    const b=document.createElement('button');b.type='button';b.textContent='☆';b.setAttribute('aria-label',`${value} 星`);b.setAttribute('aria-pressed','false')
    b.style.cssText='border:0;background:transparent;color:#efbd61;font-size:32px;cursor:pointer;padding:2px 6px'
    b.onclick=()=>{if(busy)return;rating=value;requestId=crypto.randomUUID();buttons.forEach((x,i)=>{x.textContent=i<rating?'★':'☆';x.setAttribute('aria-pressed',String(i+1===rating))});submit.disabled=false}
    stars.append(b);buttons.push(b)
  }
  const submit=document.createElement('button');submit.type='button';submit.textContent='提交评分';submit.disabled=true
  submit.style.cssText='border:0;border-radius:8px;background:#b3e9cb;color:#152a1e;padding:8px 14px;cursor:pointer'
  const skip=document.createElement('button');skip.type='button';skip.textContent='暂不评价（10s）';skip.style.cssText='border:0;background:transparent;color:#b9c9dc;padding:8px 14px;cursor:pointer'
  const position=()=>{
    const rect=anchor.getBoundingClientRect(),box=panel.getBoundingClientRect()
    panel.style.left=Math.max(12,Math.min(rect.left,innerWidth-box.width-12))+'px'
    panel.style.top=(rect.top>=box.height+20?rect.top-box.height-12:rect.bottom+12)+'px'
  }
  let countdown,timeout
  const dispose=()=>{clearInterval(countdown);clearTimeout(timeout);panel.remove();document.removeEventListener('keydown',onKey);window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true)}
  const onKey=e=>{if(e.key==='Escape')dispose()}
  skip.onclick=dispose
  submit.onclick=async()=>{
    if(busy||!rating)return
    busy=true;submit.disabled=true;buttons.forEach(b=>b.disabled=true)
    try {
      const r=await fetch('/duplex-control/api/feedback',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-Duplex-Settings':'1'},signal:AbortSignal.timeout(15000),
        body:JSON.stringify({kind:'rating',request_id:requestId,session_ticket:sessionTicket,rating})})
      const result=await r.json()
      if(!r.ok||result.persisted!==true)throw Error('not_saved')
      dispose()
    }catch{title.textContent='提交失败，请重试';submit.disabled=false;buttons.forEach(b=>b.disabled=false)}
    finally{busy=false}
  }
  panel.append(submit,skip);document.body.append(panel);document.addEventListener('keydown',onKey)
  position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true)
  const deadline=Date.now()+10000
  countdown=setInterval(()=>{skip.textContent=`暂不评价（${Math.max(0,Math.ceil((deadline-Date.now())/1000))}s）`},250)
  timeout=setTimeout(dispose,10000)
  return {dispose}
}
