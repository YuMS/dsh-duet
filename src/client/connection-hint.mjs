/** A brief, non-modal invitation after the microphone is actually ready. */
export function mountConnectionHint(controls, { duration = 8000 } = {}) {
  const hint = document.createElement('div')
  hint.dataset.duetConnectionHint = ''
  hint.setAttribute('role', 'status')
  hint.setAttribute('aria-live', 'polite')
  hint.hidden = true
  hint.style.cssText = 'position:fixed;z-index:100020;box-sizing:border-box;width:268px;max-width:calc(100vw - 32px);padding:12px 15px;border:1px solid #a5d8f4;border-radius:12px;background:#eff9ff;color:#163c56;font:13px/1.65 system-ui,sans-serif;box-shadow:0 8px 28px #153e6524;pointer-events:none'
  hint.textContent = '连接成功，可以试试对我说“你好”。'
  const arrow = document.createElement('span')
  arrow.setAttribute('aria-hidden', 'true')
  arrow.style.cssText = 'position:absolute;bottom:-6px;width:10px;height:10px;transform:rotate(45deg);background:#eff9ff;border-right:1px solid #a5d8f4;border-bottom:1px solid #a5d8f4'
  hint.append(arrow)
  // A body-level overlay escapes the sidebar's overflow and stacking context.
  document.body.append(hint)
  let wasReady = false, timer, disposed = false
  const position = () => {
    if (hint.hidden || disposed) return
    if (!controls.isConnected) { hide(); return }
    const button = controls.querySelector('[data-voice=mic]') || controls
    const rect = button.getBoundingClientRect(), width = hint.offsetWidth, height = hint.offsetHeight
    const left = Math.max(16, Math.min(rect.left, innerWidth - width - 16))
    const above = rect.top >= height + 26
    hint.style.left = `${left}px`
    hint.style.top = `${Math.max(16, Math.min(above ? rect.top - height - 10 : rect.bottom + 10, innerHeight - height - 16))}px`
    arrow.style.left = `${Math.max(16, Math.min(width - 26, rect.left + rect.width / 2 - left - 5))}px`
    arrow.style.bottom = above ? '-6px' : 'auto'
    arrow.style.top = above ? 'auto' : '-6px'
    arrow.style.transform = above ? 'rotate(45deg)' : 'rotate(225deg)'
  }
  const hide = () => { hint.hidden = true; clearTimeout(timer) }
  const dismiss = event => { if (event.type !== 'keydown' || event.key === 'Escape') hide() }
  controls.addEventListener('pointerdown', dismiss)
  document.addEventListener('keydown', dismiss)
  window.addEventListener('resize', position)
  window.addEventListener('scroll', position, true)
  const observer = new ResizeObserver(position)
  observer.observe(controls)
  return {
    dismiss: hide,
    update({ mode, ready, teaching = false }) {
      if (disposed) return
      const active = mode === 'online' && ready
      if (!active || teaching) hide()
      if (active && !wasReady && !teaching) {
        hint.hidden = false
        position()
        clearTimeout(timer)
        timer = setTimeout(hide, duration)
      }
      wasReady = active
    },
    dispose() {
      disposed = true
      hide()
      controls.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismiss)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      observer.disconnect()
      hint.remove()
    },
  }
}
