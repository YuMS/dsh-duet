/** Follow the host's available sidebar width, without depending on DSH classes. */
export function mountControlsLayout(controls) {
  const parent = controls.parentElement
  const update = () => {
    const compact = parent.getBoundingClientRect().width < 160
    if (controls.dataset.compact === String(compact)) return
    controls.dataset.compact = String(compact)
    controls.style.flexDirection = compact ? 'column' : 'row'
    controls.style.margin = compact ? '4px 0' : '4px 8px'
    controls.style.padding = compact ? '6px 0' : '6px 8px'
    const entry = controls.querySelector('#dsh-duet-entry')
    if (entry) entry.style.display = compact ? 'none' : ''
  }
  const observer = new ResizeObserver(update)
  observer.observe(parent)
  update()
  return () => observer.disconnect()
}
