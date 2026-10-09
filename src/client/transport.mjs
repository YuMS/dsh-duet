/** Use the same physical WebSocket base as DSH's own API gateway. */
export function voiceSocketUrl(params, globals = globalThis, path = 'duplex-control/voice/ws') {
  const base = globals.__DSH_TRANSPORT__?.streamBaseUrl ?? globals.document.baseURI
  const url = new URL(path, base)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw Error('voice_transport_unavailable')
  }
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:'
  url.search = new URLSearchParams(params).toString()
  url.hash = ''
  return url.href
}

/** Desktop refuses custom-protocol popups; keep settings in the owned window. */
export function bindSettingsLink(link, globals = globalThis) {
  if (globals.location.protocol !== 'dsh-app:') return () => {}
  let dialog
  const close = () => { dialog?.close(); dialog?.remove(); dialog = null }
  const open = event => {
    event.preventDefault()
    if (dialog) return
    const doc = link.ownerDocument
    dialog = doc.createElement('dialog')
    dialog.setAttribute('aria-label', 'duet 设置')
    dialog.style.cssText = 'width:min(960px,calc(100vw - 40px));height:calc(100vh - 64px);max-height:900px;padding:0;border:1px solid #9aa8b8;border-radius:14px;background:Canvas;color:CanvasText;overflow:hidden'
    const bar = doc.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px;font:14px system-ui'
    const title = doc.createElement('strong'); title.textContent = 'duet 设置'
    const button = doc.createElement('button'); button.textContent = '关闭设置'; button.onclick = close
    bar.append(title, button)
    const frame = doc.createElement('iframe')
    frame.title = 'duet 设置'; frame.src = link.href
    frame.style.cssText = 'display:block;width:100%;height:calc(100% - 48px);border:0'
    dialog.append(bar, frame)
    dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
    doc.body.append(dialog); dialog.showModal()
  }
  link.addEventListener('click', open)
  return () => { link.removeEventListener('click', open); close() }
}
