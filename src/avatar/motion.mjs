import { expressionFor } from '../shared/avatar.mjs'

const WORDS = /哈哈|呵呵|笑死|好笑|开心|不可以|不行|不是|不能|不要|不对|没有|拒绝|好的|好嘞|收到|可以|明白|没问题|对的|是的|完成了/gu
const RANDOM = ['glance_left', 'glance_right', 'tilt']
const PREFIXES = new Set(WORDS.source.split('|').flatMap(word=>
  Array.from({length:word.length-1},(_,i)=>word.slice(0,i+1))))
export const MOTION_DURATION_MS = 1800
export const MOTION_REPEAT_GAP_MS = 5000

// The explicitly enabled character owns its motion policy, independently of
// the operating system's reduced-motion preference.
export function gesturePose(action) {
  const {kind, elapsed, envelope} = action
  const wave = Math.sin(elapsed * (kind==='nod'?8:9)) * envelope
  return {
    nod: kind==='nod' ? .24*wave : 0,
    yaw: kind==='shake' ? .28*wave
      : kind==='glance_left' ? .12*envelope : kind==='glance_right' ? -.12*envelope : 0,
    roll: kind==='tilt' ? .09*envelope : 0,
  }
}

/** Uses already-played captions, never speculative model text. One motion owns
 * the rig until completion; repetition cooldown is measured from completion. */
export class MotionDirector {
  constructor(random = Math.random) {
    this.random = random
    this.active = null
    this.pending = null
    this.lastEnd = new Map()
    this.lastFinished = -Infinity
    this.text = ''; this.utterance = ''; this.changedAt = 0; this.sequence = 0
    this.nextRandomAt = null
  }
  scheduleRandom(now) { this.nextRandomAt = now + 4000 + this.random()*4000 }
  eligible(kind, now) {
    return this.active?.kind !== kind && now - (this.lastEnd.get(kind) ?? -Infinity) >= MOTION_REPEAT_GAP_MS
  }
  captions(input, now) {
    if (input.utterance && input.utterance !== this.utterance) {
      this.utterance = input.utterance; this.text = ''; this.pending = null
    }
    const text = input.text || ''
    if (!text || text === this.text) return
    // Captions are bounded sliding prefixes. Retain only the overlap, so an
    // earlier keyword cannot retrigger whenever the next character appears.
    let overlap = Math.min(this.text.length, text.length)
    while (overlap && !text.startsWith(this.text.slice(-overlap))) overlap--
    this.text = text; this.changedAt = now
    const waitingSingle = this.pending?.single ? this.pending : null
    if (waitingSingle) this.pending = null
    let candidate
    for (const match of text.matchAll(WORDS)) {
      if (match.index + match[0].length > overlap) candidate = {kind:expressionFor(match[0]), single:false}
    }
    if (!candidate && /(?:^|[，。！？!?\s])([好不])[，。！？!?\s]*$/u.test(text)) {
      const match = text.match(/([好不])[，。！？!?\s]*$/u)
      const kind = expressionFor(match[1])
      if (match.index + 1 > overlap || waitingSingle?.kind === kind) candidate = {kind, single:true}
    }
    if (candidate && this.eligible(candidate.kind, now)) {
      this.pending = candidate.single && waitingSingle?.kind === candidate.kind ? waitingSingle
        : {...candidate, at:now, after:now+(candidate.single?250:0)}
    }
  }
  sample(input, now) {
    if (this.nextRandomAt === null) this.scheduleRandom(now)
    if (this.active && now >= this.active.at + MOTION_DURATION_MS) {
      const end = this.active.at + MOTION_DURATION_MS
      this.lastEnd.set(this.active.kind, end); this.lastFinished = end; this.active = null
      this.scheduleRandom(end)
    }
    this.captions(input, now)
    if (this.pending && (now-this.pending.at > 3000 || !this.eligible(this.pending.kind, now))) this.pending = null
    if (!this.active && this.pending && now >= this.pending.after) {
      this.active = {kind:this.pending.kind, at:now}; this.pending = null; this.sequence++
    }
    // No speech is required. Semantic cues take priority when both are due;
    // an already-running motion always finishes before the next one starts.
    const partial = PREFIXES.has((input.text || '').trim()) && now-this.changedAt < 350
    if (!this.active && !this.pending && !partial && now >= this.nextRandomAt) {
      const choices = RANDOM.filter(kind=>this.eligible(kind,now))
      if (choices.length) {
        this.active = {kind:choices[Math.min(choices.length-1,Math.floor(this.random()*choices.length))], at:now}
        this.sequence++
      }
      else this.scheduleRandom(now)
    }
    const elapsed = this.active ? (now-this.active.at)/1000 : 0
    const envelope = this.active ? Math.sin(Math.PI*(now-this.active.at)/MOTION_DURATION_MS)**2 : 0
    return {kind:this.active?.kind || '', elapsed, envelope, sequence:this.sequence}
  }
}
