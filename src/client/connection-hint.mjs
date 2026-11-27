/** A brief, non-modal invitation after the microphone is actually ready. */
import {normalizeGuidance} from '../shared/connection-guidance.mjs?v=0.3.4'
import {AGENT_WORKSPACE_NOTICE,agentEntryReminder} from '../shared/work-mode.mjs'
export function mountConnectionHint(controls, { duration = 8000, onShown = ()=>{}, onSettings = ()=>{} } = {}) {
  const hint = document.createElement('div')
  hint.dataset.duetConnectionHint = ''
  hint.dataset.duetAvatarSurface = '30'
  hint.setAttribute('role', 'status')
  hint.setAttribute('aria-live', 'polite')
  hint.hidden = true
  hint.style.cssText = 'position:fixed;z-index:100020;box-sizing:border-box;width:268px;max-width:calc(100vw - 32px);padding:12px 15px;border:1px solid #a5d8f4;border-radius:12px;background:#eff9ff;color:#163c56;font:13px/1.65 system-ui,sans-serif;box-shadow:0 8px 28px #153e6524;pointer-events:auto;-webkit-user-select:text;user-select:text'
  const text=document.createTextNode(normalizeGuidance(null).text)
  hint.append(text)
  const reminder=document.createElement('div');reminder.hidden=true;reminder.style.marginTop='8px'
  reminder.dataset.duetAgentReminder=''
  const emphasis=document.createElement('strong');emphasis.textContent='只能'
  const [before,after]=AGENT_WORKSPACE_NOTICE.split('只能');reminder.append(before,emphasis,after)
  const actions=document.createElement('div');actions.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin-top:8px'
  const settings=document.createElement('button');settings.type='button';settings.textContent='打开设置'
  const acknowledge=document.createElement('button');acknowledge.type='button';acknowledge.textContent='我知道了'
  for(const button of [settings,acknowledge])button.style.cssText='padding:4px 12px;border:1px solid #a5d8f4;border-radius:8px;background:white;color:#185a89;cursor:pointer;font:inherit;pointer-events:auto;-webkit-user-select:none;user-select:none'
  settings.onclick=()=>{hide();onSettings()};acknowledge.onclick=()=>hide()
  actions.append(settings,acknowledge);hint.append(reminder,actions)
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
    const mic = controls.querySelector('[data-voice=mic]')
    const button = mic?.getClientRects().length ? mic : controls.querySelector('#dsh-duet-entry') || controls
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
    update({ mode, ready, teaching = false, guidance, workMode, connectionId }) {
      if (disposed) return
      const active = mode === 'online' && ready
      if (!active || teaching) hide()
      if (active && !wasReady && !teaching) {
        const actual=normalizeGuidance(guidance)
        text.textContent=actual.text
        reminder.hidden=workMode!=='agent'||!agentEntryReminder(connectionId)
        settings.hidden=reminder.hidden
        actions.hidden=workMode!=='agent'
        actions.style.display=actions.hidden?'none':'flex'
        hint.hidden = false
        position()
        clearTimeout(timer)
        timer = setTimeout(hide, reminder.hidden ? duration : Math.max(duration,20000))
        try{onShown(actual)}catch{ /* Diagnostics must never break the tooltip. */ }
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
