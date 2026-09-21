/** Desired voice mode is independent of a temporarily suspended connection. */
export const PLUGIN_VERSION = '0.1.3'
export const IDLE_RELEASE_MS = 60_000

const safeVersion = value => typeof value === 'string' && value.length <= 32 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value : ''
export function compatibilityNotice(code, details = {}, mode = 'online') {
  const key = mode === 'tts_only' ? 'tts_only' : 'online'
  const info = details.compatibility || {}
  const policy = details.policy || {}
  const required = safeVersion(info.modes?.[key]?.min_client_version)
    || safeVersion(policy[key + '_min_client_version']) || safeVersion(policy.min_client_version)
  const current = `当前插件 ${PLUGIN_VERSION}`
  if (code === 'plugin_upgrade_required') {
    const other = key === 'online' ? 'tts_only' : 'online'
    const alternative = info.modes?.[other]?.available === true ? `；仍可手动开启${other === 'online' ? '交互' : '播报'}模式` : ''
    return `${current}，${required ? `此模式需要 ${required} 或更高版本` : '请升级插件后再连接'}${alternative}。`
  }
  if (code === 'client_protocol_unsupported') return `${current}与服务协议不兼容，请更新插件；若已是最新版，请联系服务管理员。`
  if (code === 'client_version_unsupported') return `${current}暂不受服务支持，请联系服务管理员，不必反复重连。`
  return null
}

export class DuetState {
  constructor({ connect, changed = () => {}, notice = () => {}, now = Date.now }) {
    Object.assign(this, { connect, changed, notice, now })
    this.mode = 'off'
    this.connection = null
    this.suspended = false
    this.hidden = false
    this.running = false
    this.idleSince = null
    this.generation = 0
    this.pending = new Map()
    this.sent = new Set()
    this.state = null
    this.ready = false
    this.retiring = Promise.resolve()
    this.recommendationShown = null
  }

  toggleMic() { return this.setMode(this.mode === 'online' ? 'off' : 'online') }
  toggleSpeaker() { return this.setMode(this.mode === 'tts_only' ? 'off' : 'tts_only') }

  async setMode(mode) {
    if (!['off', 'tts_only', 'online'].includes(mode)) throw new Error('invalid_voice_mode')
    if (mode === this.mode && !this.suspended) return
    this.mode = mode
    this.suspended = false
    this.idleSince = null
    if (mode === 'off') this.pending.clear()
    // Online result polling belongs to its existing server-side Harness client.
    if (mode === 'online') this.pending.clear()
    await this.replaceConnection()
  }

  async replaceConnection() {
    const generation = ++this.generation
    const previous = this.connection
    this.connection = null
    this.ready = false
    this.sent.clear()
    if (previous) this.retiring = this.retiring.then(() => previous.close()).catch(() => {})
    this.changed(this)
    await this.retiring
    if (generation !== this.generation || this.mode === 'off' || this.suspended) return
    try {
      this.connection = this.connect(this.mode, event => {
        if (generation !== this.generation) return
        this.receive(event)
      })
    } catch (error) { this.fail(error.message) }
  }

  receive(event) {
    if (event.type === 'compatibility') {
      const recommended = safeVersion(event.compatibility?.recommended_client_version)
      const newer = recommended && recommended.split('.').reduce((result, v, i) => result || Math.sign(Number(v) - Number(PLUGIN_VERSION.split('.')[i])), 0) > 0
      if (newer && this.recommendationShown !== recommended) {
        this.recommendationShown = recommended
        this.notice(`当前插件 ${PLUGIN_VERSION}，推荐更新到 ${recommended}。当前连接可以继续使用。`, { upgrade: true })
      }
    } else if (event.type === 'ready') {
      this.ready = true
      this.connection?.sendState(this.state)
      this.flush()
    } else if (event.type === 'external_message.done') {
      this.pending.delete(event.message_id)
      this.sent.delete(event.message_id)
      this.flush()
    } else if (event.type === 'error') {
      // A rejected model action is not a dead transport. Never execute/retry it,
      // but leave the user able to clarify instead of closing their microphone.
      if (event.code === 'malformed_dense_action') {
        this.notice('这次操作指令格式有误，未执行。语音仍已连接，请重新说明。')
      } else this.fail(event.code, event)
    }
    this.changed(this)
  }

  fail(code, details = {}) {
    const compatibility = compatibilityNotice(code, details, this.mode)
    if (compatibility) {
      this.notice(compatibility, { upgrade: code !== 'client_version_unsupported' })
      void this.setMode('off')
      return
    }
    const policyNotices = {
      workspace_required: '请先在 DSH 中创建 workspace，再开启 duet。',
      workspace_loading: '正在加载 workspace，请稍后再试。',
      workspace_unavailable: '无法读取 workspace，请刷新 DSH 后重试。',
      microphone_unavailable: '无法使用所选麦克风，请在设置中检查设备与浏览器权限',
      microphone_disconnected: '麦克风已断开或权限已撤销，交互模式已关闭。请检查设备后重新开启。',
      audio_capture_failed: '麦克风采集异常，交互模式已关闭。请检查设备后重新开启。',
      voice_start_timeout: '连接超时，请检查网络或麦克风授权后重新开启。',
      harness_sync_failed: '无法继续同步 DSH 会话，语音已关闭。请检查 DSH 后重新开启。',
      interaction_mode_unavailable: '交互模式暂时不可用，请稍后再试',
      broadcast_mode_unavailable: '播报模式暂时不可用，请稍后再试',
      client_protocol_unsupported: '插件与服务器协议不兼容，请更新插件或联系服务管理员',
      client_version_unsupported: '当前插件版本暂不受服务器支持，请联系服务管理员',
    }
    if (policyNotices[code]) {
      this.notice(policyNotices[code])
      void this.setMode('off')
      return
    }
    const busy = ['capacity_exhausted', 'server_busy', 'external_message_queue_full', 'busy'].includes(code)
    const upgrade = code === 'plugin_upgrade_required'
    const backendUpgrade = ['harness_result_backend_upgrade_required', 'harness_rpc_backend_upgrade_required'].includes(code)
    this.notice(code === 'voice_settings_changed' ? '连接配置已更新，请重新打开语音' : upgrade ? '请升级 duet 插件后再连接' : backendUpgrade ? '语音服务器需要更新协议，请稍后再试' : busy ? '服务器忙，请稍后再试' : code === 'voice_tab_in_use' ? '另一个 Harness 页面正在使用语音' : '语音连接不可用，请稍后重试')
    void this.setMode('off')
  }

  update({ hidden, running, state, results = [] }) {
    this.hidden = hidden
    this.running = running
    if (JSON.stringify(state) !== JSON.stringify(this.state)) {
      this.state = state
      if (this.ready) this.connection?.sendState(state)
    }
    if (this.mode === 'tts_only') {
      for (const result of results) {
        if (this.pending.size >= 64) { this.fail('external_message_queue_full'); break }
        this.pending.set(result.message_id, result)
      }
      if (this.suspended && (running || this.pending.size)) {
        this.suspended = false
        this.idleSince = null
        void this.replaceConnection()
      }
    }
    this.flush()
    this.tick()
  }

  flush() {
    if (!this.ready || this.mode !== 'tts_only') return
    // One notification at a time; preserve the next one until generation finishes.
    if (this.sent.size) return
    const result = this.pending.values().next().value
    if (result) {
      this.sent.add(result.message_id)
      this.connection.send(result)
    }
  }

  tick() {
    const idle = this.mode === 'tts_only' && this.hidden && !this.running
      && !this.pending.size && !this.connection?.playing()
    if (!idle) { this.idleSince = null; return }
    this.idleSince ??= this.now()
    if (!this.suspended && this.now() - this.idleSince >= IDLE_RELEASE_MS) {
      this.suspended = true
      void this.replaceConnection()
    }
  }

  async dispose() { await this.setMode('off'); await this.retiring }
}
