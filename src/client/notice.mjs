/** Page-level notices must not inherit a sidebar's clipping or stacking context. */
export function mountNotice(anchor) {
  const panel = document.createElement('div')
  panel.dataset.duetNotice = ''
  panel.dataset.duetAvatarSurface = '70'
  panel.setAttribute('role', 'status')
  panel.setAttribute('aria-live', 'polite')
  panel.hidden = true
  panel.style.cssText = 'position:fixed;z-index:100021;box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:#eff9ff;color:#163c56;padding:16px;border:1px solid #a5d8f4;border-radius:12px;font:13px/1.65 system-ui,sans-serif;box-shadow:0 8px 28px #153e6524;overflow-wrap:anywhere'
  document.body.append(panel)
  let timer, disposed = false
  const hide = () => { panel.hidden = true; clearTimeout(timer) }
  const position = () => {
    if (panel.hidden || disposed) return
    const control = anchor()
    if (!control?.isConnected) { hide(); return }
    const rect = control.getBoundingClientRect(), box = panel.getBoundingClientRect()
    panel.style.left = Math.max(12, Math.min(rect.left, innerWidth - box.width - 12)) + 'px'
    const top = rect.top >= box.height + 24 ? rect.top - box.height - 12 : rect.bottom + 12
    panel.style.top = Math.max(12, Math.min(top, innerHeight - box.height - 12)) + 'px'
  }
  const key = event => { if (event.key === 'Escape') hide() }
  window.addEventListener('resize', position)
  window.addEventListener('scroll', position, true)
  document.addEventListener('keydown', key)
  const observer = new ResizeObserver(position)
  observer.observe(panel)
  return {
    show(text, {upgrade = false, releaseNotes, releases = [], currentVersion, targetVersion} = {}) {
      if (disposed) return
      clearTimeout(timer); panel.textContent = text; panel.hidden = false
      if (upgrade) {
        panel.textContent = ''
        const heading=document.createElement('strong');heading.textContent='duet 有新版本';heading.style.cssText='display:block;font-size:16px;margin-bottom:8px'
        const message=document.createElement('p');message.textContent=text;message.style.cssText='margin:0 0 12px'
        panel.append(heading,message)
        if(currentVersion&&targetVersion){
          const range=document.createElement('div');range.dataset.duetVersionRange=''
          range.style.cssText='display:flex;align-items:center;gap:10px;margin:0 0 14px;font-size:12px'
          for(const [index,text] of [`v${currentVersion}`,'→',`v${targetVersion}`].entries()){
            const badge=document.createElement('span');badge.textContent=text
            if(index!==1)badge.style.cssText=`padding:3px 10px;border-radius:20px;background:${index===2?'#d1eaff':'#ffffffa8'};font-weight:${index===2?600:400}`
            range.append(badge)
          }
          panel.append(range)
        }
        if(releases.length){
          const label=document.createElement('strong');label.textContent=`更新内容 · ${currentVersion} → ${targetVersion}`;label.style.fontSize='12px'
          const list=document.createElement('div');list.dataset.duetReleaseHistory=''
          for(const release of releases){
            const section=document.createElement('section'),version=document.createElement('strong'),notes=document.createElement('p')
            version.textContent=`v${release.version}`;notes.textContent=release.notes
            notes.style.cssText='white-space:pre-wrap;margin:4px 0 0'
            section.style.cssText='margin:8px 0;padding:10px 12px;border-radius:8px;background:#ffffffa8'
            section.append(version,notes);list.append(section)
          }
          panel.append(label,list)
        }else if(typeof releaseNotes==='string' && releaseNotes.trim()){
          const label=document.createElement('strong');label.textContent='更新内容';label.style.fontSize='12px'
          const notes=document.createElement('p');notes.dataset.duetReleaseNotes='';notes.textContent=releaseNotes.slice(0,1000).trim()
          notes.style.cssText='white-space:pre-wrap;margin:6px 0 14px;padding:10px 12px;border-radius:8px;background:#ffffffa8'
          panel.append(label,notes)
        }
        const help = document.createElement('details'), title = document.createElement('summary')
        help.open=true
        help.style.cssText='border-top:1px solid #a5d8f4;padding-top:10px'
        title.style.cssText='cursor:pointer;font-weight:600'
        title.textContent = '如何升级'; help.append(title)
        const steps=document.createElement('ol');steps.style.cssText='margin:10px 0;padding-left:20px'
        for(const text of ['在 DSH 的「插件」页面卸载 duet。','点击「添加插件」，输入 dsh-duet 并安装。','安装完成后，如果插件不可用，可能需要重启 DSH 哦']){
          const step=document.createElement('li');step.textContent=text;step.style.margin='6px 0';steps.append(step)
        }
        help.append(steps); panel.append(help)
        help.addEventListener('toggle', position)
        const actions=document.createElement('div');actions.style.cssText='display:flex;justify-content:flex-end;margin-top:14px'
        const close = document.createElement('button'); close.type = 'button'; close.textContent = '知道了'; close.onclick = hide
        close.style.cssText='font:inherit;padding:7px 15px;border-radius:8px;border:1px solid #a5d8f4;background:#dcefff;color:#185a89;cursor:pointer'
        actions.append(close);panel.append(actions)
      } else timer = setTimeout(hide, 8000)
      position()
    },
    dispose() { disposed = true; hide(); observer.disconnect(); panel.remove(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); document.removeEventListener('keydown', key) },
  }
}
