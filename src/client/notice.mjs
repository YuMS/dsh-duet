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
    show(text, {upgrade = false, releaseNotes} = {}) {
      if (disposed) return
      clearTimeout(timer); panel.textContent = text; panel.hidden = false
      if (upgrade) {
        panel.textContent = ''
        const heading=document.createElement('strong');heading.textContent='更新 duet';heading.style.cssText='display:block;font-size:15px;margin-bottom:6px'
        const message=document.createElement('p');message.textContent=text;message.style.cssText='margin:0 0 12px'
        panel.append(heading,message)
        if(typeof releaseNotes==='string' && releaseNotes.trim()){
          const label=document.createElement('strong');label.textContent='更新内容';label.style.fontSize='12px'
          const notes=document.createElement('p');notes.dataset.duetReleaseNotes='';notes.textContent=releaseNotes.slice(0,1000).trim()
          notes.style.cssText='white-space:pre-wrap;margin:6px 0 14px;padding:10px 12px;border-radius:8px;background:#ffffffa8'
          panel.append(label,notes)
        }
        const help = document.createElement('details'), title = document.createElement('summary')
        help.style.cssText='border-top:1px solid #a5d8f4;padding-top:10px'
        title.style.cssText='cursor:pointer;font-weight:600'
        title.textContent = '如何升级'; help.append(title)
        const before = document.createElement('p'), command = document.createElement('code'), after = document.createElement('p')
        before.textContent = '通过 npm 安装的用户，可在终端运行：'
        command.textContent = 'dsh plugin --profile web add dsh-duet@latest'
        command.style.cssText = 'display:block;white-space:normal;margin:8px 0;padding:10px;border-radius:8px;background:#ffffffa8;user-select:text;font:12px/1.6 monospace'
        after.textContent = '其他安装方式请从原来源更新。完成后重启 DSH 并刷新页面，再手动开启语音。'
        help.append(before, command, after); panel.append(help)
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
