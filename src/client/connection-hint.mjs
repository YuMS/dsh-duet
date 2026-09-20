/** A brief, non-modal invitation after the microphone is actually ready. */
export function mountConnectionHint(controls, { duration = 8000 } = {}) {
  const hint = document.createElement('div')
  hint.dataset.duetConnectionHint = ''
  hint.setAttribute('role', 'status')
  hint.setAttribute('aria-live', 'polite')
  hint.hidden = true
  hint.style.cssText = 'position:absolute;bottom:calc(100% + 10px);left:0;z-index:9998;box-sizing:border-box;width:268px;max-width:calc(100vw - 32px);padding:12px 15px;border:1px solid #a5d8f4;border-radius:12px;background:#eff9ff;color:#163c56;font:13px/1.65 system-ui,sans-serif;box-shadow:0 8px 28px #153e6524;pointer-events:none'
  hint.textContent = '连接成功，可以试试对我说“你好”。'
  const arrow = document.createElement('span')
  arrow.setAttribute('aria-hidden', 'true')
  arrow.style.cssText = 'position:absolute;bottom:-6px;width:10px;height:10px;transform:rotate(45deg);background:#eff9ff;border-right:1px solid #a5d8f4;border-bottom:1px solid #a5d8f4'
  hint.append(arrow)
  controls.append(hint)
  let wasReady = false, timer, disposed = false
  const hide = () => { hint.hidden = true; clearTimeout(timer) }
  const dismiss = event => { if (event.type !== 'keydown' || event.key === 'Escape') hide() }
  controls.addEventListener('pointerdown', dismiss)
  document.addEventListener('keydown', dismiss)
  return {
    dismiss: hide,
    update({ mode, ready, teaching = false }) {
      if (disposed) return
      const active = mode === 'online' && ready
      if (!active || teaching) hide()
      if (active && !wasReady && !teaching) {
        const button = controls.querySelector('[data-voice=mic]')
        arrow.style.left = `${Math.max(16, Math.min(244, (button?.offsetLeft || 32) + (button?.offsetWidth || 30) / 2 - 5))}px`
        hint.hidden = false
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
      hint.remove()
    },
  }
}
