import { microphoneConstraints } from './microphone.mjs?v=0.2.1'
import { captionCue, captionAt, AudioCaptionTimeline } from '../shared/avatar.mjs'

export const AUDIO_STOP_PROTOCOL = 'audio_stop_candidates_v1'

/** Browser-owned microphone and PCM playback. No microphone is requested in tts_only. */
export class DuetAudio {
  constructor() {
    this.context = null
    this.stream = null
    this.capture = null
    this.nodes = new Set()
    this.responses = new Map()
    this.cleared = new Set()
    this.epoch = 0
    this.nextTime = 0
    this.tones = new Set()
    this.captureCleanup = null
    this.captionTimeline = new AudioCaptionTimeline()
  }

  prepare() {
    this.context ??= new AudioContext()
    return this.context.resume()
  }

  connectedChime() {
    if (this.context?.state !== 'running') return
    // Two soft voices enter in turn and briefly resolve together (C5 + E5).
    for (const [frequency, offset] of [[523.25, 0], [659.25, 0.11]]) {
      const oscillator = this.context.createOscillator(), gain = this.context.createGain()
      const start = this.context.currentTime + offset, end = start + 0.36
      oscillator.type = 'sine'; oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.055, start + 0.025)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(gain).connect(this.context.destination)
      this.tones.add(oscillator)
      oscillator.onended = () => { this.tones.delete(oscillator); oscillator.disconnect(); gain.disconnect() }
      oscillator.start(start); oscillator.stop(end)
    }
  }

  async startMic(send, onFailure = () => {}, report = () => {}) {
    const epoch = this.epoch
    // Exact selection: an unplugged device must not silently use a different mic.
    const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints())
    report({event:'browser.microphone_granted'})
    if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return }
    this.stream = stream
    let failed = false
    const cleanups = [], muteTimers = new Map()
    const fail = code => {
      if (failed || epoch !== this.epoch) return
      failed = true
      this.stop()
      onFailure(code)
    }
    const watch = (target, event, fn) => {
      target.addEventListener(event, fn)
      cleanups.push(() => target.removeEventListener(event, fn))
    }
    this.captureCleanup = () => {
      for (const cleanup of cleanups) cleanup()
      for (const timer of muteTimers.values()) clearTimeout(timer)
      muteTimers.clear()
    }
    for (const track of stream.getAudioTracks()) {
      const muted = () => {
        clearTimeout(muteTimers.get(track))
        // Brief device transitions can recover. This is a media-track failure
        // signal, not an energy/VAD test: ordinary user silence never trips it.
        muteTimers.set(track, setTimeout(() => { if (track.muted) fail('audio_capture_failed') }, 10000))
      }
      watch(track, 'ended', () => fail('microphone_disconnected'))
      watch(track, 'mute', muted)
      watch(track, 'unmute', () => { clearTimeout(muteTimers.get(track)); muteTimers.delete(track) })
      if (track.readyState === 'ended') fail('microphone_disconnected')
      else if (track.muted) muted()
    }
    if (epoch !== this.epoch) return
    const code = `class Capture extends AudioWorkletProcessor {
      constructor(){super();this.phase=0;this.sum=0;this.count=0;this.pcm=new Int16Array(1280);this.offset=0;}
      process(inputs){const a=inputs[0]?.[0];if(!a)return true;
        for(const x of a){this.sum+=x;this.count++;this.phase+=16000;
          if(this.phase>=sampleRate){this.phase-=sampleRate;const v=Math.max(-1,Math.min(1,this.sum/this.count));this.pcm[this.offset++]=v<0?v*32768:v*32767;this.sum=0;this.count=0;
            if(this.offset===1280){this.port.postMessage(this.pcm.buffer,[this.pcm.buffer]);this.pcm=new Int16Array(1280);this.offset=0;}}}return true;}}
      registerProcessor('duet-audio-capture',Capture)`
    if (!this.captureLoaded) {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      try { await this.context.audioWorklet.addModule(url); this.captureLoaded = true } finally { URL.revokeObjectURL(url) }
    }
    if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return }
    this.source = this.context.createMediaStreamSource(stream)
    this.capture = new AudioWorkletNode(this.context, 'duet-audio-capture')
    watch(this.capture, 'processorerror', () => fail('audio_capture_failed'))
    this.capture.port.onmessage = e => { if (epoch === this.epoch) send(e.data) }
    this.mute = this.context.createGain()
    this.mute.gain.value = 0
    this.source.connect(this.capture).connect(this.mute).connect(this.context.destination)
    report({event:'browser.capture_started'})
  }

  event(event, send, present = () => {}) {
    const key = `${event.response_id}:${event.generation}`
    if (['response.output_text.delta','response.output_text.done'].includes(event.type)
        && Object.hasOwn(event,'audio_sample_end')) {
      if (this.cleared.has(key)) return true
      this.captionTimeline.ingestDelta(key,event,present)
      const response=this.responses.get(key)
      if(response && this.context)this.captionTimeline.text(key,this.playedAt(response,this.context.currentTime))
      if (this.avatarCaption?.key === key) {
        this.avatarCaption.text = this.captionTimeline.text(key,this.avatarCaption.played) ?? this.avatarCaption.text
      }
      return true
    }
    if (event.type === 'output_audio_buffer.clear') { this.interrupt(event, send); return }
    if (event.type === 'response.output_audio.done') {
      const response = this.responses.get(key)
      if (response) { response.done = true; this.progress(send) }
      return
    }
    if (event.type !== 'response.output_audio.delta') return
    if (this.cleared.has(key)) return
    const bytes = Uint8Array.from(atob(event.delta), c => c.charCodeAt(0))
    const pcm = new Int16Array(bytes.buffer)
    const rate = Number(event.sample_rate || 48000)
    const buffer = this.context.createBuffer(1, pcm.length, rate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768
    const node = this.context.createBufferSource()
    node.buffer = buffer
    const gain = this.context.createGain()
    node.connect(gain)
    gain.connect(this.avatarOutput())
    const start = Math.max(this.context.currentTime + 0.04, this.nextTime)
    this.nextTime = start + pcm.length / rate
    const response = this.responses.get(key) || { response_id: event.response_id, generation: event.generation, played: 0, basePlayed: 0, received: 0, chunks: [] }
    const chunk = { start, samples: pcm.length, rate, sampleStart: response.received, node, gain, ended: false }
    chunk.caption = captionCue(response, event)
    response.received += pcm.length
    response.chunks.push(chunk)
    this.responses.set(key, response)
    this.nodes.add(node)
    node.onended = () => {
      const until = Math.min(this.context.currentTime, response.stopAt ?? Infinity)
      if (until > chunk.start) {
        const played=this.playedAt(response,until)
        this.avatarCaption = { text: this.captionTimeline.text(key,played) ?? captionAt(chunk.caption, (until-chunk.start)*rate/pcm.length), at: performance.now(), key, played }
      }
      chunk.ended = true
      this.nodes.delete(node); node.disconnect(); gain.disconnect()
      this.progress(send)
      this.finishStop(key, response, send)
    }
    node.start(start)
  }

  playedAt(r, time) {
    const until = Math.min(time, r.stopAt ?? Infinity)
    return r.chunks.reduce((n, c) => n + Math.min(c.samples, Math.max(0,
      Math.floor((until - c.start) * c.rate + 1e-6))), r.basePlayed)
  }

  progress(send) {
    if (!this.context) return
    for (const [key, r] of this.responses) {
      const played = this.playedAt(r, this.context.currentTime)
      this.captionTimeline.text(key,played)
      if (played > r.played) {
        r.played = played
        send({ type: 'output_audio_buffer.playback_progress', response_id: r.response_id, generation: r.generation, played_samples: played })
      }
      while (!r.stopping && r.chunks.length && this.context.currentTime >= r.chunks[0].start + r.chunks[0].samples / r.chunks[0].rate) {
        r.basePlayed += r.chunks.shift().samples
      }
      if (r.done && !r.stopping && !r.chunks.length) this.responses.delete(key)
    }
  }

  playing() { return this.nodes.size > 0 }

  avatarOutput() {
    if (!this.context?.createAnalyser) return this.context.destination
    if (!this.avatarAnalyser) {
      this.avatarAnalyser = this.context.createAnalyser()
      this.avatarAnalyser.fftSize = 1024
      this.avatarAnalyser.smoothingTimeConstant = .6
      this.avatarAnalyser.connect(this.context.destination)
      this.avatarWave = new Float32Array(1024)
      this.avatarFrequency = new Uint8Array(512)
    }
    return this.avatarAnalyser
  }

  /** Meter actual post-gain playback, not network arrival or microphone input. */
  avatarSample() {
    const silent = {rms:0,viseme:'A',utterance:'',text:performance.now()-(this.avatarCaption?.at ?? -Infinity)<2000?this.avatarCaption.text:''}
    if (!this.context || this.context.state !== 'running' || !this.avatarAnalyser) return silent
    const now = this.context.currentTime
    let utterance = '', response_id = '', text = ''
    for (const [key,r] of this.responses) {
      if (now >= (r.stopAt ?? Infinity)) continue
      const chunk=r.chunks.find(c => !c.ended && now >= c.start && now < c.start + c.samples/c.rate)
      if (chunk) {
        utterance=key;response_id=r.response_id
        const played=this.playedAt(r,now)
        text=this.captionTimeline.text(key,played) ?? captionAt(chunk.caption,(now-chunk.start)*chunk.rate/chunk.samples)
        this.avatarCaption={text,at:performance.now(),key,played}
        break
      }
    }
    if (!utterance) return silent
    this.avatarAnalyser.getFloatTimeDomainData(this.avatarWave)
    this.avatarAnalyser.getByteFrequencyData(this.avatarFrequency)
    let square=0;for(const v of this.avatarWave)square+=v*v
    const rms=Math.min(1,Math.sqrt(square/this.avatarWave.length))
    const band=(lo,hi)=>{let sum=0,n=0;const hz=this.context.sampleRate/1024;for(let i=Math.ceil(lo/hz);i<Math.min(512,hi/hz);i++){sum+=this.avatarFrequency[i];n++}return sum/Math.max(1,n)}
    const low=band(160,600),mid=band(650,1250),high=band(1500,3200)
    const viseme=high>mid*1.16?'I':mid>low*1.13?'E':low>mid*1.3?(high>mid*.85?'O':'U'):'A'
    return {rms,viseme,utterance,response_id,text}
  }

  interrupt(event, send) {
    const key = `${event.response_id}:${event.generation}`
    if (this.cleared.has(key)) return
    this.cleared.add(key)
    const r = this.responses.get(key)
    if (!r || !this.context) return
    const now = this.context.currentTime, played = this.playedAt(r, now)
    const smooth = event.audio_stop_protocol === AUDIO_STOP_PROTOCOL
    const bound = Number.isFinite(event.max_wait_ms) ? Math.max(0, Math.min(300, event.max_wait_ms)) / 1000 : 0.3
    const fadeMs = Number.isFinite(event.fade_ms) ? Math.max(0, Math.min(12, event.fade_ms)) : 12
    const fade = smooth ? Math.min(fadeMs / 1000, bound) : 0
    let cut = now + fade, selected = null, reason = 'immediate_fallback'
    const candidates = event.stop_candidates_samples
    const valid = smooth && Array.isArray(candidates) && candidates.length <= 3 &&
      candidates.every((v, i) => Number.isSafeInteger(v) && v >= 0 && v <= r.received && (!i || v > candidates[i - 1]))
    if (valid) {
      for (const sample of candidates) {
        if (sample <= played) continue
        const c = r.chunks.find(c => c.sampleStart < sample && sample <= c.sampleStart + c.samples)
        if (!c) continue
        const when = c.start + (sample - c.sampleStart) / c.rate
        if (when > now && when <= now + bound) { cut = when; selected = sample; reason = 'candidate'; break }
      }
    }
    r.stopping = true; r.stopAt = cut; r.stopReason = reason; r.selectedStop = selected
    for (const c of r.chunks) {
      if (c.ended) continue
      const end = c.start + c.samples / c.rate
      const fadeStart = Math.max(now, cut - fade)
      if (end > fadeStart) {
        c.gain.gain.setValueAtTime(1, fadeStart)
        c.gain.gain.linearRampToValueAtTime(0, cut)
      }
      if (end >= cut) c.node.stop(c.start >= cut ? now : cut)
    }
    // Only the interrupted response is shortened. A newer response keeps its queue.
    this.nextTime = Math.max(now, ...[...this.responses.values()].flatMap(response =>
      response.chunks.filter(c => !c.ended).map(c => Math.min(
        c.start + c.samples / c.rate, response.stopAt ?? Infinity))))
    this.finishStop(key, r, send)
  }

  finishStop(key, r, send) {
    if (!r.stopping || r.acknowledged || r.chunks.some(c => !c.ended)) return
    r.acknowledged = true
    const played = this.playedAt(r, this.context.currentTime)
    this.captionTimeline.text(key,played)
    this.captionTimeline.discardPending(key)
    send({type:'output_audio_buffer.cleared', response_id:r.response_id, generation:r.generation,
      played_samples:played, audio_stop_protocol:AUDIO_STOP_PROTOCOL,
      selected_stop_sample:r.selectedStop, stop_reason:r.stopReason})
    this.responses.delete(key)
  }

  clear(send = () => {}) {
    this.progress(send)
    for (const [key, r] of this.responses) {
      this.cleared.add(key)
      send({ type: 'output_audio_buffer.cleared', response_id: r.response_id, generation: r.generation, played_samples: r.played })
    }
    for (const r of this.responses.values()) for (const c of r.chunks) c.gain.disconnect()
    for (const node of this.nodes) { node.onended = null; node.stop(); node.disconnect() }
    this.nodes.clear()
    this.responses.clear()
    this.nextTime = 0
    this.avatarCaption = null
    this.captionTimeline.clear()
  }

  stop() {
    this.epoch++
    this.captureCleanup?.()
    this.captureCleanup = null
    for (const tone of this.tones) { try { tone.stop() } catch {} }
    this.tones.clear()
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    this.source?.disconnect()
    this.capture?.disconnect()
    this.mute?.disconnect()
    this.clear()
    this.cleared.clear()
  }
}
