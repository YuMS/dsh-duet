/** Page-level notices must not inherit a sidebar's clipping or stacking context. */
export function mountNotice(anchor) {
  const panel = document.createElement('div')
  panel.dataset.duetNotice = ''
  panel.setAttribute('role', 'status')
  panel.setAttribute('aria-live', 'polite')
  panel.hidden = true
  panel.style.cssText = 'position:fixed;z-index:100021;box-sizing:border-box;width:280px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:#252c38;color:white;padding:14px;border:1px solid #52647d;border-radius:12px;font:13px/1.6 system-ui;box-shadow:0 8px 28px #0005;overflow-wrap:anywhere'
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
    show(text, {upgrade = false} = {}) {
      if (disposed) return
      clearTimeout(timer); panel.textContent = text; panel.hidden = false
      if (upgrade) {
        const help = document.createElement('details'), title = document.createElement('summary')
        title.textContent = '如何升级'; help.append(title)
        const before = document.createElement('p'), command = document.createElement('code'), after = document.createElement('p')
        before.textContent = '通过 npm 安装的用户，可在终端运行：'
        command.textContent = 'dsh plugin --profile web add dsh-duet@latest'
        command.style.cssText = 'display:block;white-space:normal;margin:8px 0'
        after.textContent = '其他安装方式请从原来源更新。完成后重启 DSH 并刷新页面，再手动开启语音。'
        help.append(before, command, after); panel.append(help)
        help.addEventListener('toggle', position)
        const close = document.createElement('button'); close.type = 'button'; close.textContent = '知道了'; close.onclick = hide; panel.append(close)
      } else timer = setTimeout(hide, 8000)
      position()
    },
    dispose() { disposed = true; hide(); observer.disconnect(); panel.remove(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); document.removeEventListener('keydown', key) },
  }
}
