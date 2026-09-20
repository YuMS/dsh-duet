/** Device identifiers belong to this browser, never to shared host settings. */
export const MICROPHONE_KEY = 'dsh-duet.microphone.v1'

function browserStorage() {
  try { return globalThis.localStorage } catch { return null }
}

export function selectedMicrophone(storage = browserStorage()) {
  try { return storage?.getItem(MICROPHONE_KEY) || '' } catch { return '' }
}

export function microphoneConstraints(deviceId = selectedMicrophone()) {
  return { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false }
}

export function mountMicrophoneSettings({ select, refresh, status }, media = navigator.mediaDevices, storage = browserStorage()) {
  let disposed = false, revision = 0
  const load = async () => {
    const current = ++revision
    refresh.disabled = true
    try {
      if (!media?.enumerateDevices) throw Error('unavailable')
      const devices = (await media.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
      if (disposed || current !== revision) return
      const selected = selectedMicrophone(storage)
      select.replaceChildren(new Option('系统默认麦克风', ''))
      devices.forEach((d, i) => select.add(new Option(d.label || `麦克风 ${i + 1}`, d.deviceId)))
      const missing = selected && !devices.some(d => d.deviceId === selected)
      if (missing) select.add(new Option('已选麦克风（暂不可用）', selected))
      select.value = selected
      select.disabled = false
      status.textContent = missing ? '请连接已选麦克风，或选择其他设备。' : devices.some(d => !d.label) || !devices.length
        ? '开启交互模式并允许麦克风访问后，可查看设备名称。' : ''
    } catch {
      if (!disposed && current === revision) { select.disabled = true; status.textContent = '暂时无法获取麦克风，请检查浏览器权限。' }
    } finally { if (!disposed && current === revision) refresh.disabled = false }
  }
  select.onchange = () => {
    ++revision
    refresh.disabled = false
    try {
      if (!storage) throw Error('storage_unavailable')
      storage.setItem(MICROPHONE_KEY, select.value)
      status.textContent = '已保存，下次开启交互模式时使用。'
    } catch { status.textContent = '无法保存麦克风选择，请允许浏览器存储后重试。'; select.value = selectedMicrophone(storage) }
  }
  refresh.onclick = () => { void load() }
  const storageChanged = event => { if (event.key === MICROPHONE_KEY || event.key === null) void load() }
  media?.addEventListener?.('devicechange', load)
  globalThis.addEventListener?.('storage', storageChanged)
  void load()
  return () => {
    disposed = true; ++revision
    media?.removeEventListener?.('devicechange', load)
    globalThis.removeEventListener?.('storage', storageChanged)
    select.onchange = null; refresh.onclick = null
  }
}
