/** Versioned permission for interaction audio and necessary session context. */
export const AUDIO_CONSENT_KEY = 'dsh-duet.data-upload-consent.v3'

export function createAudioUploadConsent(storage) {
  const key = AUDIO_CONSENT_KEY
  if (storage === undefined) {
    try { storage = globalThis.localStorage } catch { storage = null }
  }
  let accepted = false, dialog = null, dismissed = null
  const granted = () => {
    try { return accepted || storage?.getItem(key) === 'accepted' }
    catch { return accepted }
  }
  const cancel = (confirmed = false) => {
    if (!dialog) return
    const current = dialog; dialog = null
    current.close(); current.remove()
    const notify = dismissed; dismissed = null
    if (!confirmed) notify?.()
  }
  const request = (onAccept, onDismiss) => {
    if (granted()) { onAccept(); return }
    if (dialog) { dialog.querySelector('button')?.focus(); return }
    dismissed = onDismiss
    dialog = document.createElement('dialog')
    dialog.id = 'duet-audio-consent'
    dialog.setAttribute('aria-labelledby', 'duet-audio-consent-title')
    dialog.setAttribute('aria-describedby', 'duet-audio-consent-description')
    dialog.style.cssText = 'max-width:380px;width:calc(100vw - 40px);border:1px solid #9aa8b8;border-radius:16px;padding:24px;background:Canvas;color:CanvasText;font:14px/1.7 system-ui;box-shadow:0 16px 60px #0004'
    const title = document.createElement('h2')
    title.id = 'duet-audio-consent-title'; title.textContent = '开启 duet'
    title.style.cssText = 'font-size:18px;margin:0 0 12px'
    const description = document.createElement('p')
    description.id = 'duet-audio-consent-description'
    description.style.whiteSpace = 'pre-line'
    description.textContent = '为了提供语音交互和任务播报，您同意 duet 根据所使用的功能，将以下信息传至服务器：\n\n• 开启交互模式时，麦克风采集的交互音频。\n• 必要的会话信息，包括会话标识、名称、运行状态和当前选中的会话。\n• 功能所需的输入框内容、任务结果及相关上下文。\n\n这些信息用于理解语音、执行会话操作、生成回复和语音播报。\n\n仅在交互模式下会采集和上传麦克风音频。'
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:12px;justify-content:flex-end;margin-top:20px'
    for (const [label, agree] of [['暂不开启', false], ['同意并开启', true]]) {
      const button = document.createElement('button')
      button.type = 'button'; button.textContent = label
      button.style.cssText = `padding:8px 14px;border-radius:8px;border:1px solid #9aa8b8;cursor:pointer;background:${agree ? '#dcefff' : 'transparent'};color:${agree ? '#185a89' : 'inherit'}`
      button.onclick = () => {
        if (!agree) { cancel(); return }
        accepted = true
        try { storage?.setItem(key, 'accepted') } catch { /* This page only. */ }
        cancel(true); onAccept()
      }
      actions.append(button)
    }
    dialog.append(title, description, actions)
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel() })
    document.body.append(dialog); dialog.showModal()
  }
  const ensure = signal => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const done = error => { signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
    const abort = () => { cancel(); done(signal.reason || Error('授权已取消')) }
    signal?.addEventListener('abort', abort, { once: true })
    request(() => done(), () => done(Error('未同意数据传输，教学已停止')))
  })
  return { granted, request, cancel, ensure }
}
