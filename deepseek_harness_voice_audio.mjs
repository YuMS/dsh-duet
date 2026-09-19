import { microphoneConstraints } from './deepseek_harness_voice_microphone.mjs?v=0.1.0'

/** Browser-owned microphone and PCM playback. No microphone is requested in tts_only. */
export class VoiceAudio {
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

  async startMic(send) {
    const epoch = this.epoch
    // Exact selection: an unplugged device must not silently use a different mic.
    const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints())
    if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return }
    this.stream = stream
    const code = `class Capture extends AudioWorkletProcessor {
      constructor(){super();this.phase=0;this.sum=0;this.count=0;this.pcm=new Int16Array(1280);this.offset=0;}
      process(inputs){const a=inputs[0]?.[0];if(!a)return true;
        for(const x of a){this.sum+=x;this.count++;this.phase+=16000;
          if(this.phase>=sampleRate){this.phase-=sampleRate;const v=Math.max(-1,Math.min(1,this.sum/this.count));this.pcm[this.offset++]=v<0?v*32768:v*32767;this.sum=0;this.count=0;
            if(this.offset===1280){this.port.postMessage(this.pcm.buffer,[this.pcm.buffer]);this.pcm=new Int16Array(1280);this.offset=0;}}}return true;}}
      registerProcessor('duplex-voice-capture',Capture)`
    if (!this.captureLoaded) {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      try { await this.context.audioWorklet.addModule(url); this.captureLoaded = true } finally { URL.revokeObjectURL(url) }
    }
    if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return }
    this.source = this.context.createMediaStreamSource(stream)
    this.capture = new AudioWorkletNode(this.context, 'duplex-voice-capture')
    this.capture.port.onmessage = e => { if (epoch === this.epoch) send(e.data) }
    this.mute = this.context.createGain()
    this.mute.gain.value = 0
    this.source.connect(this.capture).connect(this.mute).connect(this.context.destination)
  }

  event(event, send) {
    const key = `${event.response_id}:${event.generation}`
    if (event.type === 'output_audio_buffer.clear') { this.cleared.add(key); this.clear(send); return }
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
    node.connect(this.context.destination)
    const start = Math.max(this.context.currentTime + 0.04, this.nextTime)
    this.nextTime = start + pcm.length / rate
    const response = this.responses.get(key) || { response_id: event.response_id, generation: event.generation, played: 0, basePlayed: 0, chunks: [] }
    response.chunks.push({ start, samples: pcm.length, rate })
    this.responses.set(key, response)
    this.nodes.add(node)
    node.onended = () => { this.nodes.delete(node); node.disconnect(); this.progress(send) }
    node.start(start)
  }

  progress(send) {
    if (!this.context) return
    for (const [key, r] of this.responses) {
      const played = r.chunks.reduce((n, c) => n + Math.min(c.samples, Math.max(0, Math.floor((this.context.currentTime - c.start) * c.rate))), r.basePlayed)
      if (played > r.played) {
        r.played = played
        send({ type: 'output_audio_buffer.playback_progress', response_id: r.response_id, generation: r.generation, played_samples: played })
      }
      while (r.chunks.length && this.context.currentTime >= r.chunks[0].start + r.chunks[0].samples / r.chunks[0].rate) {
        r.basePlayed += r.chunks.shift().samples
      }
      if (r.done && !r.chunks.length) this.responses.delete(key)
    }
  }

  playing() { return this.nodes.size > 0 }

  clear(send = () => {}) {
    this.progress(send)
    for (const [key, r] of this.responses) {
      this.cleared.add(key)
      send({ type: 'output_audio_buffer.cleared', response_id: r.response_id, generation: r.generation, played_samples: r.played })
    }
    for (const node of this.nodes) { node.onended = null; node.stop(); node.disconnect() }
    this.nodes.clear()
    this.responses.clear()
    this.nextTime = 0
  }

  stop() {
    this.epoch++
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
