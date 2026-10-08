/** A compact launcher; its top-layer flyout consumes no host footer space. */
export function mountControlsLayout(controls) {
  const parent = controls.parentElement
  const entry = controls.querySelector('#dsh-duet-entry')
  if (!entry) return () => {}
  const initial = { controls: controls.style.cssText, entry: entry.style.cssText }
  const label = [...entry.childNodes].find(node => node.nodeType === Node.TEXT_NODE)
  const labelText = label?.textContent
  const actions = document.createElement('div')
  actions.dataset.duetActions = ''
  actions.id = 'dsh-duet-actions'
  actions.setAttribute('role', 'group')
  actions.setAttribute('aria-label', 'duet 语音控制')
  for (const node of [...controls.children]) if (node.matches('[data-voice],a')) actions.append(node)
  controls.append(actions)
  let compact = false, opened = false, timer, disposed = false, pinned = false, suppressFocus = false
  const listeners = []
  const listen = (node, event, fn, options) => {
    node.addEventListener(event, fn, options)
    listeners.push(() => node.removeEventListener(event, fn, options))
  }
  const position = () => {
    if (!opened) return
    const rect = entry.getBoundingClientRect(), width = actions.offsetWidth, height = actions.offsetHeight
    const sidebar = parent.getBoundingClientRect(), right = Math.max(rect.right, sidebar.right) + 8
    actions.style.left = `${Math.max(8, Math.min(right + width <= innerWidth - 8 ? right : Math.min(rect.left, sidebar.left) - width - 8, innerWidth - width - 8))}px`
    actions.style.top = `${Math.max(8, Math.min(rect.top + (rect.height - height) / 2, innerHeight - height - 8))}px`
  }
  const close = () => {
    clearTimeout(timer)
    if (!opened) return
    if (actions.matches(':popover-open')) actions.hidePopover()
    actions.hidden = true; opened = false
    entry.setAttribute('aria-expanded', 'false')
  }
  const open = () => {
    clearTimeout(timer)
    if (!compact || disposed || !controls.isConnected) return
    if (!opened) {
      actions.hidden = false; actions.showPopover(); opened = true
      entry.setAttribute('aria-expanded', 'true')
    }
    position()
  }
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!pinned && !entry.matches(':hover') && !actions.matches(':hover') &&
          !controls.contains(document.activeElement)) close()
    }, 220)
  }
  const update = () => {
    const next = parent.getBoundingClientRect().width < 160 && typeof actions.showPopover === 'function'
    if (controls.dataset.compact === String(next)) { position(); return }
    close(); compact = next
    controls.dataset.compact = String(compact)
    controls.style.flexDirection = 'row'
    controls.style.margin = compact ? '4px 0' : '4px 8px'
    controls.style.padding = compact ? '2px 0' : '6px 8px'
    controls.style.justifyContent = compact ? 'center' : ''
    controls.style.minWidth = '0'
    entry.style.cssText = initial.entry
    if (label) label.textContent = compact ? 'D' : labelText
    if (compact) {
      entry.style.cssText += ';display:flex;align-items:center;gap:2px;margin:0;padding:4px;box-sizing:border-box;min-width:32px;height:32px;font-size:23px;cursor:pointer'
      entry.setAttribute('role', 'button'); entry.tabIndex = 0
      entry.setAttribute('aria-label', 'duet 语音控制')
      entry.setAttribute('aria-expanded', 'false'); entry.setAttribute('aria-controls', actions.id)
      actions.setAttribute('popover', 'manual'); actions.hidden = true
      actions.style.cssText = 'position:fixed;inset:auto;margin:0;box-sizing:border-box;align-items:center;gap:6px;padding:9px;border:1px solid #64748b55;border-radius:12px;background:light-dark(#fff,#17212f);color:light-dark(#243247,#edf3ff);color-scheme:light dark;box-shadow:0 8px 28px #0003;max-width:calc(100vw - 16px);z-index:100015'
      if (pinned) open()
    } else {
      for (const attr of ['role', 'tabindex', 'aria-label', 'aria-expanded', 'aria-controls']) entry.removeAttribute(attr)
      actions.removeAttribute('popover'); actions.hidden = false
      actions.style.cssText = 'display:flex;align-items:center;gap:4px'
    }
  }
  const style = document.createElement('style')
  style.textContent = '#dsh-duet-actions:popover-open{display:flex} #dsh-duet-entry[role=button]:focus-visible{outline:2px solid #80c2ff;outline-offset:2px;border-radius:6px}'
  controls.append(style)
  listen(entry, 'pointerenter', open); listen(entry, 'pointerleave', later)
  listen(actions, 'pointerenter', () => clearTimeout(timer)); listen(actions, 'pointerleave', later)
  listen(entry, 'focus', () => { if (!suppressFocus) open() }); listen(controls, 'focusout', later)
  listen(entry, 'click', event => { if (compact) { event.preventDefault(); open() } })
  listen(entry, 'keydown', event => {
    if (compact && ['Enter', ' ', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); open(); actions.querySelector('button,a')?.focus()
    }
  })
  listen(document, 'keydown', event => {
    if (event.key === 'Escape' && opened && !pinned) {
      const restore = controls.contains(document.activeElement)
      close()
      if (restore) { suppressFocus = true; entry.focus(); suppressFocus = false }
    }
  })
  listen(document, 'pointerdown', event => { if (!pinned && !controls.contains(event.target)) close() })
  listen(controls, 'duet:reveal-controls', event => {
    pinned = Boolean(event.detail)
    if (pinned) open(); else later()
  })
  listen(window, 'resize', position); listen(window, 'scroll', position, true)
  const observer = new ResizeObserver(update)
  observer.observe(parent)
  update()
  return () => {
    close(); disposed = true; observer.disconnect()
    for (const stop of listeners) stop()
    if (label) label.textContent = labelText
    for (const attr of ['role', 'tabindex', 'aria-label', 'aria-expanded', 'aria-controls']) entry.removeAttribute(attr)
    controls.style.cssText = initial.controls; entry.style.cssText = initial.entry
    controls.append(...actions.children); actions.remove(); style.remove()
    delete controls.dataset.compact
  }
}
