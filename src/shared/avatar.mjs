/** Local presentation only: never forwarded to the voice service. */
export const AVATAR_KEY = 'dsh.duet.avatar.v1'
export const AVATAR_SIZES = Object.freeze({large:1,medium:.75,small:.5})
export const avatarSize = value => Object.hasOwn(AVATAR_SIZES,value) ? value : 'large'
export const avatarScale = value => AVATAR_SIZES[avatarSize(value)]
export const AVATAR_DEFAULTS = Object.freeze({ enabled: true, webOnly: false, size:'large' })

// A suspended event loop cannot exchange heartbeats. Give it a fresh grace
// period on resume, while still expiring a silent peer during normal ticks.
export class AvatarHeartbeat {
  constructor(interval=15000,now=Date.now(),timeout=60000){this.interval=interval;this.timeout=timeout;this.last=this.tick=now}
  touch(now=Date.now()){this.last=now}
  expired(now=Date.now()){
    if(now-this.tick>this.interval*2||now<this.tick)this.last=now
    this.tick=now
    return now-this.last>this.timeout
  }
}

export const AVATAR_PRESENTATION_LABELS=Object.freeze({
  off:'当前显示：已关闭',desktop:'当前显示：桌面浮动窗口',
  connecting:'当前显示：正在启动桌面窗口',recovering:'当前显示：桌面连接恢复中',
  other:'当前显示：由另一个 DSH 页面管理桌面窗口',web:'当前显示：网页内',
  fallback:'当前显示：网页内（桌面组件暂不可用）',unavailable:'当前显示：形象加载失败',
})

// TTS text is a cumulative prefix, not word timestamps. Bind its new suffix to
// the PCM chunk's playback interval; never use ahead-of-audio LLM text deltas.
export function captionCue(response, event) {
  const text = typeof event.text === 'string' ? event.text.slice(0, 4000) : ''
  const previous = response.captionSource || ''
  const sameSegment = response.captionSegment === event.segment_id
  const add = !text ? '' : sameSegment && text.startsWith(previous) ? text.slice(previous.length)
    : sameSegment && previous.startsWith(text) ? '' : text
  const cue = { from: response.captionText || '', add }
  response.captionText = (cue.from + add).slice(-240)
  if (text) { response.captionSource = text; response.captionSegment = event.segment_id }
  return cue
}
export function captionAt(cue, fraction) {
  if (!cue) return ''
  const chars = Array.from(cue.add)
  return (cue.from + chars.slice(0, Math.floor(chars.length * Math.max(0, Math.min(1, fraction)))).join('')).slice(-240)
}

/** Sample-clock subtitles. Late/duplicate metadata cannot rewind visible text. */
export class AudioCaptionTimeline {
  constructor() { this.responses = new Map() }
  ingestDelta(key, event, present) {
    if (!Number.isSafeInteger(event.audio_sample_end) || event.audio_sample_end < 0) return
    const state = this.responses.get(key) || {cues:[],shownEnd:-1,text:'',receivedText:'',lastReceivedEnd:-1,seen:new Set()}
    state.seen ??= new Set()
    if (event.audio_sample_end < (state.lastReceivedEnd ?? -1) ||
        (event.event_id && state.seen.has(event.event_id))) return
    const delta = event.type === 'response.output_text.delta' ? event.delta : ''
    if (typeof delta !== 'string' || delta.length > 8000 || state.cues.length >= 1024) return
    state.receivedText = ((state.receivedText || '') + delta).slice(0,8000)
    state.lastReceivedEnd = event.audio_sample_end
    if(event.event_id)state.seen.add(event.event_id)
    while(state.seen.size>2048)state.seen.delete(state.seen.values().next().value)
    const {full_text, text, ...safe} = event
    state.cues.push({sample_end:event.audio_sample_end,text_prefix:state.receivedText,event:safe,present})
    this.responses.set(key,state)
    while(this.responses.size>16)this.responses.delete(this.responses.keys().next().value)
  }
  ingest(key, cues) {
    if (!Array.isArray(cues)) return
    const state = this.responses.get(key) || { cues: [], shownEnd: -1, text: '' }
    for (const cue of cues.slice(0, 128)) {
      if (!Number.isSafeInteger(cue?.sample_end) || cue.sample_end < 0 ||
          typeof cue.text_prefix !== 'string' || cue.text_prefix.length > 8000 ||
          cue.sample_end <= state.shownEnd) continue
      if (!state.cues.some(c => c.sample_end === cue.sample_end)) state.cues.push(cue)
    }
    state.cues.sort((a,b)=>a.sample_end-b.sample_end)
    // Bound future metadata without discarding the nearest playback markers.
    state.cues = state.cues.slice(0,1024)
    this.responses.set(key,state)
    while (this.responses.size > 16) this.responses.delete(this.responses.keys().next().value)
  }
  text(key, playedSamples) {
    const state = this.responses.get(key)
    if (!state) return null
    while (state.cues.length && state.cues[0].sample_end <= playedSamples) {
      const cue = state.cues.shift()
      if (cue.sample_end >= state.shownEnd && cue.text_prefix.startsWith(state.text)) {
        state.shownEnd = cue.sample_end; state.text = cue.text_prefix
        cue.present?.(cue.event)
      }
    }
    return state.text.slice(-240)
  }
  clear() { this.responses.clear() }
  discardPending(key) { const state=this.responses.get(key);if(state)state.cues=[] }
}
export function avatarPreferences(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(AVATAR_KEY))
    return { enabled: value?.enabled !== false, webOnly: value?.webOnly === true, size:avatarSize(value?.size) }
  } catch { return { ...AVATAR_DEFAULTS } }
}
export function saveAvatarPreferences(value, storage = globalThis.localStorage) {
  const clean = { enabled: value.enabled === true, webOnly: value.webOnly === true, size:avatarSize(value.size) }
  storage.setItem(AVATAR_KEY, JSON.stringify(clean))
  return clean
}
export function expressionFor(text, random = Math.random) {
  if (/(哈哈|呵呵|笑死|好笑|开心)/u.test(text)) return 'laugh'
  if (/(不行|不是|不能|不要|不对|不可以|没有|拒绝|^不[，。！!\s]*$)/u.test(text)) return 'shake'
  if (/(好的|好嘞|收到|可以|明白|没问题|对的|是的|完成了|^好[，。！!\s]*$)/u.test(text)) return 'nod'
  return ['glance_left', 'glance_right', 'tilt'][Math.min(2, Math.floor(random() * 3))]
}
export function avatarFrame(value) {
  if (!value || !['off', 'online', 'tts_only'].includes(value.mode)) throw Error('invalid_avatar_frame')
  if (!Number.isFinite(value.rms) || value.rms < 0 || value.rms > 1) throw Error('invalid_avatar_frame')
  return { type: 'frame', mode: value.mode, ready: value.ready === true, rms: value.rms, size:avatarSize(value.size),
    viseme: ['A','I','U','E','O'].includes(value.viseme) ? value.viseme : 'A',
    text: typeof value.text === 'string' ? value.text.slice(-240) : '',
    utterance: typeof value.utterance === 'string' ? value.utterance.slice(0, 100) : '' }
}

export function avatarInputEffect(value) {
  if(value?.type!=='input_effect'||typeof value.text!=='string'||!value.text||value.text.length>600)throw Error('invalid_avatar_input_effect')
  return {type:'input_effect',text:value.text}
}
